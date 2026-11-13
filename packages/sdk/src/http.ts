import type { ApiErrorBody, Page } from "@wpay/types";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.statusCode = body.statusCode;
    this.code = body.code;
    this.details = body.details;
  }
}

export type FetchLike = typeof fetch;

export interface ApiClientOptions {
  baseUrl: string;
  token?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  /** Send the httpOnly refresh/CSRF cookies; defaults to `include`. */
  credentials?: RequestCredentials;
  /** Retries only idempotent requests (GET/HEAD) and 5xx/network failures. */
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Called once when a request with a bearer token returns 401. Returning a
   * fresh access token retries the request; returning null surfaces the error.
   */
  onUnauthorized?: () => Promise<string | null>;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Authentication attempts must not trigger the refresh-token handler. */
  skipAuthRefresh?: boolean;
}

export class HttpClient {
  private token?: string;
  private apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly credentials: RequestCredentials;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private onUnauthorized?: () => Promise<string | null>;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.credentials = options.credentials ?? "include";
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.onUnauthorized = options.onUnauthorized;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  setUnauthorizedHandler(handler: (() => Promise<string | null>) | undefined): void {
    this.onUnauthorized = handler;
  }

  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const idempotent = method === "GET" || method === "HEAD";
    let attempt = 0;
    let authRetried = false;

    for (;;) {
      attempt += 1;
      try {
        const response = await this.once(url, method, body, options);
        if (response.status >= 500 && idempotent && attempt <= this.maxRetries) {
          continue;
        }
        if (
          response.status === 401 &&
          !authRetried &&
          !options.skipAuthRefresh &&
          this.token &&
          this.onUnauthorized
        ) {
          authRetried = true;
          const refreshed = await this.onUnauthorized();
          if (refreshed) {
            this.token = refreshed;
            continue;
          }
        }
        return (await this.parse<T>(response));
      } catch (error) {
        const retryable =
          (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) &&
          idempotent &&
          attempt <= this.maxRetries;
        if (!retryable) throw error;
      }
    }
  }

  async requestPage<T>(
    path: string,
    query: Query = {},
    options: RequestOptions = {},
  ): Promise<Page<T>> {
    return this.request<Page<T>>("GET", path, undefined, { ...options, query });
  }

  private async once(
    url: string,
    method: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...options.headers,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        credentials: this.credentials,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;
    if (!response.ok) {
      const body = payload as Partial<ApiErrorBody> | undefined;
      throw new ApiError({
        statusCode: response.status,
        code: body?.code ?? `HTTP_${response.status}`,
        message: body?.message ?? `request failed with status ${response.status}`,
        details: body?.details,
      });
    }
    return payload as T;
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}
