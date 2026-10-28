// dsh-office-bridge smoke tests (zero-dependency, node --test).
// Run: node --test test/smoke.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  computeUrlToken,
  fileSignature,
  isAllowedCallbackUrl,
  parseLocalAction,
} from '../host/index.js';

// --- urlToken 生成 / 校验 ----------------------------------------------------

test('computeUrlToken is deterministic for identical inputs', () => {
  const secret = randomBytes(16).toString('hex');
  const a = computeUrlToken(secret, 'D:/tmp/a.xlsx', 12345.678);
  const b = computeUrlToken(secret, 'D:/tmp/a.xlsx', 12345.678);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('computeUrlToken changes when mtime or path changes', () => {
  const secret = randomBytes(16).toString('hex');
  const base = computeUrlToken(secret, 'D:/tmp/a.xlsx', 1);
  assert.notEqual(base, computeUrlToken(secret, 'D:/tmp/a.xlsx', 2));
  assert.notEqual(base, computeUrlToken(secret, 'D:/tmp/b.xlsx', 1));
});

test('computeUrlToken matches a hand-rolled HMAC-SHA256', () => {
  const secret = 's3cret';
  const token = computeUrlToken(secret, 'D:/x/docx.docx', 42);
  const expected = createHmac('sha256', secret).update('D:/x/docx.docx:42').digest('hex');
  assert.equal(token, expected);
  // verify-path: equality check against the recomputed token accepts valid, rejects forged
  const forged = createHmac('sha256', 'wrong').update('D:/x/docx.docx:42').digest('hex');
  assert.notEqual(token, forged);
});

// --- fileKey / 本地服务路径解析 ---------------------------------------------

test('parseLocalAction splits action and fileKey', () => {
  assert.deepEqual(parseLocalAction('/download/abc123'), { action: 'download', fileKey: 'abc123' });
  assert.deepEqual(parseLocalAction('/callback/def456'), { action: 'callback', fileKey: 'def456' });
});

test('parseLocalAction rejects malformed paths', () => {
  assert.equal(parseLocalAction('/download'), null);
  assert.equal(parseLocalAction('/'), null);
  assert.equal(parseLocalAction(''), null);
  assert.equal(parseLocalAction('/a/b/c'), null);
  assert.equal(parseLocalAction(undefined), null);
});

// --- 限域判断（callback body.url allowlist）---------------------------------

test('isAllowedCallbackUrl accepts http(s) URLs under the configured base', () => {
  const base = 'http://127.0.0.1';
  assert.equal(isAllowedCallbackUrl('http://127.0.0.1/cache/files/abc/output.xlsx', base), true);
  assert.equal(isAllowedCallbackUrl('https://127.0.0.1/cache/files/abc/output.xlsx', 'https://127.0.0.1'), true);
  assert.equal(isAllowedCallbackUrl('https://127.0.0.1/x', base), false); // scheme must match
});

test('isAllowedCallbackUrl rejects non-http schemes', () => {
  assert.equal(isAllowedCallbackUrl('file:///C:/Windows/win.ini', 'http://127.0.0.1'), false);
  assert.equal(isAllowedCallbackUrl('ftp://127.0.0.1/x', 'http://127.0.0.1'), false);
  assert.equal(isAllowedCallbackUrl('', 'http://127.0.0.1'), false);
  assert.equal(isAllowedCallbackUrl(undefined, 'http://127.0.0.1'), false);
});

test('isAllowedCallbackUrl rejects URLs outside the configured base', () => {
  assert.equal(isAllowedCallbackUrl('http://192.168.1.5/secret', 'http://127.0.0.1'), false);
  assert.equal(isAllowedCallbackUrl('http://127.0.0.1.evil.io/x', 'http://127.0.0.1'), false);
  assert.equal(isAllowedCallbackUrl('http://localhost/x', 'http://127.0.0.1'), false);
});

test('isAllowedCallbackUrl honors custom dsBaseUrl with trailing slash', () => {
  assert.equal(isAllowedCallbackUrl('http://127.0.0.1:8080/a', 'http://127.0.0.1:8080/'), true);
  assert.equal(isAllowedCallbackUrl('http://127.0.0.1:9999/a', 'http://127.0.0.1:8080/'), false);
});

// --- fileSignature（watch hub 签名过滤纯函数）--------------------------------

test('fileSignature is null for missing stat and stable for equal stats', () => {
  assert.equal(fileSignature(null), null);
  const s1 = { size: 100, mtimeMs: 5 };
  const s2 = { size: 100, mtimeMs: 5 };
  assert.equal(fileSignature(s1), fileSignature(s2));
  assert.notEqual(fileSignature(s1), fileSignature({ size: 101, mtimeMs: 5 }));
});
