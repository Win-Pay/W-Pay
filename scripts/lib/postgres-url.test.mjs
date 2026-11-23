import assert from "node:assert/strict";
import test from "node:test";
import {
  LIBPQ_QUERY_PARAMETERS,
  sanitizePostgresUrl,
} from "./postgres-url.mjs";

const BASE = "postgresql://wpay:secret@db.example.com:5432/wpay";

test("removes Prisma schema and keeps sslmode", () => {
  const result = sanitizePostgresUrl(`${BASE}?schema=public&sslmode=require`);
  assert.equal(
    result,
    "postgresql://wpay:secret@db.example.com:5432/wpay?sslmode=require",
  );
  assert.equal(new URL(result).searchParams.has("schema"), false);
});

test("drops every Prisma/pooler parameter but preserves libpq ones", () => {
  const input =
    `${BASE}?schema=public&connection_limit=5&pool_timeout=10` +
    "&pgbouncer=true&statement_cache_size=0&sslaccept=strict" +
    "&sslmode=verify-full&channel_binding=require&connect_timeout=15" +
    "&application_name=wpay-backup&options=-csearch_path%3Dpublic";
  const result = sanitizePostgresUrl(input);
  const params = new URL(result).searchParams;

  for (const removed of [
    "schema",
    "connection_limit",
    "pool_timeout",
    "pgbouncer",
    "statement_cache_size",
    "sslaccept",
  ]) {
    assert.equal(params.has(removed), false, `${removed} should be removed`);
  }
  assert.equal(params.get("sslmode"), "verify-full");
  assert.equal(params.get("channel_binding"), "require");
  assert.equal(params.get("connect_timeout"), "15");
  assert.equal(params.get("application_name"), "wpay-backup");
  assert.equal(params.get("options"), "-csearch_path=public");
});

test("preserves URL-encoded credentials and special characters", () => {
  const input =
    "postgresql://wpay%40ops:p%40ss%2Fword%23%3F@db.example.com/wpay?schema=public";
  const result = sanitizePostgresUrl(input);
  const url = new URL(result);

  assert.equal(url.username, "wpay%40ops");
  assert.equal(url.password, "p%40ss%2Fword%23%3F");
  assert.equal(decodeURIComponent(url.username), "wpay@ops");
  assert.equal(decodeURIComponent(url.password), "p@ss/word#?");
  assert.equal(url.search, "");
  // The sanitized value still carries the decoded-equivalent credential.
  assert.match(result, /p%40ss%2Fword%23%3F/);
});

test("supports Neon-style URLs with TLS parameters and no schema", () => {
  const input =
    "postgresql://neondb_owner:npg_secret@ep-cool-123.us-east-2.aws.neon.tech/neondb" +
    "?sslmode=require&channel_binding=require";
  const result = sanitizePostgresUrl(input);
  const url = new URL(result);

  assert.equal(url.hostname, "ep-cool-123.us-east-2.aws.neon.tech");
  assert.equal(url.pathname, "/neondb");
  assert.equal(url.searchParams.get("sslmode"), "require");
  assert.equal(url.searchParams.get("channel_binding"), "require");
});

test("keeps IP hosts, non-default ports and TLS files", () => {
  const input =
    "postgres://wpay:wpay@127.0.0.1:5433/wpay?schema=public" +
    "&sslmode=verify-ca&sslrootcert=%2Fetc%2Fssl%2Fca.pem&sslcert=%2Fetc%2Fssl%2Fclient.pem" +
    "&sslkey=%2Fetc%2Fssl%2Fclient.key";
  const result = sanitizePostgresUrl(input);
  const url = new URL(result);

  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "5433");
  assert.equal(url.searchParams.get("sslmode"), "verify-ca");
  assert.equal(url.searchParams.get("sslrootcert"), "/etc/ssl/ca.pem");
  assert.equal(url.searchParams.get("sslcert"), "/etc/ssl/client.pem");
  assert.equal(url.searchParams.get("sslkey"), "/etc/ssl/client.key");
});

test("can point at a scratch database for restore drills", () => {
  const result = sanitizePostgresUrl(`${BASE}?schema=public`, {
    database: "wpay_restore_drill_123",
  });
  assert.equal(
    result,
    "postgresql://wpay:secret@db.example.com:5432/wpay_restore_drill_123",
  );
});

test("rejects unsafe scratch database names", () => {
  for (const database of [
    "wpay; DROP DATABASE wpay",
    "wpay-verify",
    "../postgres",
    "",
    "a".repeat(64),
  ]) {
    assert.throws(
      () => sanitizePostgresUrl(BASE, { database }),
      /safe PostgreSQL identifier/,
    );
  }
});

test("rejects missing, malformed and non-PostgreSQL URLs without echoing them", () => {
  for (const input of [
    undefined,
    "",
    "not a url",
    "mysql://wpay:secret@localhost/wpay",
    "postgresql:///wpay",
  ]) {
    assert.throws(
      () => sanitizePostgresUrl(input),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("secret"), false);
        return true;
      },
    );
  }
});

test("has no writable allowlist entries for Prisma-only parameters", () => {
  for (const parameter of [
    "schema",
    "connection_limit",
    "pool_timeout",
    "pgbouncer",
    "statement_cache_size",
    "socket_timeout",
    "sslaccept",
  ]) {
    assert.equal(LIBPQ_QUERY_PARAMETERS.has(parameter), false);
  }
});
