#!/usr/bin/env bash
# Builds an unsigned build/Hatbot.ipa for SideStore, which signs it with your Apple ID when it
# installs. Runs on a Mac with Xcode and XcodeGen (brew install xcodegen).
set -euo pipefail
cd "$(dirname "$0")"

command -v xcodegen >/dev/null || { echo "XcodeGen is missing: brew install xcodegen" >&2; exit 1; }
xcodegen generate --quiet

rm -rf build
xcodebuild build \
  -project Hatbot.xcodeproj \
  -scheme Hatbot \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build/derived \
  CODE_SIGNING_ALLOWED=NO \
  | { command -v xcbeautify >/dev/null && xcbeautify || cat; }

mkdir -p build/Payload
cp -R build/derived/Build/Products/Release-iphoneos/Hatbot.app build/Payload/
(cd build && zip -qry Hatbot.ipa Payload)
echo "Built $(pwd)/build/Hatbot.ipa"
