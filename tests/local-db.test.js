const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openEncryptedDatabase } = require('../main/local-db');

test('SQLCipher database opens with a 32-byte key and rejects a wrong key', async () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-script-db-')), 'library.sqlite');
  const key = Buffer.alloc(32, 0x2a);
  const db = await openEncryptedDatabase({ dbPath: filePath, dbKey: key });
  db.exec('CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES (\'ok\')');
  assert.equal(db.prepare('SELECT value FROM sample').get().value, 'ok');
  db.close();

  assert.throws(() => {
    const wrong = require('better-sqlite3-multiple-ciphers');
    const reopened = new wrong(filePath);
    try {
      reopened.pragma('cipher = "sqlcipher"');
      reopened.pragma(`key = "x'${Buffer.alloc(32, 0x7b).toString('hex')}'"`);
      reopened.prepare('SELECT * FROM sqlite_master').all();
    } finally { reopened.close(); }
  });
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});
