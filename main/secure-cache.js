const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function asKey(value) {
  const key = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value, 'base64url') : null;
  if (!key || key.length !== 32) throw new Error('授权缓存密钥必须是 32 字节');
  return key;
}

function createEncryptedJsonCache({ filePath, keyProvider, fsApi = fs } = {}) {
  if (!filePath || typeof keyProvider !== 'function') throw new Error('必须提供缓存路径和安全密钥提供器');
  async function read() {
    try {
      const envelope = JSON.parse(await fsApi.readFile(filePath, 'utf8'));
      const key = asKey(await keyProvider());
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Object.assign(new Error('本地授权缓存校验失败'), { code: 'AUTH_CACHE_TAMPERED', cause: error });
    }
  }
  async function write(value) {
    const key = asKey(await keyProvider());
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') });
    await fsApi.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsApi.writeFile(temporary, envelope, { encoding: 'utf8', mode: 0o600 });
    try {
      await fsApi.rename(temporary, filePath);
    } catch (error) {
      // Windows 对已存在目标文件的 rename 可能返回 EPERM；先删除旧缓存再替换。
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await fsApi.rm(filePath, { force: true });
      await fsApi.rename(temporary, filePath);
    }
  }
  async function clear() { await fsApi.rm(filePath, { force: true }); }
  return { read, write, clear };
}

module.exports = { createEncryptedJsonCache };
