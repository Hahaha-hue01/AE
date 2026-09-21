const { IPC_CHANNELS } = require('../shared/ipc-contract');

function errorWithCode(code, message, cause) { return Object.assign(new Error(message), { code, cause }); }

function registerMembershipIpc({ ipcMain, service, getMainWindow } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('必须提供 ipcMain');
  if (!service) throw new Error('必须提供会员授权服务');
  const getWindow = () => (typeof getMainWindow === 'function' ? getMainWindow() : null);
  const assertSender = (event) => {
    const window = getWindow();
    if (window?.webContents && event.sender !== window.webContents) throw errorWithCode('FORBIDDEN_SENDER', '未授权的渲染进程');
  };
  ipcMain.handle(IPC_CHANNELS.MEMBERSHIP_REFRESH, async (event) => {
    assertSender(event);
    try { return await service.validateOnline('manual_refresh'); } catch (error) { throw errorWithCode(error.code || 'MEMBERSHIP_REFRESH_FAILED', error.message, error); }
  });
  ipcMain.handle(IPC_CHANNELS.MEMBERSHIP_ACTIVATE, async (event, cardCode) => {
    assertSender(event);
    if (typeof cardCode !== 'string' || cardCode.length < 8 || cardCode.length > 256) throw errorWithCode('INVALID_CARD_CODE', '卡密格式无效');
    try { return await service.activateCard(cardCode); } catch (error) { throw errorWithCode(error.code || 'MEMBERSHIP_ACTIVATE_FAILED', error.message, error); }
  });
  ipcMain.handle(IPC_CHANNELS.MEMBERSHIP_LOGIN, async (event, credentials = {}) => {
    assertSender(event);
    if (!credentials || typeof credentials.email !== 'string' || typeof credentials.password !== 'string') throw errorWithCode('INVALID_CREDENTIALS', '登录参数无效');
    try { return await service.login(credentials.email, credentials.password); } catch (error) { throw errorWithCode(error.code || 'MEMBERSHIP_LOGIN_FAILED', error.message, error); }
  });
  ipcMain.handle(IPC_CHANNELS.MEMBERSHIP_STATUS, async (event) => { assertSender(event); return service.getStatus(); });
}

module.exports = { registerMembershipIpc };
