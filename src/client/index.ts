/**
 * dsh-upgrade-guard 客户端：
 * - settings.section：兼容状态卡片（扫描/修复/恢复/重启）
 * - shell.overlay：升级后不兼容、supervisor 自愈事故的弹窗
 * 插槽契约：component 必须是 React 组件（SlotComponent = (props) => ReactNode）。
 */
import { createElement as h, useEffect, useState } from 'react'

type SlotsService = {
  inject(name: string, callback: () => unknown, label?: string): unknown
  register(entry: Record<string, unknown>, component?: unknown): unknown
}

type ClientContext = {
  slots: SlotsService
  effect(callback: () => unknown, label?: string): unknown
  inject?(names: string[], callback: (ctx: any) => void): void
}

const SELF_PACKAGE = 'dsh-upgrade-guard'

export const inject = ['slots']

const API = '/dsh-upgrade-guard/api'
const REFRESH_MS = 8000

interface Issue { level: string; code: string; message: string }
interface PluginRow {
  name: string
  spec: string | null
  version: string | null
  description: string | null
  status: string
  sourceKind: string
  trust: string
  dir: string | null
  requirement: string | null
  fiberPhase: string | null
  issues: Issue[]
}
interface AlertAction { id: string; label: string; api: string; payload?: Record<string, unknown>; danger?: boolean }
interface Alert { id: string; kind: string; severity: string; title: string; body: string; actions: AlertAction[] }
interface DisabledRow { name: string; entryIds: string[]; reason: string }
interface Counts { ok: number; warning: number; risk: number; broken: number; disabled: number; unknown: number }
interface GuardState {
  ok?: boolean
  guardVersion?: string
  profile?: string
  hostVersion?: string | null
  baseline?: { hostVersion?: string | null; previousHostVersion?: string | null } | null
  counts?: Counts | null
  lastScan?: { at?: string; trigger?: string; total?: number; plugins?: PluginRow[] } | null
  alerts?: Alert[]
  disabledByGuard?: DisabledRow[]
  supervisor?: { enabled?: boolean; pid?: number | null; running?: boolean; mode?: string | null; currentRuntime?: string | null }
  soft?: { enabled?: boolean; autoScan?: boolean }
  incidents?: { unconsumed?: number }
  updatedAt?: string
}

const STATUS_TEXT: Record<string, string> = {
  ok: '正常', warning: '注意', risk: '不兼容', broken: '损坏', disabled: '已禁用', unknown: '未声明',
}
const STATUS_ORDER: Record<string, number> = { risk: 0, broken: 1, warning: 2, disabled: 3, ok: 4, unknown: 5 }

const STYLE = `
.cg-wrap{font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#1a1a1a);padding:4px 0 18px;max-width:900px}
.cg-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:2px}
.cg-head h3{margin:0;font-size:14px;font-weight:600}
.cg-sub{color:var(--dsw-alias-label-secondary,#666);font-size:12px}
.cg-stats{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 12px}
.cg-stat{display:flex;align-items:baseline;gap:5px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l1,#e6e6e6);border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent)}
.cg-stat b{font-size:14px;font-variant-numeric:tabular-nums}
.cg-stat span{font-size:11px;color:var(--dsw-alias-label-secondary,#777)}
.cg-stat.ok b{color:var(--dsw-alias-state-success-primary,#18a058)}
.cg-stat.warning b{color:var(--dsw-alias-state-warn-primary,#d99a00)}
.cg-stat.risk b{color:var(--dsw-alias-state-error-primary,#d64545)}
.cg-stat.disabled b{color:var(--dsw-alias-label-tertiary,#999)}
.cg-stat.unknown b{color:var(--dsw-alias-state-business-primary,#2f80ed)}
.cg-bar{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 14px}
.cg-btn{font:inherit;font-size:12px;padding:5px 13px;border-radius:8px;border:1px solid transparent;background:var(--dsw-alias-button-primary-fill,#2f6fed);color:var(--dsw-alias-label-primary-inverted,#fff);cursor:pointer}
.cg-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#255ccb)}
.cg-btn.ghost{background:transparent;border-color:var(--dsw-alias-border-l2,#d5d5d5);color:var(--dsw-alias-label-primary,#333)}
.cg-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.cg-btn.danger{background:transparent;border-color:var(--dsw-alias-state-error-primary,#d64545);color:var(--dsw-alias-state-error-primary,#d64545)}
.cg-btn.mini{padding:3px 10px;font-size:11px}
.cg-btn:disabled{opacity:.45;cursor:not-allowed}
.cg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.cg-card{display:flex;flex-direction:column;gap:5px;min-width:0;border:1px solid var(--dsw-alias-border-l1,#e6e6e6);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#fff)}
.cg-card:hover{border-color:var(--dsw-alias-border-l2,#d0d0d0)}
.cg-card-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.cg-name{flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1a1a1a)}
.cg-ver{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#999);font-variant-numeric:tabular-nums}
.cg-src{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#555);overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;min-height:36px}
.cg-foot{display:flex;align-items:center;gap:6px;margin-top:2px}
.cg-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#aaa)}
.cg-dot.ok{background:var(--dsw-alias-state-success-primary,#18a058)}
.cg-dot.warning{background:var(--dsw-alias-state-warn-primary,#d99a00)}
.cg-dot.risk,.cg-dot.broken{background:var(--dsw-alias-state-error-primary,#d64545)}
.cg-dot.unknown{background:var(--dsw-alias-state-business-primary,#2f80ed)}
.cg-state{font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.cg-state.ok{color:var(--dsw-alias-state-success-primary,#18a058)}
.cg-state.warning{color:var(--dsw-alias-state-warn-primary,#d99a00)}
.cg-state.risk,.cg-state.broken{color:var(--dsw-alias-state-error-primary,#d64545)}
.cg-state.unknown{color:var(--dsw-alias-state-business-primary,#2f80ed)}
.cg-state.disabled{color:var(--dsw-alias-label-tertiary,#999)}
.cg-spacer{flex:1}
.cg-tag{flex:none;font-size:10px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.cg-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.cg-tab{font:inherit;font-size:12px;padding:3px 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#e0e0e0);background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer}
.cg-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.cg-tab.active{background:var(--dsw-alias-interactive-bg-active,rgba(47,111,237,.1));border-color:var(--dsw-alias-brand-primary,#2f6fed);color:var(--dsw-alias-brand-primary,#2f6fed)}
.cg-decl{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-help{margin:-4px 0 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
.cg-switch{width:34px;height:18px;border-radius:999px;border:none;padding:0;background:var(--dsw-alias-border-l3,#c8c8c8);position:relative;cursor:pointer;flex:none}
.cg-switch.on{background:var(--dsw-alias-state-success-primary,#18a058)}
.cg-switch:disabled{opacity:.45;cursor:not-allowed}
.cg-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.cg-switch.on .cg-knob{left:18px}
.cg-msg{margin-top:10px;padding:8px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));border:1px solid var(--dsw-alias-border-l1,#e6e6e6);white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#555);font-size:12px}
.cgo-card{border:.5px solid var(--dsw-alias-border-l4,#e6e6e6);border-radius:16px;background:var(--dsw-alias-bg-layer-3,#fff);margin-bottom:10px;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);color:var(--dsw-alias-label-primary,#1a1a1a);overflow:hidden;transition:border-color .16s,background .16s;list-style:none}
.cgo-card:hover{border-color:var(--dsw-alias-label-dimmed,#b5b5b5)}
.cgo-card.cgo-open{background:var(--dsw-alias-bg-layer-2,#f7f7f7);border-color:var(--dsw-alias-label-dimmed,#b5b5b5)}
.cgo-head{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:14px 16px;background:transparent;border:none;border-radius:12px;cursor:pointer;text-align:left;color:inherit;font:inherit}
.cgo-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:-2px}
.cgo-head-main{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.cgo-title-row{display:flex;align-items:baseline;gap:8px}
.cgo-title{font-size:14px;font-weight:600}
.cgo-ver{font-size:11px;color:var(--dsw-alias-label-caption,#999)}
.cgo-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cgo-chevron{flex:none;width:8px;height:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;color:var(--dsw-alias-label-tertiary,#999);transform:rotate(45deg);transition:transform .16s ease;margin-right:4px}
.cgo-chevron.open{transform:rotate(-135deg)}
.cgo-body{border-top:.5px solid var(--dsw-alias-border-l2,#ddd);margin:0 16px;padding-bottom:8px}
.cgo-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}
.cgo-row:first-child{border-top:none}
.cgo-row-t{font-size:12.5px}
.cgo-row-h{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#888);margin-top:2px}
.cg-alert{position:absolute;right:18px;bottom:18px;z-index:99999;max-width:min(430px,calc(100vw - 36px));background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;padding:13px 15px;box-shadow:var(--dsw-shadow-lv3,0 10px 34px rgba(0,0,0,.18));pointer-events:auto;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:12.5px;color:var(--dsw-alias-label-primary,#1a1a1a)}
.cg-alert.error{border-color:var(--dsw-alias-state-error-primary,#d64545)}
.cg-alert.info{border-color:var(--dsw-alias-brand-primary,#2f6fed)}
.cg-alert h4{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}
.cg-alert.error h4{color:var(--dsw-alias-state-error-primary,#d64545)}
.cg-alert.info h4{color:var(--dsw-alias-state-business-primary,#2f80ed)}
.cg-alert .b{white-space:pre-wrap;max-height:190px;overflow:auto;color:var(--dsw-alias-label-secondary,#555);font-size:12px}
.cg-alert .a{display:flex;gap:7px;margin-top:11px;flex-wrap:wrap}
`

let styleInjected = false
function ensureStyle(): void {
  try {
    if (styleInjected || typeof document === 'undefined') return
    if (document.querySelector('style[data-dsh-upgrade-guard-css]') !== null) { styleInjected = true; return }
    const tag = document.createElement('style')
    tag.setAttribute('data-dsh-upgrade-guard-css', '')
    tag.textContent = STYLE
    document.head.appendChild(tag)
    styleInjected = true
  } catch { /* head 尚不可用时下次再试 */ }
}

function fetchJson(path: string, init?: RequestInit): Promise<any> {
  return fetch(API + path, { headers: { 'content-type': 'application/json' }, ...init }).then((response) => response.json())
}

function isOfficial(plugin: PluginRow): boolean {
  return plugin.trust === 'system' || plugin.sourceKind === 'official' || plugin.name.startsWith('@deepseek-ai/')
}

function isLocalDev(plugin: PluginRow): boolean {
  if (plugin.trust === 'injected' || plugin.sourceKind === 'local') return true
  const spec = plugin.spec ?? ''
  return spec.startsWith('link:') || spec.startsWith('file:') || spec.startsWith('.')
}

function visiblePlugins(plugins: PluginRow[]): PluginRow[] {
  return plugins.filter((plugin) => !isOfficial(plugin))
}

function countPlugins(plugins: PluginRow[]): Counts {
  const counts: Counts = { ok: 0, warning: 0, risk: 0, broken: 0, disabled: 0, unknown: 0 }
  for (const plugin of plugins) counts[plugin.status as keyof Counts] += 1
  return counts
}

function sourceLabel(plugin: PluginRow): string {
  if (plugin.trust === 'injected') return `注入 · ${plugin.dir ?? plugin.name}`
  if (plugin.sourceKind === 'official') return '官方 bundle'
  if (plugin.sourceKind === 'local') return `本地 · ${plugin.spec ?? plugin.dir ?? ''}`
  if (plugin.sourceKind === 'git') return `Git · ${plugin.spec ?? ''}`
  if (plugin.sourceKind === 'npm') return `npm · ${plugin.spec ?? ''}`
  return plugin.spec ?? ''
}

function describe(plugin: PluginRow, disabled: boolean): string {
  const issue = plugin.issues?.find((item) => item.level === 'risk') ?? plugin.issues?.find((item) => item.level === 'warning')
  if (plugin.status === 'risk' || plugin.status === 'broken') {
    const parts = [issue?.message ?? '与当前宿主不兼容']
    if (plugin.requirement !== null && plugin.requirement !== undefined) parts.push(`声明要求：${plugin.requirement}`)
    return parts.join('；')
  }
  if (plugin.status === 'warning') {
    const parts = [issue?.message ?? '存在兼容性提醒']
    if (plugin.requirement !== null && plugin.requirement !== undefined) parts.push(`声明要求：${plugin.requirement}`)
    return parts.join('；')
  }
  if (plugin.status === 'unknown') return '未声明兼容范围；升级后若启动失败，由 supervisor 兜底禁用或回滚。'
  if (plugin.status === 'disabled') return disabled ? '已由兼容守卫禁用，可点右侧恢复。' : '已通过 patch 禁用。'
  return plugin.requirement !== null && plugin.requirement !== undefined
    ? `声明要求：${plugin.requirement}`
    : '与当前宿主版本兼容。'
}

function StatChip(props: { kind: string; value: number; label: string; hint?: string }): unknown {
  return h('div', { className: `cg-stat ${props.kind}`, title: props.hint ?? props.label },
    h('b', undefined, String(props.value)),
    h('span', undefined, props.label),
  )
}

function PluginCard(props: { plugin: PluginRow; disabled: boolean; busy: boolean; softEnabled: boolean; onAction: (path: string, body?: Record<string, unknown>) => void }): unknown {
  const { plugin, disabled, busy, softEnabled, onAction } = props
  const isDisabled = plugin.status === 'disabled' || disabled
  const description = plugin.description !== null && plugin.description !== undefined && plugin.description !== ''
    ? plugin.description
    : describe(plugin, disabled)
  const declaration = plugin.requirement !== null && plugin.requirement !== undefined
    ? `声明：${plugin.requirement}`
    : '声明：未声明兼容范围（engines.dsh / peerDependencies）'
  const source = sourceLabel(plugin)
  const footer: unknown[] = [
    h('span', { key: 'dot', className: `cg-dot ${plugin.status}` }),
    h('span', { key: 'state', className: `cg-state ${plugin.status}` }, STATUS_TEXT[plugin.status] ?? plugin.status),
    h('span', { key: 'spacer', className: 'cg-spacer' }),
  ]
  if (plugin.status === 'risk' || plugin.status === 'broken') {
    footer.push(h('button', {
      key: 'fix',
      className: 'cg-btn mini',
      disabled: busy,
      onClick: () => onAction('/repair', { name: plugin.name }),
    }, '修复'))
  }
  const isSelf = plugin.name === SELF_PACKAGE
  if (isSelf) {
    footer.push(h('span', { key: 'self-state', className: `cg-state ${softEnabled ? 'ok' : 'disabled'}` }, softEnabled ? '已启用' : '已停用'))
    footer.push(h('button', {
      key: 'soft-toggle',
      className: `cg-switch${softEnabled ? ' on' : ''}`,
      disabled: busy,
      title: softEnabled ? '点击停用自动巡检' : '点击启用自动巡检',
      onClick: () => onAction('/config', { enabled: !softEnabled }),
    }, h('span', { className: 'cg-knob' })))
    footer.push(h('button', {
      key: 'self-uninstall',
      className: 'cg-btn mini danger',
      disabled: busy,
      onClick: () => onAction('/uninstall', { name: plugin.name, allowSelf: true }),
    }, '卸载'))
  } else {
  footer.push(h('button', {
    key: 'toggle',
    className: `cg-switch${isDisabled ? '' : ' on'}`,
    disabled: busy,
    title: isDisabled ? '点击启用' : '点击禁用',
    onClick: () => onAction('/toggle', { name: plugin.name, enabled: isDisabled }),
  }, h('span', { className: 'cg-knob' })))
  if (!isSelf && plugin.trust === 'community' && plugin.sourceKind !== 'official') {
    footer.push(h('button', {
      key: 'uninstall',
      className: 'cg-btn mini danger',
      disabled: busy,
      onClick: () => onAction('/uninstall', { name: plugin.name }),
    }, '卸载'))
  }
  }
  return h('div', { className: 'cg-card' },
    h('div', { className: 'cg-card-head' },
      h('span', { className: 'cg-name', title: plugin.name }, plugin.name),
      isLocalDev(plugin) ? h('span', { key: 'local', className: 'cg-tag' }, '本地开发') : null,
      plugin.version !== null ? h('span', { className: 'cg-ver' }, `v${plugin.version}`) : null,
    ),
    source === '' ? null : h('div', { className: 'cg-src', title: source }, source),
    h('div', { className: 'cg-desc', title: description }, description),
    h('div', { className: 'cg-decl', title: declaration }, declaration),
    h('div', { className: 'cg-foot' }, ...footer),
  )
}

function formatCounts(counts: Counts | null | undefined): string {
  if (counts === null || counts === undefined) return '尚未扫描'
  return `正常 ${counts.ok} · 注意 ${counts.warning} · 不兼容 ${counts.risk} · 损坏 ${counts.broken} · 已禁用 ${counts.disabled} · 未声明 ${counts.unknown}`
}

export function SettingsSection(): unknown {
  ensureStyle()
  const [state, setState] = useState<GuardState | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')

  const refresh = (): void => {
    fetchJson('/state').then((next: GuardState) => setState(next)).catch((error: unknown) => setMessage(`读取状态失败：${String(error)}`))
  }
  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  const act = (path: string, body?: Record<string, unknown>): void => {
    if (path === '/restart' && !window.confirm('确定要重启 DSH 吗？当前页面会断开，稍后需要重新打开。')) return
    if (path === '/uninstall') {
      const target = String(body?.name ?? '')
      if (!window.confirm(`确定卸载 ${target}？卸载后需要重启 DSH 才会彻底消失。`)) return
    }
    setBusy(true)
    setMessage('执行中…')
    fetchJson(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
      .then((result: any) => {
        if (result.report !== undefined) {
          const visible = visiblePlugins(result.report.plugins ?? [])
          setMessage(`扫描完成 · 共 ${visible.length} 个插件：${formatCounts(countPlugins(visible))}`)
        } else {
          const suffix = result.restartRequired === true ? '（需要重启生效）' : ''
          setMessage(`${result.detail ?? '完成'}${suffix}`)
        }
      })
      .catch((error: unknown) => setMessage(`请求失败：${String(error)}`))
      .finally(() => {
        setBusy(false)
        refresh()
        if (path === '/toggle') window.setTimeout(refresh, 2200)
      })
  }

  const supervisor = state?.supervisor ?? {}
  const allPlugins = visiblePlugins(state?.lastScan?.plugins ?? []).filter((plugin) => plugin.name !== SELF_PACKAGE)
  const counts = countPlugins(allPlugins)
  const meta = `profile ${state?.profile ?? '?'} · 宿主 ${state?.hostVersion ?? '未知'}`
    + (state?.baseline?.previousHostVersion ? `（上次 ${state.baseline.previousHostVersion}）` : '')
    + ` · supervisor ${supervisor.running === true ? `运行中 #${supervisor.pid ?? '?'}${supervisor.mode ? ` [${supervisor.mode}]` : ''}` : '未运行'}`
  const disabled = new Set((state?.disabledByGuard ?? []).map((item) => item.name))
  const filtered = allPlugins.filter((plugin) => {
    if (filter === 'ok') return plugin.status === 'ok'
    if (filter === 'disabled') return plugin.status === 'disabled'
    if (filter === 'declared') return plugin.requirement !== null && plugin.requirement !== undefined
    if (filter === 'undeclared') return plugin.requirement === null || plugin.requirement === undefined
    if (filter === 'local') return isLocalDev(plugin)
    return true
  })
  const sorted = [...filtered].sort((a, b) => {
    const order = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    return order !== 0 ? order : a.name.localeCompare(b.name)
  })
  const softEnabled = state?.soft?.enabled !== false
  const cards = sorted.map((plugin) => h(PluginCard, {
    key: plugin.name,
    plugin,
    disabled: disabled.has(plugin.name),
    busy,
    softEnabled,
    onAction: act,
  }))

  const tabs: Array<{ id: string; label: string; count: number }> = [
    { id: 'all', label: '全部', count: allPlugins.length },
    { id: 'ok', label: '正常', count: counts.ok },
    { id: 'disabled', label: '已禁用', count: counts.disabled },
    { id: 'declared', label: '已声明', count: allPlugins.filter((plugin) => plugin.requirement !== null && plugin.requirement !== undefined).length },
    { id: 'undeclared', label: '未声明', count: allPlugins.filter((plugin) => plugin.requirement === null || plugin.requirement === undefined).length },
    { id: 'local', label: '本地开发', count: allPlugins.filter((plugin) => isLocalDev(plugin)).length },
  ]
  const tabBar = h('div', { className: 'cg-tabs', key: 'tabs' }, ...tabs.map((tab) => h('button', {
    key: tab.id,
    className: `cg-tab${filter === tab.id ? ' active' : ''}`,
    onClick: () => setFilter(tab.id),
  }, `${tab.label} ${tab.count}`)))

  return h('div', { className: 'cg-wrap' },
    h('div', { className: 'cg-head', key: 'head' },
      h('h3', undefined, `兼容守卫${state?.guardVersion !== undefined ? ` v${state.guardVersion}` : ''}`),
      h('span', { className: 'cg-sub' }, meta),
    ),
    h('div', { className: 'cg-stats', key: 'stats' },
      h(StatChip, { kind: 'total', value: allPlugins.length, label: '插件', hint: '当前 profile 已安装的社区/本地插件（官方 bundle 已隐藏）' }),
      h(StatChip, { kind: 'ok', value: counts.ok, label: '兼容', hint: '声明的兼容范围满足当前宿主版本，且已成功加载' }),
      h(StatChip, { kind: 'warning', value: counts.warning, label: '注意', hint: '可选依赖不匹配或隐式上界超出，通常不致命' }),
      h(StatChip, { kind: 'risk', value: counts.risk + counts.broken, label: '有风险', hint: '低于最低要求、显式上界超限、core 遮蔽或加载失败' }),
      h(StatChip, { kind: 'disabled', value: counts.disabled, label: '已禁用', hint: '被 patch 或守卫禁用的插件' }),
      h(StatChip, { kind: 'unknown', value: counts.unknown, label: '无声明', hint: '插件没有写 engines.dsh / peerDependencies，无法提前判定，只能运行期兜底' }),
    ),
    h('div', { className: 'cg-help', key: 'help' }, '声明 = 插件 package.json 里的 engines.dsh / peerDependencies 兼容范围；「无声明」= 作者没写，无法提前判定。'),
    h('div', { className: 'cg-bar', key: 'bar' },
      h('button', { className: 'cg-btn', disabled: busy, onClick: () => act('/check') }, '立即检查'),
      h('button', { className: 'cg-btn ghost', disabled: busy, onClick: () => act('/repair') }, '一键修复'),
      h('button', { className: 'cg-btn ghost', disabled: busy, onClick: () => act('/restart') }, '重启 DSH'),
      h('button', { className: 'cg-btn ghost', disabled: busy, onClick: () => act('/alert/ack-all') }, '清除提醒'),
    ),
    tabBar,
    h('div', { className: 'cg-grid', key: 'grid' },
      cards.length === 0 ? h('div', { className: 'cg-sub' }, '该分类下没有插件') : cards,
    ),
    message === '' ? null : h('div', { className: 'cg-msg', key: 'msg' }, message),
  )
}

/** 官方「设置 → 插件 → 插件配置」里的兼容守卫卡片（折叠样式，与其他插件卡片一致）。 */
export function GuardPluginCard(): unknown {
  ensureStyle()
  const [state, setState] = useState<GuardState | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  const refresh = (): void => {
    fetchJson('/state').then((next: GuardState) => setState(next)).catch((error: unknown) => setMessage(`读取状态失败：${String(error)}`))
  }
  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  const soft = { enabled: state?.soft?.enabled !== false, autoScan: state?.soft?.autoScan !== false }
  const supervisor = state?.supervisor ?? {}
  const counts = state?.counts ?? { ok: 0, warning: 0, risk: 0, broken: 0, disabled: 0, unknown: 0 }

  const act = (path: string, body?: Record<string, unknown>, confirmText?: string): void => {
    if (confirmText !== undefined && !window.confirm(confirmText)) return
    setBusy(true)
    setMessage('执行中…')
    fetchJson(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
      .then((result: any) => {
        setMessage(String(result.detail ?? '完成'))
        refresh()
        if (path === '/config' || path === '/check') window.setTimeout(refresh, 2200)
      })
      .catch((error: unknown) => setMessage(`请求失败：${String(error)}`))
      .finally(() => setBusy(false))
  }

  const statusText = `宿主 ${state?.hostVersion ?? '未知'} · supervisor ${supervisor.running === true ? `运行中 #${supervisor.pid ?? '?'}${supervisor.mode ? ` [${supervisor.mode}]` : ''}` : '未运行'} · 插件 ${state?.lastScan?.total ?? 0}`
    + ` · 有风险 ${counts.risk + counts.broken} · 已禁用 ${counts.disabled}`

  const row = (title: string, hint: string, control: unknown): unknown => h('div', { className: 'cgo-row' },
    h('div', undefined, h('div', { className: 'cgo-row-t' }, title), h('div', { className: 'cgo-row-h' }, hint)),
    control,
  )
  const toggle = (on: boolean, onClick: () => void, title: string): unknown => h('button', {
    className: `cg-switch${on ? ' on' : ''}`,
    disabled: busy,
    title,
    onClick,
  }, h('span', { className: 'cg-knob' }))

  return h('div', { className: `cgo-card${open ? ' cgo-open' : ''}` },
    h('button', {
      type: 'button',
      className: 'cgo-head',
      'aria-expanded': open,
      onClick: () => setOpen(!open),
    },
      h('div', { className: 'cgo-head-main' },
        h('div', { className: 'cgo-title-row' },
          h('span', { className: 'cgo-title' }, '兼容守卫'),
          state?.guardVersion !== undefined ? h('span', { className: 'cgo-ver' }, `v${state.guardVersion}`) : null,
        ),
        h('div', { className: 'cgo-desc' }, '宿主升级后的插件兼容巡检与启动救援。'),
      ),
      h('span', { className: `cgo-chevron${open ? ' open' : ''}` }),
    ),
    open ? h('div', { className: 'cgo-body' },
      row('启用兼容守卫', '关闭后不再自动巡检与提醒；手动检查与 supervisor 救援仍保留。', toggle(soft.enabled,
        () => act('/config', { enabled: !soft.enabled }), soft.enabled ? '点击停用' : '点击启用')),
      row('自动巡检', '开启后每 5 分钟轻量检查一次插件兼容状态。', toggle(soft.autoScan,
        () => act('/config', { autoScan: !soft.autoScan }), soft.autoScan ? '点击关闭自动巡检' : '点击开启自动巡检')),
      row('当前状态', statusText, h('button', { className: 'cg-btn ghost mini', disabled: busy, onClick: () => act('/check') }, '立即检查')),
      row('卸载兼容守卫', '从 profile 移除本插件并停止 supervisor；重启后彻底消失。', h('button', {
        className: 'cg-btn danger mini',
        disabled: busy,
        onClick: () => act('/uninstall', { name: SELF_PACKAGE, allowSelf: true }, '确定卸载兼容守卫？会移除插件并停止 supervisor，重启后彻底消失。'),
      }, '卸载兼容守卫')),
      message === '' ? null : h('div', { className: 'cg-msg', style: { marginTop: '8px' } }, message),
    ) : null,
  )
}

export function AlertOverlay(): unknown {
  ensureStyle()
  const [state, setState] = useState<GuardState | null>(null)
  const [dismissed, setDismissed] = useState('')

  const refresh = (): void => {
    fetchJson('/state').then((next: GuardState) => setState(next)).catch(() => undefined)
  }
  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  const alert = (state?.alerts ?? []).find((item) => item.id !== dismissed) ?? null
  if (alert === null) return null

  const runAction = (action: AlertAction): void => {
    if (action.api === 'restart' && !window.confirm('supervisor 将重启 DSH，当前页面会断开。继续？')) return
    const finish = (): void => {
      setDismissed(alert.id)
      fetchJson('/alert/ack', { method: 'POST', body: JSON.stringify({ id: alert.id }) }).catch(() => undefined)
      refresh()
    }
    if (['check', 'repair', 'restart', 'enable'].includes(action.api)) {
      fetchJson(`/${action.api}`, { method: 'POST', body: JSON.stringify(action.payload ?? {}) })
        .then((result: any) => {
          if (action.api === 'check') window.alert(`扫描完成：${formatCounts(result.report?.counts)}`)
          else window.alert(result.detail ?? '完成')
        })
        .catch((error: unknown) => window.alert(`请求失败：${String(error)}`))
        .finally(finish)
    } else {
      finish()
    }
  }

  const actionButtons = (alert.actions ?? []).map((action) => h('button', {
    key: action.id,
    className: action.danger === true ? 'cg-btn danger' : 'cg-btn ghost',
    onClick: () => runAction(action),
  }, action.label))
  actionButtons.push(h('button', {
    key: 'ack',
    className: 'cg-btn ghost',
    onClick: () => {
      setDismissed(alert.id)
      fetchJson('/alert/ack', { method: 'POST', body: JSON.stringify({ id: alert.id }) }).catch(() => undefined)
      refresh()
    },
  }, '知道了'))

  return h('div', {
    className: `cg-alert${alert.severity === 'error' ? ' error' : alert.severity === 'info' ? ' info' : ''}`,
    style: { pointerEvents: 'auto' },
  },
    h('h4', undefined, alert.title),
    h('div', { className: 'b' }, alert.body),
    h('div', { className: 'a' }, ...actionButtons),
  )
}

export function apply(ctx: ClientContext): void {
  ctx.inject?.(['settingsScope'], (scoped: any) => {
    scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
      name: 'settings.plugin.item',
      key: 'upgrade-guard',
    }, GuardPluginCard))
  })

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'upgrade-guard-settings',
    order: 60,
    label: () => '兼容守卫',
  }, SettingsSection)), 'upgrade-guard: settings')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'upgrade-guard-alert',
    order: 90,
    label: () => '兼容守卫提醒',
  }, AlertOverlay)), 'upgrade-guard: overlay')
}
