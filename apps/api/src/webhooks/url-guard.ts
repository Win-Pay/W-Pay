import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolver: HostResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Opt-out used only by local integration tests that target a loopback server. */
export function allowPrivateWebhookTargets(): boolean {
  const value = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  return value === "1" || value === "true";
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets;
}

/** Loopback, private, link-local, multicast and reserved IPv4 space. */
function isForbiddenIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function expandIpv6(raw: string): number[] | null {
  let address = raw.toLowerCase();
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4 = parseIpv4(address.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    address = `${address.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
  if (parsed.some((value) => Number.isNaN(value))) return null;
  return parsed;
}

function isForbiddenIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  // Anything net considers IPv6 but we cannot parse is refused conservatively.
  if (!groups) return true;
  const zeroPrefix = (count: number) => groups.slice(0, count).every((value) => value === 0);
  if (zeroPrefix(8)) return true;
  if (zeroPrefix(7) && groups[7] === 1) return true;
  if ((groups[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  const embedded = (offset: number) => {
    const hi = groups[offset]!;
    const lo = groups[offset + 1]!;
    return isForbiddenIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  };
  if (zeroPrefix(5) && groups[5] === 0xffff) return embedded(6); // ::ffff:0:0/96
  if (zeroPrefix(6)) return embedded(6); // ::/96 IPv4-compatible
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return embedded(6); // 64:ff9b::/96 NAT64
  return false;
}

/** Address literals and names that must never be dialed by the delivery worker. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    return octets === null || isForbiddenIpv4(octets);
  }
  if (family === 6) return isForbiddenIpv6(address);
  return true;
}

function isForbiddenHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  );
}

/**
 * Validates a webhook destination before registration and again before every
 * delivery attempt. Rejects credential-bearing URLs, non-http(s) schemes and
 * any host that is (or resolves to) loopback/private/link-local/reserved space.
 */
export async function assertSafeWebhookUrl(
  raw: string,
  options: { requireHttps?: boolean; resolver?: HostResolver } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException("webhook url must be a valid absolute url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BadRequestException("webhook url must use http or https");
  }
  if (options.requireHttps && url.protocol !== "https:") {
    throw new BadRequestException("webhook endpoints must use https in production");
  }
  if (url.username || url.password) {
    throw new BadRequestException("webhook url must not contain credentials");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) throw new BadRequestException("webhook url must include a host");
  if (isForbiddenHostname(hostname)) {
    throw new BadRequestException("webhook url host is not allowed");
  }

  if (isIP(hostname)) {
    if (isForbiddenAddress(hostname)) {
      throw new BadRequestException("webhook url host is not allowed");
    }
    return url;
  }

  let resolved: ResolvedAddress[];
  try {
    resolved = await (options.resolver ?? defaultResolver)(hostname);
  } catch {
    throw new BadRequestException("webhook url host could not be resolved");
  }
  if (resolved.length === 0) {
    throw new BadRequestException("webhook url host could not be resolved");
  }
  if (resolved.some((entry) => isForbiddenAddress(entry.address))) {
    throw new BadRequestException("webhook url resolves to a private or reserved address");
  }
  return url;
}
