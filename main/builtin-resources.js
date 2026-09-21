const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const AES_ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

function asBuffer(value, fieldName) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string') throw new Error(`${fieldName} 必须是 Base64 字符串`);
  return Buffer.from(value, 'base64url');
}

function assertId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(id)) throw new Error('无效的内置脚本 ID');
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('内置脚本清单包含无效条目');
  assertId(entry.id);
  if (typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > 200) throw new Error(`内置脚本名称无效：${entry.id}`);
  if (!['jsx', 'jsxbin', 'aex', 'plugin'].includes(entry.type)) throw new Error(`不支持的内置脚本类型：${entry.id}`);
  if (!['free', 'member'].includes(entry.access || 'free')) throw new Error(`内置脚本权限无效：${entry.id}`);
  // payload 允许为空（仅用于元数据清单），真正运行前仍会拒绝空 payload。
  if (entry.payload !== undefined && entry.payload !== null && typeof entry.payload !== 'object') throw new Error(`内置脚本 payload 无效：${entry.id}`);
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    access: entry.access || 'free',
    category: 'builtin',
    description: typeof entry.description === 'string' ? entry.description.slice(0, 4000) : '',
    tutorial: typeof entry.tutorial === 'string' ? entry.tutorial.slice(0, 12000) : '',
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string').slice(0, 30) : [],
    aeVersions: Array.isArray(entry.aeVersions) ? entry.aeVersions.filter((version) => typeof version === 'string').slice(0, 30) : [],
    runMode: typeof entry.runMode === 'string' ? entry.runMode.slice(0, 80) : '一次性脚本',
    sha256: typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : null,
    payload: entry.payload || null,
  };
}

/**
 * 读取并按需解密内置脚本资源。
 * manifest 只包含元数据和密文，不向 renderer 暴露 payload 或密钥。
 */
function createBuiltinResourceStore({ manifestPath, keyProvider, verifyManifest } = {}) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) throw new Error('必须提供内置资源清单路径');
  if (typeof keyProvider !== 'function') throw new Error('必须注入内置脚本密钥提供器（不得把密钥写入渲染进程）');
  let entries = new Map();
  let loaded = false;

  async function load() {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    if (!manifest || manifest.format !== 'ae-script-bundle-v1' || !Array.isArray(manifest.entries)) throw new Error('内置脚本清单格式不受支持');
    if (typeof verifyManifest === 'function') await verifyManifest(manifest, Buffer.from(raw, 'utf8'));
    const next = new Map();
    manifest.entries.forEach((entry) => {
      const normalized = validateEntry(entry);
      if (next.has(normalized.id)) throw new Error(`内置脚本 ID 重复：${normalized.id}`);
      next.set(normalized.id, normalized);
    });
    entries = next;
    loaded = true;
    return getMetadata();
  }

  function ensureLoaded() {
    if (!loaded) throw new Error('内置脚本资源尚未加载');
  }

  function getMetadata() {
    ensureLoaded();
    return Array.from(entries.values()).map(({ payload, ...metadata }) => ({ ...metadata }));
  }

  async function decrypt(id) {
    ensureLoaded();
    assertId(id);
    const entry = entries.get(id);
    if (!entry) throw new Error('内置脚本不存在');
    if (!entry.payload || typeof entry.payload !== 'object') throw new Error('该内置脚本没有可执行密文');
    const nonce = asBuffer(entry.payload.nonce, 'nonce');
    const ciphertext = asBuffer(entry.payload.ciphertext, 'ciphertext');
    const authTag = asBuffer(entry.payload.authTag, 'authTag');
    if (nonce.length !== NONCE_BYTES || authTag.length !== 16 || ciphertext.length === 0) throw new Error('内置脚本密文格式错误');
    const key = await keyProvider({ id, access: entry.access, keyId: entry.payload.keyId || null });
    const keyBuffer = asBuffer(key, 'script key');
    if (keyBuffer.length !== KEY_BYTES) throw new Error('内置脚本密钥长度必须为 32 字节');
    const decipher = crypto.createDecipheriv(AES_ALGORITHM, keyBuffer, nonce);
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(`${id}\0${entry.type}`, 'utf8'));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (entry.sha256 && crypto.createHash('sha256').update(plaintext).digest('hex') !== entry.sha256) throw new Error('内置脚本完整性校验失败');
    return { metadata: { ...entry, payload: undefined }, content: plaintext };
  }

  return { load, getMetadata, decrypt, get manifestPath() { return path.resolve(manifestPath); } };
}

module.exports = { createBuiltinResourceStore, AES_ALGORITHM, NONCE_BYTES, KEY_BYTES };
