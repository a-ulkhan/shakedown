import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  DeviceInfo,
  Driver,
  ElementSelector,
  Point,
  RecordingHandle,
  UiNode,
} from './types.js'
import { isPoint } from './types.js'
import { parseUiautomatorDump } from './android-parser.js'
import { center, describeSelector, findFirst } from './query.js'
import { run, spawnDetached, sleep } from '../util/exec.js'

/**
 * Android emulator/device driver.
 * UI interaction via adb (`uiautomator dump`, `input`, `screencap`,
 * `screenrecord`), emulator lifecycle via the `emulator` CLI.
 * First-party tooling only — no Appium, no instrumentation.
 */
export class AndroidDriver implements Driver {
  readonly platform = 'android' as const

  async listDevices(): Promise<DeviceInfo[]> {
    const devices: DeviceInfo[] = []

    const { stdout } = await run(adbPath(), ['devices', '-l'])
    const connected = new Map<string, DeviceInfo>()
    for (const line of stdout.split('\n').slice(1)) {
      const match = /^(\S+)\s+(device|offline)\b/.exec(line.trim())
      if (!match) continue
      const serial = match[1] ?? ''
      const state = match[2] === 'device' ? 'booted' : 'offline'
      const name = (await this.emulatorAvdName(serial)) ?? serial
      connected.set(name, { id: serial, name, platform: 'android', state })
    }
    devices.push(...connected.values())

    // AVDs that exist but are not currently running
    try {
      const { stdout: avds } = await run(emulatorPath(), ['-list-avds'])
      for (const rawName of avds.split('\n')) {
        const name = rawName.trim()
        // `emulator -list-avds` may print INFO lines on some SDK versions
        if (!name || name.startsWith('INFO')) continue
        if (!connected.has(name)) {
          devices.push({ id: name, name, platform: 'android', state: 'shutdown' })
        }
      }
    } catch {
      // emulator CLI missing is fine when only physical devices are used
    }
    return devices
  }

  async boot(deviceIdOrName: string): Promise<DeviceInfo> {
    const devices = await this.listDevices()
    const existing =
      devices.find((d) => d.id === deviceIdOrName) ??
      devices.find((d) => d.name === deviceIdOrName)
    if (existing?.state === 'booted') return existing
    if (!existing) {
      throw new Error(`no Android device or AVD matches "${deviceIdOrName}"`)
    }

    spawnDetached(emulatorPath(), ['-avd', existing.name])
    const serial = await this.waitForBoot(existing.name)
    return { id: serial, name: existing.name, platform: 'android', state: 'booted' }
  }

  async install(deviceId: string, appPath: string): Promise<void> {
    await run(adbPath(), ['-s', deviceId, 'install', '-r', appPath], { timeoutMs: 300_000 })
  }

  async launch(deviceId: string, appId: string): Promise<void> {
    await run(adbPath(), [
      '-s', deviceId, 'shell', 'monkey',
      '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1',
    ])
  }

  async terminate(deviceId: string, appId: string): Promise<void> {
    await run(adbPath(), ['-s', deviceId, 'shell', 'am', 'force-stop', appId])
  }

  async describeUi(deviceId: string): Promise<UiNode[]> {
    const { stdout } = await run(adbPath(), [
      '-s', deviceId, 'exec-out', 'uiautomator', 'dump', '/dev/tty',
    ])
    const xmlEnd = stdout.lastIndexOf('>')
    return parseUiautomatorDump(xmlEnd >= 0 ? stdout.slice(0, xmlEnd + 1) : stdout)
  }

  async tap(deviceId: string, target: Point | ElementSelector): Promise<void> {
    const point = isPoint(target) ? target : await this.resolveSelector(deviceId, target)
    await run(adbPath(), ['-s', deviceId, 'shell', 'input', 'tap', String(point.x), String(point.y)])
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    // `input text` cannot express spaces literally; %s is its escape for space
    const escaped = text.replace(/\s/g, '%s')
    await run(adbPath(), ['-s', deviceId, 'shell', 'input', 'text', escaped])
  }

  async swipe(deviceId: string, from: Point, to: Point, durationMs = 300): Promise<void> {
    await run(adbPath(), [
      '-s', deviceId, 'shell', 'input', 'swipe',
      String(from.x), String(from.y), String(to.x), String(to.y), String(durationMs),
    ])
  }

  async screenshot(deviceId: string, outputPath: string): Promise<string> {
    const { stdout } = await runBinary(adbPath(), ['-s', deviceId, 'exec-out', 'screencap', '-p'])
    await writeFile(outputPath, stdout)
    return outputPath
  }

  async startRecording(deviceId: string, outputPath: string): Promise<RecordingHandle> {
    const devicePath = `/sdcard/shakedown-recording-${Date.now()}.mp4`
    const pid = spawnDetached(adbPath(), [
      '-s', deviceId, 'shell', 'screenrecord', '--time-limit', '180', devicePath,
    ])
    return {
      platform: 'android',
      deviceId,
      pid,
      outputPath,
      devicePath,
      startedAt: new Date().toISOString(),
    }
  }

  async stopRecording(handle: RecordingHandle): Promise<string> {
    if (!handle.devicePath) throw new Error('android recording handle is missing devicePath')
    try {
      process.kill(handle.pid, 'SIGINT')
    } catch {
      // recorder may have hit its own time limit and exited — the file is still there
    }
    // screenrecord needs a moment to finalize the MP4 after SIGINT
    await sleep(2_000)
    await run(adbPath(), ['-s', handle.deviceId, 'pull', handle.devicePath, handle.outputPath], {
      timeoutMs: 120_000,
    })
    await run(adbPath(), ['-s', handle.deviceId, 'shell', 'rm', handle.devicePath])
    return handle.outputPath
  }

  private async resolveSelector(deviceId: string, selector: ElementSelector): Promise<Point> {
    const roots = await this.describeUi(deviceId)
    const node = findFirst(roots, selector)
    if (!node) {
      throw new Error(`no element matches ${describeSelector(selector)} on the current screen`)
    }
    return center(node)
  }

  private async emulatorAvdName(serial: string): Promise<string | undefined> {
    if (!serial.startsWith('emulator-')) return undefined
    try {
      const { stdout } = await run(adbPath(), ['-s', serial, 'emu', 'avd', 'name'])
      const name = stdout.split('\n')[0]?.trim()
      return name && name !== 'OK' ? name : undefined
    } catch {
      return undefined
    }
  }

  private async waitForBoot(avdName: string, timeoutMs = 240_000): Promise<string> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const { stdout } = await run(adbPath(), ['devices'])
      for (const line of stdout.split('\n').slice(1)) {
        const serial = line.split('\t')[0]?.trim()
        if (!serial || !serial.startsWith('emulator-')) continue
        if ((await this.emulatorAvdName(serial)) !== avdName) continue
        try {
          const { stdout: booted } = await run(adbPath(), [
            '-s', serial, 'shell', 'getprop', 'sys.boot_completed',
          ])
          if (booted.trim() === '1') return serial
        } catch {
          // device visible but not responsive yet
        }
      }
      await sleep(2_000)
    }
    throw new Error(`emulator "${avdName}" did not finish booting within ${timeoutMs / 1000}s`)
  }
}

export function androidSdkRoot(): string {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
    join(homedir(), 'Android', 'Sdk'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return ''
}

function adbPath(): string {
  const sdk = androidSdkRoot()
  const bundled = sdk ? join(sdk, 'platform-tools', 'adb') : ''
  return bundled && existsSync(bundled) ? bundled : 'adb'
}

function emulatorPath(): string {
  const sdk = androidSdkRoot()
  const bundled = sdk ? join(sdk, 'emulator', 'emulator') : ''
  return bundled && existsSync(bundled) ? bundled : 'emulator'
}

/** execFile with a Buffer stdout (for binary output like screencap PNG bytes). */
function runBinary(cmd: string, args: string[]): Promise<{ stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve({ stdout })
      }
    )
  })
}
