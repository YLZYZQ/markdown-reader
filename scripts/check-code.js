'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ELECTRON_TESTS, unitTestFiles } = require('./test-all');

const projectDir = path.resolve(__dirname, '..');
const excludedDirectories = new Set(['node_modules', 'vendor', 'generated', 'tui-editor']);

function collectJavaScript(directory) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(projectDir, directory), { withFileTypes: true })) {
    const relativePath = path.posix.join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      result.push(...collectJavaScript(relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(relativePath);
    }
  }
  return result;
}

function sourceFiles() {
  return [
    'main.js', 'preload.js', 'build-bundle.js',
    ...['lib', 'renderer', 'scripts'].flatMap(collectJavaScript),
    ...unitTestFiles(),
    ...ELECTRON_TESTS,
  ].sort();
}

function checkCode() {
  const files = sourceFiles();
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: projectDir,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`Syntax check failed: ${file}`);
      return result.status || 1;
    }
  }
  console.log(`JavaScript syntax OK: ${files.length} project files checked (vendor, generated files, and probes excluded).`);
  return 0;
}

if (require.main === module) process.exitCode = checkCode();

module.exports = { sourceFiles, checkCode };
