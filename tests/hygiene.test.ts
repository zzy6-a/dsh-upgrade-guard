import { describe, expect, it } from 'vitest'
import { dedupePatchText } from '../src/hygiene.js'

describe('dedupePatchText', () => {
  it('keeps the last duplicate top-level block and removes earlier ones', () => {
    const input = [
      '- id: foo',
      '  disabled: true',
      '- id: bar',
      '  insert:',
      '    - id: baz',
      '',
      '- id: foo',
      '  disabled: false',
      '',
    ].join('\n')
    const out = dedupePatchText(input)
    expect(out.duplicateIds).toEqual(['foo'])
    expect(out.removed).toEqual(['foo'])
    expect(out.text).toContain('disabled: false')
    expect(out.text).toContain('- id: bar')
    expect((out.text.match(/^- id: foo/gm) ?? []).length).toBe(1)
  })

  it('returns input untouched when there are no duplicates', () => {
    const input = '- id: a\n- id: b\n'
    expect(dedupePatchText(input)).toEqual({ text: input, removed: [], duplicateIds: [] })
  })
})
