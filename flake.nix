{
  description = "code-server-on-lambda-microvms dev environment (Node.js, pnpm, AWS CDK CLI, gitleaks)";

  # Pinned via flake.lock. The devShell is the only interface the project uses;
  # Vite+ (vp) is a project-local pnpm devDependency run on this Node/pnpm, not a
  # Nix package (R16.3, tech.md).
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          # Pinned toolchain. Exact versions are fixed by the nixpkgs rev in
          # flake.lock; run `node --version`, `pnpm --version`, `cdk --version`,
          # and `gitleaks version` after `nix develop` to see the resolved pins.
          packages = [
            pkgs.nodejs_22      # Node.js 22 LTS (satisfies Vitest 5 / Node >= 22.12)
            pkgs.pnpm           # pnpm (owns deps, lockfile, workspace)
            pkgs.awscli2        # aws CLI (used by infra/ and spike workflows)
            pkgs.aws-cdk        # AWS CDK CLI (infra/ uses this binary; libs come from pnpm)
            pkgs.gitleaks       # secret scanner (pre-commit + CI)
          ];

          shellHook = ''
            echo "dev shell: code-server-on-lambda-microvms"
            echo "  node    $(node --version 2>/dev/null)"
            echo "  pnpm    $(pnpm --version 2>/dev/null)"
            echo "  cdk     $(cdk --version 2>/dev/null)"
            echo "  gitleaks $(gitleaks version 2>/dev/null)"
            echo "Use: pnpm install  then  pnpm check / pnpm test. vp is a local devDependency."
          '';
        };
      });
}
