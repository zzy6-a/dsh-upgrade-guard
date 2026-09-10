import { describe, expect, it } from 'vitest'
import { classifyMismatch, compareSemver, satisfiesRange } from '../src/semver'

describe('semver ranges', () => {
  it('handles DSH prerelease ranges', () => {
    expect(satisfiesRange('0.1.5-rc.1', '>=0.0.1-rc <2')).toBe(true)
    expect(satisfiesRange('0.1.5-rc.1', '^0.1.2-alpha.2')).toBe(true)
    expect(satisfiesRange('0.1.5-rc.1', '^0.0.1')).toBe(false)
  })

  it('classifies directional risk like the ecosystem policy', () => {
    expect(classifyMismatch('^0.0.1', '0.1.5-rc.1')).toMatchObject({ kind: 'warning', reason: 'aboveMax' })
    expect(classifyMismatch('>=0.2.0 <1', '0.1.5-rc.1')).toMatchObject({ kind: 'risk', direction: 'belowMin' })
    expect(classifyMismatch('<0.2.0', '0.3.0')).toMatchObject({ kind: 'risk', direction: 'aboveMax' })
  })

  it('compares prerelease and release versions', () => {
    expect(compareSemver('0.1.5-rc.1', '0.1.5')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1)
  })
})
