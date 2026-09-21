/**
 * Renderer 与 Electron 主进程之间的 IPC 合同。
 * 仅将这些白名单通道注册到 contextBridge；不要暴露通用 invoke(channel, ...args)。
 */
const IPC_CHANNELS = Object.freeze({
  GET_SCRIPTS: 'scripts:list',
  GET_SCRIPT: 'scripts:get',
  RUN_SCRIPT: 'scripts:run',
  IMPORT_EXTERNAL: 'scripts:import-external',
  UPDATE_SCRIPT: 'scripts:update',
  SET_FAVORITE: 'scripts:set-favorite',
  SET_NOTE: 'scripts:set-note',
  SET_HIDDEN: 'scripts:set-hidden',
  GET_MEMBERSHIP: 'membership:get',
  MEMBERSHIP_STATUS: 'membership:status',
  MEMBERSHIP_REFRESH: 'membership:refresh',
  MEMBERSHIP_ACTIVATE: 'membership:activate-card',
  MEMBERSHIP_LOGIN: 'membership:login',
  UPDATE_STATUS: 'app:update-status',
  UPDATE_CHECK: 'app:update-check',
  UPDATE_DOWNLOAD: 'app:update-download',
  UPDATE_INSTALL: 'app:update-install',
});

module.exports = { IPC_CHANNELS };
