import { defineConfig } from "vite-plus";

// Vite+ config for the infra (CDK) package. Only the test runner is used here;
// the root config owns lint/format for the whole repo.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
