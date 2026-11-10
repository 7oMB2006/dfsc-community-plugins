import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMarketplace, checkPackage, formatIssue, imageHeader, MARKET_FILE_BYTES } from '../scripts/check-theme-pack.mjs';
import { parseThemeComposition } from '../scripts/theme-contract/theme-composition.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJmQAAAAASUVORK5CYII=', 'base64');
const manifest = { id: 'example-theme', version: '1.0.0', skills: [], commands: [], agents: [] };
const theme = () => ({
  schemaVersion: 2, name: 'Example', scheme: 'dark',
  colors: { bg: '#141414', side: '#0d0d0d', surface: '#1f1f1f', ink: '#e8e8e8',
    muted: '#a4a4a4', border: '#404040', code: '#101010', accent: '#64cbb2' },
  ui: { renderer: 'standard-v1' },
  background: { renderer: 'image-v1', source: 'background.png', accepts: ['image-v1'] },
});
const errors = result => result.issues.filter(issue => issue.level === 'error');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dfsc-theme-author-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = (file, value) => writeFile(join(root, file), JSON.stringify(value));
  await save('step.plugin.json', manifest);
  await save('dfsc.theme.json', theme());
  await writeFile(join(root, 'background.png'), pixel);
  return { root, save };
}

test('parser copy is pinned to the host source and its MIT license is included', async () => {
  const text = (await readFile(join(repository, 'scripts/theme-contract/theme-composition.mjs'), 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(text).digest('hex'), 'b3dbfac0c3ea726289cf121aa9f2d78dd5054a872a42770abdfb78f37cb1dfa2');
  assert.match(await readFile(join(repository, 'scripts/theme-contract/LICENSE'), 'utf8'), /MIT License/);
});

test('new image theme has independent UI, default background and explicit replacement', async t => {
  const f = await fixture(t), result = await checkPackage(f.root);
  assert.deepEqual(result.issues, []);
  assert.equal(result.composition.ui, 'standard-v1');
  assert.deepEqual(result.composition.accepts, ['image-v1']);
  for (const accepts of [undefined, []]) {
    const raw = theme();
    if (accepts === undefined) delete raw.background.accepts;
    else raw.background.accepts = accepts;
    await f.save('dfsc.theme.json', raw);
    const closed = await checkPackage(f.root);
    assert.deepEqual(closed.issues, []);
    assert.deepEqual(closed.composition.accepts, []);
  }
});

test('legacy packages remain valid but get an explicit closed-slot migration warning', async t => {
  const f = await fixture(t), raw = theme();
  delete raw.ui; delete raw.background;
  await f.save('dfsc.theme.json', { ...raw, schemaVersion: 1, renderer: 'stellar-v1', scene: 'scene.json' });
  await f.save('scene.json', { dragons: {}, duck: {} });
  const result = await checkPackage(f.root);
  assert.deepEqual(errors(result), []);
  assert.deepEqual(result.composition.accepts, []);
  assert.match(result.issues[0].message, /Legacy v1/);
});

test('unknown versions, renderer names, executable fields and replacement types fail closed', async t => {
  const f = await fixture(t);
  for (const raw of [
    { ...theme(), schemaVersion: 3 }, { ...theme(), ui: { renderer: 'my-css' } },
    { ...theme(), entry: 'index.js' }, { ...theme(), background: { renderer: 'html-v1', source: 'index.html' } },
    { ...theme(), background: { ...theme().background, accepts: ['html-v1'] } },
    { ...theme(), background: { ...theme().background, accepts: ['image-v1', 'image-v1'] } },
    { ...theme(), background: { ...theme().background, interactive: true } },
    { ...theme(), background: { ...theme().background, source: '../private.png' } },
    { ...theme(), background: { ...theme().background, source: 'background.jpeg' } },
  ]) {
    await f.save('dfsc.theme.json', raw);
    assert.ok(errors(await checkPackage(f.root)).length);
  }
});

test('header limits include decoded dimensions and reject APNG, signature mismatch and truncation', () => {
  assert.deepEqual(imageHeader(pixel, 'background.png'), { width: 1, height: 1 });
  for (const [width, height] of [[0, 1], [8193, 1], [8192, 8192]]) {
    const invalid = Buffer.from(pixel);
    invalid.writeUInt32BE(width, 16); invalid.writeUInt32BE(height, 20);
    assert.throws(() => imageHeader(invalid, 'background.png'));
  }
  const chunk = Buffer.alloc(12); chunk.write('acTL', 4);
  assert.throws(() => imageHeader(Buffer.concat([pixel.subarray(0, 33), chunk, pixel.subarray(33)]), 'background.png'));
  assert.throws(() => imageHeader(pixel, 'background.jpg'));
  assert.throws(() => imageHeader(pixel.subarray(0, -1), 'background.png'));
  assert.throws(() => imageHeader(Buffer.from('<svg/>'), 'background.png'));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9]);
  assert.deepEqual(imageHeader(jpeg, 'background.jpg'), { width: 3, height: 2 });
});

test('missing, wrongly named and market-oversized assets are hard errors', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'background.png'));
  assert.equal(errors(await checkPackage(f.root))[0].file, 'background.png');
  await writeFile(join(f.root, 'background.png'), Buffer.alloc(MARKET_FILE_BYTES + 1));
  assert.match(errors(await checkPackage(f.root))[0].message, /8 MiB/);
  await f.save('dfsc.theme.json', { ...theme(), background: { renderer: 'stellar-v1', source: 'scene.json' } });
  assert.equal(errors(await checkPackage(f.root))[0].file, 'scene.json');
});

test('palette and scheme checks match the host reading constraints', async t => {
  const f = await fixture(t);
  for (const raw of [
    { ...theme(), colors: { ...theme().colors, muted: '#222222' } },
    { ...theme(), colors: { ...theme().colors, accent: '#fff' } },
    { ...theme(), scheme: 'light', ui: { renderer: 'stellar-v1' } },
    { ...theme(), name: 'line\nbreak' }, { ...theme(), colors: null },
  ]) {
    await f.save('dfsc.theme.json', raw);
    assert.ok(errors(await checkPackage(f.root)).length);
  }
});

test('optional covers warn without rejecting otherwise valid themes', async t => {
  const f = await fixture(t);
  await f.save('dfsc.theme.json', { ...theme(), cover: 'cover.png' });
  const result = await checkPackage(f.root);
  assert.deepEqual(errors(result), []);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].level, 'warning');
  assert.match(result.issues[0].message, /cover/);
});

test('ordinary plugins are skipped, but missing packages and malformed themes are not', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'dfsc.theme.json'));
  assert.equal((await checkPackage(f.root, { optional: true })).theme, false);
  assert.equal(errors(await checkPackage(f.root)).length, 1);
  assert.equal(errors(await checkPackage(join(f.root, 'missing'), { optional: true })).length, 1);
  await writeFile(join(f.root, 'dfsc.theme.json'), '{"schemaVersion":2,');
  assert.equal(errors(await checkPackage(f.root, { optional: true })).length, 1);
  await writeFile(join(f.root, 'dfsc.theme.json'), Buffer.from([0xff, 0xfe, 0xff]));
  assert.equal(errors(await checkPackage(f.root)).length, 1);
});

test('linked theme assets never leave the package boundary', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'background.png'), pixel);
  await rm(join(f.root, 'background.png'));
  try { await symlink(join(outside, 'background.png'), join(f.root, 'background.png')); } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows file symlink privilege is unavailable'); return;
  }
  assert.equal(errors(await checkPackage(f.root))[0].file, 'background.png');
});

test('linked package directories fail even when ordinary missing theme files are optional', async t => {
  const f = await fixture(t), link = join(f.root, 'linked');
  await symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const result = await checkPackage(link, { optional: true });
    assert.equal(errors(result).length, 1);
    assert.match(result.issues[0].message, /directory must exist/);
  } finally {
    if (process.platform === 'win32') await rmdir(link);
    else await rm(link);
  }
});

test('market scan reports theme files and CLI exits nonzero on a broken slot', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'plugins'));
  await mkdir(join(f.root, 'plugins', 'ordinary'));
  await f.save('registry.json', { plugins: [{ id: 'ordinary' }] });
  assert.deepEqual(await checkMarketplace(f.root), { themes: 0, issues: [] });
  await f.save('dfsc.theme.json', { ...theme(), background: { renderer: 'solid-v1', accepts: ['html-v1'] } });
  const result = spawnSync(process.execPath, [join(repository, 'scripts/check-theme-pack.mjs'), '--package', f.root],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Unsupported theme composition/);
  assert.match(result.stdout, /"errors":1/);
});

test('market CI checks the actual theme copy and reports its resource-relative path', async t => {
  const f = await fixture(t);
  const folder = join(f.root, 'plugins/example-theme');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'step.plugin.json'), JSON.stringify(manifest));
  await writeFile(join(folder, 'dfsc.theme.json'), JSON.stringify({
    ...theme(), background: { renderer: 'solid-v1', accepts: ['html-v1'] },
  }));
  await f.save('registry.json', { plugins: [{ id: 'example-theme' }] });
  const result = await checkMarketplace(f.root);
  assert.equal(result.themes, 1);
  assert.equal(errors(result).length, 1);
  assert.equal(result.issues[0].file, 'plugins/example-theme/dfsc.theme.json');
  const cli = spawnSync(process.execPath, [join(repository, 'scripts/check-theme-pack.mjs'), '--root', f.root],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /plugins\/example-theme\/dfsc.theme.json/);
});

test('GitHub annotations escape author-independent output and preserve actionable paths', () => {
  const text = formatIssue({ plugin: 'test', file: 'plugins/test/dfsc.theme.json',
    level: 'error', message: 'Invalid\n::warning::x%' }, true);
  assert.ok(!text.includes('\n'));
  assert.match(text, /%0A::warning::x%25/);
});

test('composition stays inert and does not need an author script for new paradigms', () => {
  assert.throws(() => parseThemeComposition({ ...theme(), ui: { renderer: 'standard-v1', script: 'ui.js' } }));
  assert.equal(parseThemeComposition({ ...theme(), background: { renderer: 'solid-v1' } }).accepts.length, 0);
});
