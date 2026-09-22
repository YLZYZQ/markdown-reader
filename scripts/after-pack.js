'use strict';

const path = require('node:path');
const { writeExecutableMetadata } = require('./windows-release');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const productName = context.packager.appInfo.productName;
  const executablePath = path.join(context.appOutDir, `${productName}.exe`);
  writeExecutableMetadata(executablePath, context.packager.appInfo);
};
