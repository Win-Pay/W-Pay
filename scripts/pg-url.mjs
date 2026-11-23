#!/usr/bin/env node
/**
 * Print a libpq-safe DATABASE_URL. Reads the value from the environment so the
 * credential never appears in this process's argv. Errors are intentionally
 * generic and never echo the URL.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/pg-url.mjs
 *   DATABASE_URL=... node scripts/pg-url.mjs --database postgres
 */
import { sanitizePostgresUrl } from "./lib/postgres-url.mjs";

let database;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--database") {
    database = args[index + 1];
    index += 1;
  } else {
    console.error("usage: node scripts/pg-url.mjs [--database NAME]");
    process.exit(2);
  }
}

try {
  process.stdout.write(
    sanitizePostgresUrl(process.env.DATABASE_URL, { database }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "invalid URL";
  console.error(`postgres-url: ${message}`);
  process.exit(1);
}
