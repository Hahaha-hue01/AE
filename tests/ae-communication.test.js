const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBridgeScript, escapeExtendScriptString, createMacDoScriptCommand } = require('../main/ae-bridge');
const { parseWindowsTasklist, parseMacPs, chooseAeInstallation } = require('../main/ae-process');
const { createAeRunner } = require('../main/ae-runner');

test('bridge uses ExtendScript ES3 evalFile and escapes paths', () => {
  const source = createBridgeScript({ scriptPath: 'C:\\临时\\a"b.jsx', resultPath: '/tmp/result.json', taskId: 'abc' });
  assert.match(source, /\$\.evalFile/);
  assert.match(source, /function \(\)/);
  assert.match(source, /replace\(\/\\\\\/g/);
  assert.match(source, /\{\\"taskId\\"/);
  assert.doesNotMatch(source, /=>|\blet\b|\bconst\b/);
  assert.equal(escapeExtendScriptString('a"b'), '"a\\"b"');
});

test('process parsers detect Windows and macOS AE entries', () => {
  assert.deepEqual(parseWindowsTasklist('"AfterFX.exe","1234","Console","1","123,456 K","Running","x","x"\n'), [{ image: 'AfterFX.exe', pid: 1234 }]);
  assert.equal(parseMacPs(' 123 /Applications/Adobe After Effects 2024.app/Contents/MacOS/After Effects Adobe After Effects 2024').length, 1);
});

test('installation selection prefers requested version and otherwise newest', () => {
  const list = [{ version: '2022', executable: 'a' }, { version: '2024', executable: 'b' }];
  assert.equal(chooseAeInstallation(list, '2022').executable, 'a');
  assert.equal(chooseAeInstallation(list).executable, 'b');
});

test('AEX is rejected before any process launch', async () => {
  const runner = createAeRunner({ fsApi: { mkdir: async () => {}, writeFile: async () => {}, access: async () => {}, rm: async () => {} } });
  await assert.rejects(() => runner.materializeScript({ type: 'aex', origin: 'external' }, '/tmp', null), { code: 'AE_SCRIPT_TYPE_UNSUPPORTED' });
});

test('Mac AppleScript command is escaped', () => {
  const command = createMacDoScriptCommand({ applicationName: 'Adobe After Effects 2024', bridgePath: '/tmp/a"b.jsx' });
  assert.match(command, /DoScript/);
  assert.match(command, /a\\"b/);
});

test('runner returns structured AE success through injected bridge transport', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-runner-test-'));
  const source = path.join(root, 'sample.jsx');
  await fs.writeFile(source, '"ok";');
  const runner = createAeRunner({
    tempRoot: root,
    processDetector: async () => [],
    installationResolver: async () => [{ version: '2024', executable: 'AfterFX.exe', appPath: 'Adobe After Effects 2024.app' }],
    transport: async ({ resultPath, taskId }) => fs.writeFile(resultPath, JSON.stringify({ taskId, ok: true, returnValue: 'ok', error: null })),
  });
  const result = await runner.execute({ script: { id: 'external-1', type: 'jsx', origin: 'external' }, managedPath: source });
  assert.equal(result.ok, true);
  assert.equal(result.returnValue, 'ok');
});

test('runner maps ExtendScript exception result to AE_SCRIPT_ERROR', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-runner-error-'));
  const source = path.join(root, 'bad.jsx');
  await fs.writeFile(source, 'throw new Error();');
  const runner = createAeRunner({
    tempRoot: root,
    processDetector: async () => [],
    installationResolver: async () => [{ version: '2024', executable: 'AfterFX.exe' }],
    transport: async ({ resultPath, taskId }) => fs.writeFile(resultPath, JSON.stringify({ taskId, ok: false, returnValue: '', error: { name: 'Error', message: 'syntax error', line: 3 } })),
  });
  await assert.rejects(() => runner.execute({ script: { id: 'external-2', type: 'jsx', origin: 'external' }, managedPath: source }), { code: 'AE_SCRIPT_ERROR' });
});
