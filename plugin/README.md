# shakedown Claude Code plugin

Skills and agents that orchestrate the `shakedown` CLI. Ships in phases P2 to P4.

Planned skills:

| Skill | What it does |
|---|---|
| `/setup` | Detect the app project (xcworkspace / gradle), write the app profile (bundle id, build command, device preferences) |
| `/map <screen>` \| `/map --full` | Explorer agent crawls the app, names screens, records transitions into the navigation map. `--full` asks before a whole-app crawl and saves incrementally |
| `/goto <screen>` | Resolve a route from the map, drive there, self-heal stale edges on the way |
| `/test <scenario>` | Run a manual test described in plain language: navigate, verify (accessibility + visual), capture screenshots and a recording, emit a report |
| `/doctor` | Re-verify every map edge against the current build, print a drift summary |

Planned agents: explorer, runner, healer, verifier.
