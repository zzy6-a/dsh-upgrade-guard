import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCommand } from '../src/util.js'

const runner = join(process.cwd(), 'scripts', 'probe-runner.mjs')

describe('probe runner', () => {
  it('loads a probe module and returns its result as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upgrade-guard-probe-'))
    const file = join(dir, 'probe.mjs')
    writeFileSync(file, "export async function probe(ctx){ return { ok: true, message: 'host=' + ctx.hostVersion } }\n")
    const payload = Buffer.from(JSON.stringify({
      probeFile: file,
      exportName: 'probe',
      pluginDir: dir,
      hostVersion: '1.2.3',
      profile: 'web',
      dshHome: dir,
    })).toString('base64')
    const result = await runCommand(process.execPath, [runner, payload], { timeoutMs: 10000 })
    const marker = result.stdout.split('__PROBE_RESULT__')[1]
    expect(marker).toBeDefined()
    const parsed = JSON.parse(marker) as { ok?: boolean; message?: string }
    expect(parsed.ok).toBe(true)
    expect(parsed.message).toContain('host=1.2.3')
  })
})
