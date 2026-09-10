/**
 * 最小 semver：解析、比较、范围判定、以及"方向性风险"分类。
 * 策略与 dshmarket 的 compatibility.js 对齐：
 * - belowMin（低于所有下限）= 确定风险；
 * - aboveMax（高于所有上限）：显式上界/精确锁定 = 风险，隐式 caret/tilde 上界 = 仅警告；
 * - optional peer 的不匹配 = 警告；无法解析 = 未知（不产生风险）。
 */

export interface SemVer {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseSemver(value: unknown): SemVer | null {
  if (typeof value !== 'string') return null
  const m = SEMVER_RE.exec(value.trim())
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** -1 / 0 / 1，输入不可解析时返回 null。 */
export function compareSemver(a: unknown, b: unknown): number | null {
  const pa = typeof a === 'string' ? parseSemver(a) : (a as SemVer | null)
  const pb = typeof b === 'string' ? parseSemver(b) : (b as SemVer | null)
  if (pa === null || pb === null) return null
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  return comparePre(pa.pre, pb.pre)
}

function nextBound(target: string, kind: '^' | '~'): string | null {
  const v = parseSemver(target)
  if (v === null) return null
  if (kind === '^') {
    if (v.major > 0) return `${v.major + 1}.0.0-0`
    if (v.minor > 0) return `0.${v.minor + 1}.0-0`
    return `0.0.${v.patch + 1}-0`
  }
  return `${v.major}.${v.minor + 1}.0-0`
}

type Op = 'exact' | '^' | '~' | '>=' | '>' | '<=' | '<' | '*'

interface Comparator {
  op: Op
  target: string
}

interface Alternative {
  comparators: Comparator[]
  exact: string | null
  explicitUpper: boolean
}

function parseComparator(token: string): Comparator | null {
  const t = token.trim()
  if (t === '' || t === '*' || /^x$/i.test(t)) return { op: '*', target: '' }
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(t)
  if (m === null) return null
  const rawOp = m[1] ?? ''
  const rawTarget = m[2].trim()
  // partial version：npm 允许 `2` / `2.1`，补零成完整 semver
  let target = rawTarget
  if (/^\d+$/.test(target)) target = `${target}.0.0`
  else if (/^\d+\.\d+$/.test(target)) target = `${target}.0`
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(target)) return null
  const op: Op = rawOp === '' ? 'exact' : (rawOp as Op)
  return { op, target }
}

function boundsFor(range: string): Alternative[] | null {
  const alternatives: Alternative[] = []
  for (const rawAlt of range.split('||')) {
    const altText = rawAlt.replace(/(>=|<=|>|<|\^|~|=)\s+/g, '$1').trim()
    if (altText === '') {
      alternatives.push({ comparators: [], exact: null, explicitUpper: false })
      continue
    }
    const tokens = altText.split(/\s+/).filter(Boolean)
    // hyphen range: 1.2.3 - 2.3.4
    if (tokens.length === 3 && tokens[1] === '-') {
      const lo = parseComparator(`>=${tokens[0]}`)
      const hi = parseComparator(`<=${tokens[2]}`)
      if (lo === null || hi === null) return null
      alternatives.push({ comparators: [lo, hi], exact: null, explicitUpper: true })
      continue
    }
    const comparators: Comparator[] = []
    const expanded: Comparator[] = []
    let exact: string | null = null
    let explicitUpper = false
    for (const token of tokens) {
      const comparator = parseComparator(token)
      if (comparator === null) return null
      if (comparator.op === 'exact') exact = comparator.target
      else if (comparator.op === '<' || comparator.op === '<=') explicitUpper = true
      comparators.push(comparator)
      expanded.push(comparator)
      // 把隐式上界展开成显式 <，方向性分类才能识别 aboveMax
      if (comparator.op === '^' || comparator.op === '~') {
        const upper = nextBound(comparator.target, comparator.op)
        if (upper !== null) expanded.push({ op: '<', target: upper })
      }
    }
    alternatives.push({ comparators: expanded, exact, explicitUpper })
  }
  return alternatives
}

function satisfiedByAlternative(version: SemVer, alt: Alternative): boolean {
  if (alt.exact !== null) return compareSemver(version, alt.exact) === 0
  for (const c of alt.comparators) {
    if (c.op === '*' || c.op === 'exact') continue
    const cmp = compareSemver(version, c.target)
    if (cmp === null) return false
    if (c.op === '>=' && cmp < 0) return false
    if (c.op === '>' && cmp <= 0) return false
    if (c.op === '<=' && cmp > 0) return false
    if (c.op === '<' && cmp >= 0) return false
    if (c.op === '^') {
      const upper = nextBound(c.target, '^')
      if (upper === null || cmp < 0 || (compareSemver(version, upper) ?? 1) >= 0) return false
    }
    if (c.op === '~') {
      const upper = nextBound(c.target, '~')
      if (upper === null || cmp < 0 || (compareSemver(version, upper) ?? 1) >= 0) return false
    }
  }
  return true
}

/** 版本是否落在 range 内；range 不可解析时返回 null（未知）。 */
export function satisfiesRange(version: unknown, range: unknown): boolean | null {
  if (typeof version !== 'string' || typeof range !== 'string') return null
  const v = parseSemver(version)
  if (v === null) return null
  const alts = boundsFor(range)
  if (alts === null) return null
  return alts.some((alt) => satisfiedByAlternative(v, alt))
}

function belowAllMins(version: SemVer, alts: Alternative[]): boolean {
  return alts.every((alt) => {
    if (alt.exact !== null) return (compareSemver(version, alt.exact) ?? 0) < 0
    let hasLower = false
    for (const c of alt.comparators) {
      if (c.op === '>=' || c.op === '>') {
        hasLower = true
        const cmp = compareSemver(version, c.target) ?? 1
        if (c.op === '>' ? cmp > 0 : cmp >= 0) return false
      }
    }
    return hasLower
  })
}

function aboveAllMaxes(version: SemVer, alts: Alternative[]): boolean {
  return alts.every((alt) => {
    if (alt.exact !== null) return (compareSemver(version, alt.exact) ?? 0) > 0
    let hasUpper = false
    for (const c of alt.comparators) {
      if (c.op === '<' || c.op === '<=') {
        hasUpper = true
        const cmp = compareSemver(version, c.target) ?? -1
        if (c.op === '<=' ? cmp < 0 : cmp <= 0) return false
      }
    }
    return hasUpper
  })
}

function allExplicitUpperOrExact(alts: Alternative[]): boolean {
  return alts.every((alt) => alt.exact !== null || alt.explicitUpper)
}

export type RangeVerdict =
  | { kind: 'risk'; direction: 'belowMin' | 'aboveMax'; range: string; resolved: string }
  | { kind: 'warning'; reason: 'optional' | 'aboveMax' | 'unparseable'; range: string; resolved: string }
  | { kind: 'none' }

/**
 * 判定一个"已确认不满足"的声明。调用方只在确认 mismatch 后调用；
 * 范围不可解析时返回 unparseable 警告。
 */
export function classifyMismatch(range: string, version: string, optional = false): RangeVerdict {
  if (optional) return { kind: 'warning', reason: 'optional', range, resolved: version }
  const alts = boundsFor(range)
  if (alts === null) return { kind: 'warning', reason: 'unparseable', range, resolved: version }
  const v = parseSemver(version)
  if (v === null) return { kind: 'warning', reason: 'unparseable', range, resolved: version }
  if (belowAllMins(v, alts)) return { kind: 'risk', direction: 'belowMin', range, resolved: version }
  if (aboveAllMaxes(v, alts)) {
    return allExplicitUpperOrExact(alts)
      ? { kind: 'risk', direction: 'aboveMax', range, resolved: version }
      : { kind: 'warning', reason: 'aboveMax', range, resolved: version }
  }
  return { kind: 'none' }
}

/** 判断 range 里是否需要 DSH 版本信息（供 UI 显示"声明要求"）。 */
export function displayRange(range: string): string {
  return range.trim()
}
