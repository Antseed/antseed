#!/bin/bash
# Builds "Antseed Worker.app".
#
#   SIGN_IDENTITY="Developer ID Application: … (TEAMID)"  sign with the hardened runtime (no debugger, no injection)
#   PROVISIONING_PROFILE=path/to/profile.provisionprofile  embed it and the keychain entitlement that binds the
#                                                         Secure Enclave keys to this app (needed to attest hardened)
#   NOTARY_PROFILE=name                                    notarize (xcrun notarytool keychain profile) and staple
#
# Without SIGN_IDENTITY the app is ad-hoc signed. Every build attests not hardened for now:
# decrypted prompts reach the bundled TensorFold engine over loopback (docs/protocol/colony-pool.md).
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID=com.antseed.macworker
APP="${OUT:-build/Antseed Worker.app}"
# The inference engine (https://github.com/ashhart/TensorFold), pinned by hash.
TENSORFOLD_VERSION=1.2.3
TENSORFOLD_SHA256=760a517dea45f83fc30257dc02921bf9c79fc7086f4e17e90fba2aaa510e3906

swift build -c release --arch arm64 --product AntseedMacWorker
PRODUCTS=$(swift build -c release --arch arm64 --show-bin-path)

TENSORFOLD=tensorfold-$TENSORFOLD_VERSION-macos-arm64
mkdir -p build
if [ ! -f "build/$TENSORFOLD.tar.gz" ]; then
  curl -fL --retry 3 -o "build/$TENSORFOLD.tar.gz.part" "https://github.com/ashhart/TensorFold/releases/download/v$TENSORFOLD_VERSION/$TENSORFOLD.tar.gz"
  mv "build/$TENSORFOLD.tar.gz.part" "build/$TENSORFOLD.tar.gz"
fi
shasum -a 256 -c <<<"$TENSORFOLD_SHA256  build/$TENSORFOLD.tar.gz"
rm -rf "build/$TENSORFOLD"
tar -xzf "build/$TENSORFOLD.tar.gz" -C build

rm -rf "$APP"
ENGINE="$APP/Contents/Helpers/tensorfold"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/tensorfold-licenses" "$ENGINE"
cp "$PRODUCTS/AntseedMacWorker" "$APP/Contents/MacOS/"
# Dependencies' resource bundles (CryptoSwift's privacy manifest), when the build made any.
shopt -s nullglob
BUNDLES=("$PRODUCTS"/*.bundle)
shopt -u nullglob
if ((${#BUNDLES[@]})); then cp -R "${BUNDLES[@]}" "$APP/Contents/Resources/"; fi
cp -R "build/$TENSORFOLD/bin" "build/$TENSORFOLD/lib" "$ENGINE/"
cp -R "build/$TENSORFOLD/LICENSE" "build/$TENSORFOLD/NOTICE" "build/$TENSORFOLD/THIRD_PARTY_NOTICES.md" "build/$TENSORFOLD/LICENSES" "$APP/Contents/Resources/tensorfold-licenses/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Antseed Worker</string>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
<key>CFBundleExecutable</key><string>AntseedMacWorker</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSLocalNetworkUsageDescription</key><string>Connects to your Antseed pool to serve encrypted requests.</string>
</dict></plist>
PLIST

if [ -z "${SIGN_IDENTITY:-}" ]; then
  codesign --force --sign - "$ENGINE/lib/libtfgrammar.dylib"
  codesign --force --sign - "$ENGINE/bin/tensorfold-native"
  codesign --force --sign - "$APP"
  echo "Built $APP (ad-hoc: not hardened)"
  exit 0
fi

TEAM=$(sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/' <<<"$SIGN_IDENTITY")
ENTITLEMENTS=$(mktemp)
if [ -n "${PROVISIONING_PROFILE:-}" ]; then
  cp "$PROVISIONING_PROFILE" "$APP/Contents/embedded.provisionprofile"
  cat > "$ENTITLEMENTS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>$TEAM.$BUNDLE_ID</string>
<key>com.apple.developer.team-identifier</key><string>$TEAM</string>
<key>keychain-access-groups</key><array><string>$TEAM.$BUNDLE_ID</string></array>
</dict></plist>
PLIST
else
  echo "No PROVISIONING_PROFILE: the Secure Enclave keys will not be app-bound, so the app attests not hardened." >&2
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n' > "$ENTITLEMENTS"
fi

# Hardened runtime, no get-task-allow: macOS refuses debuggers and code injection while SIP is on.
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$ENGINE/lib/libtfgrammar.dylib"
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$ENGINE/bin/tensorfold-native"
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$APP"
rm -f "$ENTITLEMENTS"
codesign --verify --strict --verbose=2 "$APP"

if [ -n "${NOTARY_PROFILE:-}" ]; then
  ZIP=$(mktemp -d)/AntseedWorker.zip
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
fi
echo "Built $APP (team $TEAM)"
