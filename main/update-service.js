const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');
const { IPC_CHANNELS } = require('../shared/ipc-contract');

function readUpdateConfig(app) {
  const envProvider = process.env.AE_UPDATE_PROVIDER;
  const envUrl = process.env.AE_UPDATE_URL;
  if (envProvider === 'github') {
    return { provider: 'github', owner: process.env.AE_UPDATE_OWNER || '', repo: process.env.AE_UPDATE_REPO || '', releaseType: process.env.AE_UPDATE_RELEASE_TYPE || 'release' };
  }
  if (envUrl) return { provider: 'generic', url: envUrl };
  try {
    const configPath = path.join(app.getAppPath(), 'resources', 'update-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config && typeof config === 'object' ? config : {};
  } catch { return {}; }
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') return { provider: '' };
  if (config.provider === 'github') {
    if (!/^[A-Za-z0-9_.-]+$/.test(config.owner || '') || !/^[A-Za-z0-9_.-]+$/.test(config.repo || '')) return { provider: '', error: 'GitHub 更新配置缺少 owner 或 repo' };
    return { provider: 'github', owner: config.owner, repo: config.repo, releaseType: config.releaseType === 'draft' ? 'draft' : 'release' };
  }
  if (config.provider === 'generic' && typeof config.url === 'string' && /^https:\/\//i.test(config.url)) return { provider: 'generic', url: config.url.replace(/\/$/, '') };
  return { provider: '', error: '更新地址必须使用 HTTPS，或配置 GitHub Releases' };
}

function createUpdateService({ app, ipcMain, getMainWindow, updateConfig = readUpdateConfig(app) } = {}) {
  if (!app || !ipcMain || typeof ipcMain.handle !== 'function') throw new Error('更新服务初始化参数不完整');
  const config = validateConfig(updateConfig);
  let state = { status: config.provider ? 'idle' : 'not_configured', version: null, progress: 0, error: config.error || null };
  let checking = null;
  const getWindow = () => (typeof getMainWindow === 'function' ? getMainWindow() : null);
  const publish = (next) => {
    state = { ...state, ...next };
    getWindow()?.webContents?.send(IPC_CHANNELS.UPDATE_STATUS, { ...state });
    return { ...state };
  };
  const assertSender = (event) => {
    const window = getWindow();
    if (window?.webContents && event.sender !== window.webContents) throw Object.assign(new Error('未授权的渲染进程'), { code: 'FORBIDDEN_SENDER' });
  };
  const configured = () => Boolean(config.provider && app.isPackaged);

  if (config.provider) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => publish({ status: 'available', version: info.version, progress: 0, error: null }));
    autoUpdater.on('update-not-available', (info) => publish({ status: 'up-to-date', version: info.version || app.getVersion(), progress: 0, error: null }));
    autoUpdater.on('download-progress', (progress) => publish({ status: 'downloading', progress: Math.round(progress.percent || 0), error: null }));
    autoUpdater.on('update-downloaded', (info) => publish({ status: 'downloaded', version: info.version, progress: 100, error: null }));
    autoUpdater.on('error', (error) => publish({ status: 'error', error: error.message || '更新服务失败' }));
    if (config.provider === 'github') autoUpdater.setFeedURL({ provider: 'github', owner: config.owner, repo: config.repo, releaseType: config.releaseType });
    else autoUpdater.setFeedURL({ provider: 'generic', url: config.url });
  }

  async function check() {
    if (!app.isPackaged) return publish({ status: 'dev-build', error: null });
    if (!config.provider) return publish({ status: 'not_configured', error: config.error || '尚未配置更新服务器' });
    if (checking) return checking;
    checking = autoUpdater.checkForUpdates().then(() => ({ ...state })).catch((error) => publish({ status: 'error', error: error.message || '检查更新失败' })).finally(() => { checking = null; });
    return checking;
  }

  ipcMain.handle(IPC_CHANNELS.UPDATE_STATUS, (event) => { assertSender(event); return { ...state }; });
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, (event) => { assertSender(event); return check(); });
  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async (event) => {
    assertSender(event);
    if (state.status !== 'available') return { ...state };
    try { await autoUpdater.downloadUpdate(); return { ...state }; } catch (error) { return publish({ status: 'error', error: error.message || '下载更新失败' }); }
  });
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, (event) => {
    assertSender(event);
    if (state.status !== 'downloaded') return { ...state };
    autoUpdater.quitAndInstall(false, true);
    return { ...state, status: 'installing' };
  });

  return {
    getStatus: () => ({ ...state }),
    check,
    start: async () => { if (configured()) await check(); },
  };
}

module.exports = { createUpdateService, readUpdateConfig, validateConfig };
