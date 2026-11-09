import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkMarketplace, checkMetadata, formatIssue } from '../scripts/check-plugin-metadata.mjs';

const base = () => ({
  schemaVersion: 1,
  authors: [{ name: 'Fixture contributors' }],
  requirements: { dfsc: '>=0.6.0 <0.7.0', external: [] },
});
const errors = value => checkMetadata(value).filter(issue => issue.level === 'error');
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/check-plugin-metadata.mjs');
async function fixture(t, bytes) {
  const root = await mkdtemp(join(tmpdir(), 'dfsc-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'plugins/fixture-plugin'), { recursive: true });
  await writeFile(join(root, 'registry.json'), JSON.stringify({ plugins: [{ id: 'fixture-plugin' }] }));
  if (bytes !== undefined) await writeFile(join(root, 'plugins/fixture-plugin/dfsc.plugin.json'), bytes);
  return root;
}
function cli(root, github = false) {
  return spawnSync(process.execPath, [script, '--root', root], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: String(github) },
  });
}

test('complete declarations and explicit no-extra-dependencies need no reminders', () => {
  assert.deepEqual(checkMetadata(base()), []);
});

test('missing legacy declarations warn instead of failing', () => {
  assert.deepEqual(checkMetadata(undefined).map(issue => issue.level), ['warning']);
  for (const value of [{ schemaVersion: 1 }, { schemaVersion: 1, authors: [], requirements: {} }]) {
    assert.equal(checkMetadata(value).length, 3);
    assert.equal(errors(value).length, 0);
  }
});

test('an omitted external list is different from an explicit empty list', () => {
  const value = base();
  delete value.requirements.external;
  assert.match(checkMetadata(value)[0].message, /external is not declared/u);
  assert.equal(errors(value).length, 0);
  value.requirements.external = [];
  assert.deepEqual(checkMetadata(value), []);
});

test('authors do not fall back to maintainers or repository identities', () => {
  const value = base();
  delete value.authors;
  value.maintainers = [{ name: 'Packaging maintainer' }];
  const issues = checkMetadata(value);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /authors is not declared/u);
});

test('author limits match host UTF-16, trim and control-character rules', () => {
  for (const name of ['x'.repeat(160), '😀'.repeat(80), '\ufeff Fixture author \ufeff']) {
    assert.equal(errors({ ...base(), authors: [{ name }] }).length, 0);
  }
  for (const authors of [null, {}, 'author', [null], [{}], [{ name: '' }], [{ name: '\ufeff' }],
    [{ name: 1 }], [{ name: 'two\nlines' }], [{ name: '😀'.repeat(81) }],
    Array.from({ length: 9 }, () => ({ name: 'Fixture' }))]) {
    assert.ok(errors({ ...base(), authors }).length, JSON.stringify(authors));
  }
  assert.deepEqual(checkMetadata({ ...base(), authors: Array.from({ length: 8 }, () => ({ name: 'Fixture' })) }), []);
});

test('version ranges use the same npm semver grammar as the host', () => {
  for (const dfsc of ['>=0.6.0 <0.7.0', '^0.6.0', '~0.6.1', '0.6.x', '0.6.0 - 0.7.0',
    '>=0.6.0 <0.7.0 || >=1.0.0 <2', '>=0.7.0-beta.1', '*', ' v0.6.0 ']) {
    assert.deepEqual(checkMetadata({ ...base(), requirements: { dfsc, external: [] } }), [], dfsc);
  }
  for (const dfsc of [null, true, 6, '', ' ', '\ufeff', 'latest', '>=banana', '最新版',
    '>=0.6.0\n<0.7.0', 'x'.repeat(129), '>=999999999999999999.0.0']) {
    assert.ok(errors({ ...base(), requirements: { dfsc, external: [] } }).length, String(dfsc));
  }
});

test('valid required and optional dependencies accept bounded fields without executing anything', () => {
  const external = [
    { name: 'Node.js', description: 'Needed to run a companion service.', url: 'https://nodejs.org/', optional: false },
    { name: 'FFmpeg', optional: true },
    { name: 'Runtime with omitted optional flag' },
    { name: 'x'.repeat(160), description: '😀'.repeat(256) },
  ];
  assert.deepEqual(checkMetadata({ ...base(), requirements: { external, dfsc: '^0.6' } }), []);
  assert.equal(errors({ ...base(), requirements: { external: Array.from({ length: 12 }, () => ({ name: 'Runtime' })) } }).length, 0);
});

test('invalid dependency shapes, limits, unknown fields and URLs fail', () => {
  const invalid = [
    null, 'none', {}, Array.from({ length: 13 }, () => ({ name: 'Runtime' })),
    [null], [[]], [{}], [{ name: '' }], [{ name: 'two\nlines' }], [{ name: 'x'.repeat(161) }],
    [{ name: 'Runtime', description: '' }], [{ name: 'Runtime', description: 'x'.repeat(513) }],
    [{ name: 'Runtime', optional: 'false' }], [{ name: 'Runtime', optional: 0 }],
    [{ name: 'Runtime', optional: null }], [{ name: 'Runtime', command: 'never execute' }],
    ...['http://example.com', 'file:///private', 'javascript:alert(1)', 'data:text/plain,fixture',
      'https://fixture_user:fixture_secret@example.com', 'https://fixture_user@example.com',
      'https://', 'https://example.com/\n', 'https://example.com/' + 'x'.repeat(2048), null]
      .map(url => [{ name: 'Runtime', url }]),
  ];
  for (const external of invalid) {
    const issues = errors({ ...base(), requirements: { external } });
    assert.ok(issues.length, JSON.stringify(external));
    assert.ok(issues.every(issue => !issue.message.includes('fixture_secret')));
  }
});

test('invalid presentation and requirements objects fail without exposing contents', () => {
  for (const value of [null, [], true, {}, { schemaVersion: true }, { schemaVersion: 2 }]) {
    assert.ok(errors(value).length);
  }
  for (const requirements of [null, [], 'fixture_secret', { autoInstall: true }]) {
    const issues = errors({ ...base(), requirements });
    assert.ok(issues.length);
    assert.ok(issues.every(issue => !issue.message.includes('fixture_secret')));
  }
});

test('the checker reads the synced plugin, never rewrites author declarations or lock records', async t => {
  const text = '{ "schemaVersion": 1, "authors": [{"name":"Fixture"}], "requirements":{"dfsc":"^0.6","external":[]} }\r\n';
  const root = await fixture(t, text);
  const lock = '{"fixture":"untouched"}\n';
  await writeFile(join(root, 'registry.lock.json'), lock);
  assert.deepEqual(await checkMarketplace(root), { plugins: 1, issues: [] });
  const run = cli(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /"errors":0,"warnings":0/u);
  assert.equal(await readFile(join(root, 'plugins/fixture-plugin/dfsc.plugin.json'), 'utf8'), text);
  assert.equal(await readFile(join(root, 'registry.lock.json'), 'utf8'), lock);
});

test('CLI warnings pass for legacy plugins and surface in GitHub annotations', async t => {
  const root = await fixture(t);
  const run = cli(root, true);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /::warning file=plugins\/fixture-plugin\/dfsc\.plugin\.json/u);
  assert.match(run.stdout, /CONTRIBUTING\.md/u);
  assert.match(run.stdout, /"errors":0,"warnings":1/u);
});

test('CLI fails malformed declarations and does not echo secrets or raw payloads', async t => {
  const value = base();
  value.requirements.external = [{ name: 'Runtime', url: 'https://user:fixture_secret@example.com' }];
  const root = await fixture(t, JSON.stringify(value));
  const run = cli(root, true);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /::error file=/u);
  assert.doesNotMatch(run.stdout + run.stderr, /fixture_secret/u);
});

test('invalid JSON, encoding and oversized files fail instead of becoming missing declarations', async t => {
  for (const bytes of ['{fixture_secret', 'null', Buffer.from([0xff]), ' '.repeat(64 * 1024 + 1)]) {
    const root = await fixture(t, bytes);
    const result = await checkMarketplace(root);
    assert.equal(result.issues[0].level, 'error');
    assert.doesNotMatch(JSON.stringify(result), /fixture_secret/u);
  }
});

test('unsafe registry identifiers fail without following outside paths or logging raw content', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'registry.json'), JSON.stringify({ plugins: [{ id: '../fixture_secret' }] }));
  await assert.rejects(checkMarketplace(root), /Invalid plugin identifier/u);
  const run = cli(root, true);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout + run.stderr, /fixture_secret/u);
});

test('annotation formatting escapes workflow control characters', () => {
  const line = formatIssue({ level: 'warning', file: 'plugins/fixture,one/file:two',
    plugin: 'fixture', message: 'percent%\r\n::error::fixture' }, true);
  assert.match(line, /fixture%2Cone\/file%3Atwo/u);
  assert.match(line, /percent%25%0D%0A::error::fixture/u);
  assert.equal(line.split('\n').length, 1);
});
