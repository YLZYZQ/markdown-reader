const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const packageJson = require(path.join(projectDir, 'package.json'));
const productName = packageJson.build.productName;
const electronDist = path.join(projectDir, 'node_modules', 'electron', 'dist');
const rceditExecutable = path.join(projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
const iconPath = path.join(projectDir, 'build', 'icon.ico');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-portable-'));
const portableRoot = path.join(temporaryRoot, productName);
const releaseDir = path.join(projectDir, 'release');
const artifactName = `${productName}-Portable-${packageJson.version}.zip`;
const artifactPath = path.join(releaseDir, artifactName);

const appFiles = [
  'main.js',
  'preload.js',
  'package.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'THIRD_PARTY_LICENSES.md',
  'lib',
  'renderer',
];

try {
  fs.cpSync(electronDist, portableRoot, { recursive: true });

  const defaultApp = path.join(portableRoot, 'resources', 'default_app.asar');
  fs.rmSync(defaultApp, { force: true });

  const portableApp = path.join(portableRoot, 'resources', 'app');
  fs.mkdirSync(portableApp, { recursive: true });
  for (const relativePath of appFiles) {
    fs.cpSync(
      path.join(projectDir, relativePath),
      path.join(portableApp, relativePath),
      { recursive: true },
    );
  }

  fs.renameSync(
    path.join(portableRoot, 'electron.exe'),
    path.join(portableRoot, `${productName}.exe`),
  );
  const executablePath = path.join(portableRoot, `${productName}.exe`);
  const rceditArgs = [
    executablePath,
    '--set-icon', iconPath,
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'CompanyName', productName,
    '--set-version-string', 'InternalName', productName,
    '--set-version-string', 'OriginalFilename', `${productName}.exe`,
    '--set-file-version', packageJson.version,
    '--set-product-version', packageJson.version,
  ];
  const rceditResult = spawnSync(rceditExecutable, rceditArgs, { stdio: 'inherit' });
  if (rceditResult.error) throw rceditResult.error;
  if (rceditResult.status !== 0) {
    process.exitCode = rceditResult.status || 1;
    return;
  }
  fs.writeFileSync(path.join(portableRoot, 'portable-mode'), '1\n');
  fs.writeFileSync(
    path.join(portableRoot, '使用说明.txt'),
    [
      'Markdown阅读器（免安装版）',
      '',
      '1. 请先完整解压 ZIP 文件。',
      `2. 双击 ${productName}.exe 启动。`,
      '3. 程序数据保存在当前目录的 data 文件夹中。',
      '',
      '本程序暂未使用商业代码签名证书。开启 Windows 智能应用控制的设备仍可能阻止运行。',
      '',
    ].join('\r\n'),
    'utf8',
  );

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.rmSync(artifactPath, { force: true });
  // 必须用 Windows 自带的 bsdtar：Git Bash 环境下 PATH 里的 MSYS GNU tar
  // 会把 `C:\...` 参数解析成远程主机（报 "Cannot connect to C:"）。
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(
    systemTar,
    ['-a', '-c', '-f', artifactPath, '-C', temporaryRoot, productName],
    { stdio: 'inherit' },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return;
  }

  console.log(`Portable package written to ${artifactPath}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
