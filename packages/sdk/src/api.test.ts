import { describe, expect, it, vi } from "vitest";
import { ApiError, WPayApi } from "./index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  const api = new WPayApi({
    baseUrl: "https://api.wpay.test/",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 1,
  });
  return { api, fetchImpl };
}

describe("WPayApi", () => {
  it("creates a payment with an idempotency key", async () => {
    const { api, fetchImpl } = client(() =>
      jsonResponse({
        payment: { id: "p_1", amount: "1000", status: "PENDING" },
        transaction: null,
      }),
    );

    const result = await api.payments.create(
      {
        merchantId: "m_1",
        token: "C".padEnd(56, "A"),
        amount: "1000",
      },
      "idem_123",
    );

    expect(result.payment.id).toBe("p_1");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.wpay.test/v1/payments");
    expect(init?.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["idempotency-key"]).toBe("idem_123");
  });

  it("sends bearer auth after login", async () => {
    const { api, fetchImpl } = client(() =>
      jsonResponse({
        accessToken: "jwt.token.here",
        expiresIn: 3600,
        user: { id: "u_1", email: "a@b.c", role: "USER", stellarAddress: null, displayName: null },
      }),
    );
    api.setToken("jwt.token.here");
    await api.payments.list({ limit: 5 });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer jwt.token.here");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("limit=5");
  });

  it("refreshes with cookies and a CSRF header instead of a token body", async () => {
    const { api, fetchImpl } = client(() =>
      jsonResponse({
        accessToken: "fresh.jwt",
        expiresIn: 3600,
        refreshExpiresIn: 86400,
        csrfToken: "new-csrf",
        user: { id: "u_1", email: "a@b.c", role: "USER", stellarAddress: null, displayName: null },
      }),
    );
    const session = await api.auth.refresh("csrf-token");
    expect(session.accessToken).toBe("fresh.jwt");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.wpay.test/v1/auth/refresh");
    expect(init?.credentials).toBe("include");
    expect(init?.body).toBeUndefined();
    expect((init!.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-token");
  });

  it("supports API key auth", async () => {
    const { api, fetchImpl } = client(() => jsonResponse({ items: [], nextCursor: null }));
    api.setApiKey("wpay_live_abc");
    await api.payments.list();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("wpay_live_abc");
  });

  it("maps API errors to ApiError", async () => {
    const { api } = client(() =>
      jsonResponse(
        { statusCode: 404, code: "NOT_FOUND", message: "payment not found" },
        404,
      ),
    );
    await expect(api.payments.get("missing")).rejects.toBeInstanceOf(ApiError);
    await expect(api.payments.get("missing")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("retries idempotent requests on 5xx", async () => {
    let calls = 0;
    const { api } = client(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ message: "boom" }, 503)
        : jsonResponse({ items: [], nextCursor: null });
    });
    const page = await api.payments.list();
    expect(page.items).toEqual([]);
    expect(calls).toBe(2);
  });

  it("does not retry POSTs on 5xx", async () => {
    let calls = 0;
    const { api } = client(() => {
      calls += 1;
      return jsonResponse({ message: "boom" }, 500);
    });
    await expect(
      api.payments.create({ merchantId: "m", token: "C".padEnd(56, "A"), amount: "1" }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });

  it("exposes health", async () => {
    const { api } = client(() =>
      jsonResponse({
        status: "ok",
        uptimeSeconds: 12,
        version: "0.1.0",
        database: "up",
        soroban: "not_configured",
        contracts: {},
      }),
    );
    const health = await api.health();
    expect(health.status).toBe("ok");
  });
});
