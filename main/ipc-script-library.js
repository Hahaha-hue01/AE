const { IPC_CHANNELS } = require('../shared/ipc-contract');

function ipcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(value)) throw ipcError('INVALID_SCRIPT_ID', '脚本 ID 无效');
  return value;
}

/** 注册脚本库 IPC；所有 handler 都在主进程重新校验参数和权限。 */
function registerScriptLibraryIpc({ ipcMain, dialog, getMainWindow, library, runner, getMembership } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('必须提供 ipcMain');
  if (!library) throw new Error('必须提供 script library');
  const windowOf = () => (typeof getMainWindow === 'function' ? getMainWindow() : undefined);
  const assertSender = (event) => {
    const window = windowOf();
    if (window && window.webContents && event.sender !== window.webContents) throw ipcError('FORBIDDEN_SENDER', '未授权的渲染进程');
  };

  ipcMain.handle(IPC_CHANNELS.GET_SCRIPTS, (event, options = {}) => { assertSender(event); return library.list({ includeHidden: options && options.includeHidden === true }); });
  ipcMain.handle(IPC_CHANNELS.GET_SCRIPT, (event, scriptId) => {
    assertSender(event);
    const script = library.get(requireId(scriptId));
    if (!script) throw ipcError('SCRIPT_NOT_FOUND', '脚本不存在');
    return script;
  });
  ipcMain.handle(IPC_CHANNELS.RUN_SCRIPT, async (event, scriptId) => {
    assertSender(event);
    try { return await library.run(requireId(scriptId), runner); } catch (error) { throw ipcError(error.code || 'SCRIPT_RUN_REJECTED', error.message); }
  });
  ipcMain.handle(IPC_CHANNELS.IMPORT_EXTERNAL, async (event) => {
    assertSender(event);
    if (!dialog || typeof dialog.showOpenDialog !== 'function') throw ipcError('DIALOG_UNAVAILABLE', '文件选择器不可用');
    const result = await dialog.showOpenDialog(windowOf(), { title: '导入 AE 脚本', properties: ['openFile'], filters: [{ name: 'AE 脚本', extensions: ['jsx', 'jsxbin', 'aex'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    try { return await library.importExternal(result.filePaths[0]); } catch (error) { throw ipcError(error.code || 'SCRIPT_IMPORT_FAILED', error.message); }
  });
  ipcMain.handle(IPC_CHANNELS.UPDATE_SCRIPT, (event, scriptId, patch = {}) => {
    assertSender(event);
    try { return library.update(requireId(scriptId), patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}); } catch (error) { throw ipcError(error.code || 'SCRIPT_UPDATE_FAILED', error.message); }
  });
  ipcMain.handle(IPC_CHANNELS.SET_FAVORITE, (event, scriptId, payload = {}) => { assertSender(event); return library.setPreference(requireId(scriptId), { favorite: payload.favorite }); });
  ipcMain.handle(IPC_CHANNELS.SET_NOTE, (event, scriptId, payload = {}) => { assertSender(event); return library.setPreference(requireId(scriptId), { note: payload.note }); });
  ipcMain.handle(IPC_CHANNELS.SET_HIDDEN, (event, scriptId, payload = {}) => { assertSender(event); return library.setPreference(requireId(scriptId), { hidden: payload.hidden }); });
  const getMembershipStatus = async (event) => { assertSender(event); return typeof getMembership === 'function' ? getMembership() : { isMember: false, status: 'unknown' }; };
  ipcMain.handle(IPC_CHANNELS.GET_MEMBERSHIP, getMembershipStatus);
}

module.exports = { registerScriptLibraryIpc };
