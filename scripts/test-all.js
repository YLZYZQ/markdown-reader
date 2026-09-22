'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
// Keep the release gate explicit: ad-hoc probes and screenshots are not regressions.
const ELECTRON_TESTS = Object.freeze([
  'test/smoke-electron.js',
  'test/print-pipeline.electron.js',
  'test/reading-electron.js',
  'test/search-electron.js',
  'test/link-electron.js',
  'test/close-electron.js',
  'test/multi-window-electron.js',
  'test/sidebar-electron.js',
  'test/help-electron.js',
  'test/menu-language-electron.js',
  'test/document-lifecycle-electron.js',
  'test/recovery-electron.js',
]);

function unitTestFiles() {
  return fs.readdirSync(path.join(projectDir, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => `test/${name}`);
}

function createSteps(electronExecutable) {
  return [
    { name: 'JavaScript syntax', command: process.execPath, args: ['scripts/check-code.js'] },
    { name: 'Open-source notices', command: process.execPath, args: ['scripts/check-open-source-notices.js'] },
    { name: 'Unit tests', command: process.execPath, args: ['--test', ...unitTestFiles()] },
    ...ELECTRON_TESTS.map((file) => ({ name: file, command: electronExecutable, args: [file] })),
  ];
}

function runSteps(steps, spawn = spawnSync, log = console.log) {
  const env = { ...process.env };
  // Some developer shells set this globally; Electron regressions need the GUI runtime.
  delete env.ELECTRON_RUN_AS_NODE;
  for (const step of steps) {
    log(`\nRunning ${step.name}`);
    const result = spawn(step.command, step.args, { cwd: projectDir, env, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      log(`Failed: ${step.name}: ${result.error?.message || result.signal || `exit ${result.status}`}`);
      return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    }
  }
  log('\nAll release checks passed.');
  return 0;
}

if (require.main === module) {
  process.exitCode = runSteps(createSteps(require('electron')));
}

module.exports = { ELECTRON_TESTS, unitTestFiles, createSteps, runSteps };
