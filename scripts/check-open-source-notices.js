'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectDir = path.resolve(__dirname, '..');
const packageJson = require(path.join(projectDir, 'package.json'));
const packageLock = require(path.join(projectDir, 'package-lock.json'));
const noticePath = path.join(projectDir, 'THIRD_PARTY_NOTICES.md');
const policyPath = path.join(projectDir, 'docs', 'open-source.md');
const readmePath = path.join(projectDir, 'README.md');
const runtimeInventoryPath = path.join(projectDir, 'THIRD_PARTY_LICENSES.md');
const portableBuildScriptPath = path.join(projectDir, 'scripts', 'build-windows-portable.js');
const notice = fs.readFileSync(noticePath, 'utf8');
const policy = fs.readFileSync(policyPath, 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');
const runtimeInventory = fs.readFileSync(runtimeInventoryPath, 'utf8');
const portableBuildScript = fs.readFileSync(portableBuildScriptPath, 'utf8');
const errors = [];

const runtimeInventoryCheck = spawnSync(process.execPath, [
  path.join(__dirname, 'update-third-party-license-inventory.js'),
  '--check',
], { stdio: 'inherit' });
if (runtimeInventoryCheck.error) {
  errors.push(`Runtime inventory check failed: ${runtimeInventoryCheck.message}`);
} else if (runtimeInventoryCheck.status !== 0) {
  errors.push('Runtime dependency license inventory is stale or invalid');
}

const markerMatch = notice.match(/<!-- direct-dependencies:start -->([\s\S]*?)<!-- direct-dependencies:end -->/);
if (!markerMatch) {
  errors.push('THIRD_PARTY_NOTICES.md is missing direct-dependencies markers');
}

const rows = markerMatch
  ? markerMatch[1].split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, '')))
  : [];

const directDependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};
const noticedNames = new Set();

for (const row of rows) {
  const [scope, name, version, license, upstream, usage] = row;
  if (!scope || !name || !version || !license || !upstream || !usage) {
    errors.push(`Incomplete notice row: ${JSON.stringify(row)}`);
    continue;
  }
  if (!['运行时', '构建工具'].includes(scope)) {
    errors.push(`${name}: invalid scope "${scope}"`);
  }
  if (!/^[A-Za-z0-9_.@/-]+$/.test(name)) {
    errors.push(`${name}: invalid package name`);
  }
  noticedNames.add(name);
  if (!Object.hasOwn(directDependencies, name)) {
    errors.push(`${name}: listed in notices but absent from package.json`);
    continue;
  }
  const lockEntry = packageLock.packages[`node_modules/${name}`];
  if (!lockEntry) {
    errors.push(`${name}: absent from package-lock.json`);
    continue;
  }
  if (version !== lockEntry.version) {
    errors.push(`${name}: notice version ${version} != lock version ${lockEntry.version}`);
  }
  if (license !== lockEntry.license) {
    errors.push(`${name}: notice license ${license} != lock license ${lockEntry.license}`);
  }
  if (!/^https:\/\/github\.com\//.test(upstream)) {
    errors.push(`${name}: upstream must be a GitHub HTTPS URL`);
  }
}

for (const name of Object.keys(directDependencies)) {
  if (!noticedNames.has(name)) {
    errors.push(`${name}: direct dependency is missing from THIRD_PARTY_NOTICES.md`);
  }
}

if (packageJson.license !== 'MIT') {
  errors.push('Project license changed; update THIRD_PARTY_NOTICES.md and docs/open-source.md');
}
if (!notice.includes('本仓库没有复制或引用任何闭源商业产品代码')) {
  errors.push('THIRD_PARTY_NOTICES.md is missing the closed-source non-reference statement');
}
if (!notice.includes('package-lock.json')) {
  errors.push('THIRD_PARTY_NOTICES.md must name package-lock.json as the transitive dependency source');
}
if (!notice.includes('npm run notices:update') || !notice.includes('npm run notices:check')) {
  errors.push('THIRD_PARTY_NOTICES.md must document both notice update and check commands');
}
if (!notice.includes('Permission is hereby granted')) {
  errors.push('THIRD_PARTY_NOTICES.md must include the MIT permission notice');
}
if (runtimeInventory.includes('UNKNOWN')) {
  errors.push('THIRD_PARTY_LICENSES.md contains UNKNOWN licenses');
}
if (!readme.includes('THIRD_PARTY_LICENSES.md')) {
  errors.push('README.md must link to THIRD_PARTY_LICENSES.md');
}
for (const distributedNotice of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.md']) {
  if (!packageJson.build.files.includes(distributedNotice)) {
    errors.push(`${distributedNotice}: missing from electron-builder files`);
  }
  if (!portableBuildScript.includes(`'${distributedNotice}'`)) {
    errors.push(`${distributedNotice}: missing from portable package files`);
  }
}
if (!readme.includes('THIRD_PARTY_NOTICES.md')) {
  errors.push('README.md must link to THIRD_PARTY_NOTICES.md');
}
for (const requiredPolicy of [
  '事实源',
  '变更流程',
  '发布要求',
  '体验接近成熟商业产品',
]) {
  if (!policy.includes(requiredPolicy)) {
    errors.push(`docs/open-source.md is missing required section/statement: ${requiredPolicy}`);
  }
}

if (errors.length) {
  console.error('Open-source notice check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Open-source notices OK: ${rows.length} direct dependencies verified.`);
}
