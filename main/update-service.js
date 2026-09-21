const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');
const { IPC_CHANNELS } = require('../shared/ipc-contract');

function readConfiguredUrl(app) {
  if (process.env.AE_UPDATE_URL) return process.env.AE_UPDATE_URL;
  try {
    const configPath = path.join(app.getAppPath(), 'resources', 'update-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return typeof config.url === 'string' && config.url.trim() ? config.url.trim() : '';
  } catch { return ''; }
}

function createUpdateService({ app, ipcMain, getMainWindow, updateUrl = readConfiguredUrl(app) } = {}) {
  if (!app || !ipcMain || typeof ipcMain.handle !== 'function') throw new Error('更新服务初始化参数不完整');
  let state = { status: updateUrl ? 'idle' : 'not_configured', version: null, progress: 0, error: null };
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

  if (updateUrl) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => publish({ status: 'available', version: info.version, progress: 0, error: null }));
    autoUpdater.on('update-not-available', (info) => publish({ status: 'up-to-date', version: info.version || app.getVersion(), progress: 0, error: null }));
    autoUpdater.on('download-progress', (progress) => publish({ status: 'downloading', progress: Math.round(progress.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => publish({ status: 'downloaded', version: info.version, progress: 100, error: null }));
    autoUpdater.on('error', (error) => publish({ status: 'error', error: error.message || '更新服务失败' }));
    // Generic provider 可由运行环境注入，避免把占位域名打进生产包。
    autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
  }

  ipcMain.handle(IPC_CHANNELS.UPDATE_STATUS, (event) => { assertSender(event); return { ...state }; });
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async (event) => {
    assertSender(event);
    if (!app.isPackaged) return publish({ status: 'dev-build', error: null });
    if (!updateUrl) return publish({ status: 'not_configured', error: '尚未配置更新服务器' });
    try { await autoUpdater.checkForUpdates(); return { ...state }; } catch (error) { return publish({ status: 'error', error: error.message || '检查更新失败' }); }
  });
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
    check: () => autoUpdater.checkForUpdates(),
    start: async () => { if (app.isPackaged && updateUrl) { try { await autoUpdater.checkForUpdates(); } catch { /* 状态已由 error 事件发布 */ } } },
  };
}

module.exports = { createUpdateService };
