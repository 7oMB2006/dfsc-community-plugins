import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, tokens, cosine, redact, clip } from '../../../plugins/memory-hub/server/text.mjs';

test('normalize folds whitespace and case', () => {
  assert.equal(normalize('  Build   Uses\tpnpm\n'), 'build uses pnpm');
  assert.equal(normalize(''), '');
});

test('tokens keeps latin words and splits CJK into bigrams', () => {
  const t = tokens('构建用 pnpm');
  assert.ok(t.includes('pnpm'), 'latin words stay whole');
  assert.ok(t.includes('构建'), 'CJK run of 3 keeps first bigram');
  assert.ok(t.includes('建用'), 'CJK run of 3 keeps second bigram');
  assert.ok(!t.includes('构建用'), 'CJK runs are not kept whole');
});

test('tokens lowercases latin and keeps single CJK characters', () => {
  assert.deepEqual(tokens('API'), ['api']);
  assert.deepEqual(tokens('构'), ['构'], 'a one-character query still matches');
});

test('tokens turns identifiers into words instead of punctuation soup', () => {
  assert.ok(tokens('run npm_ci --watch').includes('npm_ci'));
});

test('cosine is 1 for identical text and 0 for disjoint text', () => {
  assert.equal(cosine(tokens('alpha beta'), tokens('alpha beta')), 1);
  assert.equal(cosine(tokens('alpha'), tokens('beta')), 0);
  assert.equal(cosine([], tokens('alpha')), 0, 'empty vectors do not divide by zero');
});

test('cosine ranks partial overlap between the two extremes', () => {
  const value = cosine(tokens('alpha beta gamma'), tokens('alpha beta delta'));
  assert.ok(value > 0.4 && value < 1, `expected partial overlap, got ${value}`);
});

test('redact removes common credential shapes', () => {
  const out = redact('key sk-abcdef123456 and ghp_0123456789abcdef');
  assert.equal(out.redacted, 2);
  assert.ok(!out.text.includes('sk-abcdef123456'));
  assert.ok(!out.text.includes('ghp_0123456789abcdef'));
});

test('redact covers assignments, bearers, aws keys and private key blocks', () => {
  const cases = [
    'API_KEY=supersecretvalue',
    'Authorization: Bearer abcdefghijklmnop',
    'aws AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ];
  for (const text of cases) {
    const out = redact(text);
    assert.equal(out.redacted, 1, `expected one redaction for: ${text}`);
    assert.ok(out.text.includes('[redacted]'), `expected marker for: ${text}`);
  }
});

test('redact leaves ordinary prose alone', () => {
  const out = redact('构建用 pnpm，测试跑 node --test');
  assert.equal(out.redacted, 0);
  assert.equal(out.text, '构建用 pnpm，测试跑 node --test');
});

test('clip keeps short text and truncates long text within the budget', () => {
  assert.equal(clip('abc', 10), 'abc');
  const long = clip('abcdefghijk', 5);
  // 省略号也算预算：存储层直接依赖这个上限，不能靠「再多一个字符」越界。
  assert.equal(long.length, 5);
  assert.ok(long.endsWith('…'));
  assert.ok(long.startsWith('abcd'));
});
