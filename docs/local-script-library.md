# 主进程脚本库与本地存储

## 文件职责

- `main/script-library.js`：内置/外部脚本统一元数据模型、外部导入校验、SQLite CRUD、收藏/隐藏/备注和使用次数。
- `main/builtin-resources.js`：读取加密资源清单；仅在运行适配器需要时按脚本解密，不把密文或密钥传给 renderer。
- `main/local-db.js`：使用 SQLCipher 驱动打开加密 SQLite。生产环境必须从 Windows DPAPI 或 macOS Keychain 注入 32 字节数据库密钥。
- `main/ipc-script-library.js`：注册白名单 IPC handler，并在主进程重新校验 ID、字段和错误码。
- `main/script-library-bootstrap.js`：在 `app.whenReady()` 后加载资源清单、打开加密 SQLite 并注册 IPC。

`main/local-db.js` 默认使用 `better-sqlite3-multiple-ciphers`。当前代码没有擅自安装该生产依赖；接入项目时需确认后使用 `pnpm add better-sqlite3-multiple-ciphers`，或通过 `Database` 参数注入经过 SQLCipher 配置的兼容驱动。

## 本地 SQLite 表结构

本地库与云端会员 PostgreSQL 完全分离，初始化时自动创建以下表：

### `external_scripts`

保存外部脚本的元数据和应用管理目录中的副本：

`id`、`type`、`name`、`description`、`category`、`tags_json`、`ae_versions_json`、`tutorial`、`access`、`managed_path`、`original_name`、`sha256`、`size_bytes`、`run_mode`、`created_at`、`updated_at`。

原始用户路径不持久化；应用只使用复制到用户数据目录下的受控副本。`sha256` 唯一约束防止同一文件重复导入。

### `script_preferences`

同时适用于内置脚本和外部脚本：

`script_id`、`is_favorite`、`is_hidden`、`note`、`use_count`、`last_used_at`。

内置脚本本体和不可变元数据不写入此表；用户只能写入偏好，所以不能通过删除数据库记录删除内置脚本。

### `categories`

保存分类配置：`id`、`name`、`sort_order`、`is_hidden`。系统初始化 `builtin`、`external`、`favorites` 三个分类。

### `schema_meta`

用于后续本地数据库迁移版本控制。

## 内置资源清单格式

`builtin-resources.js` 读取格式为 `ae-script-bundle-v1`：

```json
{
  "format": "ae-script-bundle-v1",
  "version": 1,
  "entries": [
    {
      "id": "motion-ease",
      "name": "Motion Ease",
      "type": "jsx",
      "access": "member",
      "description": "脚本简介",
      "aeVersions": ["2022", "2023", "2024"],
      "tags": ["动画"],
      "payload": {
        "keyId": "content-key-v1",
        "nonce": "Base64URL",
        "ciphertext": "Base64URL",
        "authTag": "Base64URL"
      },
      "sha256": "解密后脚本的SHA-256"
    }
  ]
}
```

加密算法为 AES-256-GCM，AAD 为 `脚本ID + NUL + 文件类型`。清单可通过 `verifyManifest` 注入签名校验；生产构建必须签名清单和密文资源。密钥提供器必须由主进程的安全存储/授权层注入，不得放在 renderer、ASAR 配置或清单内。

## Electron 打包方案

1. 构建阶段将 JSX/JSXBIN/AEX 原始文件转换成资源清单，并逐条随机生成 nonce，使用 AES-256-GCM 加密。
2. 清单和密文放入 Electron `extraResources` 或 ASAR 中。ASAR 只负责封装，不被视为加密边界。
3. `process.resourcesPath` 下读取生产清单；开发环境使用项目资源目录。不要把路径传给 renderer。
4. 应用启动时只加载并验证清单元数据；运行单个内置脚本时才调用 `builtinStore.decrypt(id)`。
5. 明文只在主进程内存中短暂存在，不能写入日志、SQLite、崩溃报告或永久临时文件。
6. Windows 安装包、macOS 应用和资源清单都应使用代码签名/公证；发布时保留内容密钥轮换和资源撤销能力。

`bootstrapScriptLibrary()` 约定生产包中的资源路径为 `resources/builtin-scripts/manifest.json`。构建脚本应把生成的清单和密文目录复制到该位置；开发环境则从项目根目录下的 `resources/builtin-scripts` 读取。

技术边界：拥有本机管理员权限的用户仍可能通过内存抓取、调试或 Hook 在 AE 执行前截获明文。该方案是防普通解包和直接复制的反提取措施，不是绝对 DRM。

## 外部脚本校验

- 仅接受 `.jsx`、`.jsxbin`、`.aex`。
- 拒绝目录、符号链接、空文件、超过 50MB 的文件。
- JSX 支持 UTF-8/UTF-16 BOM，并读取前 64KB 的 `@name`、`@description`、`@category` 注释作为初始元数据。
- JSXBIN 作为二进制脚本保存，不尝试反编译。
- AEX 必须具备 PE `MZ` 或 Mach-O 文件头；损坏/未知文件头拒绝导入。
- 导入后复制到应用管理目录，按 SHA-256 去重，SQLite 仅记录受控副本路径。
- 第三方脚本仍属于不可信代码；导入不等于安全审查，也不自动执行脚本。

## IPC 通道

除原有查询、收藏、备注、隐藏、运行和会员状态接口外，新增：

- `scripts:import-external`：由主进程弹出文件选择器，不接受 renderer 任意路径。
- `scripts:update`：仅允许编辑外部脚本的名称、简介、标签、分类、教程和 AE 版本。

所有修改型 handler 都应在主进程重新校验，不能信任 renderer 发送的 `canRun` 或权限字段。
