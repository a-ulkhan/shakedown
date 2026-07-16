import type { Driver, Platform } from './types.js'
import { AndroidDriver } from './android.js'
import { IosDriver } from './ios.js'

export function getDriver(platform: Platform): Driver {
  switch (platform) {
    case 'ios':
      return new IosDriver()
    case 'android':
      return new AndroidDriver()
  }
}

export function parsePlatform(value: string): Platform {
  if (value === 'ios' || value === 'android') return value
  throw new Error(`unknown platform "${value}" — expected ios or android`)
}
