import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": `${import.meta.dirname}/test/stubs/cloudflare-workers.ts` },
  },
  plugins: [
    // The Worker imports sample CSVs as text (wrangler "Text" rule); mirror that for tests.
    {
      name: "csv-as-text",
      transform(code, id) {
        if (id.endsWith(".csv")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
