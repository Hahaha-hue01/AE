const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const staging = path.join(root, '.build-staging');
// 直接调用包内 CLI，避免 Windows 下依赖 node_modules/.bin 的 .cmd 包装器。
const obfuscatorCli = require.resolve('javascript-obfuscator/bin/javascript-obfuscator');

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function copyTree(source, destination) { if (await exists(source)) await fs.cp(source, destination, { recursive: true, force: true }); }
async function restoreNonJavaScriptFiles(source, destination) {
  if (!(await exists(source))) return;
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await restoreNonJavaScriptFiles(sourcePath, destinationPath);
    } else if (!entry.name.toLowerCase().endsWith('.js')) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [obfuscatorCli, ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`javascript-obfuscator exited with ${code}`)));
  });
}

async function main() {
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await copyTree(path.join(root, 'main'), path.join(staging, 'main'));
  await copyTree(path.join(root, 'renderer'), path.join(staging, 'renderer'));
  await copyTree(path.join(root, 'shared'), path.join(staging, 'shared'));
  await copyTree(path.join(root, 'resources'), path.join(staging, 'resources'));
  await fs.copyFile(path.join(root, 'preload.js'), path.join(staging, 'preload.js'));
  for (const requiredAsset of ['renderer/index.html', 'renderer/styles.css', 'preload.js', 'main/electron-entry.js', 'resources/update-config.json']) {
    if (!(await exists(path.join(staging, requiredAsset)))) throw new Error(`构建输入缺少必需文件：${requiredAsset}`);
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  // electron-builder 的 build 字段只能存在于开发目录 package.json，不能进入应用 package.json。
  delete packageJson.build;
  delete packageJson.devDependencies;
  await fs.writeFile(path.join(staging, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  const bridgePath = path.join(staging, 'main', 'ae-bridge.js');
  const bridgeSource = await fs.readFile(bridgePath);
  // Bridge/ExtendScript 运行时代码必须保持原样；它不是 Node/Renderer 代码。
  const targets = [path.join(staging, 'renderer'), path.join(staging, 'main')];
  for (const directory of targets) {
    const sourceDirectory = directory === path.join(staging, 'renderer')
      ? path.join(root, 'renderer')
      : path.join(root, 'main');
    const output = `${directory}.obfuscated`;
    await fs.rm(output, { recursive: true, force: true });
    await run([directory, '--output', output, '--config', path.join(root, 'scripts', 'obfuscator.config.json'), '--exclude', '**/ae-bridge.js']);
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rename(output, directory);
    // javascript-obfuscator 的目录模式只复制 JavaScript；恢复 HTML、CSS、图标等运行时资源。
    await restoreNonJavaScriptFiles(sourceDirectory, directory);
  }
  // ExtendScript ES3 桥接文本必须保持原样，不能接受 Node/浏览器 JS 混淆器变换。
  await fs.writeFile(bridgePath, bridgeSource);
  // preload 的 API 名称是安全契约，不做混淆；它只暴露白名单 contextBridge 方法。
  console.log(`Prepared obfuscated staging tree: ${staging}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
