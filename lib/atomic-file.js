'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Commit a complete file in one rename. A failed write never truncates the old
// document. Symbolic links keep pointing to their original target; hard links
// cannot retain their shared inode when one directory entry is replaced.
async function writeDocumentAtomically(targetPath, content, fileSystem = fs.promises) {
  let destination = path.resolve(targetPath);
  let existing;
  try {
    existing = await fileSystem.lstat(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing?.isSymbolicLink()) {
    destination = await fileSystem.realpath(destination);
    existing = await fileSystem.stat(destination);
  }

  const temporary = path.join(path.dirname(destination), `.md-reader-${crypto.randomUUID()}.tmp`);
  let handle;
  let ownsTemporary = false;
  try {
    handle = await fileSystem.open(temporary, 'wx', existing ? 0o600 : 0o666);
    ownsTemporary = true;
    await handle.writeFile(content, 'utf8');
    if (existing) await handle.chmod(existing.mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporary, destination);
    ownsTemporary = false;
  } catch (error) {
    if (handle) {
      try { await handle.close(); }
      catch (closeError) { error.closeError = closeError; }
    }
    if (ownsTemporary) {
      try {
        try { await fileSystem.unlink(temporary); }
        catch (cleanupError) {
          // Windows refuses to unlink a temporary file after read-only mode
          // has been copied from the old document. Only change our own file.
          if (!['EPERM', 'EACCES'].includes(cleanupError.code)) throw cleanupError;
          await fileSystem.chmod(temporary, 0o600);
          await fileSystem.unlink(temporary);
        }
      }
      catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

module.exports = { writeDocumentAtomically };
