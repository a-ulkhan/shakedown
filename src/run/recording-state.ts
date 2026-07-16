import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordingHandle } from '../drivers/types.js'

/**
 * `ui record start` and `ui record stop` are separate CLI invocations, so the
 * recorder handle (pid + paths) is persisted between them under
 * .shakedown/state/ in the working directory.
 */
function stateDir(rootDir: string): string {
  return join(rootDir, '.shakedown', 'state')
}

function handlePath(rootDir: string, deviceId: string): string {
  return join(stateDir(rootDir), `recording-${deviceId.replace(/[^\w-]/g, '_')}.json`)
}

export async function saveRecordingHandle(rootDir: string, handle: RecordingHandle): Promise<void> {
  await mkdir(stateDir(rootDir), { recursive: true })
  await writeFile(handlePath(rootDir, handle.deviceId), JSON.stringify(handle, null, 2), 'utf-8')
}

export async function takeRecordingHandle(
  rootDir: string,
  deviceId: string
): Promise<RecordingHandle> {
  const path = handlePath(rootDir, deviceId)
  if (!existsSync(path)) {
    throw new Error(`no active recording for device ${deviceId} (looked at ${path})`)
  }
  const handle = JSON.parse(await readFile(path, 'utf-8')) as RecordingHandle
  await rm(path)
  return handle
}
