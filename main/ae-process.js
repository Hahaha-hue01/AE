const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function parseWindowsTasklist(output) {
  return String(output || '').split(/\r?\n/).map((line) => {
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) return null;
    const image = fields[0].slice(1, -1);
    const pid = Number(fields[1].slice(1, -1).replace(/,/g, ''));
    return { image, pid: Number.isFinite(pid) ? pid : null };
  }).filter(Boolean);
}

function parseMacPs(output) {
  return String(output || '').split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+([^\s]+)\s+(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), command: match[2], args: match[3] };
  }).filter(Boolean).filter((item) => /after\s*effects|afterfx/i.test(`${item.command} ${item.args}`));
}

async function listRunningAeProcesses(platform = process.platform, exec = execFileAsync) {
  if (platform === 'win32') {
    try {
      const result = await exec('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 1024 * 1024 });
      return parseWindowsTasklist(result.stdout).filter((item) => /^AfterFX\.exe$/i.test(item.image));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw Object.assign(new Error('无法查询 Windows AE 进程'), { code: 'AE_PROCESS_QUERY_FAILED', cause: error });
    }
  }
  if (platform === 'darwin') {
    try {
      const result = await exec('/bin/ps', ['-axo', 'pid=,comm=,args='], { maxBuffer: 2 * 1024 * 1024 });
      return parseMacPs(result.stdout);
    } catch (error) {
      throw Object.assign(new Error('无法查询 macOS AE 进程'), { code: 'AE_PROCESS_QUERY_FAILED', cause: error });
    }
  }
  return [];
}

async function globDirectories(root, prefix, fsApi = fs) {
  try {
    const entries = await fsApi.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix.toLowerCase())).map((entry) => path.join(root, entry.name));
  } catch { return []; }
}

async function discoverAeInstallations(platform = process.platform, fsApi = fs, env = process.env) {
  const roots = [];
  if (platform === 'win32') {
    if (env.ProgramFiles) roots.push(path.join(env.ProgramFiles, 'Adobe'));
    if (env['ProgramFiles(x86)']) roots.push(path.join(env['ProgramFiles(x86)'], 'Adobe'));
    const result = [];
    for (const root of roots) {
      const dirs = await globDirectories(root, 'Adobe After Effects', fsApi);
      for (const dir of dirs) {
        const executable = path.join(dir, 'Support Files', 'AfterFX.exe');
        try { await fsApi.access(executable); result.push({ version: path.basename(dir).replace(/^Adobe After Effects\s*/i, ''), executable, appPath: dir }); } catch { /* ignore incomplete installs */ }
      }
    }
    return result;
  }
  if (platform === 'darwin') {
    const dirs = await globDirectories('/Applications', 'Adobe After Effects', fsApi);
    const result = [];
    for (const appPath of dirs) {
      const executable = path.join(appPath, 'Contents', 'MacOS', 'After Effects');
      try { await fsApi.access(executable); result.push({ version: path.basename(appPath).replace(/^Adobe After Effects\s*/i, '').replace(/\.app$/i, ''), executable, appPath }); } catch { /* ignore */ }
    }
    return result;
  }
  return [];
}

function chooseAeInstallation(installations, requestedVersion) {
  if (!installations.length) return null;
  if (requestedVersion) {
    const exact = installations.find((item) => item.version === String(requestedVersion));
    if (exact) return exact;
    const compatible = installations.find((item) => String(requestedVersion).startsWith(item.version) || item.version.startsWith(String(requestedVersion)));
    if (compatible) return compatible;
  }
  return installations.slice().sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0];
}

module.exports = { listRunningAeProcesses, discoverAeInstallations, chooseAeInstallation, parseWindowsTasklist, parseMacPs };
