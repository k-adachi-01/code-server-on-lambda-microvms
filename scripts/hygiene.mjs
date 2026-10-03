#!/usr/bin/env node
// Repo-hygiene guard for this PUBLIC repository.
//
// SCOPE / RESPONSIBILITY SPLIT (see .kiro/steering/tech.md "Repository hygiene"):
//   - gitleaks (.gitleaks.toml) owns credential/token/secret detection ONLY.
//   - THIS script owns personal-ENVIRONMENT values that are not secrets but must
//     still stay out of a public repo: AWS account IDs, AWS SSO start/portal URLs,
//     local user filesystem paths, and (via a LOCAL denylist) personal AWS
//     profile names.
//
// SAFE-FOR-PUBLIC: this file hardcodes NO real account ID, SSO URL, username, or
// profile name. Everything is detected by GENERIC pattern. Profile-name
// detection is a denylist that is EMPTY by default and only populated from a
// gitignored local config or an env var (see loadProfileDenylist()).
//
// Dependency-free: plain Node (ESM), no npm deps, so it runs identically in the
// pre-commit hook and in CI inside `nix develop --command`.
//
// MODES:
//   node scripts/hygiene.mjs --full     scan every tracked text file (CI)
//   node scripts/hygiene.mjs --staged   scan staged added lines only (pre-commit)
//   node scripts/hygiene.mjs <files...>  scan explicit files
//
// Exit 0 = clean. Exit 1 = at least one finding (prints file:line + rule id).
// Exit 2 = usage/internal error.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// --- Rules (generic patterns only; no real personal values) ------------------
//
// Each rule has: id, description, a RegExp with the `g` flag, and an optional
// `allow` predicate that drops a specific match (placeholders).

/** Obvious AWS documentation placeholder account id. */
const PLACEHOLDER_ACCOUNT_IDS = new Set(["123456789012", "000000000000"]);

const RULES = [
  {
    id: "aws-account-id-in-arn",
    description: "12-digit AWS account id embedded in an ARN (arn:aws...:<account>:)",
    // ARN shape: arn:<partition>:<service>:<region>:<ACCOUNT>:  — capture the
    // account field. partition/service/region may be empty (as in some ARNs).
    regex: /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):/g,
    valueOf: (m) => m[1],
    allow: (acct) => PLACEHOLDER_ACCOUNT_IDS.has(acct),
  },
  {
    id: "aws-account-id-standalone",
    description: "Standalone 12-digit AWS account id near an 'account'/'aws' token",
    // Scope the bare-12-digit rule narrowly to avoid matching timestamps/sizes:
    // only when an account/aws keyword sits just before it. Handles joined
    // tokens like `aws_account_id`, `accountId`, `account-id` and separators
    // like ` = `, `: `, `"`.
    regex: /(?:aws[_-]?)?account(?:[_-]?id)?["'\s:=]{0,8}(\d{12})\b/gi,
    valueOf: (m) => m[1],
    allow: (acct) => PLACEHOLDER_ACCOUNT_IDS.has(acct),
  },
  {
    id: "aws-sso-start-url",
    description: "AWS SSO access-portal start URL (*.awsapps.com/start)",
    regex: /https?:\/\/[a-z0-9-]+\.awsapps\.com\/start(?:[/#?][^\s"'`<>]*)?/gi,
    valueOf: (m) => m[0],
    // The generic shape itself is the signal; no real subdomain is a placeholder
    // we need to allow. (A doc wanting to show the shape should use a fenced
    // code placeholder like <subdomain>, which won't match [a-z0-9-]+ literally.)
    allow: () => false,
  },
  {
    id: "aws-sso-portal-url",
    description: "AWS SSO / Identity Center / identitystore portal URL",
    // identitystore and SSO/Identity-Center console/portal URL shapes.
    regex:
      /https?:\/\/[a-z0-9.-]*(?:identitystore|sso|identity-center)[a-z0-9.-]*\.[a-z]{2,}(?:[/#?][^\s"'`<>]*)?/gi,
    valueOf: (m) => m[0],
    allow: (url) => /example\.(?:com|org|net)/i.test(url),
  },
  {
    id: "local-user-path",
    description: "Local user home path (/Users/<name>/ or /home/<name>/)",
    regex: /\/(?:Users|home)\/([^/\s"'`:<>]+)\//g,
    valueOf: (m) => m[0],
    allow: (_full, m) => isPlaceholderUser(m[1]),
  },
];

/** Placeholder user segments that are fine to keep in docs/examples. */
function isPlaceholderUser(seg) {
  const s = seg.toLowerCase();
  // Angle-bracket / brace placeholders and generic words.
  if (/^<.*>$/.test(seg) || /^\{.*\}$/.test(seg)) return true;
  return [
    "user",
    "username",
    "youruser",
    "your-user",
    "someuser",
    "example",
    "path", // part of /path/to/
    "runner", // GitHub Actions default home: /home/runner/
    "coder", // code-server container service user: /home/coder/ (image-fixed, not personal)
    "root",
    "ec2-user",
    "ubuntu",
  ].includes(s);
}

// --- Personal AWS profile-name denylist (EMPTY by default) -------------------
//
// We must NOT bake the user's real profile names into this committed file. The
// denylist is loaded, in priority order, from:
//   1. env var CSMVM_HYGIENE_PROFILES  (comma/space/newline separated)
//   2. a gitignored local file .hygiene-profiles.local (one name per line;
//      blank lines and `#` comments ignored)
// If neither exists the denylist is empty and profile-name detection is a no-op
// — which is correct for the public repo (no real names anywhere).
function loadProfileDenylist(repoRoot) {
  const names = new Set();
  const fromEnv = process.env.CSMVM_HYGIENE_PROFILES;
  if (fromEnv) {
    for (const n of fromEnv.split(/[\s,]+/)) if (n.trim()) names.add(n.trim());
  }
  const localFile = `${repoRoot}/.hygiene-profiles.local`;
  if (existsSync(localFile)) {
    const text = readFileSync(localFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.replace(/#.*$/, "").trim();
      if (t) names.add(t);
    }
  }
  return [...names];
}

function profileRule(names) {
  if (names.length === 0) return null;
  // Escape and match each name as a whole token.
  const escaped = names
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  return {
    id: "personal-aws-profile-name",
    description: "Personal AWS profile name from the local denylist",
    regex: new RegExp(`\\b(${escaped})\\b`, "g"),
    valueOf: (m) => m[1],
    allow: () => false,
  };
}

// --- File selection ----------------------------------------------------------

function sh(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function repoRoot() {
  return sh(["rev-parse", "--show-toplevel"]).trim();
}

/** Binary / non-text or self-excluded files we never scan. */
function isScannable(path) {
  // The hygiene check itself and its docs legitimately contain the patterns.
  if (path === "scripts/hygiene.mjs") return false;
  // Lockfiles are huge, generated, and placeholder-free of personal env values.
  if (/(?:^|\/)(?:pnpm-lock\.yaml|flake\.lock)$/.test(path)) return false;
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|woff2?|ttf|eot|mp4|mov|wasm|lock)$/i.test(path))
    return false;
  return true;
}

function listTrackedFiles() {
  return sh(["ls-files", "-z"]) // NUL-separated handles odd names
    .split("\0")
    .filter(Boolean)
    .filter(isScannable);
}

// --- Scanning ----------------------------------------------------------------

/**
 * Scan text for all rule matches. Returns findings:
 * { ruleId, description, line, column, value }
 */
function scanText(text, rules) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (const rule of rules) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      rule.regex.lastIndex = 0;
      let m;
      while ((m = rule.regex.exec(line)) !== null) {
        const value = rule.valueOf(m);
        if (!rule.allow || !rule.allow(value, m)) {
          findings.push({
            ruleId: rule.id,
            description: rule.description,
            line: i + 1,
            column: m.index + 1,
            value,
          });
        }
        if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++; // avoid zero-width loop
      }
    }
  }
  return findings;
}

/** Full mode: scan whole-file content of every tracked, scannable text file. */
function scanFull(rules) {
  const results = [];
  for (const path of listTrackedFiles()) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // unreadable/binary — skip
    }
    if (text.includes("\0")) continue; // binary guard
    for (const f of scanText(text, rules)) results.push({ path, ...f });
  }
  return results;
}

/**
 * Staged mode: scan only ADDED lines in the staged diff (what the commit would
 * introduce). We parse the unified diff, tracking file + new-line numbers.
 */
function scanStaged(rules) {
  const diff = sh(["diff", "--cached", "--no-color", "--unified=0", "--diff-filter=ACMR"]);
  const results = [];
  let path = null;
  let newLine = 0;
  let skip = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "");
      path = p === "/dev/null" ? null : p;
      skip = path ? !isScannable(path) : true;
      continue;
    }
    if (raw.startsWith("@@")) {
      // @@ -old,+new @@ ; grab the new-file start line.
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (path && !skip) {
        const content = raw.slice(1);
        for (const f of scanText(content, rules)) {
          results.push({ path, ...f, line: newLine });
        }
      }
      newLine++;
      continue;
    }
    if (raw.startsWith("-")) continue; // removed line: not in new file, don't advance
    if (raw.startsWith(" ")) newLine++; // context (shouldn't appear at -U0)
  }
  return results;
}

// --- Main --------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--full")) return { mode: "full", files: [] };
  if (args.includes("--staged")) return { mode: "staged", files: [] };
  const files = args.filter((a) => !a.startsWith("-"));
  if (files.length > 0) return { mode: "files", files };
  return { mode: "full", files: [] }; // default: full tree
}

function main() {
  const { mode, files } = parseArgs(process.argv);
  const root = repoRoot();
  const profiles = profileRule(loadProfileDenylist(root));
  const rules = profiles ? [...RULES, profiles] : RULES;

  let findings;
  if (mode === "staged") {
    findings = scanStaged(rules);
  } else if (mode === "files") {
    findings = [];
    for (const path of files) {
      if (!isScannable(path) || !existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      for (const f of scanText(text, rules)) findings.push({ path, ...f });
    }
  } else {
    findings = scanFull(rules);
  }

  if (findings.length === 0) {
    const scope =
      mode === "staged" ? "staged changes" : mode === "files" ? "given files" : "tracked tree";
    console.log(`repo-hygiene: OK — no personal-environment values in ${scope}.`);
    process.exit(0);
  }

  console.error(`repo-hygiene: FAILED — ${findings.length} personal-environment value(s) found.\n`);
  for (const f of findings) {
    console.error(
      `  ${f.path}:${f.line}:${f.column}  [${f.ruleId}] ${f.description}\n` +
        `      match: ${f.value}`,
    );
  }
  console.error(
    "\nThese values must not live in a public repo. Replace them with placeholders " +
      "(e.g. 123456789012, /Users/<user>/, example.com) or move them to gitignored local config.",
  );
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`repo-hygiene: internal error: ${err && err.message ? err.message : err}`);
  process.exit(2);
}
