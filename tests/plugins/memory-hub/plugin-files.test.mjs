import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, '../../../plugins/memory-hub');
const readJson = async (name) => JSON.parse(await readFile(join(plugin, name), 'utf8'));

test('the native manifest declares the resources it ships', async () => {
  const manifest = await readJson('step.plugin.json');
  assert.equal(manifest.id, 'memory-hub');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.ok(manifest.name && manifest.description);
  assert.deepEqual(manifest.skills, ['skills']);
  assert.deepEqual(manifest.commands, ['commands']);
  const server = manifest.mcpServers?.memory;
  assert.ok(server, 'declares a memory MCP server');
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['server/memory-hub.mjs']);
  assert.ok(Number.isFinite(server.startup_timeout_sec) && server.startup_timeout_sec <= 120);
  assert.ok(Number.isFinite(server.tool_timeout_sec) && server.tool_timeout_sec <= 120);
  assert.ok(!('entry' in manifest) && !('provision' in manifest), 'the marketplace rejects executable entries');
});

test('the manifest declares no environment variables it cannot honour', async () => {
  const manifest = await readJson('step.plugin.json');
  const env = manifest.mcpServers.memory.env;
  assert.equal(env, undefined, 'no env is required for a local, zero-config server');
});

test('every declared resource path exists', async () => {
  const manifest = await readJson('step.plugin.json');
  for (const key of ['skills', 'commands']) {
    for (const value of manifest[key]) {
      const info = await stat(join(plugin, value));
      assert.ok(info.isDirectory(), `${key} path ${value} must be a directory`);
    }
  }
  for (const arg of manifest.mcpServers.memory.args) {
    const info = await stat(join(plugin, arg));
    assert.ok(info.isFile(), `server entry ${arg} must exist`);
  }
  assert.ok((await stat(join(plugin, manifest.icon))).isFile(), 'the declared icon exists');
});

test('each skill has frontmatter with a name and a description', async () => {
  const manifest = await readJson('step.plugin.json');
  const skills = [];
  for (const dir of manifest.skills) {
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(join(plugin, dir))) skills.push(join(plugin, dir, name, 'SKILL.md'));
  }
  assert.ok(skills.length >= 2, 'ships both the recall and the curate skill');
  for (const file of skills) {
    const text = await readFile(file, 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    assert.ok(front, `${file} needs YAML frontmatter`);
    assert.match(front[1], /^name:\s*\S+/m, `${file} needs a name`);
    assert.match(front[1], /^description:\s*\S+/m, `${file} needs a description`);
  }
});

test('each command file has a description and uses $ARGUMENTS', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(plugin, 'commands'));
  assert.ok(files.length >= 1);
  for (const name of files) {
    const text = await readFile(join(plugin, 'commands', name), 'utf8');
    assert.match(text, /^---[\s\S]*?description:/, `${name} needs frontmatter`);
    assert.match(text, /\$ARGUMENTS/, `${name} should receive the user's arguments`);
  }
});

test('the presentation file satisfies the marketplace rules', async () => {
  const value = await readJson('dfsc.plugin.json');
  assert.equal(value.schemaVersion, 1);
  assert.ok(Array.isArray(value.authors) && value.authors.length >= 1);
  for (const author of value.authors) {
    assert.ok(typeof author.name === 'string' && author.name.trim() && author.name.length <= 160);
  }
  assert.ok(value.license);
  const categories = new Set(['development', 'research', 'text-documents', 'knowledge',
    'audio-video', 'image-design', 'automation', 'themes']);
  assert.ok(Array.isArray(value.categories) && value.categories.length <= 3);
  for (const category of value.categories) assert.ok(categories.has(category), `unknown category ${category}`);
  assert.ok(Array.isArray(value.keywords) && value.keywords.length <= 5);
  for (const keyword of value.keywords) {
    assert.ok(keyword.trim() && keyword.length <= 48 && !/[\u0000-\u001f]/u.test(keyword));
  }
  assert.match(value.requirements.dfsc, /[<>=^~]|\d/);
  assert.ok(Array.isArray(value.requirements.external) && value.requirements.external.length >= 1);
  for (const item of value.requirements.external) {
    assert.ok(item.name && item.name.length <= 160);
    assert.ok(item.description === undefined || item.description.length <= 512);
    if (item.url !== undefined) {
      const url = new URL(item.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(!url.username && !url.password);
    }
    assert.ok(item.optional === undefined || typeof item.optional === 'boolean');
  }
  assert.ok(!('desktop' in value), 'no desktop entry: it would need a newer host build');
});

test('the icon is a small PNG inside the marketplace limits', async () => {
  const manifest = await readJson('step.plugin.json');
  const data = await readFile(join(plugin, manifest.icon));
  assert.ok(data.length <= 128 * 1024, `icon is ${data.length} bytes`);
  assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  assert.ok(width > 0 && width <= 512 && height > 0 && height <= 512, `got ${width}x${height}`);
});
