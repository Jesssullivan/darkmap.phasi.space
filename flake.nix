{
  description = "darkmap.phasi.space development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        baseShell = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Core JS toolchain
            nodejs_22
            pnpm
            typescript
            typescript-language-server

            # Build / VCS / CLI
            just
            git
            gh
            bazelisk
            gitleaks

            # Infra
            opentofu
            terraform-ls
            tflint
            kubectl
            kustomize

            # CI-schema + lane tooling (docs/CI-SCHEMA.md)
            python3
            python3Packages.jsonschema
            jq
            netcat-gnu
          ];

          shellHook = ''
            # Enable corepack so pnpm@10.13.1 (from packageManager field in
            # package.json once M0.2 lands) takes over from the nix-shipped pnpm.
            corepack enable >/dev/null 2>&1 || true

            echo "darkmap.phasi.space dev shell"
            echo "  node     $(node --version)"
            echo "  pnpm     $(pnpm --version 2>/dev/null || echo 'not available yet')"
            echo "  just     $(just --version)"
            echo "  bazel    $(bazelisk --version 2>&1 | head -n1)"
            echo "  gh       $(gh --version | head -n1)"
            echo "  gitleaks $(gitleaks version 2>&1 | head -n1)"
            echo "  tofu     $(tofu --version 2>&1 | head -n1)"
            echo "  kubectl  $(kubectl version --client 2>&1 | head -n1)"
            echo "  python   $(python3 --version)"
            echo "  jq       $(jq --version)"
          '';
        };
      in
      {
        devShells = {
          default = baseShell;
        } // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          # Browser proof uses the same locked toolchain plus an explicit
          # Chromium store executable; it is not an RBE or release shell.
          browser = pkgs.mkShell {
            inputsFrom = [ baseShell ];
            buildInputs = [
              pkgs.chromium
              pkgs.fontconfig
              pkgs.dejavu_fonts
            ];
            CHROME_BIN = "${pkgs.chromium}/bin/chromium";
            FONTCONFIG_FILE = pkgs.makeFontsConf {
              fontDirectories = [ pkgs.dejavu_fonts ];
              impureFontDirectories = [ ];
              includes = [ "${pkgs.fontconfig.out}/etc/fonts/conf.d" ];
            };
          };
        };

        formatter = pkgs.nixpkgs-fmt;
      }
    );
}
