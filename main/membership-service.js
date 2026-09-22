const crypto = require('node:crypto');
const https = require('node:https');
const { collectHardwareFingerprint } = require('./hardware-fingerprint');

const MAX_OFFLINE_MS = 7 * 24 * 60 * 60 * 1000;

function b64url(value) { return Buffer.from(value).toString('base64url'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function publicKeyForTransport(value) {
  const key = value && value.type === 'public' ? value : crypto.createPublicKey(value);
  return key.export({ type: 'spki', format: 'pem' }).toString();
}
function parseJws(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('离线授权格式无效');
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { encoded: `${parts[0]}.${parts[1]}`, header: decode(parts[0]), payload: decode(parts[1]), signature: Buffer.from(parts[2], 'base64url') };
}

function timeValue(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return Date.parse(value);
}

function verifyGrant(token, publicKeys, expected) {
  const jws = parseJws(token);
  const keyValue = publicKeys[jws.header.kid];
  if (!keyValue || jws.header.alg !== 'EdDSA') throw Object.assign(new Error('离线授权签名密钥未知'), { code: 'AUTH_GRANT_KEY_UNKNOWN' });
  const key = keyValue && keyValue.type === 'public' ? keyValue : crypto.createPublicKey(keyValue);
  if (!crypto.verify(null, Buffer.from(jws.encoded), key, jws.signature)) throw Object.assign(new Error('离线授权签名无效'), { code: 'AUTH_GRANT_SIGNATURE_INVALID' });
  const p = jws.payload;
  const now = Date.now();
  if (p.iss !== expected.issuer || p.aud !== expected.audience || p.device_id !== expected.deviceId || p.cnf !== expected.deviceKeyFingerprint) throw Object.assign(new Error('离线授权绑定信息不匹配'), { code: 'AUTH_GRANT_BINDING_INVALID' });
  const nbf = timeValue(p.nbf); const exp = timeValue(p.exp); const iat = timeValue(p.iat);
  if (!Number.isFinite(nbf) || nbf > now + 5 * 60 * 1000 || !Number.isFinite(exp) || exp <= now) throw Object.assign(new Error('离线授权已过期或尚未生效'), { code: 'AUTH_GRANT_EXPIRED' });
  if (!Number.isFinite(iat) || exp - iat > MAX_OFFLINE_MS + 5 * 60 * 1000) throw Object.assign(new Error('离线授权期限超过7天'), { code: 'AUTH_GRANT_TOO_LONG' });
  return p;
}

function requestJson({ baseUrl, endpoint, method = 'POST', body, headers = {}, timeoutMs = 15000, httpsApi = https } = {}) {
  const url = new URL(endpoint, baseUrl);
  if (url.protocol !== 'https:') return Promise.reject(Object.assign(new Error('会员 API 必须使用 HTTPS'), { code: 'AUTH_HTTPS_REQUIRED' }));
  const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
  return new Promise((resolve, reject) => {
    const request = httpsApi.request(url, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers }, timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return reject(Object.assign(new Error('会员 API 返回格式无效'), { code: 'AUTH_RESPONSE_INVALID' })); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(Object.assign(new Error(parsed.error?.message || '会员 API 请求失败'), { code: parsed.error?.code || `AUTH_HTTP_${response.statusCode}`, statusCode: response.statusCode }));
        resolve(parsed.data || parsed);
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('会员 API 请求超时'), { code: 'AUTH_NETWORK_TIMEOUT' })));
    request.on('error', (error) => reject(Object.assign(new Error('会员 API 网络请求失败'), { code: 'AUTH_NETWORK_ERROR', cause: error })));
    request.end(data);
  });
}

function createMembershipService({ baseUrl, endpoints = {}, cache, publicKeys = {}, issuer = 'ae-script-api', audience = 'ae-script-desktop', deviceIdentity, fingerprintProvider = collectHardwareFingerprint, httpsApi, now = () => Date.now(), appVersion = 'unknown', contentKeySink } = {}) {
  if (!baseUrl || !cache || !deviceIdentity || typeof deviceIdentity.getPrivateKey !== 'function' || typeof deviceIdentity.getPublicKey !== 'function') throw new Error('会员服务缺少 API、缓存或设备密钥提供器');
  let hardware;
  let identity;
  let cached = null;
  let onlinePromise = null;
  const paths = { challenge: '/v1/auth/challenges', login: '/v1/auth/login', activate: '/v1/activations/card', validate: '/v1/license/validate', offline: '/v1/license/offline-grants', ...endpoints };

  async function persistContentKeys(response) {
    if (!response || !response.content_keys || typeof contentKeySink !== 'function') return;
    const entries = Array.isArray(response.content_keys) ? response.content_keys : Object.keys(response.content_keys).map((scriptId) => ({ script_id: scriptId, ...response.content_keys[scriptId] }));
    for (const entry of entries) {
      if (!entry || typeof entry.script_id !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(entry.script_id)) continue;
      if (typeof entry.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(entry.key)) continue;
      await contentKeySink({ scriptId: entry.script_id, keyId: entry.key_id || null, key: entry.key, expiresAt: entry.expires_at || null });
    }
  }

  async function ensureDevice() {
    if (!hardware) hardware = await fingerprintProvider();
    if (!identity) {
      const publicKey = await deviceIdentity.getPublicKey();
      const publicKeyObject = publicKey && publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
      const publicDer = publicKeyObject.export({ type: 'spki', format: 'der' });
      identity = { publicKey: publicKeyForTransport(publicKey), publicKeyFingerprint: sha256(publicDer), deviceId: deviceIdentity.deviceId || sha256(publicDer).slice(0, 32) };
    }
    return { hardware, identity };
  }

  async function signRequest(method, endpoint, body, accessToken = '') {
    const { identity } = await ensureDevice();
    const timestamp = Math.floor(now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const bodyBytes = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const url = new URL(endpoint, baseUrl);
    const canonical = ['AEBOX-SIGN-V1', method.toUpperCase(), url.pathname, url.search.slice(1), sha256(bodyBytes), timestamp, nonce, identity.deviceId, accessToken ? parseJwtId(accessToken) : '', crypto.randomUUID()].join('\n');
    const requestId = canonical.split('\n').pop();
    const signature = crypto.sign(null, Buffer.from(canonical), await deviceIdentity.getPrivateKey()).toString('base64url');
    return { headers: { 'X-Device-ID': identity.deviceId, 'X-Key-ID': identity.publicKeyFingerprint, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Request-ID': requestId, 'X-Body-SHA256': sha256(bodyBytes), 'X-Signature': signature, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) } };
  }

  function parseJwtId(token) { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).jti || ''; } catch { return ''; } }

  async function loadCache() { if (!cached) cached = await cache.read(); return cached; }
  async function saveCache(next) { cached = next; await cache.write(next); return next; }
  function statusFromCache(record) {
    if (!record?.offlineGrant) return { isMember: false, status: 'offline_unavailable' };
    const grant = verifyGrant(record.offlineGrant, publicKeys, { issuer, audience, deviceId: record.deviceId, deviceKeyFingerprint: record.deviceKeyFingerprint });
    const entitlements = Array.isArray(grant.entitlements) ? grant.entitlements : [];
    return { isMember: true, status: 'offline', expiresAt: grant.exp, entitlements, lastTrustedServerTime: record.lastTrustedServerTime };
  }

  async function requestOnline(reason, resourceId) {
    const { hardware, identity } = await ensureDevice();
    const current = await loadCache();
    const body = { reason, resource_id: resourceId || undefined, app_version: appVersion, device_public_key: identity.publicKey, device_id: identity.deviceId, fingerprint: hardware.fingerprintHash, fingerprint_version: hardware.version, component_hashes: hardware.componentHashes, last_trusted_server_time: current?.lastTrustedServerTime || null };
    const accessToken = current?.accessToken || '';
    const signed = await signRequest('POST', paths.validate, body, accessToken);
    const response = await requestJson({ baseUrl, endpoint: paths.validate, method: 'POST', body, headers: signed.headers, httpsApi });
    const serverNow = Date.parse(response.server_time || response.issued_at || new Date(now()).toISOString());
    if (!Number.isFinite(serverNow)) throw Object.assign(new Error('会员服务端时间无效'), { code: 'AUTH_SERVER_TIME_INVALID' });
    const next = { ...current, accessToken: response.access_token || accessToken, refreshToken: response.refresh_token || current?.refreshToken || null, offlineGrant: response.offline_grant || current?.offlineGrant || null, deviceId: identity.deviceId, deviceKeyFingerprint: identity.publicKeyFingerprint, lastTrustedServerTime: serverNow, lastLocalTime: now(), membership: response.membership || null };
    if (next.offlineGrant) verifyGrant(next.offlineGrant, publicKeys, { issuer, audience, deviceId: identity.deviceId, deviceKeyFingerprint: identity.publicKeyFingerprint });
    await saveCache(next);
    if (response.decision === 'deny' || response.decision === 'reconnect_required') throw Object.assign(new Error(response.reason || '会员授权被拒绝'), { code: response.reason_code || 'MEMBERSHIP_DENIED' });
    await persistContentKeys(response);
    const onlineGrant = response.offline_grant || next.offlineGrant;
    return { isMember: true, status: 'online', expiresAt: response.membership?.expires_at || (onlineGrant ? verifyGrant(onlineGrant, publicKeys, { issuer, audience, deviceId: identity.deviceId, deviceKeyFingerprint: identity.publicKeyFingerprint }).exp : null), entitlements: response.entitlements || [] };
  }

  async function validateOnline(reason, resourceId) { if (!onlinePromise) onlinePromise = requestOnline(reason, resourceId).finally(() => { onlinePromise = null; }); return onlinePromise; }
  async function getStatus() {
    try {
      const record = await loadCache();
      if (!record) return { isMember: false, status: 'not_authenticated' };
      const { identity } = await ensureDevice();
      if (record.deviceId !== identity.deviceId || record.deviceKeyFingerprint !== identity.publicKeyFingerprint) return { isMember: false, status: 'device_changed' };
      const lastTrusted = Number(record.lastTrustedServerTime || 0);
      if (lastTrusted && now() + 5 * 60 * 1000 < lastTrusted) return { isMember: false, status: 'clock_rollback' };
      return statusFromCache(record);
    } catch (error) { return { isMember: false, status: error.code === 'AUTH_CACHE_TAMPERED' ? 'cache_tampered' : 'offline_expired' }; }
  }

  async function canRunScript(script) {
    if (!script || script.access !== 'member') return true;
    const status = await getStatus();
    const entitlement = status.entitlements?.includes('*') || status.entitlements?.includes(script.id);
    if (status.isMember && entitlement) return true;
    try {
      const online = await validateOnline('premium_script_run', script.id);
      return online.isMember && (online.entitlements?.includes('*') || online.entitlements?.includes(script.id));
    } catch { return false; }
  }

  async function activateCard(cardCode) {
    const { hardware, identity } = await ensureDevice();
    const body = { card_code: String(cardCode || ''), device_public_key: identity.publicKey, device_id: identity.deviceId, fingerprint: hardware.fingerprintHash, fingerprint_version: hardware.version, component_hashes: hardware.componentHashes, app_version: appVersion };
    const signed = await signRequest('POST', paths.activate, body);
    const response = await requestJson({ baseUrl, endpoint: paths.activate, method: 'POST', body, headers: signed.headers, httpsApi });
    const next = { ...(await loadCache()), accessToken: response.access_token, refreshToken: response.refresh_token, offlineGrant: response.offline_grant, deviceId: identity.deviceId, deviceKeyFingerprint: identity.publicKeyFingerprint, lastTrustedServerTime: Date.parse(response.server_time || new Date(now()).toISOString()), lastLocalTime: now(), membership: response.membership || null };
    if (next.offlineGrant) verifyGrant(next.offlineGrant, publicKeys, { issuer, audience, deviceId: identity.deviceId, deviceKeyFingerprint: identity.publicKeyFingerprint });
    await persistContentKeys(response);
    await saveCache(next);
    return getStatus();
  }

  async function login(email, password) {
    const { hardware, identity } = await ensureDevice();
    const body = { email: String(email || ''), password: String(password || ''), device_public_key: identity.publicKey, device_id: identity.deviceId, fingerprint: hardware.fingerprintHash, fingerprint_version: hardware.version, component_hashes: hardware.componentHashes, app_version: appVersion };
    const signed = await signRequest('POST', paths.login, body);
    const response = await requestJson({ baseUrl, endpoint: paths.login, method: 'POST', body, headers: signed.headers, httpsApi });
    const next = { ...(await loadCache()), accessToken: response.access_token, refreshToken: response.refresh_token, offlineGrant: response.offline_grant, deviceId: identity.deviceId, deviceKeyFingerprint: identity.publicKeyFingerprint, lastTrustedServerTime: Date.parse(response.server_time || new Date(now()).toISOString()), lastLocalTime: now(), membership: response.membership || null };
    if (next.offlineGrant) verifyGrant(next.offlineGrant, publicKeys, { issuer, audience, deviceId: identity.deviceId, deviceKeyFingerprint: identity.publicKeyFingerprint });
    await persistContentKeys(response);
    await saveCache(next);
    return getStatus();
  }

  async function startupCheck() { try { return await validateOnline('app_launch'); } catch { return getStatus(); } }
  return { getStatus, canRunScript, validateOnline, startupCheck, activateCard, login, clear: () => cache.clear(), ensureDevice, persistContentKeys };
}

module.exports = { createMembershipService, verifyGrant, parseJws, requestJson, MAX_OFFLINE_MS };
