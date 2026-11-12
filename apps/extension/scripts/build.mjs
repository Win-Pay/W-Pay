import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const file of ["manifest.json", "popup.html"]) {
  cpSync(join(root, file), join(dist, file));
}
cpSync(join(root, "src"), dist, { recursive: true });

console.log(`extension built -> ${dist}`);
