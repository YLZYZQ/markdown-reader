'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const projectDir = path.resolve(__dirname, '..');
  const productName = context.packager.appInfo.productName;
  const version = context.packager.appInfo.version;
  const executablePath = path.join(context.appOutDir, `${productName}.exe`);
  const rceditExecutable = path.join(projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  const args = [
    executablePath,
    '--set-icon', path.join(projectDir, 'build', 'icon.ico'),
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'InternalName', productName,
    '--set-version-string', 'OriginalFilename', `${productName}.exe`,
    '--set-file-version', version,
    '--set-product-version', version,
  ];

  const result = spawnSync(rceditExecutable, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rcedit failed for ${executablePath} (${result.status})`);
  }
};
