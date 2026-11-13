import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:4100";
const INVOICE_NUMBER = "INV-PLAYWRIGHT-1";
const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TX_HASH = "a".repeat(64);

const openInvoice = {
  id: "inv_playwright",
  number: INVOICE_NUMBER,
  merchantId: "mer_playwright",
  merchantName: "Playwright Merchant",
  merchantWebsite: null,
  merchantDescription: null,
  feeBps: 250,
  fee: "250000",
  net: "9750000",
  token: "native",
  amount: "10000000",
  memo: "playwright",
  status: "OPEN",
  dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  paidAt: null,
  paymentId: null,
  contractInvoiceId: null,
  contractPaymentId: null,
  txHash: null,
  customerEmail: null,
  createdAt: new Date().toISOString(),
};

async function mockApi(page: Page, submitStatus: "SUCCESS" | "FAILED" = "SUCCESS") {
  let submissions = 0;
  await page.route(`${API}/v1/invoices/public/${INVOICE_NUMBER}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(openInvoice) }),
  );
  await page.route(`${API}/v1/invoices/public/${INVOICE_NUMBER}/intent`, (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        xdr: "AAAAAgAAAABmYWtlLXRyYW5zYWN0aW9uLXhkcg==",
        networkPassphrase: "Test SDF Network ; September 2015",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        method: "create_payment",
        description: "Pay merchant through PaymentRouter",
      }),
    }),
  );
  await page.route(`${API}/v1/transactions/submit`, async (route) => {
    submissions += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ hash: TX_HASH, status: submitStatus, ledger: 123 }),
    });
  });
  await page.route(`${API}/v1/invoices/public/${INVOICE_NUMBER}/confirm`, (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ...openInvoice, status: "PAID", paidAt: new Date().toISOString(), txHash: TX_HASH }),
    }),
  );
  return { submissions: () => submissions };
}

test("reports a missing wallet instead of pretending to pay", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByLabel("Invoice number").fill(INVOICE_NUMBER);
  await page.getByRole("button", { name: "Find invoice" }).click();
  await expect(page.getByRole("button", { name: "Pay invoice" })).toBeVisible();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText(/No Stellar wallet detected/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay invoice" })).toBeDisabled();
});

test("shows merchant details and the fee split before paying", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByLabel("Invoice number").fill(INVOICE_NUMBER);
  await page.getByRole("button", { name: "Find invoice" }).click();
  await expect(page.getByText("Playwright Merchant")).toBeVisible();
  await expect(page.getByText(/Platform fee \(2\.50%\)/)).toBeVisible();
  await expect(page.getByText("Merchant receives")).toBeVisible();
  await expect(page.getByText("0.975")).toBeVisible();
});

test("connects, signs, submits once and shows the confirmed transaction", async ({ page }) => {
  const requests = await mockApi(page);
  await page.addInitScript(({ address }) => {
    (window as unknown as { freighter: unknown }).freighter = {
      getAddress: async () => ({ address }),
      signTransaction: async (xdr: string) => ({ signedTxXdr: `signed:${xdr}` }),
    };
  }, { address: WALLET });

  await page.goto("/");
  await page.getByLabel("Invoice number").fill(INVOICE_NUMBER);
  await page.getByRole("button", { name: "Find invoice" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText(new RegExp(WALLET.slice(0, 8)))).toBeVisible();

  const pay = page.getByRole("button", { name: "Pay invoice" });
  await expect(pay).toBeEnabled();
  await pay.click();
  await expect(page.getByText(`Payment confirmed on chain: ${TX_HASH}`)).toBeVisible();
  await expect(page.getByText("PAID", { exact: true })).toBeVisible();
  await expect(page.getByText("Payment receipt")).toBeVisible();
  await expect(page.getByRole("link", { name: /Stellar Expert/ })).toHaveAttribute(
    "href",
    `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`,
  );
  expect(requests.submissions()).toBe(1);
});

test("surfaces a failed network submission and does not mark the invoice paid", async ({ page }) => {
  const requests = await mockApi(page, "FAILED");
  await page.addInitScript(({ address }) => {
    (window as unknown as { freighter: unknown }).freighter = {
      getAddress: async () => ({ address }),
      signTransaction: async (xdr: string) => ({ signedTxXdr: `signed:${xdr}` }),
    };
  }, { address: WALLET });

  await page.goto("/");
  await page.getByLabel("Invoice number").fill(INVOICE_NUMBER);
  await page.getByRole("button", { name: "Find invoice" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Pay invoice" }).click();
  await expect(page.getByText(/transaction failed/i)).toBeVisible();
  await expect(page.getByText("PAID", { exact: true })).toHaveCount(0);
  expect(requests.submissions()).toBe(1);
});

test("serves a separate landing page without replacing checkout", async ({ page }) => {
  await page.goto("/landing");
  await expect(
    page.getByRole("heading", { name: /Accept wallet payments without giving up custody/i }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open checkout" })).toHaveAttribute("href", "/");
  await expect(page.getByText(/deployed on Stellar Testnet/i)).toBeVisible();
});
