const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const FINGERPRINT_VERSION = 1;

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashComponent(value) {
  return crypto.createHash('sha256').update(clean(value), 'utf8').digest('hex');
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map(clean).filter(Boolean))].sort();
}

function parsePowerShellJson(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function collectWindowsComponents(exec = execFileAsync) {
  const script = [
    '$cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { $_.ProcessorId })',
    '$board = @(Get-CimInstance Win32_BaseBoard | ForEach-Object { $_.Manufacturer + \'|\' + $_.Product + \'|\' + $_.SerialNumber })',
    '$mac = @(Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True" | Where-Object { $_.MACAddress } | ForEach-Object { $_.MACAddress })',
    '[pscustomobject]@{ cpu=$cpu; board=$board; mac=$mac } | ConvertTo-Json -Compress',
  ].join(';');
  try {
    const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    const parsed = parsePowerShellJson(stdout)[0] || {};
    return {
      cpu: uniqueNonEmpty(Array.isArray(parsed.cpu) ? parsed.cpu : [parsed.cpu]),
      board: uniqueNonEmpty(Array.isArray(parsed.board) ? parsed.board : [parsed.board]),
      mac: uniqueNonEmpty(Array.isArray(parsed.mac) ? parsed.mac : [parsed.mac]),
    };
  } catch (error) {
    throw Object.assign(new Error('无法读取 Windows 硬件信息'), { code: 'HARDWARE_QUERY_FAILED', cause: error });
  }
}

async function collectMacComponents(exec = execFileAsync) {
  try {
    const { stdout } = await exec('/usr/sbin/system_profiler', ['SPHardwareDataType', 'SPNetworkDataType', '-json'], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    const data = JSON.parse(String(stdout || '{}'));
    const hardware = (data.SPHardwareDataType || [])[0] || {};
    const network = data.SPNetworkDataType || [];
    const mac = [];
    network.forEach((item) => { if (item && item.spnetwork_macs) mac.push(...item.spnetwork_macs); });
    return {
      cpu: uniqueNonEmpty([hardware.current_processor_speed, hardware.cpu_type, hardware.chip_type, hardware.platform_uuid]),
      board: uniqueNonEmpty([hardware.platform_uuid, hardware.serial_number]),
      mac: uniqueNonEmpty(mac),
    };
  } catch (error) {
    throw Object.assign(new Error('无法读取 macOS 硬件信息'), { code: 'HARDWARE_QUERY_FAILED', cause: error });
  }
}

function buildFingerprint(platform, components) {
  const normalized = {
    version: FINGERPRINT_VERSION,
    platform,
    cpu: uniqueNonEmpty(components.cpu || []),
    board: uniqueNonEmpty(components.board || []),
    mac: uniqueNonEmpty(components.mac || []),
  };
  const available = ['cpu', 'board', 'mac'].filter((key) => normalized[key].length > 0);
  if (available.length < 2) throw Object.assign(new Error('可用硬件信息不足，无法安全绑定设备'), { code: 'HARDWARE_INSUFFICIENT' });
  const canonical = JSON.stringify(normalized);
  return {
    version: FINGERPRINT_VERSION,
    fingerprintHash: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex'),
    componentHashes: {
      cpu: normalized.cpu.map(hashComponent),
      board: normalized.board.map(hashComponent),
      mac: normalized.mac.map(hashComponent),
    },
    platform,
    availableComponents: available,
  };
}

async function collectHardwareFingerprint({ platform = process.platform, exec = execFileAsync } = {}) {
  const components = platform === 'win32'
    ? await collectWindowsComponents(exec)
    : platform === 'darwin' ? await collectMacComponents(exec) : { cpu: [os.cpus()[0]?.model || ''], board: [], mac: Object.values(os.networkInterfaces()).flat().filter(Boolean).map((item) => item.mac) };
  return buildFingerprint(platform, components);
}

module.exports = { collectHardwareFingerprint, collectWindowsComponents, collectMacComponents, buildFingerprint, FINGERPRINT_VERSION };
