{
  description = "AntSeed development environment and CLI package";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # Prebuilt native binaries fetched by prebuild-install at package build
      # time (the pnpm sandbox has no network, so they are pinned here).
      # Versions must stay in sync with pnpm-lock.yaml.
      prebuildInfo = {
        better-sqlite3 = {
          version = "12.6.2";
          abi = "node-v137";
          repo = "WiseLibs/better-sqlite3";
          napi = false;
          hashes = {
            x86_64-linux = "sha256-MTi6apJotwoZSyEoCcEpZ7d6wobWVkX4+wFHJGS5hls=";
            aarch64-linux = "sha256-TmbCwMviACBgCKNfvPuKiTqkdd8iOhEAzMUNbdLc6EQ=";
            x86_64-darwin = "sha256-/gYtua8AzW1J5kd3vBuwkzZErhoQu6bZFi6DGRBoIno=";
            aarch64-darwin = "sha256-ZkqBSpBFDrRy9yl9GZK33CtRLDfKu9mhAps+hY56mBw=";
          };
        };
        node-datachannel = {
          version = "0.7.0";
          abi = "napi-v8";
          repo = "murat-dogan/node-datachannel";
          napi = true;
          hashes = {
            x86_64-linux = "sha256-Ua6kZdUJMi+39hw7teHCbZbiTXoqk85pYp3Y+PKlJGw=";
            aarch64-linux = "sha256-Slpx9pTjMc1Bkv5JiDPoQDfFTURK1jxBDjkuo8afAbw=";
            x86_64-darwin = "sha256-aTeyR9F9c0ogujPGPtET7gWTK30MGO4jpYB1LpWCoPw=";
            aarch64-darwin = "sha256-Kd7nVMz2tqymCAFc5HsxvQK4BBK/X401VtNj99tan0c=";
          };
        };
        keytar = {
          version = "7.9.0";
          abi = "napi-v3";
          repo = "atom/node-keytar";
          napi = true;
          hashes = {
            x86_64-linux = "sha256-LXV1P6v53OtJU3riMeGJfeU3J7wPrbwqAeY3ShRDxnw=";
            aarch64-linux = "sha256-HFGsnSLKqIWwwvRhFvomqxfLEVlRJj2uo9YMRBelQ70=";
            x86_64-darwin = "sha256-TOVuOJbnai3q7xP4o2IH76bZTZZnjTAgCVLYPTJ+tfk=";
            aarch64-darwin = "sha256-GV8IVeJvg+DWHiKNG2HHdpuqmTJEUY3Jh52dVxBMfOw=";
          };
        };
      };

      platformInfo = {
        x86_64-linux = { os = "linux"; cpu = "x64"; };
        aarch64-linux = { os = "linux"; cpu = "arm64"; };
        x86_64-darwin = { os = "darwin"; cpu = "x64"; };
        aarch64-darwin = { os = "darwin"; cpu = "arm64"; };
      };
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cacert
              cmake
              git
              ninja
              nodejs_24
              pkg-config
              pnpm_9
              python311
            ] ++ lib.optionals stdenv.isLinux [
              libsecret
            ];

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              export npm_config_python="${pkgs.python311}/bin/python3"
            '';
          };
        });

      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          inherit (pkgs) lib stdenv;

          nodejs = pkgs.nodejs_24;
          pnpm = pkgs.pnpm_9;
          inherit (nodejs) version;

          platform = platformInfo.${system};

          prebuildTarballs = lib.mapAttrs (name: info:
            let
              file = "${name}-v${info.version}-${info.abi}-${platform.os}-${platform.cpu}.tar.gz";
            in
            pkgs.fetchurl {
              url = "https://github.com/${info.repo}/releases/download/v${info.version}/${file}";
              hash = info.hashes.${system};
            }
          ) prebuildInfo;

          cliVersion = (lib.importJSON ./apps/cli/package.json).version;

          # Modules the bundle needs at runtime that cannot be inlined:
          # the native packages above plus their pure-JS runtime deps.
          runtimeNodeModules = [
            "better-sqlite3"
            "bindings"
            "file-uri-to-path"
            "keytar"
            "koffi"
            "node-datachannel"
            "node-domexception"
          ];
        in
        {
          default = stdenv.mkDerivation (finalAttrs: {
            pname = "antseed-cli";
            version = cliVersion;

            src = lib.cleanSourceWith {
              src = ./.;
              filter = path: type:
                (type != "directory" || baseNameOf path != "node_modules")
                && lib.cleanSourceFilter path type;
            };

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 3;
              pnpmWorkspaces = [ "@antseed/cli..." ];
              # NIX-PNPM-HASH: this fixed-output hash goes stale on every
              # pnpm-lock.yaml change (the store no longer matches). After
              # touching the lockfile, regenerate it with:
              #   ./scripts/update-nix-hash.sh
              hash = "sha256-IXAtIATmukFFW1wLPjLU6YgiFSXbXlJg3TPKH7deAxY=";
            };

            pnpmWorkspaces = [ "@antseed/cli..." ];

            nativeBuildInputs = [
              nodejs
              pnpm
              pkgs.pnpmConfigHook
              pkgs.esbuild
              pkgs.makeWrapper
              pkgs.writableTmpDirAsHomeHook
            ] ++ lib.optionals stdenv.isLinux [
              pkgs.autoPatchelfHook
            ];

            # Shared libraries for the prebuilt native binaries (Linux).
            buildInputs = lib.optionals stdenv.isLinux [
              pkgs.glib
              pkgs.libsecret
              stdenv.cc.cc.lib
            ];

            buildPhase = ''
              runHook preBuild

              # pnpm installs with --ignore-scripts, so replicate the install
              # scripts the build actually depends on.

              # 1. packages/node postinstall: patch ethers type declarations.
              node packages/node/scripts/patch-ethers.js

              # 2. Native modules: unpack the pinned prebuilds exactly the way
              #    prebuild-install would (it checks ./prebuilds/<tarball> first).
              #    The workspace uses node-linker=hoisted, so packages are real
              #    directories directly under node_modules/.
              pi_bin="$(readlink -f node_modules/prebuild-install)/bin.js"

              install_prebuild() {
                local pkg="$1" tarball="$2" file="$3"; shift 3
                local dir
                dir="$(readlink -f "node_modules/$pkg")"
                if [ ! -d "$dir" ]; then
                  echo "error: package $pkg not found in node_modules" >&2
                  return 1
                fi
                echo "Installing prebuild for $pkg ($dir)"
                mkdir -p "$dir/prebuilds"
                cp "$tarball" "$dir/prebuilds/$file"
                (cd "$dir" && node "$pi_bin" "$@")
              }

              ${lib.concatStringsSep "\n" (lib.mapAttrsToList (name: info:
                let
                  file = "${name}-v${info.version}-${info.abi}-${platform.os}-${platform.cpu}.tar.gz";
                in
                "install_prebuild ${name} ${prebuildTarballs.${name}} ${file} ${lib.optionalString info.napi "-r napi"}"
              ) prebuildInfo)}

              # 3. Type-check/build the workspace packages the CLI depends on.
              #    The pnpmConfigHook's patchShebangs only covers the root
              #    node_modules, but pnpm recreates .bin wrapper scripts in
              #    per-package node_modules whose /usr/bin/env shebangs break
              #    inside the sandbox — patch those too.
              find apps packages plugins -type d -name node_modules | while read -r d; do
                patchShebangs "$d"
              done
              #    Native bin wrappers (esbuild) can lose their exec bit in
              #    the pnpm store, so restore it before vite shells out to them.
              for f in node_modules/@esbuild/*/bin/esbuild node_modules/*/node_modules/@esbuild/*/bin/esbuild; do
                [ -f "$f" ] && chmod +x "$f"
              done
              pnpm --filter='@antseed/cli...' run build

              # 4. Bundle the CLI into a single ESM file; native modules stay
              #    external and are shipped alongside (same as build:bundle).
              # ESM output breaks CJS deps that call require(); shim it.
              esbuild apps/cli/src/cli/index.ts \
                --bundle --platform=node --format=esm \
                --outfile=apps/cli/dist/bundle.mjs \
                --external:better-sqlite3 --external:node-datachannel \
                --external:koffi --external:keytar \
                '--banner:js=import { createRequire as __antseedCreateRequire } from "node:module"; var require = __antseedCreateRequire(import.meta.url);'

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/libexec/antseed/node_modules" "$out/bin"

              cp apps/cli/dist/bundle.mjs "$out/libexec/antseed/"

              # Web dashboard assets; @antseed/payments resolves ./web relative
              # to import.meta.url, which is the bundle's directory once built.
              cp -r apps/payments/dist/web "$out/libexec/antseed/web"
              cp -r apps/ants/dist/ants-web "$out/libexec/antseed/ants-web"

              for pkg in ${lib.concatStringsSep " " runtimeNodeModules}; do
                if [ -e "node_modules/$pkg" ]; then
                  cp -rL "node_modules/$pkg" "$out/libexec/antseed/node_modules/$pkg"
                fi
              done

              # koffi's npm package ships binaries for every platform; keep
              # only the target one so autoPatchelf does not trip on the rest.
              if [ -d "$out/libexec/antseed/node_modules/koffi/build/koffi" ]; then
                find "$out/libexec/antseed/node_modules/koffi/build/koffi" \
                  -mindepth 1 -maxdepth 1 \
                  ! -name "${platform.os}_${platform.cpu}" \
                  -exec rm -rf {} +
              fi

              makeWrapper ${nodejs}/bin/node "$out/bin/antseed" \
                --add-flags "$out/libexec/antseed/bundle.mjs" \
                --prefix PATH : ${lib.makeBinPath [ nodejs ]}

              runHook postInstall
            '';

            meta = {
              description = "AntSeed Network CLI — P2P network for AI services";
              homepage = "https://github.com/antseed/antseed";
              license = lib.licenses.gpl3Only;
              mainProgram = "antseed";
              platforms = systems;
            };
          });
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/antseed";
        };
      });
    };
}
