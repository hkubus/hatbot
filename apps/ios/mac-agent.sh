#!/usr/bin/env bash
# An Xcode build phase: builds the agent that lets Hatbot use this Mac (hatbot-agent, from
# apps/desktop/agent) into the Mac app, next to its executable and signed like it. Does nothing for iOS.
set -euo pipefail
[ "${IS_MACCATALYST:-NO}" = YES ] || [ "${EFFECTIVE_PLATFORM_NAME:-}" = -maccatalyst ] || exit 0

cargo=$(command -v cargo || echo "$HOME/.cargo/bin/cargo")
[ -x "$cargo" ] || { echo "error: The Mac app's agent is built with Rust, which is missing: https://rustup.rs" >&2; exit 1; }

cd "$SRCROOT/../desktop"
built=()
for arch in $ARCHS; do
  case $arch in
    arm64) triple=aarch64-apple-darwin ;;
    x86_64) triple=x86_64-apple-darwin ;;
    *) echo "error: The Mac app's agent can't be built for $arch." >&2; exit 1 ;;
  esac
  # Xcode's own settings are for the iPad app; the agent is a Mac program, for the Macs the app runs on.
  env -u IPHONEOS_DEPLOYMENT_TARGET MACOSX_DEPLOYMENT_TARGET=15.0 \
    "$cargo" build --release --locked -p hatbot-agent --bin hatbot-agent --target "$triple"
  built+=("target/$triple/release/hatbot-agent")
done

dest="$TARGET_BUILD_DIR/$EXECUTABLE_FOLDER_PATH/hatbot-agent"
lipo -create "${built[@]}" -output "$dest"
if [ "${CODE_SIGNING_ALLOWED:-NO}" = YES ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
  codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --identifier "$PRODUCT_BUNDLE_IDENTIFIER.agent" \
    --timestamp=none "$dest"
fi
