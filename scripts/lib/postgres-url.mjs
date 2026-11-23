/**
 * PostgreSQL connection-URL normalizer.
 *
 * Prisma accepts query parameters that libpq (and therefore pg_dump, pg_restore
 * and psql) rejects, most notably `schema=public`. Feeding a Prisma URL directly
 * to those tools fails with:
 *
 *   pg_dump: error: invalid URI query parameter: "schema"
 *
 * This module keeps only parameters understood by libpq. It preserves TLS and
 * connection settings (sslmode, channel_binding, connect_timeout, ...), keeps
 * percent-encoded credentials intact by round-tripping through WHATWG URL, and
 * drops Prisma/pooler-only parameters. It never includes the input in errors, so
 * a malformed value cannot leak a password into logs.
 */

// libpq connection parameters accepted in a postgres URI query string that are
// safe to carry through to command-line utilities. Authority/path fields
// (user, password, host, port, dbname) are deliberately not accepted as query
// parameters: the normalizer derives them from the URL itself.
const LIBPQ_QUERY_PARAMETERS = new Set([
  "application_name",
  "channel_binding",
  "client_encoding",
  "connect_timeout",
  "fallback_application_name",
  "gssencmode",
  "gsslib",
  "hostaddr",
  "keepalives",
  "keepalives_count",
  "keepalives_idle",
  "keepalives_interval",
  "krbsrvname",
  "load_balance_hosts",
  "options",
  "passfile",
  "replication",
  "requirepeer",
  "service",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
  "sslcert",
  "sslcompression",
  "sslcrl",
  "sslkey",
  "sslmode",
  "sslpassword",
  "sslrootcert",
  "target_session_attrs",
  "tcp_user_timeout",
]);

const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * @param {string | undefined} raw
 * @param {{ database?: string }} [options]
 * @returns {string} sanitized URL
 */
export function sanitizePostgresUrl(raw, options = {}) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("DATABASE_URL is not set");
  }

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  if (!url.hostname) {
    throw new Error("DATABASE_URL must include a host");
  }
  if (!url.username) {
    throw new Error("DATABASE_URL must include a user");
  }

  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (LIBPQ_QUERY_PARAMETERS.has(key)) params.append(key, value);
  }
  url.search = params.toString();
  url.hash = "";

  if (options.database !== undefined) {
    if (!DATABASE_NAME.test(options.database)) {
      throw new Error("database name is not a safe PostgreSQL identifier");
    }
    url.pathname = `/${options.database}`;
  }

  return url.toString();
}

export { LIBPQ_QUERY_PARAMETERS };
