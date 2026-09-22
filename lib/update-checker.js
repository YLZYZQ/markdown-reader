'use strict';

// GitHub 发布信息检查。只读取公开 Releases API，不下载或执行更新包。

const RELEASE_API_URL = 'https://api.github.com/repos/YLZYZQ/markdown-reader/releases/latest';
const RELEASES_PAGE_URL = 'https://github.com/YLZYZQ/markdown-reader/releases';

class UpdateCheckError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'UpdateCheckError';
    this.status = status;
  }
}

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:$|[^0-9])/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`无法比较的版本号: ${!a ? left : right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

function normalizeReleaseNotes(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 600);
}

function extractLatestRelease(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UpdateCheckError('GitHub 返回的发布信息格式无效');
  }
  if (payload.draft === true || payload.prerelease === true) {
    throw new UpdateCheckError('GitHub 最新发布不是稳定版本');
  }
  const version = parseVersion(payload.tag_name || payload.name);
  if (!version) throw new UpdateCheckError('GitHub 发布缺少有效版本号');
  return {
    version: version.join('.'),
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : `v${version.join('.')}`,
    notes: normalizeReleaseNotes(payload.body),
    releasesUrl: RELEASES_PAGE_URL
  };
}

async function fetchLatestRelease({
  fetchImpl = globalThis.fetch,
  apiUrl = RELEASE_API_URL,
  timeoutMs = 8000,
  signal: externalSignal
} = {}) {
  if (typeof fetchImpl !== 'function') throw new UpdateCheckError('当前运行环境不支持网络请求');
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(apiUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'MarkdownReader-Update-Check'
        }
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new UpdateCheckError('更新检查超时');
      throw new UpdateCheckError(`无法访问 GitHub: ${error?.message || error}`);
    }

    if (!response.ok) {
      const hint = response.status === 403 || response.status === 429 ? '，GitHub API 请求频率可能已达上限' : '';
      throw new UpdateCheckError(`GitHub 返回 ${response.status}${hint}`, { status: response.status });
    }
    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      throw new UpdateCheckError('GitHub 返回的内容不是有效 JSON');
    }
    return extractLatestRelease(payload);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

module.exports = {
  RELEASE_API_URL,
  RELEASES_PAGE_URL,
  UpdateCheckError,
  compareVersions,
  extractLatestRelease,
  fetchLatestRelease,
  isNewerVersion,
  normalizeReleaseNotes,
  parseVersion
};
