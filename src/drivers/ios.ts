import type {
  DeviceInfo,
  Driver,
  ElementSelector,
  Point,
  RecordingHandle,
  UiNode,
} from './types.js'
import { isPoint } from './types.js'
import { center, findFirst } from './query.js'
import { run, spawnDetached, sleep } from '../util/exec.js'

interface SimctlDevice {
  udid: string
  name: string
  state: string
  isAvailable: boolean
}

interface AxeNode {
  type?: string
  role?: string
  AXLabel?: string | null
  AXUniqueId?: string | null
  // axe emits a non-string AXValue for value-bearing controls (sliders -> number,
  // switches -> 0/1, steppers, progress), so this is not always a string.
  AXValue?: string | number | boolean | null
  enabled?: boolean
  frame?: { x: number; y: number; width: number; height: number }
  children?: AxeNode[]
}

export type IosEngine = 'sim-use' | 'axe'

export type FoldPosture = 'closed' | 'open' | 'half'

export function parseIosEngine(value: string | undefined): IosEngine {
  if (value === undefined || value === '' || value === 'sim-use') return 'sim-use'
  if (value === 'axe') return 'axe'
  throw new Error(`unknown SHAKEDOWN_IOS_ENGINE "${value}" — expected sim-use or axe`)
}

/**
 * iOS simulator driver.
 * UI interaction via sim-use (https://github.com/lycorp-jp/sim-use, default) or
 * AXe (https://github.com/cameroncooke/AXe, SHAKEDOWN_IOS_ENGINE=axe);
 * lifecycle via `xcrun simctl`. sim-use is an AXe fork that still delivers taps
 * to Xcode 27 Device Hub simulators and the iPhone Duo's cover and inner displays.
 */
export class IosDriver implements Driver {
  readonly platform = 'ios' as const

  constructor(readonly engine: IosEngine = parseIosEngine(process.env.SHAKEDOWN_IOS_ENGINE)) {}

  private get bin(): string {
    return this.engine
  }

  private deviceArgs(deviceId: string): string[] {
    return [this.engine === 'sim-use' ? '--device' : '--udid', deviceId]
  }

  private keyArgs(command: 'key' | 'key-combo'): string[] {
    return this.engine === 'sim-use' ? ['ios', command] : [command]
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json'])
    const parsed = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> }
    const devices: DeviceInfo[] = []
    for (const [runtime, list] of Object.entries(parsed.devices)) {
      for (const device of list) {
        if (!device.isAvailable) continue
        devices.push({
          id: device.udid,
          name: device.name,
          platform: 'ios',
          state: device.state === 'Booted' ? 'booted' : 'shutdown',
          os: runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, ' '),
        })
      }
    }
    return devices
  }

  async boot(deviceIdOrName: string): Promise<DeviceInfo> {
    const devices = await this.listDevices()
    const device =
      devices.find((d) => d.id === deviceIdOrName) ??
      devices.find((d) => d.name === deviceIdOrName)
    if (!device) {
      throw new Error(`no iOS simulator matches "${deviceIdOrName}"`)
    }
    if (device.state !== 'booted') {
      await run('xcrun', ['simctl', 'boot', device.id])
    }
    // bootstatus blocks until the simulator finishes booting
    await run('xcrun', ['simctl', 'bootstatus', device.id], { timeoutMs: 180_000 })
    return { ...device, state: 'booted' }
  }

  async install(deviceId: string, appPath: string): Promise<void> {
    await run('xcrun', ['simctl', 'install', deviceId, appPath], { timeoutMs: 180_000 })
  }

  async launch(deviceId: string, appId: string): Promise<void> {
    await run('xcrun', ['simctl', 'launch', deviceId, appId])
  }

  async terminate(deviceId: string, appId: string): Promise<void> {
    try {
      await run('xcrun', ['simctl', 'terminate', deviceId, appId])
    } catch (error) {
      // terminating an app that is not running is not an error for callers
      if (!String(error).includes('found nothing to terminate')) throw error
    }
  }

  async describeUi(deviceId: string): Promise<UiNode[]> {
    if (this.engine === 'sim-use') {
      const { stdout } = await run(this.bin, ['describe-ui', '--json', ...this.deviceArgs(deviceId)])
      return parseSimUseTree(stdout)
    }
    const { stdout } = await run(this.bin, ['describe-ui', ...this.deviceArgs(deviceId)])
    return parseAxeTree(stdout)
  }

  async fold(deviceId: string, posture: FoldPosture): Promise<void> {
    if (this.engine !== 'sim-use') {
      throw new Error('fold needs the sim-use engine (unset SHAKEDOWN_IOS_ENGINE or set it to sim-use)')
    }
    await run(this.bin, ['ios', 'fold', posture, ...this.deviceArgs(deviceId)], { timeoutMs: 60_000 })
  }

  async tap(deviceId: string, target: Point | ElementSelector): Promise<void> {
    if (isPoint(target)) {
      await run(this.bin, ['tap', '-x', String(target.x), '-y', String(target.y), ...this.deviceArgs(deviceId)])
      return
    }
    // both engines resolve accessibility selectors natively (with polling)
    const args = ['tap']
    if (target.identifier) args.push('--id', target.identifier)
    else if (target.label) args.push('--label', target.label)
    else if (target.value) args.push('--value', target.value)
    else throw new Error('iOS tap selector needs identifier, label, or value')
    if (target.type) args.push('--element-type', target.type)
    args.push(...this.deviceArgs(deviceId))
    try {
      await run(this.bin, args)
    } catch (error) {
      // Nested wrappers (common in SwiftUI) make one logical element match
      // several accessibility nodes; AXe refuses ambiguous matches. Resolve
      // to the first match ourselves and tap its center.
      if (!String(error).includes('Multiple')) throw error
      const roots = await this.describeUi(deviceId)
      const node = findFirst(roots, target)
      if (!node) throw error
      await this.tap(deviceId, center(node))
    }
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    await run(this.bin, ['type', text, ...this.deviceArgs(deviceId)])
  }

  async clearField(deviceId: string): Promise<void> {
    // Select-all then delete. HID usage codes: modifier 227 = Left GUI (Command),
    // key 4 = 'a', key 42 = Delete/Backspace. Assumes a field is focused (the
    // caller taps it first), same precondition as typeText.
    await run(this.bin, [...this.keyArgs('key-combo'), '--modifiers', '227', '--key', '4', ...this.deviceArgs(deviceId)])
    await run(this.bin, [...this.keyArgs('key'), '42', ...this.deviceArgs(deviceId)])
  }

  async swipe(deviceId: string, from: Point, to: Point, durationMs = 300): Promise<void> {
    await run(this.bin, [
      'swipe',
      '--start-x', String(from.x),
      '--start-y', String(from.y),
      '--end-x', String(to.x),
      '--end-y', String(to.y),
      '--duration', String(durationMs / 1000),
      ...this.deviceArgs(deviceId),
    ])
  }

  async screenshot(deviceId: string, outputPath: string): Promise<string> {
    await run(this.bin, ['screenshot', '--output', outputPath, ...this.deviceArgs(deviceId)])
    return outputPath
  }

  async startRecording(deviceId: string, outputPath: string): Promise<RecordingHandle> {
    const pid = spawnDetached(this.bin, [
      'record-video',
      ...this.deviceArgs(deviceId),
      '--output', outputPath,
    ])
    return {
      platform: 'ios',
      deviceId,
      pid,
      outputPath,
      startedAt: new Date().toISOString(),
    }
  }

  async stopRecording(handle: RecordingHandle): Promise<string> {
    try {
      process.kill(handle.pid, 'SIGINT')
    } catch {
      throw new Error(`recorder process ${handle.pid} is not running (already stopped?)`)
    }
    // give the encoder a moment to finalize the MP4 container
    await sleep(1_500)
    return handle.outputPath
  }
}

export function parseAxeTree(stdout: string): UiNode[] {
  const roots = JSON.parse(stdout) as AxeNode[]
  return roots.map((node) => normalizeAxeNode(node))
}

/** sim-use `describe-ui --json` wraps the AXe-shaped tree in `{ ok, data: { raw } }`. */
export function parseSimUseTree(stdout: string): UiNode[] {
  const envelope = JSON.parse(stdout) as { ok?: boolean; data?: { raw?: AxeNode[] }; error?: unknown }
  if (envelope.ok === false || !Array.isArray(envelope.data?.raw)) {
    throw new Error(`sim-use describe-ui returned no tree: ${stdout.slice(0, 300)}`)
  }
  return envelope.data.raw.map((node) => normalizeAxeNode(node))
}

function normalizeAxeNode(node: AxeNode): UiNode {
  return {
    type: node.type ?? node.role ?? 'Unknown',
    label: emptyToUndefined(node.AXLabel),
    identifier: emptyToUndefined(node.AXUniqueId),
    value: emptyToUndefined(node.AXValue),
    frame: node.frame ?? { x: 0, y: 0, width: 0, height: 0 },
    enabled: node.enabled ?? true,
    children: (node.children ?? []).map((child) => normalizeAxeNode(child)),
  }
}

function emptyToUndefined(value: string | number | boolean | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const str = typeof value === 'string' ? value : String(value)
  const trimmed = str.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
