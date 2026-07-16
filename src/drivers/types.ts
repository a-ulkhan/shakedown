export type Platform = 'ios' | 'android'

export interface DeviceInfo {
  /** UDID (iOS) or serial (Android, e.g. emulator-5554) */
  id: string
  name: string
  platform: Platform
  /** booted | shutdown | offline */
  state: 'booted' | 'shutdown' | 'offline'
  os?: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A normalized accessibility node. Both drivers translate their native
 * hierarchy (AXe describe-ui JSON / uiautomator dump XML) into this shape,
 * so everything above the driver layer is platform-agnostic.
 */
export interface UiNode {
  /** Element type: iOS accessibility type (Button, TextField) or Android class tail (Button, EditText) */
  type: string
  /** Accessibility label: AXLabel / content-desc (fallback: text) */
  label?: string
  /** Stable identifier: AXUniqueId (accessibilityIdentifier) / resource-id */
  identifier?: string
  /** Current value: AXValue / text */
  value?: string
  frame: Rect
  enabled: boolean
  children: UiNode[]
}

/** Locate an element in the normalized tree. */
export interface ElementSelector {
  identifier?: string
  label?: string
  value?: string
  type?: string
}

export interface Point {
  x: number
  y: number
}

export interface RecordingHandle {
  platform: Platform
  deviceId: string
  pid: number
  /** Final output path on the host */
  outputPath: string
  /** Android: temp path on the device that gets pulled on stop */
  devicePath?: string
  startedAt: string
}

export interface Driver {
  readonly platform: Platform

  listDevices(): Promise<DeviceInfo[]>
  /** Boot a device and wait until it is ready for UI commands. */
  boot(deviceIdOrName: string): Promise<DeviceInfo>
  install(deviceId: string, appPath: string): Promise<void>
  launch(deviceId: string, appId: string): Promise<void>
  terminate(deviceId: string, appId: string): Promise<void>

  describeUi(deviceId: string): Promise<UiNode[]>
  tap(deviceId: string, target: Point | ElementSelector): Promise<void>
  typeText(deviceId: string, text: string): Promise<void>
  swipe(deviceId: string, from: Point, to: Point, durationMs?: number): Promise<void>
  screenshot(deviceId: string, outputPath: string): Promise<string>

  startRecording(deviceId: string, outputPath: string): Promise<RecordingHandle>
  stopRecording(handle: RecordingHandle): Promise<string>
}

export function isPoint(target: Point | ElementSelector): target is Point {
  return typeof (target as Point).x === 'number' && typeof (target as Point).y === 'number'
}
