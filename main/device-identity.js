const crypto = require('node:crypto');

function createDeviceIdentity({ secureStore } = {}) {
  if (!secureStore || typeof secureStore.read !== 'function' || typeof secureStore.write !== 'function') throw new Error('设备密钥必须通过安全存储注入');
  let loaded;
  async function load() {
    if (loaded) return loaded;
    let record = await secureStore.read();
    if (!record) {
      const pair = crypto.generateKeyPairSync('ed25519');
      const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      record = { version: 1, privateKey, publicKey };
      await secureStore.write(record);
    }
    const publicKey = crypto.createPublicKey(record.publicKey);
    const publicDer = publicKey.export({ type: 'spki', format: 'der' });
    loaded = { privateKey: crypto.createPrivateKey(record.privateKey), publicKey, deviceId: crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 32) };
    return loaded;
  }
  return { getPrivateKey: async () => (await load()).privateKey, getPublicKey: async () => (await load()).publicKey, get deviceId() { return loaded?.deviceId; } };
}

module.exports = { createDeviceIdentity };
