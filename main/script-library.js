const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const MAX_TEXT_BYTES = 50 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const ALLOWED_TYPES = new Set(['jsx', 'jsxbin', 'aex']);
const CATEGORY_PATTERN = /^[\p{L}\p{N}_ .-]{1,80}$/u;

function nowIso() { return new Date().toISOString(); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function safeId(value) { return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(value); }
function quoteJson(value) { return JSON.stringify(value ?? null); }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function validateText(value, field, maxLength) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(`${field} 内容无效或超出长度限制`);
  return value;
}

function decodeScriptText(buffer) {
  if (buffer.length > MAX_METADATA_BYTES) buffer = buffer.subarray(0, MAX_METADATA_BYTES);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.swap16().toString('utf16le');
  return buffer.toString('utf8');
}

function parseAnnotation(text, names) {
  for (const name of names) {
    const pattern = new RegExp(`(?:@${name}|${name})\\s*[:=]?\\s*[\\\"']?([^\\\"'\\r\\n]{1,400})`, 'i');
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}

function detectBinaryType(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return 'pe';
  if (buffer.length >= 4) {
    const magic = buffer.readUInt32BE(0);
    if ([0xcafebabe, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return 'mach-o';
  }
  return null;
}

function toDisplayRecord(row, preference, builtin = false) {
  const metadata = builtin ? row : { ...row, aeVersions: parseJson(row.ae_versions_json, []), tags: parseJson(row.tags_json, []) };
  return {
    id: metadata.id,
    name: metadata.name,
    category: builtin ? 'builtin' : (metadata.category || 'external'),
    description: metadata.description || '',
    aeVersions: metadata.aeVersions || [],
    access: metadata.access || 'free',
    tutorial: metadata.tutorial || '',
    runMode: metadata.runMode || '一次性脚本',
    tags: metadata.tags || [],
    isFavorite: Boolean(preference?.is_favorite),
    isHidden: Boolean(preference?.is_hidden),
    note: preference?.note || '',
    useCount: Number(preference?.use_count || 0),
    lastUsedAt: preference?.last_used_at || null,
    canRun: metadata.access !== 'member',
    origin: builtin ? 'builtin' : 'external',
    type: metadata.type,
  };
}

function createScriptLibrary({ db, builtinStore, managedScriptsDir, canRunScript } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('必须提供支持 exec/prepare 的 SQLite 数据库');
  if (!builtinStore || typeof builtinStore.getMetadata !== 'function') throw new Error('必须提供内置资源存储器');
  if (typeof managedScriptsDir !== 'string' || managedScriptsDir.length === 0) throw new Error('必须提供外部脚本管理目录');

  let initialized = false;
  const builtinById = new Map();

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_scripts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('jsx','jsxbin','aex')),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'external',
        tags_json TEXT NOT NULL DEFAULT '[]',
        ae_versions_json TEXT NOT NULL DEFAULT '[]',
        tutorial TEXT NOT NULL DEFAULT '',
        access TEXT NOT NULL DEFAULT 'free' CHECK (access IN ('free','member')),
        managed_path TEXT NOT NULL,
        original_name TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        run_mode TEXT NOT NULL DEFAULT '一次性脚本',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS script_preferences (
        script_id TEXT PRIMARY KEY,
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),
        is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0,1)),
        note TEXT NOT NULL DEFAULT '',
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0,1))
      );
      INSERT OR IGNORE INTO categories(id, name, sort_order) VALUES ('builtin','自研脚本',10), ('external','外部脚本',20), ('favorites','常用脚本',30);
    `);
    builtinById.clear();
    builtinStore.getMetadata().forEach((entry) => builtinById.set(entry.id, entry));
    initialized = true;
  }

  function ensureInitialized() { if (!initialized) initialize(); }
  function getPreference(id) { return db.prepare('SELECT * FROM script_preferences WHERE script_id = ?').get(id); }
  function ensurePreference(id) { db.prepare('INSERT OR IGNORE INTO script_preferences(script_id) VALUES (?)').run(id); return getPreference(id); }
  function getExternal(id) { return db.prepare('SELECT * FROM external_scripts WHERE id = ?').get(id); }
  function findRecord(id) {
    ensureInitialized();
    if (builtinById.has(id)) return { record: builtinById.get(id), builtin: true };
    const external = getExternal(id);
    return external ? { record: external, builtin: false } : null;
  }
  function display(id) {
    const found = findRecord(id);
    return found ? toDisplayRecord(found.record, getPreference(id), found.builtin) : null;
  }

  function list(options = {}) {
    ensureInitialized();
    const includeHidden = options.includeHidden === true;
    const rows = [
      ...Array.from(builtinById.values()).map((record) => ({ record, builtin: true })),
      ...db.prepare('SELECT * FROM external_scripts ORDER BY name COLLATE NOCASE ASC').all().map((record) => ({ record, builtin: false })),
    ];
    return rows.map(({ record, builtin }) => toDisplayRecord(record, getPreference(record.id), builtin)).filter((item) => includeHidden || !item.isHidden);
  }

  async function parseExternalFile(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('未提供脚本路径');
    const absolute = path.resolve(filePath);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('只能导入普通文件，不能导入目录或符号链接');
    if (stat.size <= 0 || stat.size > MAX_TEXT_BYTES) throw new Error('脚本文件为空或超过 50MB 限制');
    const extension = path.extname(absolute).slice(1).toLowerCase();
    if (!ALLOWED_TYPES.has(extension)) throw new Error('仅支持 .jsx、.jsxbin、.aex 文件');
    const content = await fs.readFile(absolute);
    const hash = sha256(content);
    let annotations = '';
    let binaryType = null;
    if (extension === 'jsx' || extension === 'jsxbin') {
      annotations = decodeScriptText(content);
      if (extension === 'jsx' && /\u0000/.test(annotations.slice(0, 4096))) throw new Error('JSX 文本编码损坏');
      if (extension === 'jsx' && !annotations.trim()) throw new Error('JSX 文件没有可解析内容');
      if (extension === 'jsxbin' && (content.length < 8 || content.every((byte) => byte === 0))) throw new Error('JSXBIN 文件内容损坏');
    } else {
      binaryType = detectBinaryType(content.subarray(0, 4096));
      if (!binaryType) throw new Error('AEX 文件头无效，可能已损坏或不是 AE 原生插件');
    }
    const baseName = path.basename(absolute, path.extname(absolute)).slice(0, 200) || '未命名脚本';
    return {
      sourcePath: absolute,
      content,
      hash,
      type: extension,
      originalName: path.basename(absolute),
      name: parseAnnotation(annotations, ['name', 'title']) || baseName,
      description: parseAnnotation(annotations, ['description', 'desc']),
      category: parseAnnotation(annotations, ['category']) || 'external',
      tags: [],
      aeVersions: [],
      tutorial: '',
      runMode: extension === 'aex' ? 'AE 原生插件（需安装/重启）' : '一次性脚本',
      binaryType,
    };
  }

  async function importExternalPaths(filePaths = []) {
    if (!Array.isArray(filePaths) || filePaths.length > 100) throw new Error('一次最多导入 100 个脚本');
    const imported = []; const errors = [];
    for (const filePath of filePaths) { try { imported.push(await importExternal(filePath)); } catch (error) { errors.push({ path: String(filePath), message: error.message || '导入失败' }); } }
    return { imported, errors };
  }

  async function scanExternalScripts({ roots, maxFiles = 500 } = {}) {
    const home = os.homedir();
    const defaultRoots = process.platform === 'win32' ? [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'OneDrive', 'Documents')] : [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'Library', 'Application Support', 'Adobe')];
    const searchRoots = [...new Set((Array.isArray(roots) && roots.length ? roots : defaultRoots).map((item) => path.resolve(String(item))).filter((item) => item !== path.resolve(managedScriptsDir)))];
    const found = []; const seen = new Set(); const visited = new Set(); const ignored = new Set(['node_modules', '.git', '.svn', 'cache', 'caches', 'temp', 'tmp']);
    async function walk(directory, depth) {
      if (found.length >= maxFiles || depth > 5 || visited.has(directory)) return; visited.add(directory); let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) { if (found.length >= maxFiles) break; if (entry.name.startsWith('.') || ignored.has(entry.name.toLowerCase())) continue; const fullPath = path.join(directory, entry.name); if (entry.isDirectory()) { await walk(fullPath, depth + 1); continue; } if (!entry.isFile() || !/\.(jsx|jsxbin|aex)$/i.test(entry.name)) continue; try { const parsed = await parseExternalFile(fullPath); if (seen.has(parsed.hash)) continue; seen.add(parsed.hash); found.push({ id: parsed.hash, path: parsed.sourcePath, name: parsed.name, description: parsed.description, type: parsed.type, sizeBytes: parsed.content.length, originalName: parsed.originalName }); } catch { } }
    }
    for (const rootPath of searchRoots) await walk(rootPath, 0);
    return { roots: searchRoots, truncated: found.length >= maxFiles, scripts: found.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) };
  }

  async function importExternal(filePath) {
    ensureInitialized();
    const parsed = await parseExternalFile(filePath);
    const existing = db.prepare('SELECT id FROM external_scripts WHERE sha256 = ?').get(parsed.hash);
    if (existing) return display(existing.id);
    await fs.mkdir(managedScriptsDir, { recursive: true });
    const destination = path.join(managedScriptsDir, `${parsed.hash}.${parsed.type}`);
    await fs.writeFile(destination, parsed.content, { flag: 'wx', mode: 0o600 }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const id = `external_${parsed.hash.slice(0, 32)}`;
    const timestamp = nowIso();
    db.prepare(`INSERT INTO external_scripts(id,type,name,description,category,tags_json,ae_versions_json,tutorial,access,managed_path,original_name,sha256,size_bytes,run_mode,created_at,updated_at) VALUES (@id,@type,@name,@description,@category,@tags,@aeVersions,@tutorial,'free',@managedPath,@originalName,@sha256,@size,@runMode,@createdAt,@updatedAt)`).run({ id, type: parsed.type, name: parsed.name, description: parsed.description, category: CATEGORY_PATTERN.test(parsed.category) ? parsed.category : 'external', tags: quoteJson(parsed.tags), aeVersions: quoteJson(parsed.aeVersions), tutorial: parsed.tutorial, managedPath: destination, originalName: parsed.originalName, sha256: parsed.hash, size: parsed.content.length, runMode: parsed.runMode, createdAt: timestamp, updatedAt: timestamp });
    ensurePreference(id);
    return display(id);
  }

  function update(id, patch) {
    ensureInitialized();
    const existing = getExternal(id);
    if (!existing) throw new Error('只有外部脚本可以编辑元数据');
    const name = patch.name === undefined ? existing.name : validateText(patch.name, '名称', 200);
    if (!name || !name.trim()) throw new Error('脚本名称不能为空');
    const description = patch.description === undefined ? existing.description : validateText(patch.description, '简介', 4000);
    const tutorial = patch.tutorial === undefined ? existing.tutorial : validateText(patch.tutorial, '教程', 12000);
    const category = patch.category === undefined ? existing.category : validateText(patch.category, '分类', 80);
    if (category && !CATEGORY_PATTERN.test(category)) throw new Error('分类包含不支持的字符');
    const tags = patch.tags === undefined ? parseJson(existing.tags_json, []) : patch.tags;
    if (!Array.isArray(tags) || tags.length > 30 || tags.some((tag) => typeof tag !== 'string' || tag.length > 50)) throw new Error('标签格式无效');
    const aeVersions = patch.aeVersions === undefined ? parseJson(existing.ae_versions_json, []) : patch.aeVersions;
    if (!Array.isArray(aeVersions) || aeVersions.length > 30 || aeVersions.some((version) => typeof version !== 'string' || version.length > 50)) throw new Error('AE 版本格式无效');
    db.prepare('UPDATE external_scripts SET name = ?, description = ?, category = ?, tags_json = ?, ae_versions_json = ?, tutorial = ?, updated_at = ? WHERE id = ?').run(name.trim(), description, category || 'external', quoteJson(tags), quoteJson(aeVersions), tutorial, nowIso(), id);
    return display(id);
  }

  function setPreference(id, patch) {
    ensureInitialized();
    if (!findRecord(id)) throw new Error('脚本不存在');
    const current = ensurePreference(id);
    const favorite = patch.favorite === undefined ? Boolean(current.is_favorite) : patch.favorite;
    const hidden = patch.hidden === undefined ? Boolean(current.is_hidden) : patch.hidden;
    if (typeof favorite !== 'boolean' || typeof hidden !== 'boolean') throw new Error('收藏/隐藏状态必须是布尔值');
    const note = patch.note === undefined ? current.note : validateText(patch.note, '备注', 500);
    db.prepare('UPDATE script_preferences SET is_favorite = ?, is_hidden = ?, note = ? WHERE script_id = ?').run(favorite ? 1 : 0, hidden ? 1 : 0, note || '', id);
    return display(id);
  }

  function recordUse(id) {
    ensureInitialized();
    if (!findRecord(id)) throw new Error('脚本不存在');
    ensurePreference(id);
    db.prepare('UPDATE script_preferences SET use_count = use_count + 1, last_used_at = ? WHERE script_id = ?').run(nowIso(), id);
  }

  async function run(id, runner) {
    const script = display(id);
    if (!script) throw new Error('脚本不存在');
    const allowed = typeof canRunScript === 'function' ? await canRunScript(script) : script.canRun;
    if (!allowed) throw new Error('当前脚本未获得运行权限');
    recordUse(id);
    if (typeof runner !== 'function') throw new Error('主进程尚未配置 AE 运行适配器');
    return runner({ script, managedPath: builtinById.has(id) ? null : getExternal(id)?.managed_path, decryptBuiltin: () => builtinStore.decrypt(id) });
  }

  return { initialize, list, get: (id) => display(id), importExternal, importExternalPaths, scanExternalScripts, parseExternalFile, update, setPreference, recordUse, run, getBuiltinMetadata: () => Array.from(builtinById.values()).map(({ payload, ...metadata }) => metadata) };
}

module.exports = { createScriptLibrary, MAX_TEXT_BYTES };
