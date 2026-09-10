import { randomUUID } from 'node:crypto'
import { nowIso, readJson, writeJsonAtomic } from './util.js'
import type { ScanReport } from './scan.js'
import type { GuardPaths } from './paths.js'

export interface AlertAction {
  id: string
  label: string
  api: string
  payload?: Record<string, unknown>
  danger?: boolean
}

export interface GuardAlert {
  id: string
  kind: 'host-upgraded' | 'scan-risk' | 'boot-rescued' | 'action-done' | 'info'
  severity: 'info' | 'warning' | 'error'
  title: string
  body: string
  actions: AlertAction[]
  createdAt: string
  seen: boolean
}

export interface DisabledRecord {
  name: string
  entryIds: string[]
  at: string
  reason: string
  backup: string | null
  appended?: string | null
}

export interface GuardState {
  schema: string
  baseline: {
    hostVersion: string | null
    hostDir: string | null
    firstSeenAt: string
    lastSeenAt: string
    previousHostVersion: string | null
  } | null
  lastScan: ScanReport | null
  scanHistory: Array<{ at: string; trigger: string; hostVersion: string | null; total: number; risk: number; warning: number; broken: number }>
  alerts: GuardAlert[]
  disabledByGuard: DisabledRecord[]
  supervisor: { enabled: boolean; pid: number | null; adoptedAt: string | null }
  updatedAt: string
}

const SCHEMA = 'dsh-upgrade-guard/state/v1'

export function defaultState(): GuardState {
  return {
    schema: SCHEMA,
    baseline: null,
    lastScan: null,
    scanHistory: [],
    alerts: [],
    disabledByGuard: [],
    supervisor: { enabled: false, pid: null, adoptedAt: null },
  updatedAt: nowIso(),
  }
}

export function loadState(paths: GuardPaths): GuardState {
  const raw = readJson(paths.stateFile)
  if (raw === null || raw.schema !== SCHEMA) return defaultState()
  const state = defaultState()
  const baseline = raw.baseline as GuardState['baseline']
  return {
    ...state,
    ...(raw as Partial<GuardState>),
    schema: SCHEMA,
    baseline: baseline ?? null,
    lastScan: (raw.lastScan as ScanReport | null) ?? null,
    scanHistory: Array.isArray(raw.scanHistory) ? (raw.scanHistory as GuardState['scanHistory']) : [],
    alerts: Array.isArray(raw.alerts) ? (raw.alerts as GuardAlert[]) : [],
    disabledByGuard: Array.isArray(raw.disabledByGuard) ? (raw.disabledByGuard as DisabledRecord[]) : [],
    supervisor: {
      ...state.supervisor,
      ...(raw.supervisor as GuardState['supervisor'] | undefined),
    },
  }
}

export function saveState(paths: GuardPaths, state: GuardState): void {
  state.updatedAt = nowIso()
  writeJsonAtomic(paths.stateFile, state)
}

export function addAlert(state: GuardState, input: Omit<GuardAlert, 'id' | 'createdAt' | 'seen'> & { id?: string }): GuardAlert {
  const alert: GuardAlert = {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    body: input.body,
    actions: input.actions ?? [],
    createdAt: nowIso(),
    seen: false,
  }
  state.alerts.unshift(alert)
  if (state.alerts.length > 50) state.alerts.length = 50
  return alert
}

export function ackAlert(state: GuardState, id: string): boolean {
  const alert = state.alerts.find((item) => item.id === id)
  if (alert === undefined) return false
  alert.seen = true
  return true
}

export function pushScanHistory(state: GuardState, report: ScanReport): void {
  const counts = report.counts
  state.scanHistory.unshift({
    at: report.at,
    trigger: report.trigger,
    hostVersion: report.hostVersion,
    total: report.total,
    risk: counts.risk,
    warning: counts.warning,
    broken: counts.broken,
  })
  if (state.scanHistory.length > 30) state.scanHistory.length = 30
}
