import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:4100";
const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const SESSION = {
  accessToken: "playwright-admin-token",
  expiresIn: 900,
  refreshExpiresIn: 604_800,
  csrfToken: "playwright-csrf",
  user: {
    id: "usr_admin",
    email: "operator@wpay.test",
    role: "OPERATOR",
    stellarAddress: WALLET,
    displayName: null,
  },
};
const MERCHANT = {
  id: "mer_admin",
  name: "Indexed Store",
  ownerAddress: WALLET,
  settlementAddress: WALLET,
  status: "ACTIVE",
  feeBps: 250,
  registryId: "7",
  createdAt: new Date().toISOString(),
};
const HEALTH = {
  status: "ok",
  uptimeSeconds: 120,
  version: "0.1.0",
  database: "up",
  soroban: "up",
  redis: "up",
  indexer: { status: "up", lagSeconds: 4, checkpoints: 1, unresolvedFailures: 2 },
  contracts: { paymentRouter: true, refundManager: true },
};
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

async function mockAdmin(page: Page, role: "OPERATOR" | "USER" = "OPERATOR"): Promise<void> {
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/auth/refresh") return json(401, { code: "UNAUTHENTICATED" });
    if (path === "/v1/auth/login") {
      return json(201, { ...SESSION, user: { ...SESSION.user, role } });
    }
    if (path === "/v1/health") return json(200, HEALTH);
    if (path === "/v1/admin/merchants") return json(200, { items: [MERCHANT], nextCursor: null });
    if (path === "/v1/admin/indexer/status") {
      return json(200, {
        unresolvedFailures: 2,
        checkpoints: [{ contractId: CONTRACT, lastLedger: 5698164, updatedAt: new Date().toISOString() }],
        recent: [],
      });
    }
    if (path === "/v1/admin/indexer/failures") {
      return json(200, {
        items: [
          {
            id: "fail_1",
            contractId: CONTRACT,
            txHash: "b".repeat(64),
            ledger: 5698165,
            kind: "payment",
            reason: "projection could not match a unique local record",
            attempts: 1,
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }
    return json(404, { code: "NOT_FOUND" });
  });
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill("operator@wpay.test");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("signs in, shows health and exposes indexer failures to the operator", async ({ page }) => {
  await mockAdmin(page);
  await signIn(page);
  await expect(page.getByText("Platform administration")).toBeVisible();
  await expect(page.getByText("Indexed Store")).toBeVisible();
  await expect(page.getByText("ok", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Indexer", exact: true }).click();
  await expect(page.getByText("Unresolved failures")).toBeVisible();
  await expect(page.getByText("5698164")).toBeVisible();
  await expect(page.getByText(/could not match a unique local record/)).toBeVisible();
});

test("refuses a wallet account without operator role", async ({ page }) => {
  await mockAdmin(page, "USER");
  await signIn(page);
  await expect(page.getByText(/does not have operator access/i)).toBeVisible();
  await expect(page.getByText("Platform administration")).toHaveCount(0);
});
