import { defineConfig } from "vitest/config";

// The Worker imports sample CSVs as text (wrangler "Text" rule); mirror that for tests.
export default defineConfig({
  plugins: [
    {
      name: "csv-as-text",
      transform(code, id) {
        if (id.endsWith(".csv")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
