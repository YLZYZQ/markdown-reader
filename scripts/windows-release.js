'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const packageJson = require(path.join(projectDir, 'package.json'));
const productName = packageJson.build.productName;
const version = packageJson.version;

const release = Object.freeze({
  projectDir,
  productName,
  version,
  executableName: `${productName}.exe`,
  installerName: `${productName}-Setup-${version}.exe`,
  portableName: `${productName}-Portable-${version}.zip`,
  releaseDir: path.join(projectDir, packageJson.build.directories.output),
  electronDist: path.join(projectDir, 'node_modules', 'electron', 'dist'),
  iconPath: path.join(projectDir, packageJson.build.win.icon),
  rceditExecutable: path.join(projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
});

function metadataArguments(executablePath, appInfo = release) {
  const name = appInfo.productName;
  return [
    executablePath,
    '--set-icon', release.iconPath,
    '--set-version-string', 'FileDescription', name,
    '--set-version-string', 'ProductName', name,
    '--set-version-string', 'CompanyName', name,
    '--set-version-string', 'InternalName', name,
    '--set-version-string', 'OriginalFilename', `${name}.exe`,
    '--set-file-version', appInfo.version,
    '--set-product-version', appInfo.version,
  ];
}

function writeExecutableMetadata(executablePath, appInfo = release) {
  const result = spawnSync(release.rceditExecutable, metadataArguments(executablePath, appInfo), {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rcedit failed for ${executablePath} (${result.signal || result.status})`);
  }
}

function assertNonEmptyArtifact(artifactPath) {
  const stat = fs.statSync(artifactPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Build artifact must be a non-empty file: ${artifactPath}`);
  }
}

module.exports = { release, metadataArguments, writeExecutableMetadata, assertNonEmptyArtifact };
