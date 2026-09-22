'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { release, assertNonEmptyArtifact } = require('./windows-release');

const { projectDir, releaseDir, electronDist } = release;
const temporaryOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-build-'));
const artifactBaseName = release.installerName;

const electronBuilderCli = path.join(
  projectDir,
  'node_modules',
  'electron-builder',
  'cli.js',
);

const buildArgs = [
  electronBuilderCli,
  '--win',
  'nsis',
  '--x64',
  `--config.directories.output=${temporaryOutput}`,
  `--config.electronDist=${electronDist}`,
];

const buildEnvironment = {
  ...process.env,
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
  CSC_IDENTITY_AUTO_DISCOVERY:
    process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false',
};

try {
  const result = spawnSync(process.execPath, buildArgs, {
    cwd: projectDir,
    env: buildEnvironment,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return;
  }

  // Validate this build's output before copying; a stale release must not mask failure.
  assertNonEmptyArtifact(path.join(temporaryOutput, artifactBaseName));
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const fileName of [artifactBaseName, `${artifactBaseName}.blockmap`]) {
    const sourcePath = path.join(temporaryOutput, fileName);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, path.join(releaseDir, fileName));
    }
  }

  console.log(`Installer written to ${path.join(releaseDir, artifactBaseName)}`);
} finally {
  fs.rmSync(temporaryOutput, { recursive: true, force: true });
}
