const path = require('node:path');
const { app, BrowserWindow, session, ipcMain, dialog, safeStorage } = require('electron');
const { installElectronSecurityBaseline } = require('./electron-hardening');
const { bootstrapScriptLibrary } = require('./script-library-bootstrap');
const { createAeRunner } = require('./ae-runner');
const { createMembershipService } = require('./membership-service');
const { createEncryptedJsonCache } = require('./secure-cache');
const { createDeviceIdentity } = require('./device-identity');
const { createElectronSecureStore, createRandomKeyProvider } = require('./secure-store');
const { createUpdateService } = require('./update-service');

let mainWindow;
let runtime;
let updateService;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111417',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      // preload.js 需要加载 shared/ipc-contract.js；在未打包 preload bundle 的情况下，
      // Electron sandbox 会禁止该类本地 require。继续保留 contextIsolation 和关闭 Node
      // integration，主进程仍是唯一的文件/授权边界。
      sandbox: false,
      nodeIntegration: false,
      enableRemoteModule: false,
      devTools: !app.isPackaged,
    },
  });
  if (app.isPackaged) mainWindow.removeMenu();
  return mainWindow;
}

function loadWindow() {
  return mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function showStartupError(error) {
  const message = String(error?.message || '应用初始化失败').replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
  return mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111417;color:#e8edf2;font:14px system-ui;padding:48px}h1{font-size:22px}code{color:#ffb86b;white-space:pre-wrap}</style><h1>AE脚本集合器启动失败</h1><p>应用窗口已创建，但核心模块初始化失败。</p><code>${message}</code><p>请查看日志或重新安装最新版本。</p>`)}`);
}

async function initializeRuntime() {
  const secureStore = createElectronSecureStore({ app, safeStorage });
  if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('系统安全存储不可用，无法安全初始化会员和本地数据库'), { code: 'SECURE_STORE_UNAVAILABLE' });
  const deviceIdentity = createDeviceIdentity({ secureStore: {
    read: async () => (await secureStore.read())?.deviceIdentity || null,
    write: async (value) => { const current = (await secureStore.read()) || {}; await secureStore.write({ ...current, deviceIdentity: value }); },
  } });
  const cache = createEncryptedJsonCache({
    filePath: path.join(app.getPath('userData'), 'membership-cache.json'),
    keyProvider: createRandomKeyProvider({ secureStore: { read: async () => await secureStore.read(), write: async (value) => secureStore.write(value) }, field: 'cacheKey' }),
  });
  const membershipService = createMembershipService({
    baseUrl: process.env.AE_SCRIPT_API_URL || 'https://api.example.invalid',
    publicKeys: {},
    cache,
    deviceIdentity,
    appVersion: app.getVersion(),
  });
  const aeRunner = createAeRunner();
  const keyStore = { read: async () => await secureStore.read(), write: async (value) => secureStore.write(value) };
  const dbKeyProvider = createRandomKeyProvider({ secureStore: keyStore, field: 'databaseKey' });
  const contentKeyProvider = async ({ id } = {}) => {
    const record = (await secureStore.read()) || {};
    const key = record[`contentKey:${id}`] || record.contentKey;
    if (!key) throw Object.assign(new Error('内置脚本内容密钥未配置'), { code: 'CONTENT_KEY_UNAVAILABLE' });
    return Buffer.from(key, 'base64url');
  };
  runtime = await bootstrapScriptLibrary({ app, ipcMain, dialog, getMainWindow: () => mainWindow, dbKeyProvider, contentKeyProvider, runner: aeRunner.execute, membershipService });
  updateService = createUpdateService({ app, ipcMain, getMainWindow: () => mainWindow });
  void membershipService.startupCheck().catch(() => {});
  return runtime;
}

app.whenReady().then(async () => {
  installElectronSecurityBaseline({ app, session: session.defaultSession, isProduction: app.isPackaged, allowedOrigins: [] });
  createWindow();
  try { await initializeRuntime(); await loadWindow(); void updateService?.start(); } catch (error) {
    console.error('[startup]', error.code || 'STARTUP_FAILED', error.message);
    await showStartupError(error);
  }
  app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); await loadWindow(); } });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
