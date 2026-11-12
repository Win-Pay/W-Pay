/**
 * k6 load test for the W-Pay API.
 *
 * Run with:
 *   k6 run -e BASE_URL=http://127.0.0.1:4000 \
 *     -e EMAIL=load@wpay.test -e PASSWORD=... -e INVOICE=INV-... \
 *     loadtest/wpay.k6.js
 *
 * `loadtest/seed.cjs` prints the matching EMAIL/PASSWORD/INVOICE values.
 * Thresholds fail the CI job when latency or error budgets regress.
 *
 * Read traffic and login traffic run as separate scenarios: bcrypt is CPU-bound,
 * so mixing many logins into the read load would measure the runner's cores
 * rather than the API's read path.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const baseUrl = (__ENV.BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const email = __ENV.EMAIL;
const password = __ENV.PASSWORD;
const invoice = __ENV.INVOICE;

if (!email || !password || !invoice) {
  throw new Error("EMAIL, PASSWORD and INVOICE must be provided via -e");
}

const loginFailures = new Rate("login_failures");

export const options = {
  scenarios: {
    reads: {
      executor: "ramping-vus",
      exec: "reads",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "20s", target: 10 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
    logins: {
      executor: "constant-arrival-rate",
      exec: "logins",
      rate: 1,
      timeUnit: "1s",
      duration: "35s",
      preAllocatedVUs: 4,
      maxVUs: 8,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:health}": ["p(95)<500"],
    "http_req_duration{name:invoice_lookup}": ["p(95)<600"],
    "http_req_duration{name:login}": ["p(95)<2500"],
    checks: ["rate>0.99"],
    login_failures: ["rate<0.01"],
  },
};

export function reads() {
  const health = http.get(`${baseUrl}/v1/health`, { tags: { name: "health" } });
  check(health, { "health is 200": (r) => r.status === 200 });

  const lookup = http.get(`${baseUrl}/v1/invoices/public/${invoice}`, {
    tags: { name: "invoice_lookup" },
  });
  check(lookup, {
    "invoice lookup is 200": (r) => r.status === 200,
    "invoice number matches": (r) => r.json("number") === invoice,
  });

  sleep(0.2);
}

export function logins() {
  const login = http.post(
    `${baseUrl}/v1/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { "content-type": "application/json" }, tags: { name: "login" } },
  );
  const ok = check(login, {
    "login is 201 or 200": (r) => r.status === 200 || r.status === 201,
    "login returns a token": (r) => typeof r.json("accessToken") === "string",
  });
  loginFailures.add(!ok);
  sleep(0.1);
}
