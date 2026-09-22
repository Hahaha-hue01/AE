# 内置脚本内容密钥下发契约

内置脚本密钥不放入 Electron、renderer、SQLite 或 Git 仓库。客户端仅在会员 API 完成 HTTPS、设备签名和授权决策后接收密钥，并立即写入 Electron `safeStorage`。

## 响应字段

`POST /v1/license/validate`、`/v1/auth/login`、`/v1/activations/card` 的成功响应可包含：

```json
{
  "decision": "allow",
  "content_keys": {
    "builtin_text_manager": {
      "key_id": "builtin-content-v1",
      "key": "<32-byte AES key encoded as base64url>",
      "expires_at": "2026-10-01T00:00:00Z"
    }
  }
}
```

约束：

- `key` 必须是 32 字节 AES-256 密钥的 43 字符 Base64URL 表示，不能带 `=`。
- 只有 `decision=allow` 或成功登录/激活并通过离线授权签名校验后才返回。
- 服务端按设备公钥、设备指纹和会员权益过滤可返回的脚本 ID。
- 不要把 `content_keys` 写入离线会员 JSON；客户端只写入系统 `safeStorage`。
- HTTPS、请求签名、时间戳、nonce 和设备绑定仍必须启用；密钥接口不得接受未签名请求。
- 密钥轮换时递增 `key_id`，客户端可保留旧密钥直到对应脚本版本退役。

当前客户端只会把格式正确的密钥交给主进程安全存储；无密钥时会明确提示“请先完成在线授权并连接会员服务”。
