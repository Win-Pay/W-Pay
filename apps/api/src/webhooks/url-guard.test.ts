import { describe, expect, it } from "vitest";
import { assertSafeWebhookUrl, isForbiddenAddress, type HostResolver } from "./url-guard";

function resolverReturning(...addresses: string[]): HostResolver {
  return async () => addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
}

const publicResolver = resolverReturning("93.184.216.34");

describe("webhook url guard", () => {
  it("accepts a normal public https endpoint", async () => {
    await expect(
      assertSafeWebhookUrl("https://hooks.example.com/wpay", {
        requireHttps: true,
        resolver: publicResolver,
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects malformed and non-http schemes", async () => {
    await expect(assertSafeWebhookUrl("not a url", { resolver: publicResolver })).rejects.toThrow(
      /valid absolute url/,
    );
    await expect(
      assertSafeWebhookUrl("ftp://example.com/hook", { resolver: publicResolver }),
    ).rejects.toThrow(/http or https/);
    await expect(
      assertSafeWebhookUrl("file:///etc/passwd", { resolver: publicResolver }),
    ).rejects.toThrow(/http or https/);
  });

  it("requires https when production mode is on", async () => {
    await expect(
      assertSafeWebhookUrl("http://hooks.example.com/wpay", {
        requireHttps: true,
        resolver: publicResolver,
      }),
    ).rejects.toThrow(/https in production/);
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertSafeWebhookUrl("https://user:pass@hooks.example.com/wpay", {
        resolver: publicResolver,
      }),
    ).rejects.toThrow(/credentials/);
  });

  it("rejects loopback and internal hostnames without resolving them", async () => {
    const failing: HostResolver = async () => {
      throw new Error("should not resolve");
    };
    for (const url of [
      "http://localhost:3000/hook",
      "http://api.localhost/hook",
      "http://printer.local/hook",
      "http://metadata.home.arpa/hook",
    ]) {
      await expect(assertSafeWebhookUrl(url, { resolver: failing })).rejects.toThrow(/not allowed/);
    }
  });

  it("rejects private and reserved address literals", async () => {
    for (const url of [
      "http://127.0.0.1/hook",
      "http://127.1.2.3/hook",
      "http://0.0.0.0/hook",
      "http://10.1.2.3/hook",
      "http://172.16.0.1/hook",
      "http://192.168.1.1/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/hook",
      "http://224.0.0.1/hook",
      "http://[::1]/hook",
      "http://[fc00::1]/hook",
      "http://[fe80::1]/hook",
      "http://[::ffff:127.0.0.1]/hook",
      "http://[::ffff:10.0.0.1]/hook",
    ]) {
      await expect(
        assertSafeWebhookUrl(url, { resolver: publicResolver }),
      ).rejects.toThrow(/not allowed/);
    }
  });

  it("accepts public address literals", async () => {
    await expect(
      assertSafeWebhookUrl("https://8.8.8.8/hook", { resolver: publicResolver }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects a hostname when any resolved address is private", async () => {
    await expect(
      assertSafeWebhookUrl("https://hooks.example.com/wpay", {
        resolver: resolverReturning("93.184.216.34", "10.0.0.7"),
      }),
    ).rejects.toThrow(/private or reserved/);
  });

  it("rejects unresolvable hosts and hosts with no records", async () => {
    await expect(
      assertSafeWebhookUrl("https://missing.example.com/wpay", {
        resolver: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/could not be resolved/);
    await expect(
      assertSafeWebhookUrl("https://empty.example.com/wpay", {
        resolver: resolverReturning(),
      }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it("classifies addresses consistently", () => {
    expect(isForbiddenAddress("127.0.0.1")).toBe(true);
    expect(isForbiddenAddress("10.0.0.1")).toBe(true);
    expect(isForbiddenAddress("192.168.0.1")).toBe(true);
    expect(isForbiddenAddress("::1")).toBe(true);
    expect(isForbiddenAddress("fd00::1")).toBe(true);
    expect(isForbiddenAddress("8.8.8.8")).toBe(false);
    expect(isForbiddenAddress("2606:4700:4700::1111")).toBe(false);
    expect(isForbiddenAddress("not-an-ip")).toBe(true);
  });
});
