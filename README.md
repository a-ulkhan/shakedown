# shakedown

Agentic manual-test automation for mobile apps. Describe a manual test case in plain language, and an AI agent runs it on an iOS simulator or Android emulator, verifies each step, and hands you the evidence: step screenshots, a full screen recording, and a pass/fail report.

The trick that makes this reliable is a **persistent navigation map**: a per-app UI transition graph that remembers how to get anywhere in your app ("Loans screen: tap Loans in the More menu; More menu: last tab on Home"). The agent explores once, remembers forever, and self-heals the map when your app changes.

## Status

Early. Phase 1 (of 5) is done:

- [x] **P1 — substrate**: unified iOS/Android driver CLI, navigation map store + route resolver
- [ ] P2 — `/goto` skill with self-healing navigation
- [ ] P3 — `/test` skill: scenario runner with evidence capture
- [ ] P4 — `/map` skill: autonomous app exploration
- [ ] P5 — polish, demo app, plugin marketplace

## How it works

```
scenario ("verify the Arabic headline aligns with the logo on the Welcome screen")
  → resolve route via the navigation map (BFS to the target screen)
  → drive the simulator/emulator (AXe on iOS, adb on Android)
  → verify each step:
      accessibility assertions   (element present, label text)   fast, deterministic
      visual checks              (the agent reads the screenshot) for what the AX tree can't see
  → capture evidence (step screenshots + full recording + JSON report)
  → self-heal: mismatches re-read the screen, patch the map, log the drift
```

No Appium, no instrumentation, no test framework in your app. First-party tooling only:

| | iOS | Android |
|---|---|---|
| UI tree | [AXe](https://github.com/cameroncooke/AXe) `describe-ui` | `uiautomator dump` |
| Input | AXe `tap` / `type` / `swipe` | `adb shell input` |
| Screenshots | AXe `screenshot` | `adb exec-out screencap` |
| Recording | AXe `record-video` | `adb shell screenrecord` |
| Lifecycle | `xcrun simctl` | `adb` + `emulator` |

Both drivers normalize to the same `UiNode` shape, so everything above the driver layer is platform-agnostic.

## Requirements

- macOS with Xcode (for iOS) and/or Android SDK (for Android)
- Node.js 20+
- iOS: `brew install cameroncooke/axe/axe`
- Android: `adb` on PATH or a standard SDK location (`ANDROID_HOME`, `~/Library/Android/sdk`, `~/Android/Sdk`)

## Install

```bash
npm install
npm run build
npm link        # exposes the `shakedown` binary
```

## CLI

```bash
# devices
shakedown devices                        # list simulators, emulators, connected devices
shakedown boot --platform ios --device "iPhone 17"
shakedown boot --platform android --device Pixel_9

# app lifecycle
shakedown install --platform ios --device <UDID> --app path/to/My.app
shakedown launch --platform ios --device <UDID> --bundle com.example.demo

# inspect and drive (same commands, either platform)
shakedown ui describe --platform ios --device <UDID> --flat
shakedown ui find --platform android --device emulator-5554 --label "Loans"
shakedown ui tap --platform ios --device <UDID> --id id_button_login
shakedown ui type --platform android --device emulator-5554 --text "hello"
shakedown ui screenshot --platform ios --device <UDID> --out welcome.png
shakedown ui record start --platform ios --device <UDID> --out run.mp4
shakedown ui record stop  --platform ios --device <UDID>

# navigation map
shakedown map route loans --platform ios      # how do I get to the Loans screen?
shakedown map validate --file .shakedown/maps/ios.map.json
shakedown map show --platform android
```

Every command takes `--json` (or prints JSON by default where output is data), so AI agents can consume everything.

## The navigation map

Maps live in your app repo, committable and team-shareable:

```
.shakedown/maps/
├── ios.map.json        # platform-specific screens and transitions
├── android.map.json
└── shared.map.json     # optional overlay when the UX is identical; platform wins on conflict
```

A map is a directed graph. Screens carry a **signature** (a few stable accessibility ids or labels that answer "am I on this screen?"); edges carry the action that gets you from one screen to the next, plus a health state (`ok` / `stale` / `broken`) and when it was last verified:

```jsonc
{
  "app": "com.example.demo",
  "platform": "ios",
  "schema": 1,
  "anchors": ["home"],
  "screens": {
    "loans": {
      "name": "Loans",
      "signature": [{ "kind": "a11yId", "value": "id_label_loans_title" }]
    }
  },
  "edges": [
    {
      "from": "more_menu",
      "to": "loans",
      "action": { "kind": "tap", "target": { "kind": "a11yId", "value": "id_item_loans" } },
      "verified_at": "2026-07-16T12:00:00Z",
      "health": "ok"
    }
  ]
}
```

Routes are resolved by BFS (broken edges excluded, stale edges warned about), and every traversal re-verifies the edges it uses. The map gets more accurate the more you use it, which is the opposite of how UI test suites usually age.

## Claude Code plugin

The `plugin/` directory will ship skills (`/setup`, `/map`, `/goto`, `/test`, `/doctor`) and agents (explorer, runner, healer, verifier) that orchestrate the CLI. Coming in P2 to P4.

## Prior art and credits

- [DroidBot](https://github.com/honeynet/droidbot) pioneered the UI transition graph this map format descends from.
- [mobile-mcp](https://github.com/mobile-next/mobile-mcp) validated accessibility-first driving with screenshot fallback.
- [AXe](https://github.com/cameroncooke/AXe) does the heavy lifting on iOS.

## License

MIT
