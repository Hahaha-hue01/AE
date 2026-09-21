# AE脚本集合器 V1.0 打包、安装与安全加固方案

## 1. 构建前提

`package.json` 已配置 Electron、electron-builder 和 javascript-obfuscator 的版本范围，但当前工作区没有安装依赖。首次接入项目时由维护者确认后执行：

```bash
pnpm install
```

不要把 `.p12`、`.pfx`、Apple 私钥、Notary API Key、KMS 密钥、会员 API 私钥或内容加密密钥放入仓库。

## 2. package.json / electron-builder

关键设置已经写入根目录 `package.json`：

- `main: main/electron-entry.js`
- `asar: true`
- `directories.app: .build-staging`
- Windows NSIS + Portable
- macOS DMG，x64 + arm64
- Windows `asInvoker`，默认用户级安装
- NSIS 允许用户选择安装目录
- 不捆绑第三方软件
- `deleteAppDataOnUninstall: false`，避免卸载误删会员/脚本数据
- Electron Fuses：关闭 RunAsNode、Node CLI inspect、Node Options，开启 Cookie 加密和 ASAR 完整性

`asarUnpack` 只用于原生 `.node` 模块；内置加密脚本不能放入 `asarUnpack` 或 `extraResources`，否则会落到可直接浏览的外部目录。

## 3. 资源打包

内置资源应放在 `resources/builtin-scripts/`，由构建前工具生成：

```text
resources/builtin-scripts/manifest.json
resources/builtin-scripts/*.bundle
```

清单和密文通过 AES-256-GCM 封装，清单还应使用发布签名。`main/script-library-bootstrap.js` 已改为从 `__dirname/../resources` 读取，打包后路径位于 `app.asar/resources`，不会作为 `resourcesPath` 外部目录暴露。

这不是绝对 DRM：ASAR 可以被复制和解包，拥有本机管理员权限的用户也可在运行时抓取解密后的脚本。目标是避免普通用户直接复制明文资源，并让篡改在完整性校验处失败。

## 4. JS 混淆

`javascript-obfuscator` 配置在 [scripts/obfuscator.config.json](../scripts/obfuscator.config.json)：

- 混淆 Renderer 与主进程逻辑
- 控制流扁平化、字符串数组、Self-defending、调试保护
- 不重命名 `require/module/exports` 和 IPC 公共契约
- 排除 `ae-bridge.js`，因为该文件生成/承载 ExtendScript ES3 文本，不应被 Node 混淆器破坏
- Preload 保持原样，只暴露白名单 API，便于安全审计

构建流程：

1. `scripts/prepare-build.js` 复制主进程、Renderer、shared、resources 到 `.build-staging`。
2. 仅在 staging 目录混淆，不修改源码。
3. electron-builder 以 `.build-staging` 作为 app 目录生成安装包。

混淆不是加密；源码字符串、API 结构和运行时逻辑仍可能被动态分析。不要把密钥放进混淆后的 JS 里。

## 5. 构建命令

```bash
# 安装依赖
pnpm install

# 运行测试
pnpm test

# 生成 Windows NSIS + Portable
pnpm build:win

# 生成 macOS DMG（应在 macOS 主机或合法 macOS 构建环境执行）
pnpm build:mac

# 生成未安装目录，便于冒烟测试
pnpm build:dir

# 同时构建 Windows/macOS（通常使用 CI 矩阵，而不是单机交叉构建）
pnpm build:all

# 清理 release 和 staging
pnpm dist:clean
```

## 6. 签名与发布

### Windows

- 使用受信任代码签名证书签署 exe、NSIS 安装包和卸载程序。
- CI 中通过安全密钥库注入 `CSC_LINK` / `CSC_KEY_PASSWORD`，不要写入 `.env`。
- 生产发布只允许 SHA-256 签名。
- 先签名再交付，用户通过 SmartScreen/杀毒软件首次安装时可能仍有信誉积累期。

### macOS

- 使用 Developer ID Application 签名。
- Hardened Runtime 已启用。
- 使用 `codesign`、`notarytool` 和 stapler 完成公证与票据装订。
- 同时验证 Intel 和 Apple Silicon 包；原生 `.node` 模块必须分别签名。

## 7. 安装行为

- NSIS 为可选安装路径、用户级权限，默认不请求管理员权限。
- Portable 版本不写入安装目录；数据库、授权缓存和外部脚本仍应写入系统用户数据目录，不写 exe 同目录。
- 不捆绑任何第三方软件、浏览器、驱动或后台服务。
- 首次启动自动从 ASAR 内部加载内置脚本元数据。
- 用户卸载不会自动删除用户数据，便于换版本和恢复；应在设置页提供“清理本地数据”显式操作。

## 8. 版本号与更新预留

- `package.json.version` 使用 SemVer。
- Windows/macOS 安装包、资源清单、离线授权中的 `app_min_version` 必须分开管理。
- V1 不自动下载更新，但保留 `build.publish` 的配置入口，不启用发布 provider。
- 以后启用更新时必须使用签名元数据、最低安全版本和回滚策略，不能只下载一个未经签名的 exe。

## 9. 打包后测试清单

### 基础安装

- Windows 10/11 x64 NSIS 安装、卸载、升级覆盖。
- Windows ARM64 Portable/安装包（若业务需要）。
- macOS Intel/Apple Silicon DMG 安装、公证、首次启动、Gatekeeper。
- 更换电脑重新安装：免费脚本、外部脚本导入、账号重新登录。
- 安装目录包含 `app.asar`，不存在明文内置 JSX 目录。

### 资源和逆向

- 使用 `asar extract app.asar` 验证：只能看到混淆后的 JS 和内置密文，不应出现原始 JSX。
- 修改 `app.asar` 文件后，Electron ASAR 完整性检查应失败或应用无法正常启动。
- 删除/替换内置密文后，资源签名/哈希校验失败，不进入执行流程。
- 搜索 `.jsx`、`.jsxbin`、`.aex`，确认没有把内置原文写入 release、日志、崩溃报告或临时目录。

### 授权和离线

- 首次断网：应用可进入免费模式，免费内置脚本和外部脚本仍可用。
- 有效会员断网 1～7 天：会员脚本可按离线 JWS 运行。
- 第 8 天：会员脚本拒绝运行并提示联网，免费功能不应被锁死。
- 修改系统时间回拨：进入 `clock_rollback` 或要求联网。
- 删除/修改 SQLite 会员字段：不应获得会员权限。
- 修改 AES 缓存内容：进入 `cache_tampered`，不应崩溃或解锁会员。
- 将缓存复制到另一台电脑：设备公钥绑定校验失败。
- 服务端撤销设备：联网后拒绝运行；明确接受离线期间最长 7 天的撤销延迟。

### IPC 和调试

- DevTools、`--remote-debugging-port`、Node CLI inspect、`NODE_OPTIONS` 在生产构建不可用。
- Renderer 不能访问 Node、文件系统、SQLite、授权缓存或硬件原始值。
- 伪造 Renderer IPC 的 `canRun/isMember` 参数不能绕过主进程校验。
- 未授权窗口、导航、外部协议和未知网络请求被拒绝。

## 10. 风险与限制

| 风险 | 结论 |
|---|---|
| ASAR 直接解压 | 无法阻止，只能避免放入明文脚本和降低可读性 |
| JS 混淆被逆向 | 无法阻止，主进程关键授权应使用服务端签名和安全存储 |
| 本机管理员内存抓取 | 无法绝对防御，运行时解密只能缩短窗口 |
| Portable 绿色版 | 不能等同于完全无痕；用户数据仍写系统数据目录 |
| 代码签名 | 防篡改和建立发布者信任，不等于防逆向 |
| 7天离线宽限 | 无法即时感知撤销，最长存在7天权限延迟 |
| 跨平台构建 | Windows/macOS 签名、公证和原生模块应分别在对应系统/CI runner完成 |

