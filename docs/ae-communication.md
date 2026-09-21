# Electron ↔ After Effects 通信与执行

## 兼容性边界

ExtendScript 的官方执行入口是 AE 内部的 `$.evalFile()`。CEP 的 `CSInterface.evalScript()` 只能由安装在 AE 内的 CEP 面板调用，不能从普通 Electron Renderer 直接调用。Windows 也没有一个可对 CS6～AE2026 统一适用的“连接到已运行 AE 并远程 DoScript”外部 API。

因此 `main/ae-runner.js` 使用三层策略：

1. `transport` 注入层：生产环境可接入签名 CEP/本地桥接，由桥接在 AE 内调用 `$.evalFile()`。
2. macOS Apple Events：已运行 AE 使用官方 `osascript`/`DoScript`，未运行时先用 `/usr/bin/open -a` 启动指定版本，再调用 `DoScript`。
3. Windows 未运行 AE：使用 Adobe 支持的 `AfterFX.exe -r <bridge.jsx>` 启动执行。Windows 已运行但没有 `transport` 时明确返回 `AE_RUNNING_BRIDGE_REQUIRED`，不会伪造不存在的远程 API。

## 文件说明

- `main/ae-process.js`：Win `tasklist`、Mac `ps` 进程探测，标准安装目录发现，多版本选择。
- `main/ae-bridge.js`：生成 ES3 兼容的桥接 JSX。桥接只包含受控脚本路径和结果路径，调用 `$.evalFile(new File(...))`，捕获异常后写入 JSON 结果。
- `main/ae-runner.js`：安全临时目录、内置脚本解密/外部脚本复制、执行策略、超时、结果解析和清理。
- 现有 `main/ipc-script-library.js` 已经注册 `scripts:run`。将 `createAeRunner(...).execute` 作为脚本库的 `runner` 注入即可，不要重复注册同一 IPC channel。

## 主进程接入示例

```js
const { createAeRunner } = require('./main/ae-runner');
const { bootstrapScriptLibrary } = require('./main/script-library-bootstrap');

const aeRunner = createAeRunner({
  targetVersion: settings.aeVersion,
  // 现代版本可在这里接入经过验证的 CEP/本地桥接；不要从 Renderer 传入任意命令。
  transport: trustedAeTransport
});

await bootstrapScriptLibrary({
  app,
  ipcMain,
  dialog,
  runner: aeRunner.execute,
  // canRunScript 应先调用会员模块，再允许 runner 接触脚本明文。
  canRunScript: membershipService.canRunScript,
  dbKeyProvider,
  contentKeyProvider,
  getMainWindow: () => mainWindow
});
```

`script-library.js` 会在调用 runner 前先执行 `canRunScript`；会员未授权时不会解密内置脚本，也不会复制外部脚本到 AE 任务目录。

## 返回值约定

成功：

```json
{
  "taskId": "唯一任务ID",
  "ok": true,
  "returnValue": "AE脚本最后表达式的截断字符串",
  "via": "transport|osascript|afterfx-r"
}
```

失败错误码包括：

- `AE_NOT_INSTALLED`
- `AE_RUNNING_BRIDGE_REQUIRED`
- `AE_START_TIMEOUT`
- `AE_SCRIPT_TYPE_UNSUPPORTED`（`.aex` 不可作为 JSX 执行）
- `AE_SCRIPT_ERROR`（ExtendScript 捕获的异常）
- `AE_EXECUTION_TIMEOUT`
- `AE_RESULT_MISMATCH`
- `AE_EXTERNAL_SCRIPT_NOT_FOUND`
- `AE_BUILTIN_DECRYPT_FAILED`

## 权限与异常边界

- Windows/macOS 应用安装目录可能需要管理员权限；应用不应尝试静默提权。
- AE 弹出模态对话框时任务可能一直不返回，超时后不自动重试，避免重复修改项目。
- 脚本结果文件只在主进程临时目录生成，任务完成后删除；管理员权限攻击者仍可能在执行期间读取临时文件或内存。
- `.aex` 是原生插件，不是 ExtendScript。它需要单独的架构/签名/安装/重启流程，不能传入 `$.evalFile()`。
- JSX 使用 ES3 语法；桥接代码不使用 `let`、`const`、箭头函数或现代 Node API。

## 多版本策略

- `targetVersion` 或脚本声明的 `targetAeVersion` 优先精确匹配。
- 未指定时选择发现的最高版本，并在 UI/日志中返回实际版本。
- 目标版本未安装时返回 `AE_NOT_INSTALLED`，不能静默切换到另一版本。
- 正式发布前应在 CS6、早期 CC、中期 CC、当前 AE 和最新 AE 上分别验证脚本行为；通信成功不代表脚本 DOM/API 兼容。
