#!/usr/bin/env node
/**
 * Seeds a user, merchant and public invoice for `wpay.k6.js`, then prints the
 * values k6 needs. All writes go through the real API; the only direct database
 * access activates the merchant and attaches the on-chain registry id needed by
 * checkout, mirroring what an operator approval does in production.
 *
 * Usage:
 *   DATABASE_URL=... K6_API_URL=http://127.0.0.1:4000 node loadtest/seed.cjs
 *   DATABASE_URL=... node loadtest/seed.cjs >> "$GITHUB_ENV"
 */
"use strict";

const { randomBytes } = require("node:crypto");
const { PrismaClient } = require("@wpay/database");

const base = (process.env.K6_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const prisma = new PrismaClient();
const run = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const email = `load-${run}@wpay.test`;
const password = `load-${run}-password`;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function address() {
  let value = "G";
  for (const byte of randomBytes(55)) value += B32[byte % 32];
  return value;
}

async function call(method, path, body, token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  }
  return parsed;
}

(async () => {
  const registered = await call("POST", "/v1/auth/register", { email, password });
  await prisma.user.update({ where: { id: registered.user.id }, data: { role: "ADMIN" } });
  const login = await call("POST", "/v1/auth/login", { email, password });

  const merchant = await call(
    "POST",
    "/v1/merchants",
    {
      name: `Load ${run}`,
      ownerAddress: address(),
      settlementAddress: address(),
      feeBps: 250,
    },
    login.accessToken,
  );
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { status: "ACTIVE", registryId: BigInt(`9${run.replace(/\D/g, "").slice(0, 12)}`) },
  });

  const invoice = await call(
    "POST",
    "/v1/invoices",
    {
      merchantId: merchant.id,
      token: address(),
      amount: "10000000",
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      memo: `load-${run}`,
    },
    login.accessToken,
  );

  console.log(`K6_EMAIL=${email}`);
  console.log(`K6_PASSWORD=${password}`);
  console.log(`K6_INVOICE=${invoice.number}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
