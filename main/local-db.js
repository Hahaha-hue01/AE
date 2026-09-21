const fs = require('node:fs/promises');
const path = require('node:path');

function normalizeKey(value) {
  const key = Buffer.isBuffer(value) ? value : (typeof value === 'string' ? Buffer.from(value, 'base64url') : null);
  if (!key || key.length !== 32) throw new Error('本地 SQLite 密钥必须是 32 字节 Buffer 或 Base64URL 字符串');
  return key;
}

/**
 * 打开 SQLCipher 数据库。
 * 默认驱动是 better-sqlite3-multiple-ciphers，但不在此处自动安装依赖。
 * 生产环境应从 Windows DPAPI/macOS Keychain 提供 dbKey，而不是从普通配置文件读取。
 */
async function openEncryptedDatabase({ dbPath, dbKey, getDatabaseKey, Database } = {}) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) throw new Error('必须提供 SQLite 路径');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const key = normalizeKey(typeof getDatabaseKey === 'function' ? await getDatabaseKey() : dbKey);
  const Driver = Database || (() => {
    try { return require('better-sqlite3-multiple-ciphers'); } catch (error) { throw new Error('缺少 better-sqlite3-multiple-ciphers。请使用 pnpm 添加依赖后再启用本地加密数据库。', { cause: error }); }
  })();
  const db = new Driver(dbPath);
  if (typeof db.pragma !== 'function') throw new Error('SQLite 驱动不支持 SQLCipher pragma');
  db.pragma('cipher = "sqlcipher"');
  db.pragma(`key = "x'${key.toString('hex')}'"`);
  db.pragma('kdf_iter = 256000');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}

module.exports = { openEncryptedDatabase };
