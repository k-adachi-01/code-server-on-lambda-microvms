import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

// Authoritative core import-boundary guard (R16.4, task 2.6).
//
// This scan is tool-independent: it fails on any banned import under src/core/
// regardless of whether Oxlint's no-restricted-imports rule can express the
// boundary. It is the second, decisive check next to the Oxlint override in
// vite.config.ts. Keep the banned sets in sync with that override.

const CORE_DIR = fileURLToPath(new URL("../../src/core", import.meta.url));

// Exact module specifiers that src/core/** may not import.
const BANNED_EXACT = new Set<string>([
  "fs",
  "fs/promises",
  "net",
  "http",
  "https",
  "process",
  "child_process",
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:http",
  "node:https",
  "node:process",
  "node:child_process",
]);

// Specifier prefixes that are banned for any subpath.
const BANNED_PREFIXES = ["@aws-sdk/", "node:fs/", "node:child_process/"];

/** Collect every .ts/.tsx/.mts/.cts file under dir, recursively. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract imported module specifiers from a source file: static `import ...
 * from 'x'`, side-effect `import 'x'`, `export ... from 'x'`, dynamic
 * `import('x')`, and CommonJS `require('x')`. Line/block comments are stripped
 * first so commented-out imports do not produce false positives.
 */
function extractSpecifiers(source: string): string[] {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutComments = withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, "$1");

  const specifiers: string[] = [];
  const patterns: RegExp[] = [
    // import ... from '...'  /  export ... from '...'
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    // side-effect import '...'
    /\bimport\s*['"]([^'"]+)['"]/g,
    // dynamic import('...')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // require('...')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(withoutComments)) !== null) {
      if (m[1] !== undefined) {
        specifiers.push(m[1]);
      }
    }
  }
  return specifiers;
}

function isBanned(spec: string): boolean {
  if (BANNED_EXACT.has(spec)) {
    return true;
  }
  return BANNED_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

describe("src/core import boundary (R16.4)", () => {
  const files = collectSourceFiles(CORE_DIR);

  it("finds at least one source file to scan", () => {
    // Guard against the scan silently passing because the directory was moved.
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no banned imports (AWS SDK, node fs/net/http(s)/process/child_process)", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(source)) {
        if (isBanned(spec)) {
          violations.push(`${relative(CORE_DIR, file)} imports "${spec}"`);
        }
      }
    }
    // Join into one message so a failure prints every offending import. The
    // expectation is that there are zero violations.
    expect(violations.join("\n")).toBe("");
  });
});
