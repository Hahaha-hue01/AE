# AE 脚本集合器 V1.0 整体整合复核

复核范围：Electron 主进程、preload/Renderer、脚本库、本地数据库、会员授权、AE 执行器、打包链路及现有测试。本文是整合验收文档，不替代后端 API、代码签名或真实 AE 兼容性测试。

## 结论摘要

当前代码已经形成可维护的分层骨架，IPC 白名单、主进程权限边界、离线授权 JWS、资源加密接口和 electron-builder 配置方向基本正确；但还不能认定为可发布的 V1.0。最重要的原因是 `main/electron-entry.js` 没有把已有模块组装起来，因此打包程序目前主要只能显示 UI，脚本库、会员和 AE 执行链路并未在入口完成注册。

**后续修复状态（本轮已完成）**：主入口编排、safeStorage 密钥存储、会员正式状态通道、导入/编辑 UI、AEX 禁止直接执行、SQLCipher 依赖和集成测试已经接入。下文仍保留原始复核中的风险与发布门槛；真实内置脚本资源、生产会员 API 公钥和代码签名仍需发布配置注入。

发布门槛按优先级划分如下：

| 优先级 | 问题 | 影响 | 发布要求 |
|---|---|---|---|
| P0 | 主入口未初始化安全存储、设备身份、会员服务、AE runner、脚本库 bootstrap | IPC handler 不注册；数据库和资源不加载；运行按钮必然失败 | 必须补齐启动编排并通过打包后启动冒烟 |
| P0 | `better-sqlite3-multiple-ciphers` 原生模块 | 已安装 13.0.3，并完成 Node/Electron 36.9.5 加载验证；各架构仍需在 CI 分别重建 | 发布前在 Windows x64/arm64、macOS x64/arm64 分别执行原生模块冒烟 |
| P0 | 内置 `manifest.json` 为空，未接入正式加密和签名流水线 | 发布包没有真实自研脚本 | 生成真实密文、签名清单并注入内容密钥提供器 |
| P1 | 会员状态有 `membership:get` 与 `membership:status` 两套通道 | 状态字段和 UI 行为容易漂移 | 统一为 `membership:status`，旧通道仅保留兼容期 |
| P1 | `toDisplayRecord().canRun` 对会员脚本始终返回 false | 已授权会员 UI 仍可能显示不可运行 | 返回 `requiresMembership`，UI 只作展示，主进程运行时再次授权 |
| P1 | Renderer 没有导入按钮、编辑元数据表单 | 已暴露 IPC 但需求功能不可达 | 增加导入入口、详情编辑模式和成功/失败提示 |
| P1 | `.aex` 可导入但 `ae-runner` 只允许 JSX/JSXBIN | 用户会误以为 AEX 可直接运行 | V1 明确改为“导入并显示/安装指引”，或另做插件安装器 |
| P2 | 构建脚本在 Windows 通过 `shell:true` 调 `.cmd` | 有 Node DEP0190 警告，增加命令注入审计负担 | 改为直接调用 CLI JS 或固定路径的安全启动方式 |
| P2 | 只有单元测试，没有真实 Electron/安装包/AE/SQLCipher 集成测试 | 无法证明发布包可启动 | 在 RC 前完成本文的集成验收清单 |

## 1. 端到端依赖与启动顺序

推荐的唯一启动编排如下，所有对象都在主进程创建，不由 Renderer 传入：

```text
app.whenReady()
  -> installElectronSecurityBaseline()
  -> secureStore / dbKeyProvider / cacheKeyProvider 初始化
  -> createDeviceIdentity(secureStore)
  -> createMembershipService(API、加密缓存、公钥、deviceIdentity)
  -> createAeRunner(平台、目标 AE 版本、可信 transport)
  -> bootstrapScriptLibrary(
       dbKeyProvider, contentKeyProvider,
       runner: aeRunner.execute,
       membershipService,
       verifyManifest,
       getMainWindow
     )
  -> createWindow()
  -> membershipService.startupCheck()（异步，不阻塞免费功能）
```

`bootstrapScriptLibrary` 内部负责加载 `app.asar/resources/builtin-scripts/manifest.json`、打开用户数据目录的加密 SQLite、初始化脚本表、注册脚本 IPC 和会员 IPC。`createWindow` 必须在 `getMainWindow` 可返回窗口之后完成，或使用延迟闭包；不能把窗口对象从 Renderer 传回主进程。

当前 `main/electron-entry.js` 只安装安全基线、创建窗口和加载页面，没有上述任何初始化。该缺口是当前最高优先级整合问题。

### 权限和明文边界

`scripts:run` 的正确链路是：主进程查脚本元数据 → `membershipService.canRunScript()` → 授权通过后才调用 `builtinStore.decrypt()` 或复制外部脚本 → `aeRunner.execute()`。Renderer 的 `canRun`、`isMember`、脚本路径和任何 token 都不能作为授权依据。

## 2. IPC/API 匹配复核

### 2.1 Renderer ↔ preload ↔ 主进程通道

| 能力 | 通道 | preload | 主进程注册 | Renderer 当前使用 | 结论 |
|---|---|---|---|---|---|
| 列表 | `scripts:list` | `getScripts` | `ipc-script-library.js` | `getScripts` | 匹配 |
| 详情 | `scripts:get` | `getScript` | 已注册 | 未直接使用 | 匹配，待详情编辑复用 |
| 运行 | `scripts:run` | `runScript` | 已注册 | `runScript` | 匹配；主进程仍需授权 |
| 导入 | `scripts:import-external` | `importExternalScript` | 已注册 | 未使用 | P1：缺 UI 入口 |
| 编辑 | `scripts:update` | `updateScript` | 已注册 | 未使用 | P1：缺编辑表单 |
| 收藏 | `scripts:set-favorite` | `setFavorite` | 已注册 | 右键使用 | 匹配 |
| 备注 | `scripts:set-note` | `setNote` | 已注册 | 右键使用 | 匹配 |
| 隐藏 | `scripts:set-hidden` | `setHidden` | 已注册 | 右键使用 | 匹配；内置只能隐藏 |
| 会员摘要（旧） | `membership:get` | `getMembership` | 脚本 IPC 中注册 | Renderer 使用 | P1：应收敛 |
| 会员摘要（正式） | `membership:status` | `getMembershipStatus` | `membership-ipc.js` 注册 | 未使用 | 推荐主通道 |
| 在线刷新 | `membership:refresh` | `refreshMembership` | 已注册 | 未使用 | 会员页需要接入 |
| 卡密激活 | `membership:activate-card` | `activateMembershipCard` | 已注册 | 未使用 | 会员页需要接入 |
| 账号登录 | `membership:login` | `loginMembership` | 已注册 | 未使用 | 会员页需要接入 |

建议统一返回：

```json
{
  "isMember": true,
  "status": "online|offline|not_authenticated|offline_expired|cache_tampered|device_changed",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "entitlements": ["script-id"]
}
```

`membership:get` 可以在一个过渡版本中作为别名转发到同一个 `service.getStatus()`，但 Renderer 应改用 `getMembershipStatus()`。任何状态接口都不得返回 access/refresh token、设备指纹、离线 JWS、缓存密钥或原始硬件信息。

### 2.2 脚本运行返回值

文档约定的 `{ taskId }` 是最小返回体，当前 runner 实际返回 `{ taskId, ok, returnValue, installation, via }`，属于向后兼容的超集。建议 Renderer 统一展示 `ok/returnValue/installation.version`，并把主进程错误序列化为 `{ code, message, retryable }`，禁止把绝对路径、脚本明文、SQL 或堆栈返回到 UI。

### 2.3 AEX 边界

导入器允许 `.jsx`、`.jsxbin`、`.aex`，但 `ALLOWED_SCRIPT_TYPES` 执行集合只有 `jsx`、`jsxbin`。这是正确的 Adobe 技术边界：AEX 是原生插件，不是可被 `$.evalFile()` 执行的 ExtendScript。V1 应在详情中明确“已导入，需安装/重启 AE”，并禁用“运行脚本”；不要为了表面统一而把 AEX 当作 JSX 发送。

### 2.4 会员后端 REST 契约

`membership-service.js` 期望 HTTPS API 提供以下路径和字段，后端实现必须逐字对齐或通过 `endpoints` 配置覆盖：

| 用途 | 默认路径 | 请求关键字段 | 响应关键字段 |
|---|---|---|---|
| 在线校验 | `POST /v1/license/validate` | `reason、resource_id、app_version、device_id、device_public_key、fingerprint、component_hashes` | `decision、reason_code、server_time、membership、entitlements、offline_grant、access_token、refresh_token` |
| 卡密激活 | `POST /v1/activations/card` | `card_code` 加设备字段 | 同上 |
| 账号登录 | `POST /v1/auth/login` | `email、password` 加设备字段 | 同上 |
| 挑战（预留） | `POST /v1/auth/challenges` | 当前客户端未调用 | 后端可保留，不应误认为已启用 |
| 离线授权（预留） | `POST /v1/license/offline-grants` | 当前客户端未单独调用 | 实际由 validate/login/activate 返回 `offline_grant` |

请求还必须验证 `X-Device-ID、X-Key-ID、X-Timestamp、X-Nonce、X-Request-ID、X-Body-SHA256、X-Signature`。签名规范为 `AEBOX-SIGN-V1` 加方法、路径、查询、body SHA-256、时间戳、nonce、device id、JWT jti、request id，使用设备 Ed25519 私钥签名。服务端必须做时间窗、nonce 原子去重、request id 去重和设备公钥绑定，否则客户端的防重放设计无法成立。

## 3. 推荐工程目录

```text
ae-script-collector/
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ preload.js
├─ main/
│  ├─ electron-entry.js              # 唯一启动编排
│  ├─ electron-hardening.js          # CSP、导航、DevTools、网络白名单
│  ├─ ipc-script-library.js          # scripts:* IPC
│  ├─ membership-ipc.js              # membership:* IPC
│  ├─ script-library.js              # 元数据、导入、运行前授权
│  ├─ script-library-bootstrap.js    # 依赖注入和初始化
│  ├─ ae-runner.js                   # JSX/JSXBIN 执行编排
│  ├─ ae-bridge.js                   # ES3 ExtendScript bridge，禁止混淆
│  ├─ ae-process.js                  # Win/Mac 进程和安装发现
│  ├─ builtin-resources.js            # 清单签名、AES-GCM 解密
│  ├─ local-db.js                    # SQLCipher 驱动适配
│  ├─ hardware-fingerprint.js        # 硬件摘要采集
│  ├─ device-identity.js             # Ed25519 设备密钥
│  ├─ secure-cache.js                # AES-GCM 授权缓存
│  └─ providers/                     # 生产安全实现（DPAPI/Keychain/API）
│     ├─ windows-secure-store.js
│     ├─ macos-keychain-store.js
│     ├─ membership-api.js
│     └─ manifest-verifier.js
├─ renderer/
│  ├─ index.html
│  ├─ styles.css
│  ├─ renderer.js
│  └─ views/                         # 会员页、导入页、编辑页（V1 待补）
├─ shared/
│  └─ ipc-contract.js
├─ resources/
│  └─ builtin-scripts/
│     ├─ manifest.json                # 签名元数据+密文 payload
│     └─ *.bundle
├─ scripts/
│  ├─ prepare-build.js
│  ├─ build-builtin-bundle.js         # 建议新增
│  ├─ obfuscator.config.json
│  └─ clean-dist.js
├─ tests/
│  ├─ ae-communication.test.js
│  ├─ membership.test.js
│  ├─ ipc-integration.test.js         # 建议新增
│  ├─ packaging-smoke.test.js         # 建议新增
│  └─ fixtures/
├─ docs/
└─ .build-staging/                    # 构建生成，禁止提交
```

`release/`、`.build-staging/`、`node_modules/` 和用户数据目录不应纳入源代码提交。生产密钥、证书、会员 API 私钥和脚本明文也不能放入该树。

## 4. 依赖与版本复核

当前已验证的工具版本是 Electron `36.9.5`、electron-builder `26.15.3`、javascript-obfuscator `4.2.2`；建议在 `package.json` 和 lockfile 中锁定确切版本，不使用 `^`，避免 Electron ABI、builder schema 或混淆输出漂移。

推荐清单：

```json
{
  "devDependencies": {
    "electron": "36.9.5",
    "electron-builder": "26.15.3",
    "javascript-obfuscator": "4.2.2"
  },
  "dependencies": {
    "better-sqlite3-multiple-ciphers": "<经确认后锁定的兼容版本>"
  }
}
```

`better-sqlite3-multiple-ciphers` 已锁定为 13.0.3，并纳入生产依赖；当前工作区已验证驱动可加载、SQLCipher 可建表，Electron 36.9.5 Node ABI 也已验证。仍须在发布 CI 中为四个目标架构分别执行原生模块重建并做安装包启动测试。

依赖约束：

- Electron 与原生 SQLite 驱动必须在同一 Electron 主版本下 `electron-rebuild`/builder 重建。
- 原生 `.node` 只放 `asarUnpack`，内置脚本密文不能放 `asarUnpack` 或 `extraResources`。
- Renderer 不需要第三方运行时框架；继续使用 HTML/CSS/JS 可减少攻击面。
- `https`、`crypto`、`fs`、`child_process` 使用 Node/Electron 内置能力，不要重复引入 polyfill。

## 5. 开发启动、调试与发布流程

### 环境准备

1. Windows 开发机安装 Node.js LTS、pnpm、Git；macOS 构建机另备 Xcode Command Line Tools、Developer ID 和公证凭据。
2. 克隆项目并在 `G:\脚本开发` 执行 `pnpm install --frozen-lockfile`。若 lockfile 与 package.json 不一致，先由维护者更新 lockfile，不要在发布机自动漂移版本。
3. 准备开发用安全存储适配器、会员 API 测试地址、离线授权公钥和测试 manifest。开发密钥不得进入生产包。
4. 若启用 SQLCipher，确认原生依赖、许可和双架构编译后再安装，并执行 `pnpm rebuild` 或 electron-builder 的 `npmRebuild`。

### 本地验证与调试

```bash
pnpm test
pnpm exec electron .
```

当前没有 `start`/`dev` 脚本，`pnpm exec electron .` 是实际启动命令；建议后续补充 `"dev": "electron ."`。开发环境允许 DevTools，但不得把调试开关、远程端口或测试密钥带入生产构建。打开应用后依次验证：主入口初始化日志、脚本列表、免费脚本运行、会员摘要、导入/编辑/隐藏和错误提示。

### 构建和打包

```bash
pnpm build:prepare       # 复制到 .build-staging 并混淆 main/renderer
pnpm build:dir           # 未安装目录冒烟
pnpm build:win           # Windows NSIS（x64/arm64）
pnpm build:portable      # Windows Portable
pnpm build:mac           # 必须在 macOS 或合规 macOS CI 执行
pnpm dist:clean          # 清理 release/staging
```

构建前必须先生成非空、已签名的内置资源清单。`prepare-build.js` 应将 `ae-bridge.js` 正式排除在混淆输入之外；现状虽会恢复原文，但属于构建后补救。构建产物要检查 `app.asar`、原生模块位置、preload 路径和 renderer 页面加载路径。

### 签名和发布

Windows 用受信任 SHA-256 代码签名证书签署应用、安装包和卸载程序；macOS 用 Developer ID Application + Hardened Runtime + notarytool + stapler。当前 `release/` 中的 EXE 是未签名测试构建（`NotSigned`），不能作为商用发布包。生产证书、CSC 密钥、Apple 私钥、公证 token 只由 CI 密钥库注入。

## 6. V1.0 遗留限制与验收条件

- 不能阻止有管理员权限的用户解包 ASAR、调试主进程或从内存抓取已解密脚本；加密、混淆和 ASAR 完整性只能提高成本。
- 会员撤销在离线期间最多延迟 7 天；系统时间、虚拟机快照和本机 Hook 仍是高风险边界。
- Windows 已运行 AE 没有统一官方外部 DoScript API；没有受信任 CEP/本地 transport 时返回 `AE_RUNNING_BRIDGE_REQUIRED`，不能宣称 CS6～AE2026 全部场景已打通。
- AEX 只能导入和提示安装，V1 不负责插件签名、架构选择、安装、卸载和 AE 重启。
- 硬件指纹会因换主板、网卡、虚拟机或 macOS 隐私策略发生变化，必须提供人工解绑/换机流程。
- 当前真实内置清单为空，不能进行正式会员脚本验收。
- 当前测试通过的是语法、AE 适配器和会员服务单元测试；尚缺真实 Electron 启动、preload/IPC、SQLCipher、安装升级、ASAR 完整性、签名、公证和真实 AE 矩阵测试。

V1 发布前的硬门槛是：入口编排完成；SQLCipher 驱动和安全存储 provider 可用；内置资源非空且签名；统一会员状态通道；导入/编辑 UI 可达；Windows x64 至少完成安装、启动、免费脚本和会员离线冒烟；发布包完成代码签名。

## 7. V2.0 建议功能清单

按优先级建议如下：

1. **可靠性与更新**：自动更新、签名更新元数据、灰度发布、回滚、崩溃报告和可观测日志。
2. **脚本生态**：AEX 安装/卸载向导、CEP/本地 transport、脚本版本管理、依赖检查、批量导入、拖拽导入、导入来源可信度和沙箱策略。
3. **云同步**：脚本元数据、收藏、备注、分类和使用统计的端到端加密同步；冲突合并和多设备管理。
4. **会员运营**：多设备授权策略、换机自助、退款/封禁实时撤销、设备管理页、风控后台、优惠券和团队授权。
5. **安全升级**：原生/远程证明模块、密钥轮换、内容密钥按版本分层、透明审计日志、企业部署策略和更严格的 Windows/macOS 安全存储。
6. **体验与兼容性**：脚本标签全文搜索、最近使用、批量操作、国际化、无障碍、AE 版本兼容矩阵、运行进度/取消任务和更丰富的 AE 错误诊断。
7. **质量工程**：Windows/macOS 双架构 CI、真实 AE 自动化实验室、安装升级/卸载回归、恶意脚本和逆向攻击回归、SQLCipher 数据迁移测试。

## 8. 最终验收顺序

先修 P0，再按以下顺序验收：`pnpm test` → `pnpm build:dir` 启动和 IPC 冒烟 → 真实 SQLCipher/安全存储 → 非空内置资源和会员授权 → Windows 安装/升级 → macOS 签名/公证 → AE CS6、CC、中期版本和当前版本矩阵 → ASAR/数据库/重放/调试器安全测试。任何一步失败，都不应把当前构建标记为 V1.0 正式发布。
