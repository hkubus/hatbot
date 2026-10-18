# Hatbot for iOS

A native SwiftUI app for Hatbot (PLAN.md §4.7), installed with SideStore. It talks to the brain's
API with a bearer token. Notifications still come from the ntfy app.

- `Hatbot/Core`: Foundation only. API types, the API client, the reconnecting WebSocket, the live
  store, Markdown blocks, cron in words. `Package.swift` builds it on its own so it compiles and
  tests anywhere Swift runs.
- `Hatbot/Views`, `Hatbot/App`: SwiftUI and UIKit. Chat, Search, Tasks, To-do, Live, Memory and Settings;
  Schedules & Triggers, Watchers, Check everything and the Heartbeat open from Settings. Siri and
  Shortcuts actions are in `Hatbot/App/Intents.swift`.
- `Share`: the share extension. It sends what you share, with a note, to Hatbot's chat.
- `Widgets`: the home-screen widget (today's spend and what needs you) and the Pause all control.
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
`swift test -Xswiftc -use-ld=lld`. Without a toolchain, use Docker:

```sh
cd apps/ios && docker run --rm -v "$PWD":/src -w /src -e HOME=/tmp --user "$(id -u):$(id -g)" \
  swift:6.1 swift test --scratch-path /tmp/build
```

SwiftUI isn't there on Linux: `swiftc -parse Hatbot/Views/*.swift` checks the views' syntax, and CI builds them.

## Sign in

Enter the brain's address (`hatbot.example.com`), your password and a TOTP code. The app gets its
own API token, named after the device; it shows in Settings → API tokens on the web, and signing out
of the app deletes it.

The address must be https, on the LAN too: the token goes with every request, and a phone joins
networks you don't control. The app, the widget and the share extension refuse http. For a brain
reached only on the LAN, put it behind a certificate the iPhone trusts: Caddy's internal CA (install
its root certificate as a profile, then turn on full trust in Settings → General → About →
Certificate Trust Settings), or Tailscale with `tailscale cert` for the brain's `*.ts.net` name.

## Siri, Shortcuts and the share sheet

Shortcuts has four Hatbot actions, and Siri knows them without setup:

- **Ask Hatbot** ("Ask Hatbot"): sends the question to Hatbot's chat, or another bot's or a group's,
  and answers with the reply. It waits up to 25 seconds; a longer answer is in the chat.
- **Give Hatbot a Task** ("Give Hatbot a task"): starts a background task, like `/task` in the chat.
- **Add a To-do** ("Add a to-do in Hatbot"): adds an item to the to-do list, with a day it's due if
  you give one.
- **Send to Hatbot**: text and files into the chat. Photos go up as JPEG.

On a locked iPhone they ask you to unlock it first, and so does Pause Hatbot.

**Hatbot** in the share sheet sends text, links, photos and files (up to 10, each up to 25 MB) with a
note; a bigger file is left out, and it says so. It reads
the token from the App Group the app shares with it (`group.<prefix>.hatbot`; SideStore adds your
team ID to the name), so open the app once after updating. If the share sheet says to sign in, the
group wasn't set up by the install; the rest of the app works without it.

The share extension and the widgets are App IDs of their own: with a free Apple ID SideStore has 10
App IDs a week, so Hatbot takes 3 of them.

The widget, small or medium, shows today's spend against the daily limit (and the month's, medium)
and how many things need you; iOS refreshes it about every 15 minutes, and the app when they change.
**Pause Hatbot** in Control Center pauses all, or resumes.

## Links

`hatbot://tasks/<id>` opens a task, `hatbot://approvals/<id>` the task an approval belongs to, and
`hatbot://schedules/<id>` and `hatbot://triggers/<id>` their pages. Notifications use them when
Settings → Notifications says this app. `hatbot://new`, `hatbot://live` and `hatbot://tasks` are the
home-screen quick actions, and `hatbot://memory/<path>` opens a memory file, as Spotlight does.
