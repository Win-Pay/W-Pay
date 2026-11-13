// Bundles the Nest API for Vercel's Node runtime as CommonJS. Vercel's
// launcher cannot require() ESM-only packages (e.g. @noble/hashes, pulled in
// by @stellar/stellar-sdk's CJS build), so dependencies are bundled and
// converted at build time. SWC emits the decorator metadata Nest's DI needs.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as swc from "@swc/core";

const root = path.resolve(import.meta.dirname, "..");

function swcDecorators() {
  return {
    name: "swc-decorators",
    setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const { code } = await swc.transform(source, {
          filename: args.path,
          jsc: {
            parser: { syntax: "typescript", decorators: true, dynamicImport: true },
            transform: { legacyDecorator: true, decoratorMetadata: true },
            target: "es2022",
            keepClassNames: true,
            externalHelpers: false,
          },
          module: { type: "es6" },
        });
        return { contents: code, loader: "js" };
      });
    },
  };
}

await build({
  absWorkingDir: root,
  entryPoints: ["apps/api/api/index.ts"],
  outfile: "api/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  logLevel: "warning",
  // The Prisma client and its query engine binary must stay on disk so
  // Vercel's file tracing ships the generated client and native engine.
  // Nest's optional peer integrations are lazy requires guarded by try/catch.
  external: [
    "@prisma/client",
    ".prisma/client",
    "@prisma/engines",
    "class-validator",
    "class-transformer",
    "class-transformer/*",
    "@nestjs/websockets",
    "@nestjs/websockets/*",
    "@nestjs/microservices",
    "@nestjs/microservices/*",
    "@nestjs/platform-socket.io",
  ],
  plugins: [swcDecorators()],
});

console.log(`[serverless] bundled ${path.relative(root, path.join(root, "api/index.js"))}`);
