#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import { platformProfile } from '../config.js'
import { getDriver, parsePlatform } from '../drivers/index.js'
import { findAll } from '../drivers/query.js'
import type { ElementSelector, Platform, UiNode } from '../drivers/types.js'
import { stitchFrames } from '../evidence/annotate.js'
import { captureAnnotatedShot } from '../evidence/capture.js'
import { resolveRoute, renderRouteReverse } from '../map/route.js'
import { identifyScreen, verifyScreen } from '../map/signature.js'
import { defaultMapPath, loadEffectiveMap, loadMap, saveMap, validateMap } from '../map/store.js'
import type { EdgeHealth } from '../map/types.js'
import { saveRecordingHandle, takeRecordingHandle } from '../run/recording-state.js'
import { appendStep, finishRun, loadRun, recordMapEdit, startRun } from '../run/session.js'
import type { RunStatus, StepOutcome } from '../run/session.js'

const program = new Command()
  .name('shakedown')
  .description(
    'Agentic manual-test automation for iOS simulators and Android emulators: ' +
      'persistent navigation maps, self-healing runs, evidence capture.'
  )
  .version('0.1.0')

interface PlatformDeviceOpts {
  platform: string
  device: string
  json?: boolean
}

function output(json: boolean | undefined, data: unknown, human?: () => void): void {
  if (json || !human) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    human()
  }
}

function fail(error: unknown): never {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// devices / boot / app lifecycle

program
  .command('devices')
  .description('List simulators, emulators, and connected devices')
  .option('--platform <platform>', 'ios | android (default: both)')
  .option('--json', 'JSON output')
  .action(async (opts: { platform?: string; json?: boolean }) => {
    try {
      const platforms: Platform[] = opts.platform
        ? [parsePlatform(opts.platform)]
        : ['ios', 'android']
      const all = (
        await Promise.all(
          platforms.map(async (platform) => {
            try {
              return await getDriver(platform).listDevices()
            } catch {
              return [] // missing toolchain for one platform should not hide the other
            }
          })
        )
      ).flat()
      output(opts.json, all, () => {
        for (const device of all) {
          console.log(`${device.state === 'booted' ? '●' : '○'} ${device.platform}  ${device.name}  ${device.id}${device.os ? `  (${device.os})` : ''}`)
        }
        if (all.length === 0) console.log('no devices found')
      })
    } catch (error) {
      fail(error)
    }
  })

program
  .command('boot')
  .description('Boot a simulator/emulator and wait until ready')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <idOrName>', 'device UDID/serial or name/AVD')
  .option('--json', 'JSON output')
  .action(async (opts: PlatformDeviceOpts) => {
    try {
      const device = await getDriver(parsePlatform(opts.platform)).boot(opts.device)
      output(opts.json, device, () => console.log(`booted ${device.name} (${device.id})`))
    } catch (error) {
      fail(error)
    }
  })

program
  .command('install')
  .description('Install an app (.app dir for iOS, .apk for Android)')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--app <path>', 'path to .app / .apk')
  .action(async (opts: PlatformDeviceOpts & { app: string }) => {
    try {
      await getDriver(parsePlatform(opts.platform)).install(opts.device, opts.app)
      console.log('installed')
    } catch (error) {
      fail(error)
    }
  })

program
  .command('launch')
  .description('Launch an app by bundle id / package name')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--bundle <id>', 'bundle id / package name')
  .action(async (opts: PlatformDeviceOpts & { bundle: string }) => {
    try {
      await getDriver(parsePlatform(opts.platform)).launch(opts.device, opts.bundle)
      console.log('launched')
    } catch (error) {
      fail(error)
    }
  })

program
  .command('terminate')
  .description('Terminate a running app')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--bundle <id>', 'bundle id / package name')
  .action(async (opts: PlatformDeviceOpts & { bundle: string }) => {
    try {
      await getDriver(parsePlatform(opts.platform)).terminate(opts.device, opts.bundle)
      console.log('terminated')
    } catch (error) {
      fail(error)
    }
  })

// ---------------------------------------------------------------------------
// ui

const ui = program.command('ui').description('Inspect and drive the current screen')

function selectorFromOpts(opts: {
  id?: string
  label?: string
  value?: string
  type?: string
}): ElementSelector {
  return {
    ...(opts.id !== undefined && { identifier: opts.id }),
    ...(opts.label !== undefined && { label: opts.label }),
    ...(opts.value !== undefined && { value: opts.value }),
    ...(opts.type !== undefined && { type: opts.type }),
  }
}

ui.command('describe')
  .description('Dump the normalized accessibility tree (same shape on both platforms)')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .option('--flat', 'flatten to a list of nodes with frames')
  .action(async (opts: PlatformDeviceOpts & { flat?: boolean }) => {
    try {
      const roots = await getDriver(parsePlatform(opts.platform)).describeUi(opts.device)
      const data = opts.flat ? flatten(roots) : roots
      console.log(JSON.stringify(data, null, 2))
    } catch (error) {
      fail(error)
    }
  })

ui.command('find')
  .description('Find elements by selector; prints matches with frames and centers')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .option('--id <identifier>', 'accessibility identifier / resource-id')
  .option('--label <label>', 'accessibility label / content-desc')
  .option('--value <value>', 'element value / text')
  .option('--type <type>', 'element type (Button, TextField, ...)')
  .action(async (opts: PlatformDeviceOpts & { id?: string; label?: string; value?: string; type?: string }) => {
    try {
      const roots = await getDriver(parsePlatform(opts.platform)).describeUi(opts.device)
      const matches = findAll(roots, selectorFromOpts(opts)).map((node) => ({
        ...node,
        children: undefined,
        center: {
          x: Math.round(node.frame.x + node.frame.width / 2),
          y: Math.round(node.frame.y + node.frame.height / 2),
        },
      }))
      console.log(JSON.stringify(matches, null, 2))
    } catch (error) {
      fail(error)
    }
  })

ui.command('tap')
  .description('Tap by coordinates or by accessibility selector')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .option('-x <x>', 'x coordinate')
  .option('-y <y>', 'y coordinate')
  .option('--id <identifier>', 'accessibility identifier / resource-id')
  .option('--label <label>', 'accessibility label / content-desc')
  .option('--value <value>', 'element value / text')
  .option('--type <type>', 'narrow selector matches by element type')
  .action(async (opts: PlatformDeviceOpts & { x?: string; y?: string; id?: string; label?: string; value?: string; type?: string }) => {
    try {
      const driver = getDriver(parsePlatform(opts.platform))
      if (opts.x !== undefined && opts.y !== undefined) {
        await driver.tap(opts.device, { x: Number(opts.x), y: Number(opts.y) })
      } else {
        await driver.tap(opts.device, selectorFromOpts(opts))
      }
      console.log('tapped')
    } catch (error) {
      fail(error)
    }
  })

ui.command('type')
  .description('Type text into the focused field')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--text <text>', 'text to type')
  .action(async (opts: PlatformDeviceOpts & { text: string }) => {
    try {
      await getDriver(parsePlatform(opts.platform)).typeText(opts.device, opts.text)
      console.log('typed')
    } catch (error) {
      fail(error)
    }
  })

ui.command('swipe')
  .description('Swipe between two points')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--from-x <n>').requiredOption('--from-y <n>')
  .requiredOption('--to-x <n>').requiredOption('--to-y <n>')
  .option('--duration <ms>', 'duration in milliseconds', '300')
  .action(async (opts: PlatformDeviceOpts & { fromX: string; fromY: string; toX: string; toY: string; duration: string }) => {
    try {
      await getDriver(parsePlatform(opts.platform)).swipe(
        opts.device,
        { x: Number(opts.fromX), y: Number(opts.fromY) },
        { x: Number(opts.toX), y: Number(opts.toY) },
        Number(opts.duration)
      )
      console.log('swiped')
    } catch (error) {
      fail(error)
    }
  })

ui.command('screenshot')
  .description('Capture a screenshot (PNG)')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--out <path>', 'output PNG path')
  .action(async (opts: PlatformDeviceOpts & { out: string }) => {
    try {
      const path = await getDriver(parsePlatform(opts.platform)).screenshot(opts.device, opts.out)
      console.log(path)
    } catch (error) {
      fail(error)
    }
  })

ui.command('shot')
  .description('Screenshot with an optional element highlight + caption (annotated evidence frame). Uses ImageMagick; without it, saves a raw screenshot.')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--out <path>', 'output PNG path')
  .option('--id <identifier>', 'highlight the element with this accessibility id')
  .option('--label <label>', 'highlight the element with this label')
  .option('--value <value>', 'highlight the element with this value')
  .option('--type <type>', 'narrow the highlighted element by type')
  .option('--title <text>', 'caption title (default: the selector id/label)')
  .action(async (opts: PlatformDeviceOpts & { out: string; id?: string; label?: string; value?: string; type?: string; title?: string }) => {
    try {
      const driver = getDriver(parsePlatform(opts.platform))
      const selector = selectorFromOpts(opts)
      const result = await captureAnnotatedShot(driver, opts.device, opts.out, {
        ...(Object.keys(selector).length > 0 && { selector }),
        ...(opts.title !== undefined && { title: opts.title }),
      })
      if (result.warning) console.error(`warning: ${result.warning}`)
      console.log(result.path)
    } catch (error) {
      fail(error)
    }
  })

const record = ui.command('record').description('Screen recording (start/stop across invocations)')

record
  .command('start')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--out <path>', 'output MP4 path')
  .action(async (opts: PlatformDeviceOpts & { out: string }) => {
    try {
      const handle = await getDriver(parsePlatform(opts.platform)).startRecording(opts.device, opts.out)
      await saveRecordingHandle(process.cwd(), handle)
      console.log(`recording (pid ${handle.pid}) → ${handle.outputPath}`)
    } catch (error) {
      fail(error)
    }
  })

record
  .command('stop')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .action(async (opts: PlatformDeviceOpts) => {
    try {
      const handle = await takeRecordingHandle(process.cwd(), opts.device)
      const path = await getDriver(parsePlatform(opts.platform)).stopRecording(handle)
      console.log(path)
    } catch (error) {
      fail(error)
    }
  })

// ---------------------------------------------------------------------------
// map

const map = program.command('map').description('Query and maintain the navigation map')

map
  .command('route <screen>')
  .description('Resolve the path to a screen (from an anchor or --from)')
  .requiredOption('--platform <platform>', 'ios | android')
  .option('--from <screen>', 'start from this screen instead of an anchor')
  .option('--root <dir>', 'app repo root containing .shakedown/maps', process.cwd())
  .option('--json', 'JSON output')
  .action(async (screen: string, opts: { platform: string; from?: string; root: string; json?: boolean }) => {
    try {
      const nav = await loadEffectiveMap(opts.root, parsePlatform(opts.platform))
      const route = resolveRoute(nav, screen, opts.from)
      output(opts.json, route, () => {
        console.log(`route to "${screen}" from "${route.start}" (${route.steps.length} steps):`)
        for (const line of renderRouteReverse(nav, route)) console.log(`  ${line}`)
        for (const warning of route.warnings) console.log(`  ! ${warning}`)
      })
    } catch (error) {
      fail(error)
    }
  })

map
  .command('show')
  .description('Print the effective (merged) map for a platform')
  .requiredOption('--platform <platform>', 'ios | android')
  .option('--root <dir>', 'app repo root containing .shakedown/maps', process.cwd())
  .action(async (opts: { platform: string; root: string }) => {
    try {
      const nav = await loadEffectiveMap(opts.root, parsePlatform(opts.platform))
      console.log(JSON.stringify(nav, null, 2))
    } catch (error) {
      fail(error)
    }
  })

map
  .command('validate')
  .description('Validate a map file (dangling edges, unreachable screens, missing signatures)')
  .requiredOption('--file <path>', 'map file to validate')
  .option('--json', 'JSON output')
  .action(async (opts: { file: string; json?: boolean }) => {
    try {
      const nav = await loadMap(opts.file)
      const issues = validateMap(nav)
      output(opts.json, issues, () => {
        if (issues.length === 0) {
          console.log('map is valid')
          return
        }
        for (const issue of issues) console.log(`${issue.severity}: ${issue.message}`)
      })
      if (issues.some((issue) => issue.severity === 'error')) process.exit(1)
    } catch (error) {
      fail(error)
    }
  })

map
  .command('upsert')
  .description('Merge a partial map (screens/edges/anchors JSON on stdin) into a map file')
  .requiredOption('--file <path>', 'target map file (created if missing)')
  .requiredOption('--app <id>', 'app id, used when creating a new map')
  .requiredOption('--platform <platform>', 'ios | android | shared')
  .action(async (opts: { file: string; app: string; platform: string }) => {
    try {
      const stdin = await readStdin()
      const partial = JSON.parse(stdin) as {
        anchors?: string[]
        screens?: NavigationMapScreens
        edges?: NavigationMapEdges
      }
      const { existsSync } = await import('node:fs')
      const { emptyMap } = await import('../map/store.js')
      const platform = opts.platform === 'shared' ? 'shared' : parsePlatform(opts.platform)
      const current = existsSync(opts.file) ? await loadMap(opts.file) : emptyMap(opts.app, platform)

      current.anchors = [...new Set([...current.anchors, ...(partial.anchors ?? [])])]
      Object.assign(current.screens, partial.screens ?? {})
      for (const edge of partial.edges ?? []) {
        const index = current.edges.findIndex(
          (existing) =>
            existing.from === edge.from &&
            existing.to === edge.to &&
            existing.action.kind === edge.action.kind
        )
        if (index >= 0) current.edges[index] = edge
        else current.edges.push(edge)
      }
      await saveMap(opts.file, current)
      console.log(`saved ${opts.file} (${Object.keys(current.screens).length} screens, ${current.edges.length} edges)`)
    } catch (error) {
      fail(error)
    }
  })

map
  .command('path')
  .description('Print the default map file path for a platform')
  .requiredOption('--platform <platform>', 'ios | android | shared')
  .option('--root <dir>', 'app repo root', process.cwd())
  .action((opts: { platform: string; root: string }) => {
    const platform = opts.platform === 'shared' ? 'shared' : parsePlatform(opts.platform)
    console.log(defaultMapPath(opts.root, platform))
  })

map
  .command('set-health')
  .description('Update an edge health state (used by self-healing)')
  .requiredOption('--file <path>', 'map file to edit')
  .requiredOption('--from <screen>').requiredOption('--to <screen>')
  .option('--kind <kind>', 'action kind of the edge', 'tap')
  .requiredOption('--health <health>', 'ok | stale | broken')
  .option('--verified-now', 'stamp verified_at with the current time')
  .option('--app-version <version>', 'stamp the app version the edge was verified against')
  .action(async (opts: { file: string; from: string; to: string; kind: string; health: string; verifiedNow?: boolean; appVersion?: string }) => {
    try {
      if (!['ok', 'stale', 'broken'].includes(opts.health)) {
        throw new Error(`invalid health "${opts.health}"`)
      }
      const nav = await loadMap(opts.file)
      const edge = nav.edges.find(
        (candidate) =>
          candidate.from === opts.from &&
          candidate.to === opts.to &&
          candidate.action.kind === opts.kind
      )
      if (!edge) throw new Error(`no ${opts.kind} edge ${opts.from} → ${opts.to} in ${opts.file}`)
      edge.health = opts.health as EdgeHealth
      if (opts.verifiedNow) edge.verified_at = new Date().toISOString()
      if (opts.appVersion) edge.app_version = opts.appVersion
      await saveMap(opts.file, nav)
      console.log(`edge ${opts.from} → ${opts.to}: health=${edge.health}`)
    } catch (error) {
      fail(error)
    }
  })

// ---------------------------------------------------------------------------
// screen — recognition against the map

const screen = program.command('screen').description('Recognize the current screen using map signatures')

screen
  .command('identify')
  .description('Rank map screens by how well the current UI matches them')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .option('--root <dir>', 'app repo root containing .shakedown/maps', process.cwd())
  .option('--top <n>', 'how many candidates to print', '3')
  .action(async (opts: PlatformDeviceOpts & { root: string; top: string }) => {
    try {
      const platform = parsePlatform(opts.platform)
      const nav = await loadEffectiveMap(opts.root, platform)
      const roots = await getDriver(platform).describeUi(opts.device)
      const matches = identifyScreen(nav, roots).slice(0, Number(opts.top))
      console.log(JSON.stringify(matches, null, 2))
    } catch (error) {
      fail(error)
    }
  })

screen
  .command('verify <screenId>')
  .description('Check whether the current UI matches a specific screen signature (exit 1 if not)')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .option('--root <dir>', 'app repo root containing .shakedown/maps', process.cwd())
  .action(async (screenId: string, opts: PlatformDeviceOpts & { root: string }) => {
    try {
      const platform = parsePlatform(opts.platform)
      const nav = await loadEffectiveMap(opts.root, platform)
      const roots = await getDriver(platform).describeUi(opts.device)
      const result = verifyScreen(nav, screenId, roots)
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exit(1)
    } catch (error) {
      fail(error)
    }
  })

// ---------------------------------------------------------------------------
// run — evidence sessions

const runCmd = program.command('run').description('Evidence run sessions (report.json + screenshots)')

runCmd
  .command('start')
  .requiredOption('--name <name>', 'human name of the scenario')
  .option('--platform <platform>').option('--device <id>')
  .option('--root <dir>', 'app repo root', process.cwd())
  .action(async (opts: { name: string; platform?: string; device?: string; root: string }) => {
    try {
      const { dir } = await startRun(opts.root, opts.name, {
        ...(opts.platform !== undefined && { platform: opts.platform }),
        ...(opts.device !== undefined && { device: opts.device }),
      })
      console.log(JSON.stringify({ dir }, null, 2))
    } catch (error) {
      fail(error)
    }
  })

runCmd
  .command('step')
  .requiredOption('--dir <dir>', 'run directory from `run start`')
  .requiredOption('--title <title>', 'what this step did or checked')
  .requiredOption('--outcome <outcome>', 'pass | fail | info')
  .option('--screenshot <path>', 'screenshot evidencing the step')
  .option('--detail <json>', 'extra structured detail')
  .action(async (opts: { dir: string; title: string; outcome: string; screenshot?: string; detail?: string }) => {
    try {
      if (!['pass', 'fail', 'info'].includes(opts.outcome)) {
        throw new Error(`invalid outcome "${opts.outcome}"`)
      }
      const step = await appendStep(opts.dir, {
        title: opts.title,
        outcome: opts.outcome as StepOutcome,
        ...(opts.screenshot !== undefined && { screenshot: opts.screenshot }),
        ...(opts.detail !== undefined && { detail: JSON.parse(opts.detail) as unknown }),
      })
      console.log(JSON.stringify(step, null, 2))
    } catch (error) {
      fail(error)
    }
  })

runCmd
  .command('map-edit')
  .description('Record a self-healing map edit made during this run')
  .requiredOption('--dir <dir>').requiredOption('--description <text>')
  .action(async (opts: { dir: string; description: string }) => {
    try {
      await recordMapEdit(opts.dir, opts.description)
      console.log('recorded')
    } catch (error) {
      fail(error)
    }
  })

runCmd
  .command('finish')
  .requiredOption('--dir <dir>', 'run directory')
  .requiredOption('--status <status>', 'pass | fail | aborted')
  .option('--summary <text>')
  .option('--recording <path>', 'path to the run screen recording')
  .action(async (opts: { dir: string; status: string; summary?: string; recording?: string }) => {
    try {
      if (!['pass', 'fail', 'aborted'].includes(opts.status)) {
        throw new Error(`invalid status "${opts.status}"`)
      }
      const report = await finishRun(opts.dir, opts.status as Exclude<RunStatus, 'running'>, {
        ...(opts.summary !== undefined && { summary: opts.summary }),
        ...(opts.recording !== undefined && { recording: opts.recording }),
      })
      console.log(JSON.stringify(report, null, 2))
    } catch (error) {
      fail(error)
    }
  })

runCmd
  .command('show')
  .requiredOption('--dir <dir>', 'run directory')
  .action(async (opts: { dir: string }) => {
    try {
      console.log(JSON.stringify(await loadRun(opts.dir), null, 2))
    } catch (error) {
      fail(error)
    }
  })

runCmd
  .command('shot')
  .description('Capture an annotated step screenshot into the run and record the step in one call')
  .requiredOption('--dir <dir>', 'run directory from `run start`')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .requiredOption('--title <title>', 'what this step shows (also the caption)')
  .option('--outcome <outcome>', 'pass | fail | info', 'info')
  .option('--id <identifier>', 'highlight the element with this accessibility id')
  .option('--label <label>', 'highlight the element with this label')
  .option('--value <value>', 'highlight the element with this value')
  .option('--type <type>', 'narrow the highlighted element by type')
  .action(async (opts: PlatformDeviceOpts & { dir: string; title: string; outcome: string; id?: string; label?: string; value?: string; type?: string }) => {
    try {
      if (!['pass', 'fail', 'info'].includes(opts.outcome)) {
        throw new Error(`invalid outcome "${opts.outcome}"`)
      }
      const report = await loadRun(opts.dir)
      const index = report.steps.length + 1
      const file = join(opts.dir, `step-${String(index).padStart(2, '0')}.png`)
      const driver = getDriver(parsePlatform(opts.platform))
      const selector = selectorFromOpts(opts)
      const result = await captureAnnotatedShot(driver, opts.device, file, {
        ...(Object.keys(selector).length > 0 && { selector }),
        title: opts.title,
      })
      if (result.warning) console.error(`warning: ${result.warning}`)
      const step = await appendStep(opts.dir, {
        title: opts.title,
        outcome: opts.outcome as StepOutcome,
        screenshot: file,
        detail: { annotated: result.annotated, ...selector },
      })
      console.log(JSON.stringify(step, null, 2))
    } catch (error) {
      fail(error)
    }
  })

runCmd
  .command('export')
  .description("Stitch a run's step screenshots into a captioned walkthrough (MP4 or GIF). Needs ffmpeg.")
  .requiredOption('--dir <dir>', 'run directory from `run start`')
  .option('--out <path>', 'output file (default: <dir>/evidence.mp4 or .gif)')
  .option('--seconds <n>', 'seconds per step', '3')
  .option('--gif', 'export an animated GIF instead of MP4')
  .action(async (opts: { dir: string; out?: string; seconds: string; gif?: boolean }) => {
    try {
      const report = await loadRun(opts.dir)
      const frames = report.steps
        .filter((step) => step.screenshot)
        .map((step) => {
          const shot = step.screenshot as string
          const candidate = resolve(opts.dir, shot)
          return { path: existsSync(candidate) ? candidate : shot, seconds: Number(opts.seconds) }
        })
        .filter((frame) => existsSync(frame.path))
      if (frames.length === 0) throw new Error('no step screenshots to export in this run')
      const out = opts.out ?? join(opts.dir, opts.gif ? 'evidence.gif' : 'evidence.mp4')
      await stitchFrames({ frames, out, ...(opts.gif !== undefined && { gif: opts.gif }) })
      console.log(out)
    } catch (error) {
      fail(error)
    }
  })

// ---------------------------------------------------------------------------
// app — profile-driven build / install / launch

const app = program.command('app').description('Build, install, and launch using the app profile (.shakedown/config.json)')

app
  .command('build')
  .requiredOption('--platform <platform>', 'ios | android')
  .option('--root <dir>', 'app repo root', process.cwd())
  .action(async (opts: { platform: string; root: string }) => {
    try {
      const profile = await platformProfile(opts.root, parsePlatform(opts.platform))
      if (!profile.buildCommand) {
        throw new Error(`no buildCommand in the ${opts.platform} app profile`)
      }
      const code = await runShell(profile.buildCommand, opts.root)
      process.exit(code)
    } catch (error) {
      fail(error)
    }
  })

app
  .command('install')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .option('--root <dir>', 'app repo root', process.cwd())
  .action(async (opts: PlatformDeviceOpts & { root: string }) => {
    try {
      const platform = parsePlatform(opts.platform)
      const profile = await platformProfile(opts.root, platform)
      if (!profile.artifactPath) {
        throw new Error(`no artifactPath in the ${opts.platform} app profile`)
      }
      await getDriver(platform).install(opts.device, profile.artifactPath)
      console.log('installed')
    } catch (error) {
      fail(error)
    }
  })

app
  .command('launch')
  .requiredOption('--platform <platform>', 'ios | android')
  .requiredOption('--device <id>', 'device UDID/serial')
  .option('--root <dir>', 'app repo root', process.cwd())
  .action(async (opts: PlatformDeviceOpts & { root: string }) => {
    try {
      const platform = parsePlatform(opts.platform)
      const profile = await platformProfile(opts.root, platform)
      await getDriver(platform).launch(opts.device, profile.appId)
      console.log(`launched ${profile.appId}`)
    } catch (error) {
      fail(error)
    }
  })

// ---------------------------------------------------------------------------

type NavigationMapScreens = import('../map/types.js').NavigationMap['screens']
type NavigationMapEdges = import('../map/types.js').NavigationMap['edges']

function runShell(command: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

function flatten(roots: UiNode[]): Array<Omit<UiNode, 'children'>> {
  const nodes: Array<Omit<UiNode, 'children'>> = []
  const visit = (node: UiNode) => {
    const { children, ...rest } = node
    nodes.push(rest)
    children.forEach(visit)
  }
  roots.forEach(visit)
  return nodes
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

program.parseAsync().catch(fail)
