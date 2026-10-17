#!/usr/bin/env bash
# Builds an unsigned build/Hatbot.ipa for SideStore, which signs it with your Apple ID when it
# installs. Runs on a Mac with Xcode and XcodeGen (brew install xcodegen). VERSION and BUILD
# override the version in project.yml (the iOS workflow sets them per run), and BUNDLE_PREFIX its
# bundle prefix.
set -euo pipefail
cd "$(dirname "$0")"
prefix=${BUNDLE_PREFIX:-$(sed -n 's/^ *BUNDLE_PREFIX: *//p' project.yml | head -n1)}

command -v xcodegen >/dev/null || { echo "XcodeGen is missing: brew install xcodegen" >&2; exit 1; }
xcodegen generate --quiet

# xcbeautify tidies the log when it's installed.
if command -v xcbeautify >/dev/null; then log=xcbeautify; else log=cat; fi

rm -rf build
xcodebuild build \
  -project Hatbot.xcodeproj \
  -scheme Hatbot \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build/derived \
  CODE_SIGNING_ALLOWED=NO \
  BUNDLE_PREFIX="$prefix" \
  ${VERSION:+MARKETING_VERSION=$VERSION} \
  ${BUILD:+CURRENT_PROJECT_VERSION=$BUILD} \
  | "$log"

mkdir -p build/Payload
cp -R build/derived/Build/Products/Release-iphoneos/Hatbot.app build/Payload/
# Ad-hoc signed with the entitlements, the extensions first: SideStore reads the App Group from them
# and re-signs all three with your Apple ID. The files name the group with $(BUNDLE_PREFIX), which
# only Xcode's own signing fills in.
app=build/Payload/Hatbot.app
sign() {
  sed "s/\$(BUNDLE_PREFIX)/$prefix/g" "$2" >build/signing.entitlements
  codesign --force --sign - --entitlements build/signing.entitlements "$1"
}
sign "$app/PlugIns/HatbotShare.appex" Share/HatbotShare.entitlements
sign "$app/PlugIns/HatbotWidgets.appex" Widgets/HatbotWidgets.entitlements
sign "$app" Hatbot/Hatbot.entitlements
(cd build && zip -qry Hatbot.ipa Payload)
echo "Built $(pwd)/build/Hatbot.ipa"
