import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GuardPaths } from './paths.js'
import type { PluginReport, ProbeResult, ScanReport } from './scan.js'
import { asRecord, asString, readJson, runCommand } from './util.js'

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'probe-runner.mjs')

interface ProbeSpec {
  file: string
  exportName: string
  timeoutMs: number
}

interface ProbeTarget {
  plugin: PluginReport
  spec: ProbeSpec
  file: string | null
}

/**
 * 插件可选声明：package.json -> dsh.compat.probe
 * 字符串："./lib/probe.js"；对象：{ file|module|path, export, timeoutMs }
 */
function specFor(manifest: Record<string, unknown>): ProbeSpec | null {
  const dsh = asRecord(manifest.dsh)
  const compat = dsh === null ? null : asRecord(dsh.compat)
  const probe = compat === null ? null : compat.probe
  if (typeof probe === 'string' && probe.trim() !== '') {
    return { file: probe.trim(), exportName: 'probe', timeoutMs: 20000 }
  }
  const record = asRecord(probe)
  if (record === null) return null
  const file = asString(record.file) ?? asString(record.module) ?? asString(record.path)
  if (file === null || file.trim() === '') return null
  const timeout = Number(record.timeoutMs ?? 20000)
  return {
    file: file.trim(),
    exportName: asString(record.export) ?? 'probe',
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 120000 ? timeout : 20000,
  }
}

function resolveProbeFile(pluginDir: string, file: string): string | null {
  let candidate: string | null = null
  if (isAbsolute(file)) candidate = file
  else if (file.startsWith('.')) candidate = resolve(pluginDir, file)
  if (candidate === null) {
    try {
      candidate = createRequire(join(pluginDir, 'package.json')).resolve(file)
    } catch {
      return null
    }
  }
  const variants = extname(candidate) === '' ? [`${candidate}.js`, `${candidate}.mjs`, `${candidate}.cjs`, candidate] : [candidate]
  for (const variant of variants) if (existsSync(variant)) return variant
  return null
}

function issue(plugin: PluginReport, code: string, message: string, level: 'warning' | 'risk'): void {
  plugin.issues.push({ level, code, message })
  if (level === 'risk' && (plugin.status === 'ok' || plugin.status === 'warning' || plugin.status === 'unknown')) plugin.status = 'risk'
}

async function runOne(paths: GuardPaths, target: ProbeTarget, probeFile: string): Promise<ProbeResult> {
  const started = Date.now()
  const payload = Buffer.from(JSON.stringify({
    probeFile,
    exportName: target.spec.exportName,
    pluginDir: target.plugin.dir,
    hostVersion: paths.hostVersion,
    profile: paths.profile,
    dshHome: paths.dshHome,
  })).toString('base64')
  const result = await runCommand(process.execPath, [RUNNER, payload], {
    cwd: target.plugin.dir ?? undefined,
    timeoutMs: target.spec.timeoutMs + 3000,
  })
  const durationMs = Date.now() - started
  const match = /__PROBE_RESULT__(\{.*\})/s.exec(result.stdout)
  if (match === null) {
    return { status: 'error', message: result.error ?? `probe runner 无输出（code ${result.code}）`, durationMs }
  }
  try {
    const parsed = JSON.parse(match[1]) as { ok?: unknown; message?: unknown }
    return {
      status: parsed.ok === false ? 'failed' : 'ok',
      message: parsed.message === undefined ? undefined : String(parsed.message),
      durationMs,
    }
  } catch {
    return { status: 'error', message: 'probe runner 返回值不是合法 JSON', durationMs }
  }
}

/** 对声明了 dsh.compat.probe 的插件跑隔离自检；无声明时零开销。 */
export async function runPluginProbes(paths: GuardPaths, report: ScanReport): Promise<ScanReport> {
  const targets: ProbeTarget[] = []
  for (const plugin of report.plugins) {
    if (plugin.dir === null || plugin.status === 'disabled') continue
    const manifest = readJson(join(plugin.dir, 'package.json'))
    if (manifest === null) continue
    const spec = specFor(manifest)
    if (spec === null) continue
    targets.push({ plugin, spec, file: resolveProbeFile(plugin.dir, spec.file) })
  }
  if (targets.length === 0) return report

  const queue = [...targets]
  const worker = async (): Promise<void> => {
    for (;;) {
      const target = queue.shift()
      if (target === undefined) return
      if (target.file === null) {
        target.plugin.probe = { status: 'error', message: `声明的 probe 文件不存在：${target.spec.file}` }
        issue(target.plugin, 'probe-missing', `probe 文件不存在：${target.spec.file}`, 'risk')
        continue
      }
      const result = await runOne(paths, target, target.file)
      target.plugin.probe = result
      if (result.status === 'failed') issue(target.plugin, 'probe-failed', `自检未通过：${result.message ?? '无详情'}`, 'risk')
      else if (result.status === 'error') issue(target.plugin, 'probe-error', `自检执行失败：${result.message ?? '无详情'}`, 'risk')
    }
  }
  await Promise.all([worker(), worker()])

  const counts = { ok: 0, warning: 0, risk: 0, broken: 0, disabled: 0, unknown: 0 }
  for (const plugin of report.plugins) counts[plugin.status] += 1
  report.counts = counts
  return report
}
