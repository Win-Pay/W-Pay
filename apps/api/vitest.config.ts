import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * NestJS resolves constructor dependencies from `design:paramtypes` metadata,
 * which only TypeScript emits when `emitDecoratorMetadata` is on. Vitest's
 * default esbuild transform does not emit it, so anything that boots the Nest
 * container (e.g. the Postgres integration suite) needs the SWC transform.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2021",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    // One process per file keeps Prisma and the Nest container from sharing
    // cross-test state.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
