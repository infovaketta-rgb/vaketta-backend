import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run the TypeScript sources under src/. Without this, `npm run build`
    // emits compiled `dist/**/*.test.js` (CommonJS) that vitest (ESM) cannot load
    // — "Vitest cannot be imported in a CommonJS module using require()". Excluding
    // dist keeps build-then-test reproducible.
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["node_modules", "dist"],
  },
});
