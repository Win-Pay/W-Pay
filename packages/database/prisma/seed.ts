/**
 * Seeds a local database with one admin and one demo merchant.
 *
 * Credentials are never hard-coded: the seed requires SEED_ADMIN_EMAIL and
 * SEED_ADMIN_PASSWORD, or generates a random password and prints it once.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@wpay.local";
  const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`generated admin password (store it now): ${password}`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: "ADMIN" },
    create: { email, passwordHash, displayName: "W-Pay Admin", role: "ADMIN" },
  });
  console.log(`admin user ready: ${admin.email}`);

  const ownerAddress = process.env.SEED_MERCHANT_ADDRESS ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const merchant = await prisma.merchant.upsert({
    where: { ownerAddress },
    update: {},
    create: {
      ownerAddress,
      settlementAddress: process.env.SEED_MERCHANT_SETTLEMENT ?? ownerAddress,
      name: "Demo Merchant",
      feeBps: 250,
      status: "ACTIVE",
      description: "Seeded local merchant used by the dashboards.",
    },
  });
  console.log(`demo merchant ready: ${merchant.id}`);

  await prisma.notification.create({
    data: {
      merchantId: merchant.id,
      title: "Welcome to W-Pay",
      body: "Your merchant account is ready. Deploy contracts and set CONTRACT_* ids to go live.",
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
