const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createMembershipService } = require('../main/membership-service');

test('content keys are validated and forwarded to the secure-store sink', async () => {
  const device = crypto.generateKeyPairSync('ed25519');
  const received = [];
  const service = createMembershipService({
    baseUrl: 'https://api.example.test',
    deviceIdentity: { deviceId: 'device', getPublicKey: async () => device.publicKey, getPrivateKey: async () => device.privateKey },
    fingerprintProvider: async () => ({ version: 1, fingerprintHash: 'fp', componentHashes: {} }),
    cache: { read: async () => null, write: async () => {}, clear: async () => {} },
    contentKeySink: async (entry) => received.push(entry),
  });
  const key = Buffer.alloc(32, 7).toString('base64url');
  await service.persistContentKeys({ content_keys: {
    builtin_text_manager: { key_id: 'builtin-content-v1', key, expires_at: '2099-01-01T00:00:00Z' },
    invalid: { key: 'too-short' },
  } });
  assert.deepEqual(received, [{ scriptId: 'builtin_text_manager', keyId: 'builtin-content-v1', key, expiresAt: '2099-01-01T00:00:00Z' }]);
});
