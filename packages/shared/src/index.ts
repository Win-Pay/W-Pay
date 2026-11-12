/**
 * Small isomorphic utilities shared by the API, SDK and web apps.
 * No Node-only imports: everything here runs in a browser as well.
 */

export type Result<T, E = WPayError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export type WPayErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "VALIDATION_FAILED"
  | "UPSTREAM_ERROR"
  | "NOT_CONFIGURED"
  | "INTERNAL";

export class WPayError extends Error {
  readonly code: WPayErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: WPayErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = "WPayError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  static unauthorized(message = "authentication required"): WPayError {
    return new WPayError("UNAUTHORIZED", message, 401);
  }

  static forbidden(message = "not allowed"): WPayError {
    return new WPayError("FORBIDDEN", message, 403);
  }

  static notFound(message = "not found"): WPayError {
    return new WPayError("NOT_FOUND", message, 404);
  }

  static conflict(message: string): WPayError {
    return new WPayError("CONFLICT", message, 409);
  }

  static notConfigured(message: string): WPayError {
    return new WPayError("NOT_CONFIGURED", message, 503);
  }

  toJSON(): { code: WPayErrorCode; message: string; details?: unknown } {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

/** True when `value` is a positive integer amount of stroops. */
export function isPositiveAmount(value: string): boolean {
  return /^\d{1,39}$/.test(value) && BigInt(value) > 0n;
}

export function normalizeAmount(value: string): string {
  if (!/^\d{1,39}$/.test(value)) throw new WPayError("VALIDATION_FAILED", "invalid amount");
  return BigInt(value).toString();
}

export function shortAddress(address: string, keep = 5): string {
  if (address.length <= keep * 2 + 1) return address;
  return `${address.slice(0, keep)}…${address.slice(-keep)}`;
}

/** Base64url cursor helpers for keyset pagination. */
export function encodeCursor(id: string): string {
  return base64UrlEncode(id);
}

export function decodeCursor(cursor: string): string {
  const decoded = base64UrlDecode(cursor);
  if (!decoded) throw new WPayError("VALIDATION_FAILED", "invalid cursor");
  return decoded;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Random, URL-safe token used for nonces and API keys. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newIdempotencyKey(): string {
  return `idem_${randomToken(16)}`;
}

/** Wallet-auth message. The wallet signs the UTF-8 bytes of this string. */
export function buildWalletAuthMessage(params: {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Stellar account`,
    params.address,
    "",
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join("\n");
}

const WEBHOOK_TOLERANCE_SECS = 300;

export interface WebhookHeaders {
  "x-wpay-signature": string;
  "x-wpay-timestamp": string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Signs a webhook body. The signature covers `${timestamp}.${body}` so a
 * captured request cannot be replayed outside the tolerance window.
 */
export async function signWebhook(
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<WebhookHeaders> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return {
    "x-wpay-signature": `sha256=${toHex(mac)}`,
    "x-wpay-timestamp": String(timestamp),
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhook(params: {
  body: string;
  secret: string;
  signature: string;
  timestamp: string;
  toleranceSecs?: number;
  now?: number;
}): Promise<boolean> {
  const tolerance = params.toleranceSecs ?? WEBHOOK_TOLERANCE_SECS;
  const timestamp = Number(params.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) return false;
  const expected = await signWebhook(params.body, params.secret, timestamp);
  return timingSafeEqual(expected["x-wpay-signature"], params.signature);
}

/** Retry with exponential backoff and jitter. `attempt` is 1-based. */
export function backoffDelayMs(attempt: number, baseMs = 500, maxMs = 60_000): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), maxMs);
  const jitter = Math.floor(Math.random() * Math.max(exponential * 0.2, 1));
  return exponential + jitter;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}
