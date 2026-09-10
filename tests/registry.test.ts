import { describe, expect, it } from 'vitest'
import { chooseCompatibleTarget } from '../src/registry'

function manifest(version: string, enginesDsh: string | null, peers: Record<string, string> = {}) {
  return [version, { version, enginesDsh, peerDependencies: peers }] as const
}

describe('chooseCompatibleTarget', () => {
  it('prefers the highest declared-compatible version over latest', () => {
    const versions = new Map([
      manifest('1.1.0', '>=0.1.5 <2'),
      manifest('1.3.0', '>=0.2.0 <2'),
      manifest('0.9.0', '>=0.0.1-rc <2'),
      manifest('2.0.0', '>=0.3.0 <2'),
    ])
    const hostCore = new Map<string, string | null>([['@deepseek-ai/dsh', '0.1.5-rc.1']])
    expect(chooseCompatibleTarget('0.8.0', versions, '0.1.5-rc.1', hostCore, '2.0.0')).toMatchObject({
      latest: '2.0.0',
      compatible: '0.9.0',
      reason: 'declared-compatible',
    })
  })

  it('falls back to unverified latest only when nothing is declared', () => {
    const versions = new Map([manifest('1.2.0', null), manifest('1.1.0', null)])
    const hostCore = new Map<string, string | null>([['@deepseek-ai/dsh', '0.1.5-rc.1']])
    expect(chooseCompatibleTarget('1.1.0', versions, '0.1.5-rc.1', hostCore, '1.2.0')).toMatchObject({
      compatible: '1.2.0',
      reason: 'unverified-latest',
    })
  })
})
