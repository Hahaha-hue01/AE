const path = require('node:path');
const { openEncryptedDatabase } = require('./local-db');
const { createBuiltinResourceStore } = require('./builtin-resources');
const { createScriptLibrary } = require('./script-library');
const { registerScriptLibraryIpc } = require('./ipc-script-library');
const { registerMembershipIpc } = require('./membership-ipc');

/**
 * 在 app.whenReady() 后调用。dbKeyProvider/contentKeyProvider 应由安全存储或授权层注入。
 * 这里不实现 AE 执行和会员校验，只把它们作为可替换 hook 连接进来。
 */
async function bootstrapScriptLibrary({ app, ipcMain, dialog, getMainWindow, dbKeyProvider, contentKeyProvider, runner, canRunScript, getMembership, membershipService, verifyManifest, Database } = {}) {
  if (!app || typeof app.getPath !== 'function') throw new Error('必须传入 Electron app');
  // 资源放入 app.asar 内部，避免使用 extraResources 将密文清单暴露为可直接浏览的外部文件夹。
  // __dirname 在打包后位于 app.asar/main，在开发环境位于项目 main 目录。
  const resourceRoot = path.resolve(__dirname, '..', 'resources');
  const manifestPath = path.join(resourceRoot, 'builtin-scripts', 'manifest.json');
  const managedScriptsDir = path.join(app.getPath('userData'), 'external-scripts');
  const databasePath = path.join(app.getPath('userData'), 'script-library.sqlite');
  const builtinStore = createBuiltinResourceStore({ manifestPath, keyProvider: contentKeyProvider, verifyManifest });
  await builtinStore.load();
  const db = await openEncryptedDatabase({ dbPath: databasePath, getDatabaseKey: dbKeyProvider, Database });
  const library = createScriptLibrary({ db, builtinStore, managedScriptsDir, canRunScript: membershipService?.canRunScript || canRunScript });
  library.initialize();
  registerScriptLibraryIpc({ ipcMain, dialog, getMainWindow, library, runner, getMembership: membershipService?.getStatus || getMembership });
  if (membershipService) registerMembershipIpc({ ipcMain, service: membershipService, getMainWindow });
  return { db, library, builtinStore, paths: { manifestPath, databasePath, managedScriptsDir } };
}

module.exports = { bootstrapScriptLibrary };
