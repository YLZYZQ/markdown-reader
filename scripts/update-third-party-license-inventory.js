'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const outputPath = path.join(projectDir, 'THIRD_PARTY_LICENSES.md');
const packageLock = require(path.join(projectDir, 'package-lock.json'));

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function normalizeLicense(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.type === 'string') return value.type;
  return 'UNKNOWN';
}

function detectLicenseFromFiles(packageDir) {
  const licenseNames = new Set(['license', 'license.md', 'licence', 'licence.md', 'copying']);
  const licenseFile = fs.readdirSync(packageDir, { withFileTypes: true })
    .find((entry) => entry.isFile() && licenseNames.has(entry.name.toLowerCase()));
  if (!licenseFile) return null;

  const text = fs.readFileSync(path.join(packageDir, licenseFile.name), 'utf8').slice(0, 4096);
  if (/MIT License/i.test(text)) return 'MIT';
  if (/Apache License\s*.*Version 2/i.test(text)) return 'Apache-2.0';
  if (/GNU General Public License/i.test(text)) return 'GPL';
  if (/Mozilla Public License\s*.*2/i.test(text)) return 'MPL-2.0';
  if (/BSD 3-Clause License/i.test(text)) return 'BSD-3-Clause';
  if (/BSD 2-Clause License/i.test(text)) return 'BSD-2-Clause';
  if (/ISC License/i.test(text)) return 'ISC';
  if (/Unlicense/i.test(text)) return 'Unlicense';
  return null;
}

function collectRuntimeDependencies() {
  const npmCli = findNpmCli();
  const npmArgs = [
    'ls',
    '--omit=dev',
    '--all',
    '--parseable',
    '--long',
  ];
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...npmArgs], {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
    })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
      shell: process.platform === 'win32',
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
    });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ls failed (${result.status}): ${result.stderr.trim()}`);
  }

  const dependencies = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line || !line.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const separator = line.lastIndexOf(':');
    if (separator <= projectDir.length) continue;

    const packageDir = line.slice(0, separator);
    if (!packageDir.startsWith(projectDir + path.sep)) continue;
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    const installed = require(packageJsonPath);
    const relativeKey = path.relative(projectDir, packageDir).replace(/\\/g, '/');
    const lockEntry = packageLock.packages[relativeKey] || {};
    const key = `${installed.name}@${installed.version}`;
    if (!dependencies.has(key)) {
      dependencies.set(key, {
        name: installed.name,
        version: installed.version,
        license: normalizeLicense(
          installed.license ||
          lockEntry.license ||
          detectLicenseFromFiles(packageDir),
        ),
      });
    }
  }
  return [...dependencies.values()]
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }));
}

function renderInventory(dependencies) {
  const rows = dependencies.map((dependency) => {
    const name = dependency.name.replace(/\|/g, '\\|');
    const license = dependency.license.replace(/\|/g, '\\|');
    return `| \`${name}\` | \`${dependency.version}\` | ${license} |`;
  });
  return [
    '# 运行时第三方依赖许可证清单',
    '',
    '此清单由 `npm run notices:update` 从当前生产依赖闭包自动生成。直接集成项目的代码来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。',
    '',
    '| 包名 | 版本 | 许可证 |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const dependencies = collectRuntimeDependencies();
  if (!dependencies.length) throw new Error('No runtime dependencies found');
  const unknownLicenses = dependencies.filter((dependency) => dependency.license === 'UNKNOWN');
  if (unknownLicenses.length) {
    throw new Error(`Unable to detect licenses: ${unknownLicenses.map((item) => `${item.name}@${item.version}`).join(', ')}`);
  }

  const rendered = renderInventory(dependencies);
  if (check) {
    const current = fs.readFileSync(outputPath, 'utf8');
    if (current !== rendered) {
      console.error(`Runtime dependency license inventory is stale (${dependencies.length} dependencies).`);
      console.error('Run: npm run notices:update');
      process.exitCode = 1;
    } else {
      console.log(`Runtime dependency licenses OK: ${dependencies.length} entries verified.`);
    }
    return;
  }

  fs.writeFileSync(outputPath, rendered, 'utf8');
  console.log(`Runtime dependency license inventory written: ${outputPath} (${dependencies.length} entries)`);
}

if (require.main === module) main();
