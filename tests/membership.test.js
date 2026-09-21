const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { buildFingerprint } = require('../main/hardware-fingerprint');
const { createEncryptedJsonCache } = require('../main/secure-cache');
const { verifyGrant, createMembershipService } = require('../main/membership-service');
const { createDeviceIdentity } = require('../main/device-identity');

function makeGrant(privateKey, payload, kid = 'test-v1') {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'AEBOX-OFFLINE-GRANT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const encoded = `${header}.${body}`;
  return `${encoded}.${crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`;
}

test('fingerprint hashes components and is stable for ordering', () => {
  const a = buildFingerprint('win32', { cpu: ['CPU-B', 'cpu-a'], board: ['BOARD'], mac: ['AA:BB'] });
  const b = buildFingerprint('win32', { cpu: ['cpu-a', 'CPU-B'], board: ['board'], mac: ['aa:bb'] });
  assert.equal(a.fingerprintHash, b.fingerprintHash);
  assert.notEqual(a.componentHashes.cpu[0], 'cpu-a');
});

test('offline grant verifies signature, binding and seven-day limit', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const now = Date.now();
  const grant = makeGrant(privateKey, { iss: 'issuer', aud: 'aud', device_id: 'device', cnf: 'key', iat: now, nbf: now - 1000, exp: now + 3600000, entitlements: ['script-1'] });
  const payload = verifyGrant(grant, { 'test-v1': publicKey }, { issuer: 'issuer', audience: 'aud', deviceId: 'device', deviceKeyFingerprint: 'key' });
  assert.deepEqual(payload.entitlements, ['script-1']);
  const tooLong = makeGrant(privateKey, { iss: 'issuer', aud: 'aud', device_id: 'device', cnf: 'key', iat: now, nbf: now, exp: now + 8 * 24 * 3600000, entitlements: ['script-1'] });
  assert.throws(() => verifyGrant(tooLong, { 'test-v1': publicKey }, { issuer: 'issuer', audience: 'aud', deviceId: 'device', deviceKeyFingerprint: 'key' }), { code: 'AUTH_GRANT_TOO_LONG' });
});

test('encrypted cache detects tampering', async () => {
  const files = new Map();
  const fsApi = {
    mkdir: async () => {},
    writeFile: async (file, data) => files.set(file, data),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFile: async (file) => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
    rm: async (file) => files.delete(file),
  };
  const cache = createEncryptedJsonCache({ filePath: '/user/cache.json', keyProvider: async () => Buffer.alloc(32, 7), fsApi });
  await cache.write({ hello: 'world' });
  assert.deepEqual(await cache.read(), { hello: 'world' });
  files.set('/user/cache.json', `${files.get('/user/cache.json')}x`);
  await assert.rejects(() => cache.read(), { code: 'AUTH_CACHE_TAMPERED' });
});

test('membership service refuses premium script without valid offline grant', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const device = crypto.generateKeyPairSync('ed25519');
  const der = device.publicKey.export({ type: 'spki', format: 'der' });
  const deviceFingerprint = crypto.createHash('sha256').update(der).digest('hex');
  const now = Date.now();
  const grant = makeGrant(privateKey, { iss: 'issuer', aud: 'aud', device_id: 'device', cnf: deviceFingerprint, iat: now, nbf: now - 1000, exp: now + 3600000, entitlements: ['premium-1'] });
  let record = { offlineGrant: grant, deviceId: 'device', deviceKeyFingerprint: deviceFingerprint, lastTrustedServerTime: now };
  const service = createMembershipService({ baseUrl: 'https://api.example.test', publicKeys: { 'test-v1': publicKey }, issuer: 'issuer', audience: 'aud', deviceIdentity: { deviceId: 'device', getPublicKey: async () => device.publicKey, getPrivateKey: async () => device.privateKey }, fingerprintProvider: async () => ({ version: 1, fingerprintHash: 'fp', componentHashes: { cpu: ['x'], board: ['y'], mac: [] } }), cache: { read: async () => record, write: async (value) => { record = value; }, clear: async () => {} }, now: () => now });
  assert.equal(await service.canRunScript({ access: 'member', id: 'premium-1' }), true);
  assert.equal(await service.canRunScript({ access: 'member', id: 'premium-2' }), false);
});

test('device identity persists an Ed25519 key through injected secure storage', async () => {
  let record = null;
  const identity = createDeviceIdentity({ secureStore: { read: async () => record, write: async (value) => { record = value; } } });
  const first = await identity.getPublicKey();
  const second = await identity.getPublicKey();
  assert.equal(first.export({ type: 'spki', format: 'der' }).toString('hex'), second.export({ type: 'spki', format: 'der' }).toString('hex'));
  assert.equal(typeof identity.deviceId, 'string');
});
