'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDocumentAtomically } = require('../lib/atomic-file');

async function fixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'md-reader-atomic-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return { directory, target: path.join(directory, 'document.md') };
}

test('atomically replaces an existing document and preserves its permissions', async (t) => {
  const { directory, target } = await fixture(t);
  await fs.promises.writeFile(target, 'Original');
  await fs.promises.chmod(target, 0o640);
  const mode = (await fs.promises.stat(target)).mode & 0o7777;
  await writeDocumentAtomically(target, '# 更新后的文档\n');
  assert.equal(await fs.promises.readFile(target, 'utf8'), '# 更新后的文档\n');
  assert.equal((await fs.promises.stat(target)).mode & 0o7777, mode);
  assert.deepEqual(await fs.promises.readdir(directory), ['document.md']);
});

test('creates a new document and supports an intentionally empty document', async (t) => {
  const { directory, target } = await fixture(t);
  await writeDocumentAtomically(target, 'New content');
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'New content');
  await writeDocumentAtomically(target, '');
  assert.equal(await fs.promises.readFile(target, 'utf8'), '');
  assert.deepEqual(await fs.promises.readdir(directory), ['document.md']);
});

for (const stage of ['write', 'sync', 'rename']) {
  test(`${stage} failure preserves the original document and removes its own temporary file`, async (t) => {
    const { directory, target } = await fixture(t);
    await fs.promises.writeFile(target, 'Original');
    const failure = new Error(`Injected ${stage} failure`);
    const adapter = {
      ...fs.promises,
      async open(...args) {
        const handle = await fs.promises.open(...args);
        return {
          async writeFile(...writeArgs) {
            if (stage === 'write') {
              await handle.writeFile('Partial');
              throw failure;
            }
            return handle.writeFile(...writeArgs);
          },
          chmod: (...chmodArgs) => handle.chmod(...chmodArgs),
          sync: () => stage === 'sync' ? Promise.reject(failure) : handle.sync(),
          close: () => handle.close(),
        };
      },
      rename: (...args) => stage === 'rename' ? Promise.reject(failure) : fs.promises.rename(...args),
    };
    await assert.rejects(writeDocumentAtomically(target, 'Replacement', adapter), (error) => error === failure);
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'Original');
    assert.deepEqual(await fs.promises.readdir(directory), ['document.md']);
  });
}

test('a temporary filename collision never removes a file owned by another operation', async (t) => {
  const { directory, target } = await fixture(t);
  await fs.promises.writeFile(target, 'Original');
  let collisionPath;
  const adapter = {
    ...fs.promises,
    async open(temporary, flags, mode) {
      assert.equal(flags, 'wx');
      assert.equal(path.dirname(temporary), directory);
      collisionPath = temporary;
      await fs.promises.writeFile(temporary, 'Other operation');
      return fs.promises.open(temporary, flags, mode);
    },
  };
  await assert.rejects(writeDocumentAtomically(target, 'Replacement', adapter), { code: 'EEXIST' });
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'Original');
  assert.equal(await fs.promises.readFile(collisionPath, 'utf8'), 'Other operation');
  assert.equal((await fs.promises.readdir(directory)).length, 2);
});

test('follows a symbolic link without replacing the link itself', async (t) => {
  const { directory, target } = await fixture(t);
  const link = path.join(directory, 'link.md');
  await fs.promises.writeFile(target, 'Original');
  try { await fs.promises.symlink(target, link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Creating file symlinks requires Windows privilege on this host');
      return;
    }
    throw error;
  }
  await writeDocumentAtomically(link, 'Replacement');
  assert.equal((await fs.promises.lstat(link)).isSymbolicLink(), true);
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'Replacement');
  assert.deepEqual((await fs.promises.readdir(directory)).sort(), ['document.md', 'link.md']);
});

test('symbolic-link resolution commits beside the resolved target, including on hosts without symlink privilege', async (t) => {
  const { directory, target } = await fixture(t);
  await fs.promises.writeFile(target, 'Original');
  const link = path.join(directory, 'virtual-link.md');
  let resolved = false;
  const adapter = {
    ...fs.promises,
    async lstat(candidate) {
      assert.equal(candidate, link);
      return { isSymbolicLink: () => true };
    },
    async realpath(candidate) {
      assert.equal(candidate, link);
      resolved = true;
      return target;
    },
    async rename(temporary, destination) {
      assert.equal(destination, target);
      assert.equal(path.dirname(temporary), path.dirname(target));
      return fs.promises.rename(temporary, destination);
    },
  };
  await writeDocumentAtomically(link, 'Replacement', adapter);
  assert.equal(resolved, true);
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'Replacement');
  assert.deepEqual(await fs.promises.readdir(directory), ['document.md']);
});

test('failed commits clean up a read-only temporary file without changing the original', async (t) => {
  const { directory, target } = await fixture(t);
  await fs.promises.writeFile(target, 'Original');
  const failure = new Error('Injected rename failure');
  let cleanupAttempts = 0;
  const adapter = {
    ...fs.promises,
    rename: () => Promise.reject(failure),
    async unlink(temporary) {
      cleanupAttempts++;
      if (cleanupAttempts === 1) throw Object.assign(new Error('Read-only temporary'), { code: 'EPERM' });
      return fs.promises.unlink(temporary);
    },
    async chmod(temporary, mode) {
      assert.notEqual(temporary, target);
      assert.equal(mode, 0o600);
      return fs.promises.chmod(temporary, mode);
    },
  };
  await assert.rejects(writeDocumentAtomically(target, 'Replacement', adapter), (error) => error === failure);
  assert.equal(cleanupAttempts, 2);
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'Original');
  assert.deepEqual(await fs.promises.readdir(directory), ['document.md']);
});

test('syncs and closes the completed temporary file before committing it', async (t) => {
  const { target } = await fixture(t);
  const calls = [];
  const adapter = {
    ...fs.promises,
    async open(...args) {
      const handle = await fs.promises.open(...args);
      return {
        async writeFile(...writeArgs) { calls.push('write'); await handle.writeFile(...writeArgs); },
        async sync() { calls.push('sync'); await handle.sync(); },
        async close() { calls.push('close'); await handle.close(); },
      };
    },
    async rename(...args) { calls.push('rename'); await fs.promises.rename(...args); },
  };
  await writeDocumentAtomically(target, 'New content', adapter);
  assert.deepEqual(calls, ['write', 'sync', 'close', 'rename']);
});
