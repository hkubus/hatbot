#!/usr/bin/env bash
# Builds an unsigned build/Hatbot.ipa for SideStore, which signs it with your Apple ID when it
# installs. Runs on a Mac with Xcode and XcodeGen (brew install xcodegen). VERSION and BUILD
# override the version in project.yml (the iOS workflow sets them per run).
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
  ${VERSION:+MARKETING_VERSION=$VERSION} \
  ${BUILD:+CURRENT_PROJECT_VERSION=$BUILD} \
  | { command -v xcbeautify >/dev/null && xcbeautify || cat; }

mkdir -p build/Payload
cp -R build/derived/Build/Products/Release-iphoneos/Hatbot.app build/Payload/
# Ad-hoc signed with the entitlements, the extensions first: SideStore reads the App Group from them
# and re-signs all three with your Apple ID.
app=build/Payload/Hatbot.app
codesign --force --sign - --entitlements Share/HatbotShare.entitlements "$app/PlugIns/HatbotShare.appex"
codesign --force --sign - --entitlements Widgets/HatbotWidgets.entitlements "$app/PlugIns/HatbotWidgets.appex"
codesign --force --sign - --entitlements Hatbot/Hatbot.entitlements "$app"
(cd build && zip -qry Hatbot.ipa Payload)
echo "Built $(pwd)/build/Hatbot.ipa"
