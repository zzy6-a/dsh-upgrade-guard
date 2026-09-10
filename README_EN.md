# dsh-upgrade-guard

English | [中文](README.md)

[![Download](https://img.shields.io/badge/Download-latest-2e7d32?style=flat&logo=github&logoColor=white)](https://github.com/zzy6-a/dsh-upgrade-guard/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2f6fed)](https://github.com/topics/dsh-plugin)

**A safety net for DeepSeek Harness upgrades.**

`dsh-upgrade-guard` watches the DSH host version. When it changes, the guard audits every installed plugin against the new host, then (with your confirmation) repairs, updates, disables, or rolls the host back — so a single incompatible community plugin cannot leave you with a harness that refuses to boot.

> DSH is in developer preview and ships compatibility-breaking changes. This plugin exists because that is the expected failure mode, not an edge case.

## Features

- **Post-upgrade audit** — triggers automatically on the first boot after the host version changes.
- **Declared compatibility checks** — reads each installed plugin's `engines.dsh` and `peerDependencies` against the resolved host/core versions, with the ecosystem's directional policy (below-min and explicit upper bounds are risks; implicit caret ceilings are warnings).
- **Install/load/API surface checks** — Loader fiber state, dangling junctions, core-package shadowing.
- **Patch hygiene** — duplicate top-level entry ids and stale patch targets in `cordis.patch.yml`, with a one-click dedupe (backed up first).
- **Plugin probes** — plugins may declare `dsh.compat.probe`; the guard runs it in an isolated child process and reports pass/fail.
- **dshmarket diagnostics** — when the market plugin is present, its read-only composition diagnostics (duplicates, stale targets, multi-version, peer mismatches) are merged into the same report.
- **Guided remediation** — finds the *highest published version compatible with the current host* (not blindly `@latest`), installs it, otherwise repairs the local install, otherwise disables the plugin.
- **Boot-failure rescue** — an **out-of-host supervisor** survives a host that fails to start: it parses the boot log, disables the failing loader entry, and relaunches.
- **Host rollback** — if disabling is not enough, the supervisor starts the previous host version from a snapshot. No `sudo`, no npm.
- **Manual restart** — restart DSH from the settings panel or the alert card.
- **Bilingual UI / notifications** — audit results, incidents, and actions appear in the DSH settings section and in overlay alerts.

## How it works

Three parts, one package:

| Part | Where | Responsibility |
| --- | --- | --- |
| Host plugin | DSH profile bundle | Version baseline, scans, remediation, HTTP API, settings namespace |
| Client UI | DSH web client | Settings panel, plugin cards, status switches, overlay alerts |
| Supervisor | detached Node process | Adopts the host, snapshots host versions, rescues crashes, rolls back, performs restarts |

State lives under `~/.dsh/upgrade-guard/`.

### Patch hygiene and plugin probes

- Each audit checks the profile `cordis.patch.yml` for duplicate top-level `- id:` entries and stale patch targets reported by `dsh --dump-config`; the panel shows a "composition diagnostics" block with a dedupe action (keeps the last entry, backs up first).
- If `dsh-market` is installed, the guard reads its read-only diagnostics endpoint and merges duplicates / stale targets / multi-version / peer mismatches into the same block. An unavailable or unauthorized market is skipped without affecting the audit.
- Plugin authors can declare an optional probe; it runs in a detached Node child so a crash or timeout cannot take down the host:

```json
{
  "dsh": {
    "compat": {
      "probe": { "file": "./lib/probe.js", "export": "probe", "timeoutMs": 20000 }
    }
  }
}
```

```js
// lib/probe.js — ctx: { hostVersion, profile, dshHome, pluginDir }
export async function probe(ctx) {
  const ok = await checkSomethingAgainst(ctx.hostVersion)
  return { ok, message: ok ? 'ok' : 'why it is incompatible' }
}
```

## Install

### GitHub Release (current channel)

```sh
dsh plugin --profile web add \
  https://github.com/zzy6-a/dsh-upgrade-guard/releases/download/v0.2.0/dsh-upgrade-guard-0.2.0.tgz
```

Or download the `.tgz` from the Releases page and install the local file:

```sh
dsh plugin --profile web add /path/to/dsh-upgrade-guard-0.2.0.tgz
```

### npm (once published)

```sh
dsh plugin --profile web add dsh-upgrade-guard
```

### Local checkout (development)

```sh
dsh plugin --profile web add link:/path/to/dsh-upgrade-guard
```

Then restart DSH once (`设置 → 升级守卫 → 重启 DSH`, or your usual launcher). The guard mounts as a profile bundle and keeps itself loaded on later boots.

## What happens after a host upgrade

1. The guard compares the current host version with the recorded baseline.
2. Every installed community/local plugin is audited.
3. If nothing is risky, a short notification confirms the upgrade.
4. If something is risky, an alert lists the plugin, the reason, and suggested actions.
5. After confirmation the remediation chain runs, with a backup before every change:
   - install the highest host-compatible version, else
   - repair the local install (`pnpm install`, rebuild when declared), else
   - write a `disabled` override into `cordis.patch.yml` (recoverable from the panel).
6. Changes that need a restart are reported with a one-click restart.

## Boot-failure rescue and rollback

If the tree fails to load, no host-side plugin can help — that is what the detached supervisor is for:

- It reads recent boot output and looks for `failed to apply loader entry <entry> (<package>)`.
- It maps the package to loader entry ids using `dsh --dump-config` (read-only), backs up the patch file, writes `disabled: true`, and relaunches.
- If that still fails, or the failure is not attributable to a plugin, it launches the previous host version from `~/.dsh/upgrade-guard/host-snapshots/<version>/` and reports the rollback.
- Every action is recorded under `incidents/` and surfaced in the UI on the next successful boot.

Snapshots are full copies of the host package directory (~300 MB each, latest two kept).

## Settings

In **Settings → Plugins → Plugin configuration** the guard exposes a card with:

- **Enable upgrade guard** — soft switch: disables automatic audits and alerts while keeping the plugin, manual checks, and the supervisor.
- **Automatic audit** — periodic lightweight scan (default every 5 minutes).
- **Current status** and **Check now**.
- **Uninstall upgrade guard**.

`cordis.patch.yml` accepts the composition-layer defaults:

```yaml
- id: dsh-upgrade-guard
  config:
    autoScanMs: 0        # periodic scan interval, 0 = only on boot/upgrade/manual
    supervisor: true     # out-of-host rescue / rollback / restart
    snapshotHost: true   # keep host snapshots for rollback
```

## HTTP API

Loopback and same-origin guarded:

- `GET  /dsh-upgrade-guard/api/state`
- `POST /dsh-upgrade-guard/api/check`
- `POST /dsh-upgrade-guard/api/repair` `{ name?, dryRun? }`
- `POST /dsh-upgrade-guard/api/toggle` `{ name, enabled }`
- `POST /dsh-upgrade-guard/api/uninstall` `{ name, allowSelf? }`
- `POST /dsh-upgrade-guard/api/config` `{ enabled?, autoScan? }`
- `POST /dsh-upgrade-guard/api/patch-fix` (dedupe patch entries; returns the backup dir)
- `POST /dsh-upgrade-guard/api/restart`
- `POST /dsh-upgrade-guard/api/alert/ack` | `alert/ack-all`

## Requirements

- DSH `>= 0.1.5-rc.1`
- Node.js `>= 22.19`
- Web profile for the UI features (audits still work in other profiles)

### Windows

- Works on native Windows and WSL 2 (DSH has no OS restriction; the official development guide documents both).
- The guard uses Node APIs only, hides spawned consoles (`windowsHide`), and kills process trees with `taskkill /PID <pid> /T /F` when restarting.
- Electron/DSH Desktop hosts own their lifecycle: the guard skips the supervisor and the restart button points you at the desktop shell.
- Windows behavior has had a compatibility pass but not a full native test run; please report issues with logs from `~/.dsh/upgrade-guard/`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build        # host: tsc -> lib, client: tsdown -> lib/client.js
npm pack             # produces dsh-upgrade-guard-<version>.tgz
```

The supervisor source is `scripts/supervisor.mjs`; it is copied into `lib/` during build.

## Safety and limitations

- The guard **changes files**: `cordis.patch.yml`, and it runs package-manager commands during remediation. Every write is backed up first under `~/.dsh/upgrade-guard/backups/`.
- It **does not intercept host upgrades**, and it does not patch plugin source code. If no compatible release exists, it can only disable or roll back.
- Plugins that declare no compatibility metadata cannot be predicted; the guard falls back to runtime rescue.
- This is an independent community project, not an official DeepSeek product.

## Contributors

- [zzy6-a](https://github.com/zzy6-a) — author
- DeepSeek V4.1 — architecture, implementation, testing, and release workflow

## License

[MIT](LICENSE)
