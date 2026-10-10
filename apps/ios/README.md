# Hatbot for iOS

A native SwiftUI app for Hatbot (PLAN.md §4.6), installed with SideStore. It talks to the brain's
API with a bearer token. Notifications still come from the ntfy app.

- `Hatbot/Core`: Foundation only. API types, the API client, the reconnecting WebSocket, the live
  store, Markdown blocks, cron in words. `Package.swift` builds it on its own so it compiles and
  tests anywhere Swift runs.
- `Hatbot/Views`, `Hatbot/App`: SwiftUI and UIKit. Chat, Tasks, Live and Settings tabs.
- `project.yml`: the Xcode project, generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen).

## Install with SideStore

The iOS workflow on the GitHub mirror builds the app for every change. On `main` it publishes the
IPA and a SideStore source to GitHub Pages. In SideStore, add the source
`https://hkubus.github.io/hatbot/source.json` and install Hatbot from it; new builds show up there
as updates. SideStore signs the app with your Apple ID. With a free Apple ID it refreshes the app
every 7 days.

Builds of other branches are artifacts on the workflow run.

## Build an IPA on a Mac

```sh
brew install xcodegen
apps/ios/build-ipa.sh        # → apps/ios/build/Hatbot.ipa, unsigned
```

To work on it in Xcode: `cd apps/ios && xcodegen generate && open Hatbot.xcodeproj`.

## Test the core (Mac or Linux)

```sh
cd apps/ios && swift test
```

On Linux, Swift 6.1's `libswiftObservation.so` doesn't link with GNU ld; use
`swift test -Xswiftc -use-ld=lld`.

## Sign in

Enter the brain's address (`hatbot.gaycats.ovh`, or `http://192.168.55.<id>:8080` on the LAN),
your password and a TOTP code. The app gets its own API token, named after the device; it shows in
Settings → API tokens on the web, and signing out of the app deletes it.

## Links

`hatbot://tasks/<id>` opens a task, and `hatbot://approvals/<id>` opens the task an approval
belongs to.
