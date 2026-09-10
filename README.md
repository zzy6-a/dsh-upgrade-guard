# dsh-upgrade-guard

[English](README_EN.md) | 中文

[![Download](https://img.shields.io/badge/Download-latest-2e7d32?style=flat&logo=github&logoColor=white)](https://github.com/zzy6-a/dsh-upgrade-guard/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2f6fed)](https://github.com/topics/dsh-plugin)

**DeepSeek Harness 升级安全网。**

`dsh-upgrade-guard` 监视 DSH 宿主版本。升级后首次启动时，它会检查所有已安装插件与新宿主的兼容性，并在你确认后升级、修复、禁用插件，或在必要时回滚到上一个宿主版本——避免一个不兼容的社区插件把整个 harness 留在"起不来"的状态。

> DSH 处于开发者预览阶段，破坏性变更会持续发生。这个插件针对的是预期内的失败，而不是边缘情况。

## 功能

- **升级后自动巡检**：宿主版本变化后的首次启动自动触发
- **声明兼容性检查**：读取每个已安装插件的 `engines.dsh` 与 `peerDependencies`，与解析出的宿主/core 版本比对，沿用生态的方向性策略（低于下限、显式上界 = 风险；隐式 caret 上界 = 警告）
- **安装/加载/结构检查**：Loader fiber 状态、悬空 junction、core 包遮蔽
- **引导式修复**：联网找"与当前宿主兼容的最高版本"（不是盲目 `@latest`）→ 安装；不行则修复本地安装；再不行则禁用
- **启动失败救援**：宿主外 supervisor 在主进程起不来时仍可工作：解析启动日志、禁用故障 entry、重启宿主
- **宿主回滚**：禁用仍救不回来时，从快照直接启动上一个宿主版本，无需 sudo/npm
- **手动重启**：设置面板 / 弹窗里一键重启 DSH
- **中文界面与通知**：巡检结果、事故、操作项展示在设置页与浮层弹窗

## 工作原理

一个包，三部分：

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| 宿主插件 | DSH profile bundle | 版本基线、扫描、修复链、HTTP API、settings 命名空间 |
| 客户端 UI | DSH Web 客户端 | 设置页面板、插件卡片、开关、浮层弹窗 |
| Supervisor | 独立 Node 进程 | adopt 宿主、快照宿主版本、崩溃救援、回滚、执行重启 |

运行数据在 `~/.dsh/upgrade-guard/`。

## 安装

### GitHub Release（当前分发通道）

```sh
dsh plugin --profile web add \
  https://github.com/zzy6-a/dsh-upgrade-guard/releases/download/v0.1.0/dsh-upgrade-guard-0.1.0.tgz
```

也可以从 Releases 页面下载 `.tgz` 后安装本地文件：

```sh
dsh plugin --profile web add /path/to/dsh-upgrade-guard-0.1.0.tgz
```

### npm（发布后可用）

```sh
dsh plugin --profile web add dsh-upgrade-guard
```

### 本地源码（开发）

```sh
dsh plugin --profile web add link:/path/to/dsh-upgrade-guard
```

然后重启一次 DSH（设置 → 升级守卫 → 重启 DSH，或用你的启动器）。之后守卫作为 profile bundle 常驻。

## 宿主升级后会发什么

1. 对比当前宿主版本与上次记录的版本
2. 审计所有已安装的社区/本地插件
3. 无风险：轻提示"升级后兼容检查通过"
4. 有风险：弹窗列出插件、原因、建议动作
5. 确认后执行修复链，每一步改动前都自动备份：
   - 安装与当前宿主兼容的最高版本；否则
   - 修复本地安装（`pnpm install`、有构建脚本则重建）；否则
   - 在 `cordis.patch.yml` 写入 `disabled` 覆盖行（可在面板恢复）
6. 需要重启生效的改动会附一键重启

## 启动失败救援与回滚

如果插件树加载失败，任何宿主内插件都救不了——这时由宿主外 supervisor 兜底：

- 读取最近的启动日志，匹配 `failed to apply loader entry <entry> (<package>)`
- 用 `dsh --dump-config`（只读）把包名映射成 entry id，备份 patch，写入 `disabled: true`，重启
- 仍失败或无法归因到插件：从 `~/.dsh/upgrade-guard/host-snapshots/<version>/` 启动上一个宿主版本，并记录回滚
- 所有动作写入 `incidents/`，下次成功启动后由插件弹窗展示

快照是宿主目录的完整拷贝（每份约 300MB，保留最近 2 份）。

## 设置

**设置 → 插件 → 插件配置** 里的升级守卫卡片：

- **启用升级守卫**：软开关；关闭后不自动巡检/提醒，但保留插件、手动检查和 supervisor
- **自动巡检**：默认每 5 分钟轻量检查一次
- **当前状态** + **立即检查**
- **卸载升级守卫**

`cordis.patch.yml` 支持组合层默认配置：

```yaml
- id: dsh-upgrade-guard
  config:
    autoScanMs: 0        # 自动扫描间隔（毫秒），0 = 仅启动/升级/手动
    supervisor: true     # 宿主外救援 / 回滚 / 重启
    snapshotHost: true   # 保留宿主快照用于回滚
```

## HTTP API

仅限本机同源：

- `GET  /dsh-upgrade-guard/api/state`
- `POST /dsh-upgrade-guard/api/check`
- `POST /dsh-upgrade-guard/api/repair` `{ name?, dryRun? }`
- `POST /dsh-upgrade-guard/api/toggle` `{ name, enabled }`
- `POST /dsh-upgrade-guard/api/uninstall` `{ name, allowSelf? }`
- `POST /dsh-upgrade-guard/api/config` `{ enabled?, autoScan? }`
- `POST /dsh-upgrade-guard/api/restart`
- `POST /dsh-upgrade-guard/api/alert/ack` | `alert/ack-all`

## 环境要求

- DSH `>= 0.1.5-rc.1`
- Node.js `>= 22.19`
- UI 功能需要 Web profile（其他 profile 仍可执行巡检）

### Windows

- 原生 Windows 与 WSL 2 都可用（DSH 官方开发文档两种都支持）
- 守卫只用 Node API；拉起进程加了 `windowsHide`；Windows 下重启用 `taskkill /PID <pid> /T /F` 杀进程树
- Electron / DSH Desktop 宿主由桌面外壳管理生命周期：守卫跳过 supervisor，重启按钮会提示你使用桌面应用
- Windows 做了代码层兼容，但未做完整实机验证；遇到问题请附 `~/.dsh/upgrade-guard/` 日志提 issue

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build        # host: tsc -> lib，client: tsdown -> lib/client.js
npm pack             # 产出 dsh-upgrade-guard-<version>.tgz
```

Supervisor 源码在 `scripts/supervisor.mjs`，构建时复制进 `lib/`。

## 安全与边界

- 守卫**会修改文件**：`cordis.patch.yml`，修复过程中会调用包管理器命令；每次写入前都备份到 `~/.dsh/upgrade-guard/backups/`
- **不拦截宿主升级**，也不修改插件源码；没有兼容版本时只能禁用或回滚
- 未声明兼容信息的插件无法提前判定，只能运行期兜底
- 这是一个独立社区项目，不是 DeepSeek 官方产品

## Contributors / 致谢

- [zzy6-a](https://github.com/zzy6-a) — 作者
- DeepSeek V4.1 — 架构设计、实现、测试与发布流程

## License

[MIT](LICENSE)
