const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * 使用 Electron safeStorage 保存小型密钥/设备身份记录。
 * safeStorage 必须在 app ready 后调用；生产环境不可退化为明文文件。
 */
function createElectronSecureStore({ app, safeStorage, filename = 'secure-store.json' } = {}) {
  if (!app || typeof app.getPath !== 'function' || !safeStorage) throw new Error('安全存储初始化参数不完整');
  const filePath = path.join(app.getPath('userData'), filename);

  async function readEnvelope() {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Object.assign(new Error('安全存储读取失败'), { code: 'SECURE_STORE_READ_FAILED', cause: error });
    }
  }

  async function read() {
    const envelope = await readEnvelope();
    if (!envelope) return null;
    if (envelope.version !== 1 || typeof envelope.data !== 'string') throw Object.assign(new Error('安全存储格式无效'), { code: 'SECURE_STORE_TAMPERED' });
    try {
      const plaintext = safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
      return JSON.parse(plaintext);
    } catch (error) { throw Object.assign(new Error('安全存储校验失败'), { code: 'SECURE_STORE_TAMPERED', cause: error }); }
  }

  async function write(value) {
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('系统安全存储不可用'), { code: 'SECURE_STORE_UNAVAILABLE' });
    const plaintext = JSON.stringify(value);
    const envelope = JSON.stringify({ version: 1, data: safeStorage.encryptString(plaintext).toString('base64') });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temporary, envelope, { mode: 0o600 });
    await fs.rename(temporary, filePath).catch(async (error) => {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await fs.rm(filePath, { force: true });
      await fs.rename(temporary, filePath);
    });
  }

  return { read, write, filePath };
}

function createRandomKeyProvider({ secureStore, field, bytes = 32 } = {}) {
  if (!secureStore || typeof secureStore.read !== 'function' || typeof secureStore.write !== 'function' || !field) throw new Error('密钥提供器参数不完整');
  return async () => {
    const record = (await secureStore.read()) || {};
    if (typeof record[field] === 'string') return Buffer.from(record[field], 'base64url');
    const key = crypto.randomBytes(bytes);
    await secureStore.write({ ...record, [field]: key.toString('base64url') });
    return key;
  };
}

module.exports = { createElectronSecureStore, createRandomKeyProvider };
