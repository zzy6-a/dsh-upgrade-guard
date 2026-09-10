import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, nowIso, readText, runCommand, stamp } from './util.js'
import type { GuardPaths } from './paths.js'

export interface ComposeMap {
  /** package name -> loader entry ids */
  byName: Map<string, string[]>
  raw: string
  error: string | null
}

export function hostBinPath(): string {
  return process.argv[1] ?? ''
}

/** 运行 dsh --dump-config，得到包名 → loader entry id 映射（只读，不启动宿主）。 */
export async function dumpComposeMap(paths: GuardPaths): Promise<ComposeMap> {
  const bin = hostBinPath()
  const byName = new Map<string, string[]>()
  if (bin === '') return { byName, raw: '', error: '无法确定 dsh bin 路径（process.argv[1] 为空）' }
  const result = await runCommand(process.execPath, [bin, '--profile', paths.profile, '--dump-config'], {
    cwd: paths.profileDir,
    timeoutMs: 60_000,
  })
  const text = result.stdout
  if (result.code !== 0 && text.trim() === '') {
    return { byName, raw: text, error: result.error ?? `dump-config 退出码 ${result.code}: ${result.stderr.slice(-300)}` }
  }
  let currentId: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const idMatch = /^- id:\s*(\S+)\s*$/.exec(line)
    if (idMatch !== null) { currentId = idMatch[1]; continue }
    const nameMatch = /^\s{2,}name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (nameMatch !== null && currentId !== null) {
      const packageName = nameMatch[1]
      const list = byName.get(packageName) ?? []
      if (!list.includes(currentId)) list.push(currentId)
      byName.set(packageName, list)
      continue
    }
    if (/^\S/.test(line) && !line.startsWith('-')) currentId = null
  }
  return { byName, raw: text, error: null }
}

export interface BackupResult {
  dir: string | null
  files: string[]
}

/** 修改前把关键文件复制到 backups/<stamp>-<label>/。 */
export function backupFiles(paths: GuardPaths, files: string[], label: string): BackupResult {
  const existing = files.filter((file) => existsSync(file))
  if (existing.length === 0) return { dir: null, files: [] }
  const dir = join(paths.backupsDir, `${stamp()}-${label}`)
  try {
    ensureDir(dir)
    const copied: string[] = []
    for (const file of existing) {
      const target = join(dir, file.split(/[\\/]/).pop() ?? 'file')
      copyFileSync(file, target)
      copied.push(target)
    }
    return { dir, files: copied }
  } catch {
    return { dir: null, files: [] }
  }
}

function stripEmptyArray(content: string): string {
  const lines = content.split(/\r?\n/)
  const kept = lines.filter((line) => line.trim() !== '[]')
  return kept.join('\n').replace(/\s+$/, '')
}

export interface DisableResult {
  ok: boolean
  entryIds: string[]
  backup: string | null
  appended: string
  detail: string
}

/** 向 profile 的 cordis.patch.yml 追加 disabled 覆盖行（带备份），返回 appended 文本用于追踪。 */
export function appendEntryOverrides(
  paths: GuardPaths,
  name: string,
  entryIds: string[],
  disabled: boolean,
  reason: string,
): DisableResult {
  const ids = [...new Set(entryIds.filter((id) => id !== ''))]
  if (ids.length === 0) {
    return { ok: false, entryIds: [], backup: null, appended: '', detail: `未找到 ${name} 的 loader entry id，无法写入开关` }
  }
  const action = disabled ? 'disable' : 'enable'
  const backup = backupFiles(paths, [paths.profilePatchFile], `${action}-${name.replace(/[\\/@]/g, '_')}`)
  const appended = `\n# dsh-upgrade-guard ${action} ${name} at ${nowIso()} — ${reason}\n`
    + ids.map((id) => `- id: ${id}\n  disabled: ${disabled ? 'true' : 'false'}`).join('\n') + '\n'
  try {
    const original = readText(paths.profilePatchFile) ?? ''
    const base = stripEmptyArray(original)
    const next = `${base === '' ? '' : `${base}\n`}${appended}`
    ensureDir(join(paths.profilePatchFile, '..'))
    writeFileSync(paths.profilePatchFile, next, 'utf8')
    return {
      ok: true,
      entryIds: ids,
      backup: backup.dir,
      appended,
      detail: `已写入 ${disabled ? '禁用' : '启用'}：${ids.join(', ')}`,
    }
  } catch (error) {
    return { ok: false, entryIds: ids, backup: backup.dir, appended: '', detail: `写入 patch 失败：${String(error)}` }
  }
}

/** 向 profile 的 cordis.patch.yml 追加 disabled 行（带备份），返回 appended 文本用于恢复。 */
export function disableEntryIds(paths: GuardPaths, name: string, entryIds: string[], reason: string): DisableResult {
  return appendEntryOverrides(paths, name, entryIds, true, reason)
}

/** 删除守卫之前追加的 disabled 文本（按记录精确匹配）。 */
export function enableEntryIds(paths: GuardPaths, appended: string | null, name: string): { ok: boolean; detail: string } {
  if (appended === null || appended.trim() === '') {
    return { ok: false, detail: `没有 ${name} 的恢复记录，请手动编辑 cordis.patch.yml` }
  }
  const content = readText(paths.profilePatchFile)
  if (content === null) return { ok: false, detail: 'cordis.patch.yml 不存在' }
  if (!content.includes(appended)) {
    return { ok: false, detail: 'patch 文件已变化，找不到守卫写入的原文，请手动恢复（或使用备份）' }
  }
  backupFiles(paths, [paths.profilePatchFile], `enable-${name.replace(/[\\/@]/g, '_')}`)
  const next = content.replace(appended, '')
  try {
    writeFileSync(paths.profilePatchFile, next, 'utf8')
    return { ok: true, detail: `已恢复 ${name}` }
  } catch (error) {
    return { ok: false, detail: `写回 patch 失败：${String(error)}` }
  }
}

export function ensureBackupsDir(paths: GuardPaths): void {
  mkdirSync(paths.backupsDir, { recursive: true })
}

export function readPatchText(paths: GuardPaths): string {
  try { return readFileSync(paths.profilePatchFile, 'utf8') } catch { return '' }
}
