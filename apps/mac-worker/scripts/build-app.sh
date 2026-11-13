#!/bin/bash
# Builds "Antseed Colony.app".
#
#   SIGN_IDENTITY="Developer ID Application: … (TEAMID)"  sign with the hardened runtime (no debugger, no injection)
#   PROVISIONING_PROFILE=path/to/profile.provisionprofile  embed it and the keychain entitlement that binds the
#                                                         Secure Enclave keys to this app (needed to attest hardened)
#   NOTARY_PROFILE=name                                    notarize (xcrun notarytool keychain profile) and staple
#   NOTARY_KEY=AuthKey.p8 NOTARY_KEY_ID=… NOTARY_ISSUER=…  or notarize with an App Store Connect API key (CI)
#   DMG=1                                                  also package build/Antseed-Colony-<version>.dmg,
#                                                          signed and notarized like the app
#
# The version comes from ../VERSION; BUILD_NUMBER (default: the commit count) is CFBundleVersion.
#
# Without SIGN_IDENTITY the app is ad-hoc signed. Every build attests not hardened for now:
# decrypted prompts leave the app for the bundled TensorFold engine (docs/protocol/colony-pool.md).
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID=com.antseed.macworker
VERSION=$(tr -d '[:space:]' < VERSION)
BUILD_NUMBER=${BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}
APP="${OUT:-build/Antseed Colony.app}"
# The inference engine (https://github.com/ashhart/TensorFold), pinned by hash.
TENSORFOLD_VERSION=1.2.6
TENSORFOLD_SHA256=4b50317bfdc00cd34a2c43d02f06eefbdd537b847747bcfa0f6cef6d19386751

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
# The panel's ant (from the desktop app), one per status.
cp -R Resources/mascot "$APP/Contents/Resources/"
cp -R "build/$TENSORFOLD/LICENSE" "build/$TENSORFOLD/NOTICE" "build/$TENSORFOLD/THIRD_PARTY_NOTICES.md" "build/$TENSORFOLD/LICENSES" "$APP/Contents/Resources/tensorfold-licenses/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Antseed Colony</string>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
<key>CFBundleExecutable</key><string>AntseedMacWorker</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
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

NOTARY=()
if [ -n "${NOTARY_PROFILE:-}" ]; then
  NOTARY=(--keychain-profile "$NOTARY_PROFILE")
elif [ -n "${NOTARY_KEY:-}" ]; then
  NOTARY=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
fi
notarize() {
  ((${#NOTARY[@]})) || return 0
  xcrun notarytool submit "$1" "${NOTARY[@]}" --wait --timeout 30m
}

if ((${#NOTARY[@]})); then
  ZIP=$(mktemp -d)/AntseedColony.zip
  ditto -c -k --keepParent "$APP" "$ZIP"
  notarize "$ZIP"
  xcrun stapler staple "$APP"
fi

if [ -n "${DMG:-}" ]; then
  DMG_PATH="build/Antseed-Colony-$VERSION.dmg"
  STAGE=$(mktemp -d)
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  rm -f "$DMG_PATH"
  hdiutil create -volname "Antseed Colony" -srcfolder "$STAGE" -format UDZO -ov "$DMG_PATH"
  rm -rf "$STAGE"
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_PATH"
  if ((${#NOTARY[@]})); then
    notarize "$DMG_PATH"
    xcrun stapler staple "$DMG_PATH"
  fi
  echo "Packaged $DMG_PATH"
fi
echo "Built $APP $VERSION ($BUILD_NUMBER, team $TEAM)"
