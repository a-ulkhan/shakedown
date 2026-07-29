---
name: setup
description: Set up shakedown for the current app repo — check tooling, detect the project, write the app profile (.shakedown/config.json). Use when the user says "set up shakedown", "shakedown init", or shakedown commands fail with a missing profile.
---

# shakedown setup

Prepare the current repo for shakedown runs.

## 1. Tooling preflight

Check and report each of:

```bash
shakedown --version              # the CLI itself (install: npm install -g shakedown, or npm link from a checkout)
axe --version                    # iOS driving (install: brew install cameroncooke/axe/axe)
xcrun simctl help > /dev/null    # iOS simulators
adb version                      # Android driving (or standard SDK path: ~/Library/Android/sdk)
```

Missing iOS tooling only matters if the user wants iOS, same for Android. Report what works, offer install commands for what does not.

## 2. Detect the project

- iOS: look for `*.xcworkspace` / `*.xcodeproj`; find the bundle id in project settings or ask.
- Android: look for `settings.gradle*`; find the applicationId in `app/build.gradle*` or ask.
- A repo can have both (monorepo) or neither (user points at artifacts instead).

## 3. Write the app profile

Create `.shakedown/config.json` (committable — no machine-specific paths, no secrets):

```json
{
  "ios": {
    "appId": "com.example.demo",
    "buildCommand": "xcodebuild -workspace Demo.xcworkspace -scheme Demo -configuration Debug -sdk iphonesimulator -derivedDataPath build",
    "artifactPath": "build/Build/Products/Debug-iphonesimulator/Demo.app",
    "device": "iPhone 17"
  },
  "android": {
    "appId": "com.example.demo",
    "buildCommand": "./gradlew assembleDebug",
    "artifactPath": "app/build/outputs/apk/debug/app-debug.apk",
    "device": "Pixel_9"
  }
}
```

Machine-specific overrides (custom build queues, personal device choices) go in `.shakedown/config.local.json` — same shape, merged over the base, and it must be gitignored. If the user wants to keep maps out of the repo (team hasn't adopted shakedown yet), set `"mapStore": "user"` there — map writes then go to `~/.shakedown/maps/<appId>/`, and `shakedown map promote` moves them into the repo later. Add `.shakedown/runs/` and `.shakedown/state/` and `.shakedown/config.local.json` to the repo's .gitignore if missing; `.shakedown/maps/` and `config.json` stay committable.

Confirm values with the user before writing; do not guess bundle ids silently.

## 4. Smoke test

```bash
shakedown devices
shakedown app build --platform <p>        # only with user consent — builds can be slow
shakedown boot --platform <p> --device <name>
shakedown app install --platform <p> --device <id>
shakedown app launch --platform <p> --device <id>
shakedown ui screenshot --platform <p> --device <id> --out /tmp/shakedown-setup-check.png
```

Show the screenshot to the user to prove the loop works end to end. Then suggest `/shakedown:map` to start building the navigation map.
