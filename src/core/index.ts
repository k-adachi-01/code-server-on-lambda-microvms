// Lifecycle_Core (pure). No AWS SDK, fs, net, http(s), process, or child_process
// imports are allowed here (enforced by the Oxlint core override in vite.config.ts
// and by test/hygiene/core-imports.test.ts). Modules land in task 3+.
export {};
