#!/usr/bin/env node
import { Command } from 'commander'
import { getDriver, parsePlatform } from '../drivers/index.js'
import { findAll } from '../drivers/query.js'
import type { ElementSelector, Platform, UiNode } from '../drivers/types.js'
import { resolveRoute, renderRouteReverse } from '../map/route.js'
import { defaultMapPath, loadEffectiveMap, loadMap, saveMap, validateMap } from '../map/store.js'
import { saveRecordingHandle, takeRecordingHandle } from '../run/recording-state.js'

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

// ---------------------------------------------------------------------------

type NavigationMapScreens = import('../map/types.js').NavigationMap['screens']
type NavigationMapEdges = import('../map/types.js').NavigationMap['edges']

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
