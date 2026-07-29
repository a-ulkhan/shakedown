<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="shakedown" width="420">
  </picture>
</p>

# shakedown

Agentic manual-test automation for mobile apps. Describe a manual test case in plain language, and an AI agent runs it on an iOS simulator or Android emulator, verifies each step, and hands you the evidence: step screenshots, a full screen recording, and a pass/fail report.

The trick that makes this reliable is a **persistent navigation map**: a per-app UI transition graph that remembers how to get anywhere in your app ("Loans screen: tap Loans in the More menu; More menu: last tab on Home"). The agent explores once, remembers forever, and self-heals the map when your app changes.

## Status

Functional, young. All five build phases are in:

- [x] **P1 — substrate**: unified iOS/Android driver CLI, navigation map store + route resolver
- [x] **P2 — navigation**: screen recognition by signature (`screen identify`/`verify`), edge health, `/goto` skill + healer agent
- [x] **P3 — test runs**: evidence sessions (`run start/step/finish` → report.json + screenshots + recording), `/test` skill, runner + verifier agents
- [x] **P4 — exploration**: `/map` skill + explorer agent (targeted or full crawl, incremental saves)
- [x] **P5 — plugin packaging**: Claude Code marketplace manifest, worked example map ([docs/examples/ios-settings.map.json](docs/examples/ios-settings.map.json), verified live against the iOS Settings app)

Not yet battle-tested beyond the worked example. Expect edges.

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
- Optional (annotated evidence only): `brew install imagemagick ffmpeg` — `ui shot` highlights/captions need ImageMagick, `run export` needs ffmpeg. Without them, capture still works; annotation is skipped with a warning.

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

# annotated evidence — screenshot with the element highlighted + captioned by its id
shakedown ui shot --platform ios --device <UDID> --out from.png \
  --id id_button_transfers_betweenOwnFromAccount --title "From account"

# evidence runs — capture + annotate + record a step in one call, then stitch a captioned walkthrough
shakedown run start --name betweenown-ids --root .
shakedown run shot --dir <run-dir> --platform ios --device <UDID> \
  --title "From account" --outcome pass --id id_button_transfers_betweenOwnFromAccount
shakedown run export --dir <run-dir>              # -> <run-dir>/evidence.mp4  (add --gif for a GIF)

# navigation map
shakedown map route loans --platform ios      # how do I get to the Loans screen?
shakedown map validate --file .shakedown/maps/ios.map.json
shakedown map show --platform android
shakedown map promote --platform ios          # merge your private (~/.shakedown) map into the repo
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

There is also a **user-level store** at `~/.shakedown/maps/<appId>/` (override the base dir with `SHAKEDOWN_HOME`) for maps you don't want to commit — e.g. while your team hasn't adopted the tool yet. Reads always merge both stores (repo shared → repo platform → user shared → user platform, later wins), so private maps layer on top of the team map. Writes go to the repo by default; opt into the user store per machine with `"mapStore": "user"` in `.shakedown/config.local.json`, or per command with `--store user`. On adoption day, `shakedown map promote --platform ios` merges your user map into the repo files and removes the private copy (`--keep` retains it).

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

The `plugin/` directory ships five skills and four agents that orchestrate the CLI:

| Skill | Does |
|---|---|
| `/shakedown:setup` | Tooling preflight, project detection, app profile (`.shakedown/config.json`) |
| `/shakedown:map` | Explore and record screens/transitions (targeted, or full crawl with a step budget) |
| `/shakedown:goto` | Navigate to a named screen, self-healing stale edges via the healer agent |
| `/shakedown:test` | Run a manual test scenario: navigate, act, verify, capture evidence |
| `/shakedown:doctor` | Re-verify the whole map against the current build, repair drift |

Agents: **explorer** (crawls and records), **runner** (executes scenario steps, structural checks), **healer** (diagnoses and repairs dead edges), **verifier** (visual judgments on screenshots — the checks an accessibility tree cannot answer).

Install as a plugin marketplace:

```
/plugin marketplace add <this-repo-url>
/plugin install shakedown@shakedown
```

The CLI must be on PATH (`npm install -g` or `npm link`); the skills call it via Bash.

## Evidence output

Each `/test` run produces a directory under `.shakedown/runs/`:

```
.shakedown/runs/2026-07-16T12-00-00_loans-smoke/
├── report.json      # steps, outcomes, timings, self-healing map edits
├── recording.mp4    # full-run screen recording
├── 01_home.png
└── 02_loans_verified.png
```

### Rendering publishable evidence

`run render` turns a finished run into an MR-ready markdown document: a step
summary table, a compressed screen recording, and a captioned key-frame grid.

```bash
# mark the frames worth showing while you drive
shakedown run shot --dir "$RUN" --key --title "Swipe actions render" ...

# render locally (evidence.md + evidence_480p.mp4 in the run dir)
shakedown run render --dir "$RUN"

# render and upload assets, links substituted (GITLAB_TOKEN + GITLAB_URL from env)
shakedown run render --dir "$RUN" --uploader gitlab --project group/repo
```

Layout is configurable per project in `.shakedown/config.json`:

```jsonc
"evidence": {
  "styles": {
    "mr-evidence": {
      "video": { "maxWidth": 480, "fps": 12, "crf": 33 },
      "keyframes": "marked",            // or "all" | "failures-only"
      "grid": { "columns": 3, "captions": true },
      "sections": ["summary-table", "video", "keyframe-grid", "failures"]
    }
  }
}
```

Pick a style with `--style mr-evidence`, or pass `--template file.md` with
`{{name}}`, `{{status}}`, `{{summary-table}}`, `{{video}}`, `{{keyframe-grid}}`
and `{{failures}}` placeholders for a fully custom layout. Uploaders are
pluggable; GitLab (project uploads API) ships first.

## Prior art and credits

- [DroidBot](https://github.com/honeynet/droidbot) pioneered the UI transition graph this map format descends from.
- [mobile-mcp](https://github.com/mobile-next/mobile-mcp) validated accessibility-first driving with screenshot fallback.
- [AXe](https://github.com/cameroncooke/AXe) does the heavy lifting on iOS.

## License

MIT
