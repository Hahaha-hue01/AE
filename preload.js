const { contextBridge, ipcRenderer } = require('electron');
const { IPC_CHANNELS } = require('./shared/ipc-contract');

// 只暴露语义化接口，渲染进程不能任意选择 IPC channel 或访问 Node.js API。
contextBridge.exposeInMainWorld('aeScripts', {
  getScripts: (options = {}) => ipcRenderer.invoke(IPC_CHANNELS.GET_SCRIPTS, options),
  getScript: (scriptId) => ipcRenderer.invoke(IPC_CHANNELS.GET_SCRIPT, scriptId),
  runScript: (scriptId) => ipcRenderer.invoke(IPC_CHANNELS.RUN_SCRIPT, scriptId),
  importExternalScript: () => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_EXTERNAL),
  updateScript: (scriptId, patch) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SCRIPT, scriptId, patch),
  setFavorite: (scriptId, payload) => ipcRenderer.invoke(IPC_CHANNELS.SET_FAVORITE, scriptId, payload),
  setNote: (scriptId, payload) => ipcRenderer.invoke(IPC_CHANNELS.SET_NOTE, scriptId, payload),
  setHidden: (scriptId, payload) => ipcRenderer.invoke(IPC_CHANNELS.SET_HIDDEN, scriptId, payload),
  getMembership: () => ipcRenderer.invoke(IPC_CHANNELS.GET_MEMBERSHIP),
  getMembershipStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MEMBERSHIP_STATUS),
  refreshMembership: () => ipcRenderer.invoke(IPC_CHANNELS.MEMBERSHIP_REFRESH),
  activateMembershipCard: (cardCode) => ipcRenderer.invoke(IPC_CHANNELS.MEMBERSHIP_ACTIVATE, cardCode),
  loginMembership: (credentials) => ipcRenderer.invoke(IPC_CHANNELS.MEMBERSHIP_LOGIN, credentials),
  getUpdateStatus: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_STATUS),
  checkForUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATUS, listener);
  },
});
