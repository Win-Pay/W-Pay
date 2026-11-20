/**
 * Builds the workspace packages the three browser apps import, exactly once
 * even though Playwright starts their dev servers concurrently.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const lock = path.join(root, "node_modules/.cache/wpay-playwright-build.lock");
fs.mkdirSync(path.dirname(lock), { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + 5 * 60_000;

while (true) {
  try {
    fs.mkdirSync(lock);
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > 10 * 60_000) {
      fs.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the build lock");
    await sleep(500);
  }
}

try {
  const build = spawnSync(
    "pnpm",
    [
      "exec",
      "turbo",
      "build",
      "--filter=@wpay/web^...",
      "--filter=@wpay/merchant-dashboard^...",
      "--filter=@wpay/admin-dashboard^...",
    ],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
} finally {
  fs.rmSync(lock, { recursive: true, force: true });
}
