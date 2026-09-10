import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GuardPaths } from './paths.js'
import type { HygieneIssue } from './scan.js'
import { asRecord, asString, nowIso, short } from './util.js'

export interface MarketDiagnostics {
  available: boolean
  version: string | null
  summary: Record<string, unknown> | null
  issues: HygieneIssue[]
  detail: string
  checkedAt: string
}

function tailText(path: string, maxBytes = 262144): string | null {
  try {
    const info = statSync(path)
    const start = Math.max(0, info.size - maxBytes)
    const text = readFileSync(path).subarray(start).toString('utf8')
    return text
  } catch {
    return null
  }
}

/** 从 web.log / host.log 里找当前 web 服务的 token（用于本机市场 API 的只读诊断）。 */
function findToken(paths: GuardPaths): string | null {
  const files = [
    join(paths.dshHome, 'logs', 'web.log'),
    join(paths.dshHome, 'upgrade-guard', 'host.log'),
    join(paths.dshHome, 'compat-guard', 'host.log'),
  ].filter((file) => existsSync(file))
  for (const file of files) {
    const text = tailText(file)
    if (text === null) continue
    const matches = [...text.matchAll(/[?&]token=([A-Za-z0-9_-]{8,})/g)]
    if (matches.length > 0) return matches[matches.length - 1][1]
  }
  return null
}

async function getJson(url: string, timeoutMs: number): Promise<{ status: number; data: unknown }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text()
    let data: unknown = null
    try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data }
  } catch {
    return { status: 0, data: null }
  }
}

function label(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  if (record === null) return short(value, 80)
  for (const key of ['id', 'name', 'plugin', 'package', 'entry']) {
    const found = asString(record[key])
    if (found !== null) return found
  }
  return short(value, 80)
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 读取 dsh-market 的只读诊断接口，映射成卫生问题。
 * 市场不在、未授权或接口超时都只降级为 available=false，不抛错、不影响巡检。
 */
export async function fetchMarketDiagnostics(paths: GuardPaths, port: number | null): Promise<MarketDiagnostics> {
  const checkedAt = nowIso()
  if (port === null || port <= 0) {
    return { available: false, version: null, summary: null, issues: [], detail: '未找到 DSH web 端口', checkedAt }
  }
  const base = `http://127.0.0.1:${port}`
  const token = findToken(paths)
  const query = token === null ? '' : `?token=${encodeURIComponent(token)}`
  const capabilities = await getJson(`${base}/dsh-market/api/v1/capabilities${query}`, 6000)
  if (capabilities.status !== 200) {
    const detail = capabilities.status === 401 || capabilities.status === 403
      ? '市场接口需要授权，已跳过'
      : capabilities.status === 0 ? '市场接口不可达' : `市场接口 HTTP ${capabilities.status}`
    return { available: false, version: null, summary: null, issues: [], detail, checkedAt }
  }
  const cap = asRecord(capabilities.data)
  const version = cap === null ? null : asString(cap.marketVersion)

  const check = await getJson(`${base}/dsh-market/check${query}`, 20000)
  const data = asRecord(check.data)
  if (check.status !== 200 || data === null) {
    return { available: true, version, summary: null, issues: [], detail: `市场可用，诊断接口 HTTP ${check.status}`, checkedAt }
  }

  const issues: HygieneIssue[] = []
  const source = 'dsh-market'
  for (const item of list(data.duplicates).slice(0, 30)) {
    issues.push({ level: 'error', code: 'duplicate-entry', message: `重复 entry：${label(item)}`, source })
  }
  for (const item of list(data.duplicateNames).slice(0, 30)) {
    issues.push({ level: 'error', code: 'duplicate-name', message: `重复名称：${label(item)}`, source })
  }
  for (const item of list(data.orphans).slice(0, 30)) {
    const record = asRecord(item)
    issues.push({ level: 'warning', code: 'patch-orphan', message: `patch 引用了不存在的 entry：${label(item)}`, source })
  }
  for (const item of list(data.multiVersion).slice(0, 30)) {
    const record = asRecord(item)
    const versions = record === null ? null : record.versions
    const count = Array.isArray(versions) ? versions.length : null
    issues.push({ level: 'risk', code: 'multi-version', message: `同一包存在多版本：${label(item)}${count === null ? '' : ` ×${count}`}`, source })
  }
  for (const item of list(data.peerMismatches).slice(0, 30)) {
    const record = asRecord(item)
    if (record === null || record.satisfied !== false) continue
    const plugin = label(record.plugin ?? record)
    const name = asString(record.name) ?? '?'
    const range = asString(record.range) ?? '*'
    const resolved = asString(record.resolved) ?? '?'
    issues.push({ level: 'warning', code: 'peer-mismatch', message: `peer 依赖不满足：${plugin} → ${name}@${resolved}（需要 ${range}）`, source })
  }
  const summary = asRecord(data.summary)
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.length
    const parsed = Number(value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
  }
  const errorCount = summary === null ? 0 : count(summary.errors)
  const warningCount = summary === null ? 0 : count(summary.warnings)
  const detail = `市场可用（v${version ?? '?'}，错误 ${errorCount} / 警告 ${warningCount}）`
  return { available: true, version, summary: summary === null ? null : summary, issues, detail, checkedAt }
}
