const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createBridgeScript, createTaskId, createMacDoScriptCommand } = require('./ae-bridge');
const { listRunningAeProcesses, discoverAeInstallations, chooseAeInstallation } = require('./ae-process');

const execFileAsync = promisify(execFile);
const ALLOWED_SCRIPT_TYPES = new Set(['jsx', 'jsxbin']);

function pathExists(filePath, fsApi) { return fsApi.access(filePath).then(() => true).catch(() => false); }

function createAeRunner({ platform = process.platform, tempRoot = path.join(os.tmpdir(), 'ae-script-collector'), fsApi = fs, exec = execFileAsync, spawnProcess = spawn, processDetector, installationResolver, targetVersion, transport, timeoutMs = 120000, now = () => Date.now() } = {}) {
  const detect = processDetector || (() => listRunningAeProcesses(platform, exec));
  const resolveInstallations = installationResolver || (() => discoverAeInstallations(platform, fsApi));

  async function waitForResult(resultPath, taskId, deadline) {
    while (now() < deadline) {
      if (await pathExists(resultPath, fsApi)) {
        try {
          const parsed = JSON.parse(await fsApi.readFile(resultPath, 'utf8'));
          if (parsed.taskId !== taskId) throw Object.assign(new Error('AE 返回任务 ID 不匹配'), { code: 'AE_RESULT_MISMATCH' });
          return parsed;
        } catch (error) {
          if (error.code === 'AE_RESULT_MISMATCH') throw error;
          // AE 可能正在写入结果文件，下一轮再读取。
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Object.assign(new Error('AE 脚本执行超时；请检查 AE 是否被模态对话框阻塞'), { code: 'AE_EXECUTION_TIMEOUT' });
  }

  async function materializeScript(script, taskDir, decryptBuiltin) {
    if (!script || !ALLOWED_SCRIPT_TYPES.has(script.type)) throw Object.assign(new Error('仅支持 JSX/JSXBIN 执行；AEX 必须使用插件安装流程'), { code: 'AE_SCRIPT_TYPE_UNSUPPORTED' });
    const targetPath = path.join(taskDir, `script.${script.type}`);
    if (script.origin === 'builtin') {
      if (typeof decryptBuiltin !== 'function') throw Object.assign(new Error('内置脚本解密器未配置'), { code: 'AE_BUILTIN_DECRYPT_UNAVAILABLE' });
      const decrypted = await decryptBuiltin();
      const content = Buffer.isBuffer(decrypted) ? decrypted : decrypted?.content;
      if (!Buffer.isBuffer(content) || content.length === 0) throw Object.assign(new Error('内置脚本解密结果为空'), { code: 'AE_BUILTIN_DECRYPT_FAILED' });
      await fsApi.writeFile(targetPath, content, { mode: 0o600 });
      return targetPath;
    }
    if (typeof script.managedPath !== 'string' || !(await pathExists(script.managedPath, fsApi))) throw Object.assign(new Error('外部脚本文件不存在'), { code: 'AE_EXTERNAL_SCRIPT_NOT_FOUND' });
    // 不直接修改外部脚本；复制到任务目录，避免 AE 读取过程中源文件被替换。
    await fsApi.copyFile(script.managedPath, targetPath);
    return targetPath;
  }

  async function executeViaMacAppleScript(applicationName, bridgePath) {
    const command = createMacDoScriptCommand({ applicationName, bridgePath });
    await exec('/usr/bin/osascript', ['-e', command], { timeout: 30000, maxBuffer: 1024 * 1024 });
  }

  async function waitForAeProcess(deadline) {
    while (now() < deadline) {
      const processes = await detect();
      if (processes.length > 0) return processes;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Object.assign(new Error('After Effects 启动超时，请确认应用没有被系统权限或弹窗阻塞'), { code: 'AE_START_TIMEOUT' });
  }

  async function execute({ script, managedPath, decryptBuiltin }) {
    const taskId = createTaskId();
    const taskDir = path.join(tempRoot, taskId);
    await fsApi.mkdir(taskDir, { recursive: true, mode: 0o700 });
    const resultPath = path.join(taskDir, 'result.json');
    try {
      const scriptPath = managedPath && script.origin !== 'builtin' ? await materializeScript({ ...script, managedPath }, taskDir, decryptBuiltin) : await materializeScript(script, taskDir, decryptBuiltin);
      const bridgePath = path.join(taskDir, 'ae-bridge.jsx');
      await fsApi.writeFile(bridgePath, createBridgeScript({ scriptPath, resultPath, taskId }), { encoding: 'utf8', mode: 0o600 });
      const running = await detect();
      const installations = await resolveInstallations();
      const selected = chooseAeInstallation(installations, targetVersion || script.targetAeVersion);
      if (!selected) throw Object.assign(new Error('未找到本机 Adobe After Effects 安装；请先安装 AE 或在设置中指定版本'), { code: 'AE_NOT_INSTALLED' });
      if (typeof transport === 'function') {
        await transport({ scriptPath, bridgePath, resultPath, taskId, installation: selected, running });
      } else if (platform === 'darwin' && running.length > 0) {
        const appName = selected.appPath ? path.basename(selected.appPath, '.app') : `Adobe After Effects ${selected.version}`;
        await executeViaMacAppleScript(appName, bridgePath);
      } else if (running.length > 0) {
        const child = spawnProcess(selected.executable, ['-r', bridgePath], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } else if (platform === 'darwin') {
        await exec('/usr/bin/open', ['-a', selected.appPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
        await waitForAeProcess(now() + Math.min(timeoutMs, 90000));
        const appName = selected.appPath ? path.basename(selected.appPath, '.app') : `Adobe After Effects ${selected.version}`;
        await executeViaMacAppleScript(appName, bridgePath);
      } else {
        const child = spawnProcess(selected.executable, ['-r', bridgePath], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      }
      const result = await waitForResult(resultPath, taskId, now() + timeoutMs);
      if (!result.ok) throw Object.assign(new Error(result.error?.message || 'AE 脚本执行失败'), { code: 'AE_SCRIPT_ERROR', details: result.error || null, taskId });
      return { taskId, ok: true, returnValue: result.returnValue || '', installation: selected, via: transport ? 'transport' : (platform === 'darwin' ? 'osascript' : 'afterfx-r') };
    } catch (error) {
      if (error.code) throw error;
      throw Object.assign(new Error(error.message || 'AE 通信失败'), { code: 'AE_COMMUNICATION_FAILED', cause: error, taskId });
    } finally {
      // 延迟清理，给 AE 读取脚本的进程留出时间；结果已读取后立即删除。
      await fsApi.rm(taskDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { execute, materializeScript };
}

module.exports = { createAeRunner, ALLOWED_SCRIPT_TYPES };
