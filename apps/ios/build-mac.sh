#!/usr/bin/env bash
# Builds build/mac/Hatbot.app, the iPad app for the Mac (Mac Catalyst). Runs on a Mac with Xcode, Rust and
# XcodeGen (brew install xcodegen). TEAM, the team ID of an Apple ID added in Xcode's Settings →
# Accounts, signs it with Xcode's own signing; without it the app is unsigned and won't keep you
# signed in, which is only for checking that it builds (the iOS workflow does). VERSION, BUILD and
# BUNDLE_PREFIX are as in build-ipa.sh.
set -euo pipefail
cd "$(dirname "$0")"
prefix=${BUNDLE_PREFIX:-$(sed -n 's/^ *BUNDLE_PREFIX: *//p' project.yml | head -n1)}

command -v xcodegen >/dev/null || { echo "XcodeGen is missing: brew install xcodegen" >&2; exit 1; }
xcodegen generate --quiet
# The agent in the app (mac-agent.sh) is Rust, built for both kinds of Mac.
rustup=$(command -v rustup || echo "$HOME/.cargo/bin/rustup")
[ -x "$rustup" ] || { echo "Rust is missing: https://rustup.rs" >&2; exit 1; }
"$rustup" target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

if command -v xcbeautify >/dev/null; then log=xcbeautify; else log=cat; fi

# Signed, it's built for this Mac, so Xcode can register it with the team: a development profile only
# runs on the Macs it lists.
if [ -n "${TEAM:-}" ]; then
  destination='platform=macOS,variant=Mac Catalyst'
  signing=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic)
else
  destination='generic/platform=macOS,variant=Mac Catalyst'
  signing=(CODE_SIGNING_ALLOWED=NO)
fi

rm -rf build/mac
xcodebuild build \
  -project Hatbot.xcodeproj \
  -scheme Hatbot \
  -configuration Release \
  -destination "$destination" \
  -derivedDataPath build/mac/derived \
  BUNDLE_PREFIX="$prefix" \
  ${VERSION:+MARKETING_VERSION=$VERSION} \
  ${BUILD:+CURRENT_PROJECT_VERSION=$BUILD} \
  "${signing[@]}" \
  | "$log"

cp -R build/mac/derived/Build/Products/Release-maccatalyst/Hatbot.app build/mac/
echo "Built $(pwd)/build/mac/Hatbot.app"
