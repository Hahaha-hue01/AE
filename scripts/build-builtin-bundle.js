/* 生成加密内置 JSX 清单；源文件位于 scripts/builtin-source，不会进入 app.asar。 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var root = path.resolve(__dirname, '..');
var source = path.join(root, 'scripts', 'builtin-source', '文字管理器.jsx');
var output = path.join(root, 'resources', 'builtin-scripts', 'manifest.json');
var keyText = process.env.BUILTIN_CONTENT_KEY || '';
if (!/^[0-9a-fA-F]{64}$/.test(keyText)) throw new Error('BUILTIN_CONTENT_KEY 必须是 64 位十六进制字符串');
var key = Buffer.from(keyText, 'hex');
var id = 'builtin_text_manager';
var type = 'jsx';
var content = fs.readFileSync(source);
var nonce = crypto.randomBytes(12);
var cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
cipher.setAAD(Buffer.from(id + '\0' + type, 'utf8'));
var ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
var manifest = { format: 'ae-script-bundle-v1', version: 1, generatedAt: new Date().toISOString(), entries: [{
  id: id, name: '文字管理器', version: '6.0', type: type, access: 'free', category: '自研脚本',
  description: '批量扫描和修改 AE 项目中的文字图层，支持预合成递归扫描、查找替换、字体、字间距和行距调整。',
  aeVersions: ['CS6', 'CC', 'CC 2014', 'CC 2015', 'CC 2017', 'CC 2018', 'CC 2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'],
  sha256: crypto.createHash('sha256').update(content).digest('hex'),
  payload: { keyId: 'builtin-content-v1', nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), authTag: cipher.getAuthTag().toString('base64url'), fileName: '文字管理器.jsx' }
}] };
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('已生成内置脚本清单：' + output);
