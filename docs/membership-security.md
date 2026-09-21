# 主进程硬件指纹与会员授权安全设计

## 运行链路

1. 主进程通过 PowerShell/CIM（Windows）或 `system_profiler`（macOS）读取 CPU、主板/平台和物理网卡信息。
2. 原始序列号只在主进程内存中短暂存在；每个组件先规范化再 SHA-256，发送给服务器的是组合指纹摘要和分项摘要。
3. 首次使用由设备密钥提供器生成 Ed25519 密钥对。私钥必须放入 Windows DPAPI、macOS Keychain 或等价的安全存储；`main/device-identity.js` 只接受已经加密的 `secureStore`，不把 PEM 明文写入普通配置文件。
4. 服务器签发绑定 `device_id`、设备公钥摘要、会员权益、`iat/nbf/exp`、`entitlement_revision` 的 Ed25519 离线授权 JWS。
5. 主进程验证 JWS 后，把它与访问令牌放入 AES-256-GCM 加密缓存。缓存密钥也必须由 DPAPI/Keychain/KMS 注入，不能从 SQLite 普通字段读取。
6. 会员脚本运行前由 `script-library.js` 调用 `membershipService.canRunScript()`；授权失败时不会调用内置脚本解密器和 AE runner。

## IPC

- `membership:status`：返回 `isMember/status/expiresAt/entitlements` 摘要。
- `membership:refresh`：触发在线校验。
- `membership:activate-card`：卡密激活。
- `membership:login`：账号登录。

Renderer 不会获得硬件原始值、私钥、离线 JWS、Access/Refresh Token 或缓存密钥。

`main/electron-hardening.js` 可在创建窗口前注册，用于生产环境关闭 DevTools、拒绝未知窗口/导航和拦截非白名单网络请求。它不能替代代码签名、CSP、`contextIsolation`、Renderer sandbox 和安全 Preload，也不能抵抗本机管理员级注入。

## 可被破解的路径与防御

| 攻击路径 | 现实风险 | 防御/剩余风险 |
|---|---|---|
| 修改 SQLite 的 `isMember` 或会员字段 | 高 | 会员事实不来自 SQLite；授权缓存使用 AES-GCM，且 JWS 由服务器签名。篡改后进入免费/重新联网模式。 |
| 删除/替换授权缓存 | 中 | 完整性校验失败即拒绝离线会员功能；不锁死免费功能。 |
| 复制授权缓存到另一台电脑 | 高 | 缓存绑定 `device_id` 和设备公钥摘要，私钥由 DPAPI/Keychain保护。 |
| 抓包修改会员 API 响应 | 高 | HTTPS + Ed25519 JWS；客户端不信任未签名权益。控制本机的攻击者仍可在 HTTPS 前后 Hook。 |
| 重放激活/校验请求 | 中 | 请求使用设备 Ed25519 签名、时间戳、Nonce、Request ID；服务端应原子记录 Nonce。 |
| 系统时间回拨延长7天 | 高 | 保存最后可信服务器时间并检测回拨；管理员仍可 Hook 时间 API 或恢复虚拟机快照。 |
| 伪造 CPU/主板/网卡信息 | 高 | 硬件指纹只做连续性和风控，不作为唯一秘密；设备公钥绑定才是核心。 |
| 修改 Renderer 的按钮或 IPC 参数 | 高 | 主进程重新执行 `canRunScript`，不信任 Renderer 的 `canRun` 或 `isMember`。 |
| 调试器跳过 `canRunScript` | 严重 | 代码签名、关闭 DevTools/远程调试、主进程最小化接口、关键逻辑可下沉签名原生模块；无法抵抗本机管理员。 |
| 从内存截获离线 JWS/解密脚本 | 严重 | 缩短明文生命周期、主进程内存操作、资源按脚本解密；无法提供绝对防提取。 |
| 劫持 PowerShell 或 `system_profiler` 输出 | 中 | 只将结果用于风控，服务端结合设备公钥、历史行为和多组件一致性。 |
| 恶意脚本读取 Token | 高 | 第三方 JSX 不应获得会员缓存路径或 IPC；不向脚本暴露凭据。 |
| Electron 注入/远程调试 | 严重 | `contextIsolation`、sandbox、禁用 `nodeIntegration`、禁用远程调试端口、CSP、生产包去除 DevTools。拥有本机管理员仍可注入。 |
| API 私钥泄露 | 严重 | 离线签名私钥放 KMS/HSM；客户端只内置公钥，支持 `kid` 轮换。 |
| 设备指纹隐私泄露 | 中 | 原始硬件值不上传，上传不可逆摘要；提供隐私说明、删除和换机流程。 |

## 7天离线规则

有效期取服务端 `min(server_now + 7天, membership.expires_at)`。离线期间不能感知服务端刚发生的封禁或退款，最长存在7天撤销延迟；高风险设备应由服务端拒绝签发离线授权或缩短期限。
