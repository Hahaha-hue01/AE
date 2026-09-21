# 渲染进程 IPC 接口

通道常量位于 `shared/ipc-contract.js`，渲染进程只能通过 `preload.js` 暴露的语义化方法调用。主进程必须在每个 handler 内重新校验参数、当前用户权限和脚本状态；不能相信渲染进程传入的 `canRun`。

## `getScripts(options)` → `Promise<Script[] | { scripts: Script[] }>`

- 主进程应默认过滤隐藏脚本。
- `options.includeHidden` 仅允许受信任的设置页使用，普通界面传 `false`。
- `Script` 至少包含：`id`、`name`、`category`（`builtin|external`）、`description`、`aeVersions`、`access`（`free|member`）、`tutorial`、`isFavorite`、`isHidden`、`note`、`canRun`、`runMode`。

## `getScript(scriptId)` → `Promise<Script>`

主进程按 ID 查询，并返回不含脚本密文和内部路径的展示元数据。

## `runScript(scriptId)` → `Promise<{ taskId: string }>`

主进程必须重新执行会员权益、脚本完整性、AE 版本与脚本类型检查。渲染进程的按钮状态只用于用户体验，不能作为授权边界。

## `setFavorite(scriptId, { favorite })` → `Promise<void>`

更新用户级收藏状态。只接受布尔值。

## `setNote(scriptId, { note })` → `Promise<void>`

更新用户备注。主进程应限制长度（建议 500 个 Unicode 字符）并拒绝控制字符。

## `setHidden(scriptId, { hidden })` → `Promise<void>`

只允许修改外部脚本的隐藏状态；内置脚本不能被删除，隐藏状态仅是用户配置。

## `getMembership()` → `Promise<{ isMember: boolean, status: string, expiresAt?: string }>`

返回已经过主进程/授权层校验的摘要。不要把令牌、离线授权签名或设备指纹返回给渲染进程。

## `importExternalScript()` → `Promise<Script | null>`

主进程弹出文件选择器，只接受 `.jsx`、`.jsxbin`、`.aex`，完成文件头、大小、SHA-256 和重复校验后复制到用户数据目录。取消选择返回 `null`。

## `updateScript(scriptId, patch)` → `Promise<Script>`

仅允许外部脚本修改 `name`、`description`、`tags`、`category`、`tutorial` 和 `aeVersions`。内置脚本的不可变元数据不能通过此接口修改。

## 错误约定

主进程建议使用可序列化错误对象：`{ code, message, retryable }`。不要把堆栈、SQL、文件绝对路径、脚本明文或会员密钥放入错误消息。
