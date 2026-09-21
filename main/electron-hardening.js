/**
 * Electron 进程级加固。它只能提高逆向成本，不能阻止拥有本机管理员权限的调试器。
 * 应在 app.ready 前调用 commandLine 部分，在创建窗口前注册 webContents 监听。
 */
function installElectronSecurityBaseline({ app, session, isProduction = app?.isPackaged, allowedOrigins = [] } = {}) {
  if (!app) throw new Error('必须提供 Electron app');
  if (isProduction && app.commandLine?.appendSwitch) {
    // 不打开远程调试端口；若启动器显式传入端口，应在发布启动脚本中拒绝该参数。
    app.commandLine.appendSwitch('remote-debugging-port', '0');
  }
  const originSet = new Set(allowedOrigins);
  const attach = (webContents) => {
    if (isProduction) webContents.on('devtools-opened', () => webContents.closeDevTools());
    webContents.setWindowOpenHandler(({ url }) => { try { return { action: originSet.has(new URL(url).origin) ? 'allow' : 'deny' }; } catch { return { action: 'deny' }; } });
    webContents.on('will-navigate', (event, url) => {
      try { if (!originSet.has(new URL(url).origin)) event.preventDefault(); } catch { event.preventDefault(); }
    });
  };
  app.on('web-contents-created', (_event, webContents) => attach(webContents));
  if (session?.webRequest) {
    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      try {
        const url = new URL(details.url);
        callback({ cancel: !originSet.has(url.origin) && !['file:', 'devtools:'].includes(url.protocol) });
      } catch { callback({ cancel: true }); }
    });
  }
}

module.exports = { installElectronSecurityBaseline };
