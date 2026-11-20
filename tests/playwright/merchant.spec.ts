import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:4100";
const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const MERCHANT_ID = "mer_playwright";
const SESSION = {
  accessToken: "playwright-access-token",
  expiresIn: 900,
  refreshExpiresIn: 604_800,
  csrfToken: "playwright-csrf",
  user: {
    id: "usr_merchant",
    email: "merchant@wpay.test",
    role: "MERCHANT",
    stellarAddress: WALLET,
    displayName: null,
  },
};
const MERCHANT = {
  id: MERCHANT_ID,
  registryId: "12",
  name: "Playwright Store",
  ownerAddress: WALLET,
  settlementAddress: WALLET,
  feeBps: 250,
  status: "ACTIVE",
  website: null,
  description: null,
  createdAt: new Date().toISOString(),
};
const PAYMENT = {
  id: "pay_playwright",
  merchantId: MERCHANT_ID,
  payerAddress: WALLET,
  token: "native",
  amount: "25000000",
  fee: "625000",
  net: "24375000",
  refunded: "0",
  status: "SETTLED",
  memo: "playwright",
  txHash: "a".repeat(64),
  contractPaymentId: "1",
  createdAt: new Date().toISOString(),
  settledAt: new Date().toISOString(),
};

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill("merchant@wpay.test");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Merchant operations")).toBeVisible();
}

test("signs in and shows only API-backed merchant data", async ({ page }) => {
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/auth/refresh") return json(401, { code: "UNAUTHENTICATED" });
    if (path === "/v1/auth/login") return json(201, SESSION);
    if (path === "/v1/auth/me") return json(200, SESSION.user);
    if (path === "/v1/merchants") return json(200, { items: [MERCHANT], nextCursor: null });
    if (path === "/v1/analytics/overview") {
      return json(200, {
        merchantId: MERCHANT_ID,
        grossVolume: "25000000",
        feesPaid: "625000",
        refundedVolume: "0",
        paymentCount: 1,
        settledCount: 1,
        refundCount: 0,
        pendingRefunds: 0,
        averagePayment: "25000000",
        daily: [],
      });
    }
    if (path === "/v1/payments") return json(200, { items: [PAYMENT], nextCursor: null });
    return json(404, { code: "NOT_FOUND" });
  });

  await signIn(page);
  await expect(page.getByText("ACTIVE", { exact: true })).toBeVisible();
  await expect(page.getByText("250 bps fee")).toBeVisible();
  await expect(page.getByText("registry #12")).toBeVisible();
  await expect(page.getByText("Gross volume (30d)")).toBeVisible();
  await expect(page.getByText("2.5", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Payments", exact: true }).click();
  await expect(page.getByText("0.0625", { exact: true })).toBeVisible();
  await expect(page.getByText("SETTLED", { exact: true })).toBeVisible();
});

test("explains a rejected sign-in instead of rendering an empty dashboard", async ({ page }) => {
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/auth/refresh") return json(401, { code: "UNAUTHENTICATED" });
    if (path === "/v1/auth/login") return json(401, { message: "invalid credentials" });
    return json(404, { code: "NOT_FOUND" });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("merchant@wpay.test");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page.getByText("Merchant operations")).toHaveCount(0);
});
