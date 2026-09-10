import { writeFileSync } from 'node:fs'
import { backupFiles, hostBinPath } from './patch.js'
import type { GuardPaths } from './paths.js'
import type { HygieneIssue, HygieneReport } from './scan.js'
import { nowIso, readText, runCommand } from './util.js'

/** 从 profile patch 文本里统计顶层 `- id:` 重复项；纯函数，便于测试。 */
export function dedupePatchText(text: string): { text: string; removed: string[]; duplicateIds: string[] } {
  const lines = text.split(/\r?\n/)
  const starts: Array<{ index: number; id: string }> = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^- id:\s*(\S+)\s*$/.exec(lines[i])
    if (match !== null) starts.push({ index: i, id: match[1] })
  }
  const counts = new Map<string, number>()
  for (const item of starts) counts.set(item.id, (counts.get(item.id) ?? 0) + 1)
  const duplicateIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id)
  if (duplicateIds.length === 0) return { text, removed: [], duplicateIds: [] }

  const blockEnd = (startIndex: number): number => {
    for (let i = startIndex + 1; i < lines.length; i += 1) {
      if (/^- /.test(lines[i])) return i
    }
    return lines.length
  }
  const keep = new Set<number>()
  const seen = new Set<string>()
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const item = starts[i]
    if (!duplicateIds.includes(item.id)) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    for (let j = item.index; j < blockEnd(item.index); j += 1) keep.add(j)
  }
  const output: string[] = []
  const removed: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const start = starts.find((item) => item.index === i && duplicateIds.includes(item.id))
    if (start !== undefined) {
      if (keep.has(i)) {
        for (let j = i; j < blockEnd(i); j += 1) { output.push(lines[j]); i = j }
      } else {
        removed.push(start.id)
        i = blockEnd(i) - 1
      }
      continue
    }
    output.push(lines[i])
  }
  return { text: output.join('\n'), removed, duplicateIds }
}

function collectFileIssues(paths: GuardPaths): HygieneIssue[] {
  const issues: HygieneIssue[] = []
  const text = readText(paths.profilePatchFile) ?? ''
  const result = dedupePatchText(text)
  for (const id of result.duplicateIds) {
    issues.push({ level: 'error', code: 'patch-duplicate', message: `用户 patch 里重复的 entry id：${id}`, source: paths.profilePatchFile })
  }
  return issues
}

/** 组合层卫生检查：用户 patch 重复 id + dump-config 的失效/重复告警。 */
export async function analyzePatchHygiene(paths: GuardPaths): Promise<HygieneReport> {
  const issues = collectFileIssues(paths)
  const bin = hostBinPath()
  if (bin !== '') {
    const result = await runCommand(process.execPath, [bin, '--profile', paths.profile, '--dump-config'], {
      cwd: paths.profileDir,
      timeoutMs: 60_000,
    })
    const stderr = result.stderr ?? ''
    for (const line of stderr.split(/\r?\n/)) {
      let match = /patch: entry "([^"]+)" not found/.exec(line)
      if (match !== null) {
        issues.push({ level: 'warning', code: 'patch-orphan', message: `patch 引用了不存在的 entry：${match[1]}`, source: 'dump-config' })
        continue
      }
      match = /duplicate loader entry id: (\S+)/.exec(line)
      if (match !== null) {
        issues.push({ level: 'error', code: 'duplicate-entry', message: `重复 loader entry id：${match[1]}`, source: 'dump-config' })
      }
    }
  }
  return { ok: issues.length === 0, checkedAt: nowIso(), source: 'mixed', issues }
}

/** 修复用户 patch 里的重复顶层 id（保留最后一次），改动前备份。 */
export function fixPatchDuplicates(paths: GuardPaths): { ok: boolean; detail: string; backup: string | null } {
  const original = readText(paths.profilePatchFile)
  if (original === null) return { ok: false, detail: 'cordis.patch.yml 不存在', backup: null }
  const result = dedupePatchText(original)
  if (result.removed.length === 0) return { ok: true, detail: '没有发现重复 entry id，无需修改', backup: null }
  const backup = backupFiles(paths, [paths.profilePatchFile], 'patch-dedupe')
  try {
    writeFileSync(paths.profilePatchFile, result.text, 'utf8')
    return { ok: true, detail: `已去掉 ${result.removed.length} 个重复块：${[...new Set(result.removed)].join(', ')}`, backup: backup.dir }
  } catch (error) {
    return { ok: false, detail: `写回失败：${String(error)}`, backup: backup.dir }
  }
}

