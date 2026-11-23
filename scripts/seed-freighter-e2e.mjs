#!/usr/bin/env node
/**
 * Creates a disposable invoice for the real-Freighter checkout test.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/seed-freighter-e2e.mjs
 *
 * Optional:
 *   WPAY_FREIGHTER_INVOICE   exact invoice number to create
 *   WPAY_FREIGHTER_AMOUNT    amount in stroops (default 10000000 = 1 XLM)
 *   WPAY_FREIGHTER_MERCHANT  merchant id
 *   WPAY_FREIGHTER_DUE_OFFSET_MINUTES  due date offset (default 120; use -5 for expiry)
 *   WPAY_FREIGHTER_BOOTSTRAP=1         create the Testnet merchant when absent
 *   WPAY_FREIGHTER_REGISTRY_ID         on-chain merchant id (default 1)
 *   WPAY_FREIGHTER_SETTLEMENT_ADDRESS  merchant owner/settlement public key
 *
 * Prints JSON with the invoice details. The invoice is Testnet-only: it is
 * created OPEN for the first ACTIVE merchant registered on chain.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const nativeSac =
  process.env.WPAY_NATIVE_SAC ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
try {
  if (process.env.WPAY_FREIGHTER_BOOTSTRAP === "1") {
    const address = process.env.WPAY_FREIGHTER_SETTLEMENT_ADDRESS;
    if (!address) throw new Error("WPAY_FREIGHTER_SETTLEMENT_ADDRESS is required for bootstrap");
    const registryId = BigInt(process.env.WPAY_FREIGHTER_REGISTRY_ID ?? "1");
    const existing = await prisma.merchant.findFirst({ where: { registryId } });
    if (!existing) {
      await prisma.merchant.create({
        data: {
          id: `freighter-e2e-merchant-${registryId}`,
          registryId,
          ownerAddress: address,
          settlementAddress: address,
          name: process.env.WPAY_FREIGHTER_MERCHANT_NAME ?? "Testnet Invoice Merchant",
          feeBps: 250,
          status: "ACTIVE",
        },
      });
    }
  }

  const merchant = await prisma.merchant.findFirst({
    where: {
      status: "ACTIVE",
      registryId: { not: null },
      ...(process.env.WPAY_FREIGHTER_MERCHANT
        ? { id: process.env.WPAY_FREIGHTER_MERCHANT }
        : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (!merchant) throw new Error("no ACTIVE merchant with an on-chain registry id");

  const number =
    process.env.WPAY_FREIGHTER_INVOICE ??
    `INV-FREIGHTER-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3)
      .toString("hex")
      .toUpperCase()}`;
  const amount = BigInt(process.env.WPAY_FREIGHTER_AMOUNT ?? "10000000");
  const dueOffsetMinutes = Number(process.env.WPAY_FREIGHTER_DUE_OFFSET_MINUTES ?? "120");
  const dueAt = new Date(Date.now() + dueOffsetMinutes * 60 * 1000);
  const invoice = await prisma.invoice.create({
    data: {
      number,
      merchantId: merchant.id,
      token: nativeSac,
      amount,
      memo: number,
      status: "OPEN",
      dueAt,
    },
  });
  console.log(
    JSON.stringify(
      {
        id: invoice.id,
        number: invoice.number,
        amount: invoice.amount.toString(),
        token: invoice.token,
        dueAt: invoice.dueAt.toISOString(),
        merchantName: merchant.name,
        merchantRegistryId: merchant.registryId?.toString(),
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
