import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Real-browser Testnet checkout with the actual Freighter (Varial) extension.
 *
 * Prerequisites (see docs/TESTNET_VERIFICATION.md):
 *   FREIGHTER_EXTENSION_PATH       unpacked extension directory
 *   WPAY_FREIGHTER_INVOICE         disposable OPEN Testnet invoice number
 *   WPAY_FREIGHTER_API_URL         default http://localhost:4100
 *   WPAY_FREIGHTER_APP_URL         default http://localhost:3100
 *   WPAY_FREIGHTER_EXPIRED_INVOICE optional expired invoice number
 *   WPAY_FREIGHTER_MERCHANT_ADDRESS optional settlement address for balance checks
 *   DATABASE_URL                   optional; enables DB-level payment assertions
 *
 * The extension is reset for every run: a fresh wallet is created inside the
 * browser profile, funded through Friendbot, and never exported. The password
 * is generated at runtime and neither it nor the recovery phrase is logged.
 */

const extensionPath = process.env.FREIGHTER_EXTENSION_PATH ?? "";
const invoiceNumber = process.env.WPAY_FREIGHTER_INVOICE ?? "";
const expiredInvoice = process.env.WPAY_FREIGHTER_EXPIRED_INVOICE ?? "";
const appUrl = process.env.WPAY_FREIGHTER_APP_URL ?? "http://localhost:3100";
const apiUrl = process.env.WPAY_FREIGHTER_API_URL ?? "http://localhost:4100";
const rpcUrl = process.env.WPAY_FREIGHTER_RPC_URL ?? "https://soroban-testnet.stellar.org";
const horizonUrl = process.env.WPAY_FREIGHTER_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const friendbotUrl = process.env.WPAY_FREIGHTER_FRIEND_BOT ?? "https://friendbot.stellar.org";
const evidenceFile =
  process.env.WPAY_FREIGHTER_EVIDENCE_FILE ?? "deployments/freighter-e2e.json";
const headless = process.env.WPAY_FREIGHTER_HEADLESS !== "false";

const missing: string[] = [];
if (!extensionPath) missing.push("FREIGHTER_EXTENSION_PATH");
if (!invoiceNumber) missing.push("WPAY_FREIGHTER_INVOICE");
test.skip(
  missing.length > 0,
  `Real Freighter E2E is opt-in; set ${missing.join(", ")} and run pnpm test:e2e:freighter`,
);

test.describe.configure({ mode: "serial", timeout: 300_000 });

type PublicInvoice = {
  id: string;
  number: string;
  merchantId: string;
  merchantName: string;
  token: string;
  amount: string;
  memo: string | null;
  status: string;
  dueAt: string;
  feeBps: number;
  fee: string;
  net: string;
  txHash: string | null;
  paymentId: string | null;
  contractPaymentId: string | null;
};

type InvoiceRecord = PublicInvoice & { paidAt: string | null; createdAt: string };

const evidence = {
  generatedAt: new Date().toISOString(),
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  environment: { appUrl, apiUrl, rpcUrl, horizonUrl },
  extension: {
    name: "Freighter (Varial)",
    version: "",
    source: "official unpacked extension",
    mode: headless ? "headless-chromium" : "headed-chromium",
  },
  wallet: {
    address: "",
    funding: "Friendbot Testnet",
    secretExposed: false,
  },
  invoice: {
    number: invoiceNumber,
    merchantName: "",
    merchantAddress: "",
    token: "",
    amount: "",
    fee: "",
    feeBps: 0,
    net: "",
    memo: "",
    statusBefore: "",
  },
  transaction: {
    hash: "",
    ledger: 0,
    rpcStatus: "",
    explorerUrl: "",
    successful: false,
  },
  checks: {
    freshWalletCreated: false,
    testNetSelected: false,
    grantAccessPopupShowedTestNet: false,
    wrongNetworkRejected: false,
    userRejectionHandled: false,
    failedTransactionRejected: false,
    expiredInvoiceRejected: false as boolean | "not-provided",
    invoicePaid: false,
    paymentSettled: false,
    referenceVerified: false,
    amountAndFeeVerified: false,
    merchantBalanceCredited: false as boolean | "not-checked",
    duplicateProtected: false,
    rpcConfirmed: false,
  },
  database: {
    checked: false,
    invoiceStatus: "",
    paymentStatus: "",
    payerMatched: false,
    ledgerMatched: false,
    paymentRowsForInvoice: 0,
  },
};

let context: BrowserContext;
let extensionId = "";
let extensionPage: Page;
let checkout: Page;
let walletAddress = "";
let merchantAddress = process.env.WPAY_FREIGHTER_MERCHANT_ADDRESS ?? "";
let merchantBalanceBefore: bigint | null = null;
let publicBefore: PublicInvoice;

function extensionBase(): string {
  return `chrome-extension://${extensionId}/index.html`;
}

async function api<T>(method: string, route: string, data?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${apiUrl}${route}`, {
    method,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as T) : (undefined as T) };
}

async function openExtension(): Promise<Page> {
  if (!extensionPage || extensionPage.isClosed()) {
    extensionPage = context.pages().find((page) => page.url().startsWith("chrome-extension://")) ??
      (await context.newPage());
  }
  await extensionPage.goto(extensionBase());
  await extensionPage.waitForTimeout(800);
  return extensionPage;
}

async function selectNetwork(label: "Main Net" | "Test Net"): Promise<void> {
  const page = await openExtension();
  await page.getByText(/Account 1/).first().click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForTimeout(800);
  await page.getByText(/Network/).last().click();
  await page.waitForTimeout(800);
  await page.locator("select").first().selectOption({ label });
  await page.waitForTimeout(600);
  await expect(page.locator("select").first()).toHaveValue(label);
}

async function createFreshWallet(): Promise<void> {
  const page = await openExtension();
  await page.getByText("Create new wallet", { exact: true }).click();
  await page.waitForTimeout(800);
  // Ephemeral password; never logged or persisted.
  const password = `${randomBytes(18).toString("base64url")}Aa1!`;
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(password);
  await fields.nth(1).fill(password);
  await page.locator('input[type="checkbox"]').first().focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: /^confirm$/i }).click();
  await page.waitForTimeout(1500);
  await page.getByText("Do this later").click();
  await page.waitForTimeout(1500);
  evidence.checks.freshWalletCreated = true;
  await selectNetwork("Test Net");
  evidence.checks.testNetSelected = true;
}

async function connectWallet(page: Page): Promise<void> {
  const popupPromise = context.waitForEvent("page", { timeout: 20_000 }).catch(() => null);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  const popup = await popupPromise;
  if (!popup) throw new Error("Freighter did not open a connection request");
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await expect(popup.getByText("Test Net")).toBeVisible();
  evidence.checks.grantAccessPopupShowedTestNet = true;
  await popup.getByRole("button", { name: /^connect$/i }).click();
  await expect(page.getByText(/Wallet G[A-Z0-9]{4}/)).toBeVisible({ timeout: 20_000 });
}

async function walletPublicKey(page: Page): Promise<string> {
  const key = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const id = Date.now() + Math.random();
        const timer = setTimeout(() => {
          window.removeEventListener("message", handler);
          reject(new Error("wallet did not answer REQUEST_PUBLIC_KEY"));
        }, 10_000);
        const handler = (event: MessageEvent) => {
          if (
            event.source === window &&
            event.data?.source === "FREIGHTER_EXTERNAL_MSG_RESPONSE" &&
            event.data?.messagedId === id
          ) {
            clearTimeout(timer);
            window.removeEventListener("message", handler);
            resolve(event.data.publicKey as string);
          }
        };
        window.addEventListener("message", handler);
        window.postMessage(
          {
            source: "FREIGHTER_EXTERNAL_MSG_REQUEST",
            messageId: id,
            type: "REQUEST_PUBLIC_KEY",
          },
          window.location.origin,
        );
      }),
  );
  if (!/^G[A-Z0-9]{55}$/.test(key)) throw new Error("wallet returned an invalid public key");
  return key;
}

async function fundWithFriendbot(address: string): Promise<void> {
  const response = await fetch(`${friendbotUrl}/?addr=${encodeURIComponent(address)}`);
  if (!response.ok) throw new Error(`Friendbot funding failed with HTTP ${response.status}`);
  for (let attempt = 0; attempt < 40; attempt++) {
    const account = await fetch(`${horizonUrl}/accounts/${address}`);
    if (account.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error("Friendbot-funded account did not appear on Horizon");
}

function stroops(balance: string): bigint {
  const [whole, fraction = ""] = balance.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(`${fraction}0000000`.slice(0, 7));
}

async function nativeBalance(address: string): Promise<bigint> {
  const response = await fetch(`${horizonUrl}/accounts/${address}`);
  if (!response.ok) throw new Error(`Horizon account lookup failed (${response.status})`);
  const account = (await response.json()) as {
    balances: Array<{ asset_type: string; balance: string }>;
  };
  const native = account.balances.find((balance) => balance.asset_type === "native");
  if (!native) throw new Error("account has no native balance");
  return stroops(native.balance);
}

async function queryDb<T>(fn: (prisma: any) => Promise<T>): Promise<T | null> {
  if (!process.env.DATABASE_URL) return null;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/** Opens the Freighter signing prompt, retrying Freighter's stale fee cache. */
async function openSignature(page: Page): Promise<Page> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await expect(page.getByRole("button", { name: /pay invoice/i })).toBeEnabled({ timeout: 30_000 });
    const popupPromise = context.waitForEvent("page", { timeout: 40_000 }).catch(() => null);
    await page.getByRole("button", { name: /pay invoice/i }).click();
    const popup = await popupPromise;
    if (!popup) {
      await page.waitForTimeout(2_000);
      continue;
    }
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    await popup.waitForTimeout(1_000);
    const text = await popup.locator("body").innerText();
    if (/INSUFFICIENT FUNDS FOR FEE/i.test(text)) {
      await popup.getByRole("button", { name: /got it/i }).click();
      await popup.close();
      await extensionPage.goto(extensionBase()).catch(() => {});
      await page.waitForTimeout(3_000);
      continue;
    }
    await expect(popup.getByText("Confirm Transaction")).toBeVisible();
    await expect(popup.getByText("Test Net")).toBeVisible();
    return popup;
  }
  throw new Error("Freighter never offered a signing confirmation");
}

test.beforeAll(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, "manifest.json"), "utf8")) as {
    version: string;
  };
  evidence.extension.version = manifest.version;

  context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "wpay-freighter-")), {
    channel: "chromium",
    headless,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  extensionId = new URL(worker.url()).host;

  await createFreshWallet();

  checkout = await context.newPage();
  await checkout.goto(`${appUrl}/?invoice=${encodeURIComponent(invoiceNumber)}`);
  await expect(checkout.getByText(/Invoice amount/i)).toBeVisible({ timeout: 30_000 });
  await connectWallet(checkout);
  walletAddress = await walletPublicKey(checkout);
  evidence.wallet.address = walletAddress;

  const before = await api<PublicInvoice>("GET", `/v1/invoices/public/${invoiceNumber}`);
  expect(before.status).toBe(200);
  publicBefore = before.body;
  evidence.invoice.merchantName = publicBefore.merchantName;
  evidence.invoice.token = publicBefore.token;
  evidence.invoice.amount = publicBefore.amount;
  evidence.invoice.fee = publicBefore.fee;
  evidence.invoice.feeBps = publicBefore.feeBps;
  evidence.invoice.net = publicBefore.net;
  evidence.invoice.memo = publicBefore.memo ?? "";
  evidence.invoice.statusBefore = publicBefore.status;
  expect(publicBefore.status).toBe("OPEN");
  expect(publicBefore.memo).toBe(invoiceNumber);

  const row = await queryDb(async (prisma) =>
    prisma.invoice.findUnique({
      where: { number: invoiceNumber },
      include: { merchant: true },
    }),
  );
  if (row) {
    merchantAddress = merchantAddress || row.merchant.settlementAddress || row.merchant.ownerAddress;
  }
  evidence.invoice.merchantAddress = merchantAddress;
  if (merchantAddress) merchantBalanceBefore = await nativeBalance(merchantAddress);

  await fundWithFriendbot(walletAddress);
});

test.afterAll(async () => {
  await context?.close();
});

test("refuses to sign while the wallet is on Mainnet", async () => {
  await selectNetwork("Main Net");
  await expect(checkout.getByRole("button", { name: /pay invoice/i })).toBeEnabled();
  await checkout.getByRole("button", { name: /pay invoice/i }).click();
  await expect(checkout.getByText(/Wallet is on Public Global Stellar Network/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(checkout.getByText(/transaction targets Testnet/i)).toBeVisible();
  evidence.checks.wrongNetworkRejected = true;

  const stillOpen = await api<PublicInvoice>("GET", `/v1/invoices/public/${invoiceNumber}`);
  expect(stillOpen.body.status).toBe("OPEN");
  await selectNetwork("Test Net");
});

test("surfaces a rejected signature without marking the invoice paid", async () => {
  const popup = await openSignature(checkout);
  await popup.getByRole("button", { name: /^cancel$/i }).click();
  await expect(checkout.locator(".wp-alert-error")).toBeVisible({ timeout: 30_000 });
  await expect(checkout.getByText(/Payment confirmed on chain/)).toHaveCount(0);
  evidence.checks.userRejectionHandled = true;

  const stillOpen = await api<PublicInvoice>("GET", `/v1/invoices/public/${invoiceNumber}`);
  expect(stillOpen.body.status).toBe("OPEN");
});

test("rejects a transaction the network did not confirm", async () => {
  const bogus = "0".repeat(64);
  const rejected = await api<{ message: string }>(
    "POST",
    `/v1/invoices/public/${invoiceNumber}/confirm`,
    { txHash: bogus },
  );
  expect(rejected.status).toBe(400);
  expect(rejected.body.message).toMatch(/not successful|NOT_FOUND/i);
  evidence.checks.failedTransactionRejected = true;

  const stillOpen = await api<PublicInvoice>("GET", `/v1/invoices/public/${invoiceNumber}`);
  expect(stillOpen.body.status).toBe("OPEN");
});

test("refuses an expired invoice", async () => {
  if (!expiredInvoice) {
    evidence.checks.expiredInvoiceRejected = "not-provided";
    test.skip(true, "set WPAY_FREIGHTER_EXPIRED_INVOICE to cover expiry");
    return;
  }
  const intent = await api<{ message: string }>(
    "POST",
    `/v1/invoices/public/${expiredInvoice}/intent`,
    { payer: walletAddress },
  );
  expect(intent.status).toBe(409);
  expect(intent.body.message).toMatch(/expired/i);
  evidence.checks.expiredInvoiceRejected = true;
});

test("pays the invoice, confirms it on Testnet and settles the payment", async ({}, testInfo) => {
  const popup = await openSignature(checkout);
  await popup.getByRole("button", { name: /^confirm$/i }).click();

  await expect(checkout.getByText(/Payment confirmed on chain/i)).toBeVisible({ timeout: 120_000 });
  await expect(checkout.getByText("PAID", { exact: true })).toBeVisible();
  evidence.checks.invoicePaid = true;

  const after = await api<PublicInvoice>("GET", `/v1/invoices/public/${invoiceNumber}`);
  expect(after.status).toBe(200);
  expect(after.body.status).toBe("PAID");
  expect(after.body.txHash).toMatch(/^[0-9a-f]{64}$/);
  expect(after.body.contractPaymentId).toMatch(/^\d+$/);
  expect(after.body.memo).toBe(invoiceNumber);
  evidence.checks.referenceVerified = true;

  expect(BigInt(after.body.fee) + BigInt(after.body.net)).toBe(BigInt(after.body.amount));
  expect(BigInt(after.body.net)).toBe(BigInt(publicBefore.net));
  evidence.checks.amountAndFeeVerified = true;

  const txHash = after.body.txHash!;
  const rpc = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: txHash } }),
  });
  expect(rpc.ok).toBe(true);
  const rpcBody = (await rpc.json()) as {
    result?: { status: string; ledger: number };
    error?: { message: string };
  };
  expect(rpcBody.error).toBeUndefined();
  expect(rpcBody.result?.status).toBe("SUCCESS");
  expect(rpcBody.result?.ledger).toBeGreaterThan(0);
  evidence.checks.rpcConfirmed = true;
  evidence.transaction = {
    hash: txHash,
    ledger: rpcBody.result!.ledger,
    rpcStatus: rpcBody.result!.status,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    successful: true,
  };

  await expect(checkout.getByText(new RegExp(`ledger\\s+${rpcBody.result!.ledger}`))).toBeVisible();
  const explorer = checkout.locator(`a[href*="/tx/${txHash}"]`);
  await expect(explorer).toBeVisible();

  if (merchantAddress && merchantBalanceBefore !== null) {
    const merchantAfter = await nativeBalance(merchantAddress);
    const delta = merchantAfter - merchantBalanceBefore;
    expect(delta).toBe(BigInt(after.body.net));
    evidence.checks.merchantBalanceCredited = true;
  } else {
    evidence.checks.merchantBalanceCredited = "not-checked";
  }

  const replay = await api<InvoiceRecord>(
    "POST",
    `/v1/invoices/public/${invoiceNumber}/confirm`,
    { txHash },
  );
  expect(replay.status).toBe(201);
  expect(replay.body.status).toBe("PAID");
  expect(replay.body.txHash).toBe(txHash);

  const secondIntent = await api<{ message: string }>(
    "POST",
    `/v1/invoices/public/${invoiceNumber}/intent`,
    { payer: walletAddress },
  );
  expect(secondIntent.status).toBe(409);
  evidence.checks.duplicateProtected = true;

  const rows = await queryDb(async (prisma) => {
    const invoice = await prisma.invoice.findUnique({
      where: { number: invoiceNumber },
      include: { payment: true },
    });
    if (!invoice) return null;
    const payments = await prisma.payment.findMany({
      where: { memo: invoiceNumber },
    });
    return { invoice, payments };
  });
  if (!rows) {
    throw new Error("DATABASE_URL is required to verify the invoice and SETTLED payment row");
  }
  {
    const { invoice, payments } = rows;
    expect(invoice.status).toBe("PAID");
    expect(invoice.txHash).toBe(txHash);
    expect(invoice.payment).not.toBeNull();
    const payment = invoice.payment!;
    expect(payment.status).toBe("SETTLED");
    expect(payment.amount).toBe(BigInt(publicBefore.amount));
    expect(payment.fee).toBe(BigInt(publicBefore.fee));
    expect(payment.net).toBe(BigInt(publicBefore.net));
    expect(payment.payerAddress).toBe(walletAddress);
    expect(payment.merchantId).toBe(invoice.merchantId);
    expect(payment.txHash).toBe(txHash);
    expect(payment.ledger).toBe(rpcBody.result!.ledger);
    expect(payment.memo).toBe(invoiceNumber);
    expect(payment.contractPaymentId?.toString()).toBe(after.body.contractPaymentId);
    expect(payments.filter((entry: { txHash: string | null }) => entry.txHash === txHash)).toHaveLength(1);
    evidence.checks.paymentSettled = true;
    evidence.database = {
      checked: true,
      invoiceStatus: invoice.status,
      paymentStatus: payment.status,
      payerMatched: payment.payerAddress === walletAddress,
      ledgerMatched: payment.ledger === rpcBody.result!.ledger,
      paymentRowsForInvoice: payments.length,
    };
  }

  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  testInfo.annotations.push({ type: "evidence", description: evidenceFile });
  testInfo.annotations.push({ type: "tx", description: txHash });
});
