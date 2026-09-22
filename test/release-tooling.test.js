'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const packageJson = require('../package.json');
const { release, metadataArguments, assertNonEmptyArtifact } = require('../scripts/windows-release');
const { sourceFiles } = require('../scripts/check-code');
const { ELECTRON_TESTS, createSteps, runSteps } = require('../scripts/test-all');

test('Windows release metadata uses configured product, icon, and version', () => {
  const args = metadataArguments('app.exe');
  for (const key of ['FileDescription', 'ProductName', 'CompanyName', 'InternalName']) {
    assert.equal(args[args.indexOf(key) + 1], packageJson.build.productName);
  }
  assert.equal(args[args.indexOf('--set-icon') + 1], path.resolve(__dirname, '..', packageJson.build.win.icon));
  assert.equal(args[args.indexOf('OriginalFilename') + 1], `${packageJson.build.productName}.exe`);
  assert.equal(args[args.indexOf('--set-product-version') + 1], packageJson.version);
  assert.equal(release.installerName, `${packageJson.build.productName}-Setup-${packageJson.version}.exe`);
  assert.equal(release.portableName, `${packageJson.build.productName}-Portable-${packageJson.version}.zip`);
  assert.equal(metadataArguments('app.exe', { productName: 'Custom', version: '2.0.0' }).at(-1), '2.0.0');
});

test('release gate includes every registered Electron regression and uses direct executables', () => {
  const registered = Object.values(packageJson.scripts)
    .filter((command) => command.startsWith('electron test/'))
    .map((command) => command.slice('electron '.length));
  assert.deepEqual([...ELECTRON_TESTS].sort(), [...new Set([
    ...registered,
    'test/document-lifecycle-electron.js',
    'test/recovery-electron.js',
  ])].sort());
  const steps = createSteps('local-electron.exe');
  assert.equal(steps[2].command, process.execPath);
  assert.equal(steps[2].args[0], '--test');
  assert.ok(steps[2].args.includes('test/release-tooling.test.js'));
  assert.ok(steps.slice(3).every((step) => step.command === 'local-electron.exe'));
});

test('release gate stops at first failure, including spawn failure or signal', () => {
  for (const failure of [{ status: 3 }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn failed') }]) {
    const calls = [];
    const result = runSteps(createSteps('local-electron.exe'), (command, args, options) => {
      calls.push({ command, args, options });
      return calls.length === 2 ? failure : { status: 0 };
    }, () => {});
    assert.equal(calls.length, 2);
    assert.equal(result, failure.status === 3 ? 3 : 1);
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  }
});

test('syntax gate includes maintained source and regressions while excluding probes and bundles', () => {
  const files = sourceFiles();
  for (const file of ['main.js', 'preload.js', 'renderer/app.js', 'renderer/help.js', ...ELECTRON_TESTS]) {
    assert.ok(files.includes(file), file);
  }
  assert.equal(files.length, new Set(files).size);
  assert.ok(files.every((file) => !/tui-editor|probe-|audit-electron|typo-shot/.test(file)));
});

test('build artifact validation rejects missing, empty, and directory outputs', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-artifact-test-'));
  try {
    for (const extension of ['exe', 'zip']) {
      const artifact = path.join(temporaryRoot, `artifact.${extension}`);
      assert.throws(() => assertNonEmptyArtifact(artifact), { code: 'ENOENT' });
      fs.writeFileSync(artifact, '');
      assert.throws(() => assertNonEmptyArtifact(artifact), /non-empty file/);
      fs.writeFileSync(artifact, 'build output');
      assert.doesNotThrow(() => assertNonEmptyArtifact(artifact));
    }
    assert.throws(() => assertNonEmptyArtifact(temporaryRoot), /non-empty file/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
