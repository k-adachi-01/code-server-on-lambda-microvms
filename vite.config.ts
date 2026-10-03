import { defineConfig } from "vite-plus";

// Single source of toolchain config for Vite+ (`vp`): test (Vitest), lint
// (Oxlint), fmt (Oxfmt), pack (tsdown), and staged (pre-commit) blocks.
//
// Vite+ is used ONLY as the JS/TS task runner. Node.js, pnpm, the AWS CDK CLI,
// and gitleaks come from the Nix flake devShell; Vite+ runtime/package-manager
// management (`vp env`/`vp install`/`vp add`/`setup-vp`) is not used.

// Banned imports in the pure Lifecycle_Core (src/core/**). This is the Oxlint
// half of the two-part boundary guard; test/hygiene/core-imports.test.ts is the
// authoritative, tool-independent guard (see tech.md and R16.4).
//
// Oxlint's eslint/no-restricted-imports expresses the whole boundary:
//   - `paths`    for the exact node: builtin specifiers
//   - `patterns` (group globs) for the @aws-sdk/* namespace
// and `lint.overrides[].files` scopes the rule to src/core/**.
const CORE_BANNED_PATHS = [
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:http",
  "node:https",
  "node:process",
  "node:child_process",
];

export default defineConfig({
  test: {
    // Vitest via Vite+. The suite runs with no AWS credentials and no network.
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Property tests ([PBT]) and the import-boundary scan can be slower than a
    // unit test; give them room without hiding real hangs.
    testTimeout: 30_000,
  },

  lint: {
    plugins: ["typescript", "vitest"],
    // image/hooks is a separate workspace package with its own build (vp pack)
    // and its own tsconfig; the root lint toolchain does not type-check it.
    ignorePatterns: ["dist/**", "cdk.out/**", "image/**", "infra/**"],
    options: {
      // Full type-aware linting, as recommended by the Vite+ lint guide.
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "no-console": "off",
    },
    overrides: [
      {
        // Core import boundary (R16.2, R16.4). Pure core may not reach for the
        // AWS SDK or Node fs/net/http(s)/process/child_process APIs.
        files: ["src/core/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: CORE_BANNED_PATHS.map((name) => ({
                name,
                message:
                  "src/core/** is the pure Lifecycle_Core: no Node fs/net/http(s)/process/child_process. Inject effects through Ctx and run them in the shell.",
              })),
              patterns: [
                {
                  group: ["@aws-sdk", "@aws-sdk/*"],
                  message:
                    "src/core/** must not import the AWS SDK. Keep AWS calls in src/shell/aws-adapter.ts behind MicrovmsPort.",
                },
                {
                  // Catch bare node builtins too (e.g. `import fs from "fs"`),
                  // not just the node:-prefixed form.
                  group: ["fs", "fs/*", "net", "http", "https", "child_process"],
                  message:
                    "src/core/** must not import Node runtime APIs. Inject effects through Ctx and run them in the shell.",
                },
              ],
            },
          ],
        },
      },
      {
        // Tests may use `any` freely and import whatever they need.
        files: ["test/**"],
        rules: {
          "typescript/no-explicit-any": "off",
          "no-restricted-imports": "off",
          // Property-test titles are built by propertyTitle() so the suite maps
          // 1:1 onto the numbered design properties (R16.5); the title is a
          // deterministic string expression, not a literal. Property tests also
          // assert inside fast-check predicates (guarded by the generated
          // input), which the vitest plugin flags as "conditional expect".
          // Both are intentional for this project's PBT convention.
          "vitest/valid-title": "off",
          "vitest/no-conditional-expect": "off",
        },
      },
    ],
  },

  fmt: {
    // Oxfmt formats code (ts/js/json/etc). Markdown prose — the authoritative
    // spec docs under .kiro/ and the README (authored in task 15.2) — is out of
    // scope for this toolchain config, so `vp check` does not gate on it.
    ignorePatterns: ["dist/**", "cdk.out/**", "image/hooks/dist/**", "**/*.md"],
  },

  pack: {
    // Used by image/hooks (task 4) to bundle the hook handler to a single file
    // (Node platform) so the MicroVM image carries no node_modules for it.
    // The root package is a CLI compiled with tsc, not packed; this block only
    // takes effect for the image/hooks package build.
    platform: "node",
    format: ["esm"],
  },

  staged: {
    // Pre-commit staged-file checks run by `.vite-hooks/pre-commit` via `vp staged`.
    "*.{js,ts,tsx}": "vp check --fix",
  },
});
