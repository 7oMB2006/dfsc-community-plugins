import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug, resolveProject } from '../../../plugins/memory-hub/server/project.mjs';

test('projectSlug matches the DFSC session directory convention', () => {
  assert.equal(projectSlug('D:\\AgentPrograms\\x'), '--D--AgentPrograms-x--');
  assert.equal(projectSlug('D:\\AgentPrograms\\DFSC Plugin'), '--D--AgentPrograms-DFSC Plugin--');
  assert.equal(projectSlug('D:/AgentPrograms/x/'), '--D--AgentPrograms-x--', 'trailing separator is ignored');
});

test('resolveProject prefers the explicit argument', () => {
  const resolved = resolveProject({ project: 'D:\\AgentPrograms\\x', env: { MEMORY_HUB_PROJECT: 'D:\\other' } });
  assert.equal(resolved.slug, '--D--AgentPrograms-x--');
  assert.equal(resolved.source, 'arg');
});

test('resolveProject falls back to the environment variable', () => {
  const resolved = resolveProject({ env: { MEMORY_HUB_PROJECT: 'D:\\AgentPrograms\\env-proj' } });
  assert.equal(resolved.slug, '--D--AgentPrograms-env-proj--');
  assert.equal(resolved.source, 'env');
});

test('resolveProject reads cwd from the newest session file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-hub-project-'));
  try {
    const dir = join(root, '--D--AgentPrograms-old--');
    await mkdir(dir, { recursive: true });
    const older = join(dir, '2026-11-01T00-00-00-000Z_a.jsonl');
    await writeFile(older, JSON.stringify({ type: 'session', cwd: 'D:\\AgentPrograms\\old' }) + '\n');
    const newer = join(dir, '2026-11-02T00-00-00-000Z_b.jsonl');
    await writeFile(newer, JSON.stringify({ type: 'session', cwd: 'D:\\AgentPrograms\\new' }) + '\n');
    const now = Date.now() / 1000;
    await utimes(older, now - 3600, now - 3600);
    await utimes(newer, now, now);
    const resolved = resolveProject({ env: {}, sessionsRoot: root });
    assert.equal(resolved.slug, '--D--AgentPrograms-new--');
    assert.equal(resolved.source, 'session');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveProject skips unreadable session files and falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-hub-project-'));
  try {
    await writeFile(join(root, 'broken.jsonl'), 'not json at all\n');
    const resolved = resolveProject({ env: {}, sessionsRoot: root });
    assert.equal(resolved.slug, '_default');
    assert.equal(resolved.source, 'fallback');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveProject does not escape through a relative argument', () => {
  const resolved = resolveProject({ project: 'relative/dir', env: {} });
  assert.equal(resolved.slug, '_default');
  assert.equal(resolved.source, 'fallback');
});
