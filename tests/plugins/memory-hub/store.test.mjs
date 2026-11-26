import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryBank } from '../../../plugins/memory-hub/server/store.mjs';

async function withBank(fn, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'memory-hub-bank-'));
  try {
    const bank = new MemoryBank({ home, ...options });
    return await fn(bank, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const PROJECT = 'D:\\AgentPrograms\\demo';

test('retain adds a memory and reports the bank', async () => {
  await withBank(async (bank) => {
    const result = await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'added');
    assert.equal(result.bank, 'project');
    assert.equal(result.total, 1);
    assert.match(result.id, /^m_[0-9a-z]+$/);
  });
});

test('retain merges duplicate text instead of adding a second row', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    const again = await bank.retain({ text: '  构建用   pnpm ', project: PROJECT });
    assert.equal(again.action, 'merged');
    assert.equal(again.total, 1);
  });
});

test('retain folds stray whitespace instead of storing it', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    await bank.retain({ text: '构建用   pnpm ', project: PROJECT });
    const { memories } = await bank.recall({ query: '构建用 pnpm', project: PROJECT });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].text, '构建用 pnpm', '合并时不能把带多余空格的版本留下来');
  });
});

test('retain keeps the higher importance when merging', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm', importance: 0.9, project: PROJECT });
    await bank.retain({ text: '构建用 pnpm', importance: 0.2, project: PROJECT });
    const { memories } = await bank.recall({ query: '构建用 pnpm', project: PROJECT });
    assert.equal(memories.length, 1);
    assert.ok(memories[0].importance >= 0.9);
  });
});

test('retain clamps limits instead of trusting the caller', async () => {
  await withBank(async (bank) => {
    const long = `构建说明 ${'细节'.repeat(1200)}`;
    const result = await bank.retain({ text: long, tags: Array.from({ length: 20 }, (_, i) => `tag${i}`), project: PROJECT });
    assert.equal(result.ok, true);
    const { memories } = await bank.recall({ query: '构建说明', project: PROJECT });
    assert.ok(memories[0].text.length <= 2000, 'text is clipped to the 2000 character budget');
    assert.ok(memories[0].tags.length <= 8, 'tags are capped at 8');
  });
});

test('retain rejects empty text', async () => {
  await withBank(async (bank) => {
    await assert.rejects(bank.retain({ text: '   ', project: PROJECT }), /text/i);
  });
});

test('retain redacts credentials before writing them to disk', async () => {
  await withBank(async (bank, home) => {
    const result = await bank.retain({ text: 'token sk-live-abcdef123456789 for the API', project: PROJECT });
    assert.ok(result.redacted >= 1);
    const files = await readdir(join(home, '--D--AgentPrograms-demo--'));
    const raw = await readFile(join(home, '--D--AgentPrograms-demo--', files[0]), 'utf8');
    assert.ok(!raw.includes('sk-live-abcdef123456789'), 'the raw secret never reaches the file');
  });
});

test('recall records a hit so repeated use strengthens the memory', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    await bank.recall({ query: '构建', project: PROJECT });
    const second = await bank.recall({ query: '构建', project: PROJECT });
    assert.equal(second.memories[0].hits, 2);
  });
});

test('recall filters by type and tag', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm', type: 'fact', tags: ['构建'], project: PROJECT });
    await bank.retain({ text: '先写测试再实现功能', type: 'lesson', tags: ['测试'], project: PROJECT });
    const lessons = await bank.recall({ query: '写测试', type: 'lesson', project: PROJECT });
    assert.equal(lessons.memories.length, 1);
    assert.equal(lessons.memories[0].type, 'lesson');
    const tagged = await bank.recall({ query: '构建', tags: ['测试'], project: PROJECT });
    assert.equal(tagged.memories.length, 0);
  });
});

test('recall respects the limit and sorts by score', async () => {
  await withBank(async (bank) => {
    // 每条都带「构建」这个查询词，但内容彼此独立，不会被合并成一条。
    const topics = [
      '构建用 pnpm workspaces', '构建前先跑 lint', '构建产物写在 dist',
      '构建缓存放 CI', '构建脚本用 node', '构建失败先看 stderr',
      '构建日志留档', '构建机是 windows runner', '构建超时设为十分钟',
      '构建依赖锁文件', '构建分支是 main', '构建完成后跑验收',
    ];
    for (const text of topics) await bank.retain({ text, project: PROJECT });
    const { memories } = await bank.recall({ query: '构建', limit: 3, project: PROJECT });
    assert.equal(memories.length, 3);
    assert.ok(memories[0].score >= memories[2].score);
  });
});

test('invalidated memories stay out of recall but remain inspectable', async () => {
  await withBank(async (bank) => {
    const { id } = await bank.retain({ text: '构建用 npm', project: PROJECT });
    const replacement = await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    const edited = await bank.edit({ op: 'invalidate', id, replacementId: replacement.id, project: PROJECT });
    assert.equal(edited.status, 'invalidated');
    const normal = await bank.recall({ query: '构建用 npm', project: PROJECT });
    assert.equal(normal.memories.some((m) => m.id === id), false);
    const full = await bank.recall({ query: '构建用 npm', status: 'invalidated', project: PROJECT });
    assert.equal(full.memories.length, 1);
    assert.equal(full.memories[0].supersededBy, replacement.id);
  });
});

test('edit updates text, tags and importance', async () => {
  await withBank(async (bank) => {
    const { id } = await bank.retain({ text: '构建用 npm', project: PROJECT });
    const result = await bank.edit({ op: 'update', id, text: '构建用 pnpm', importance: 0.95, tags: ['构建'], project: PROJECT });
    assert.equal(result.status, 'updated');
    assert.equal(result.memory.text, '构建用 pnpm');
    assert.equal(result.memory.importance, 0.95);
    assert.deepEqual(result.memory.tags, ['构建']);
  });
});

test('edit restores an archived memory', async () => {
  await withBank(async (bank) => {
    const { id } = await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    await bank.edit({ op: 'archive', id, project: PROJECT });
    const restored = await bank.edit({ op: 'restore', id, project: PROJECT });
    assert.equal(restored.status, 'restored');
    assert.equal(restored.memory.status, 'active');
  });
});

test('edit forget requires an explicit confirmation', async () => {
  await withBank(async (bank) => {
    const { id } = await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    await assert.rejects(bank.edit({ op: 'forget', id, project: PROJECT }), /confirm/i);
    const gone = await bank.edit({ op: 'forget', id, confirm: 'yes', project: PROJECT });
    assert.equal(gone.status, 'deleted');
    const { memories } = await bank.recall({ query: '构建用 pnpm', status: 'all', project: PROJECT });
    assert.equal(memories.length, 0);
  });
});

test('edit reports not_found for unknown ids', async () => {
  await withBank(async (bank) => {
    const result = await bank.edit({ op: 'update', id: 'm_missing', text: 'x', project: PROJECT });
    assert.equal(result.status, 'not_found');
    assert.equal(result.ok, false);
  });
});

test('global scope is a separate bank that recall can include', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '回答用中文', scope: 'global', project: PROJECT });
    await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    const local = await bank.recall({ query: '中文', project: PROJECT });
    assert.equal(local.memories.length, 0, 'project recall does not see the global bank by default');
    const all = await bank.recall({ query: '中文', scope: 'all', project: PROJECT });
    assert.equal(all.memories.length, 1);
    assert.equal(all.memories[0].bank, 'global');
  });
});

test('writing beyond the cap archives the weakest entries and says how many', async () => {
  await withBank(async (bank) => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await bank.retain({ text: `条目 ${i}`, importance: i / 100, project: PROJECT, cap: 3 }));
    }
    const last = results.at(-1);
    assert.ok(last.evicted >= 1, `expected evictions, got ${last.evicted}`);
    const stats = await bank.stats({ project: PROJECT });
    assert.equal(stats.banks.project.active, 3);
    assert.ok(stats.banks.project.archived >= 3, '被淘汰的条目归档而不是删除');
  });
});

test('a write after the retention window archives the untouched memory', async () => {
  await withBank(async (bank) => {
    let now = Date.UTC(2026, 10, 1);
    const clocked = new MemoryBank({ home: bank.home, clock: () => now });
    await clocked.retain({ text: '很久没用的结论', project: PROJECT });
    now += 70 * 86_400_000;
    // 衰减发生在写入路径上：这条新写入顺带把上面那条过了窗口的条目归档。
    await clocked.retain({ text: '刚写下的另一条', project: PROJECT });
    const stats = await clocked.stats({ project: PROJECT });
    assert.equal(stats.banks.project.active, 1);
    assert.equal(stats.banks.project.archived, 1);
    const { memories } = await clocked.recall({ query: '很久没用', status: 'archived', project: PROJECT });
    assert.equal(memories.length, 1, '归档条目仍可查到，不是被删掉');
  });
});

test('merging also runs decay, not only the add path', async () => {
  await withBank(async (bank) => {
    let now = Date.UTC(2026, 10, 1);
    const clocked = new MemoryBank({ home: bank.home, clock: () => now });
    await clocked.retain({ text: '构建用 pnpm', project: PROJECT });
    await clocked.retain({ text: '一条不相干的旧结论', project: PROJECT });
    now += 70 * 86_400_000;
    // 这次写入会合并到已有条目（merged 分支），早期实现该分支不做衰减，
    // 于是「一直在合并」的项目永远不清过期条目。
    const merged = await clocked.retain({ text: '构建用 pnpm', project: PROJECT });
    assert.equal(merged.action, 'merged');
    const stats = await clocked.stats({ project: PROJECT });
    assert.ok(stats.banks.project.archived >= 1, `expected decay on the merge path, saw ${JSON.stringify(stats.banks.project)}`);
  });
});

test('recall only counts hits for the memories it returns', async () => {
  await withBank(async (bank) => {
    for (let i = 0; i < 4; i++) await bank.retain({ text: `构建细节 ${i}`, project: PROJECT });
    const first = await bank.recall({ query: '构建', limit: 1, project: PROJECT });
    assert.equal(first.memories.length, 1);
    // 直接看落盘：limit=1 只该给那一条记命中，其余三条必须还是 0。
    const { data } = await bank.store(bank.resolve(PROJECT).slug).read();
    const hits = data.memories.map((memory) => memory.hits).sort((a, b) => a - b);
    assert.deepEqual(hits, [0, 0, 0, 1], `unexpected hit counts: ${hits}`);
  });
});

test('a read-only style query does not write the bank when nothing matches', async () => {
  await withBank(async (bank, home) => {
    await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    const file = join(home, '--D--AgentPrograms-demo--', 'memory.json');
    const before = await readFile(file, 'utf8');
    const { memories } = await bank.recall({ query: '完全无关的部署话题', project: PROJECT });
    assert.deepEqual(memories, []);
    assert.equal(await readFile(file, 'utf8'), before, 'a query that matches nothing must not rewrite the store');
  });
});

test('edit falls back to the global bank when the id lives there', async () => {
  await withBank(async (bank) => {
    const { id } = await bank.retain({ text: '回答用中文', scope: 'global', project: PROJECT });
    // 不传 scope：先查项目库，找不到再查全局库
    const updated = await bank.edit({ op: 'update', id, text: '回答一律用中文', project: PROJECT });
    assert.equal(updated.status, 'updated');
    assert.equal(updated.bank, 'global');
  });
});

test('edit reports which banks it searched when the id is unknown', async () => {
  await withBank(async (bank) => {
    const result = await bank.edit({ op: 'update', id: 'm_missing', text: 'x', project: PROJECT });
    assert.equal(result.status, 'not_found');
    assert.deepEqual(result.searched, ['project', 'global']);
  });
});

test('repeated merges keep the source label bounded and deduplicated', async () => {
  await withBank(async (bank) => {
    for (let i = 0; i < 8; i++) {
      await bank.retain({ text: '构建用 pnpm', source: `session:${i}`, project: PROJECT });
    }
    const { memories } = await bank.recall({ query: '构建用 pnpm', project: PROJECT });
    const source = memories[0].source;
    assert.ok(source.length <= 200, `source grew to ${source.length} chars`);
    const parts = source.split(',').map((part) => part.trim());
    assert.equal(new Set(parts).size, parts.length, `duplicate source items: ${source}`);
    assert.ok(parts.length <= 4, `expected at most 4 source items, got ${parts.length}: ${source}`);
  });
});

test('merging keeps the cleaner text when whitespace was the only difference', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm workspaces', project: PROJECT });
    await bank.retain({ text: '构建用   pnpm workspaces ', project: PROJECT });
    const { memories } = await bank.recall({ query: '构建用 pnpm', project: PROJECT });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].text, '构建用 pnpm workspaces');
  });
});

test('purge keeps a corrupt store contents intact in the trash file', async () => {
  await withBank(async (bank, home) => {
    const dir = join(home, '--D--AgentPrograms-demo--');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'memory.json'), 'broken on purpose');
    const result = await bank.purge({ scope: 'project', confirm: 'DELETE', project: PROJECT });
    assert.equal(result.ok, true);
    assert.equal(result.moved[0].corrupt, true, 'a corrupt bank is still moved, flagged as corrupt');
    const names = await readdir(dir);
    const trash = names.find((name) => name.startsWith('memory.json.trash-'));
    assert.ok(trash, `trash file missing: ${names}`);
    assert.equal(await readFile(join(dir, trash), 'utf8'), 'broken on purpose');
  });
});

test('maintenance can force decay and eviction on demand', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '一条普通结论', project: PROJECT });
    const result = await bank.maintenance({ project: PROJECT, days: -1, cap: 0 });
    assert.ok(result.archived.length >= 1, 'negative window archives everything untouched');
    assert.equal(result.ok, true);
  });
});

test('reflect groups evidence by type and flags conflicts', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm', type: 'fact', tags: ['构建'], project: PROJECT });
    const old = await bank.retain({ text: '构建用 npm', type: 'fact', tags: ['构建'], project: PROJECT });
    await bank.retain({ text: '构建前先跑 lint 再写测试', type: 'lesson', tags: ['构建'], project: PROJECT });
    await bank.edit({ op: 'invalidate', id: old.id, project: PROJECT });
    const result = await bank.reflect({ question: '构建', project: PROJECT });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.groups).sort(), ['fact', 'lesson']);
    assert.ok(result.conflicts.some((c) => c.some((m) => m.id === old.id)), 'invalidated memories are listed as superseded evidence');
    assert.match(result.note, /组装|assembly/i);
  });
});

test('reflect drops evidence that only shares a generic word with the question', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm workspaces', type: 'fact', tags: ['构建'], project: PROJECT });
    // 只共享「是」这类通用词，相关度在门槛以下：不该被当成证据返回。
    await bank.retain({ text: '部署是由运维手动触发的', type: 'fact', tags: ['部署'], project: PROJECT });
    const result = await bank.reflect({ question: '构建是用什么工具跑的', project: PROJECT });
    const texts = Object.values(result.groups).flat().map((memory) => memory.text);
    assert.equal(texts.length, 1, `unexpected evidence: ${JSON.stringify(texts)}`);
    assert.match(texts[0], /pnpm/);
  });
});

test('stats reports counts, caps, storage path and project source', async () => {
  await withBank(async (bank) => {
    await bank.retain({ text: '构建用 pnpm', tags: ['构建'], project: PROJECT });
    const stats = await bank.stats({ project: PROJECT });
    assert.equal(stats.ok, true);
    assert.equal(stats.banks.project.active, 1);
    assert.equal(stats.caps.project, 600);
    assert.equal(stats.project.slug, '--D--AgentPrograms-demo--');
    assert.equal(stats.project.source, 'arg');
    assert.ok(stats.storage.project.endsWith('memory.json'));
    assert.deepEqual(stats.topTags.map((t) => t.tag), ['构建']);
  });
});

test('purge moves the bank to a trash file instead of deleting it', async () => {
  await withBank(async (bank, home) => {
    await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    const result = await bank.purge({ scope: 'project', confirm: 'DELETE', project: PROJECT });
    assert.equal(result.ok, true);
    assert.match(result.movedTo, /\.trash-/);
    const dir = join(home, '--D--AgentPrograms-demo--');
    const names = await readdir(dir);
    assert.ok(!names.includes('memory.json'), 'the live file is gone');
    const stats = await bank.stats({ project: PROJECT });
    assert.equal(stats.banks.project.total, 0);
  });
});

test('purge on a bank that was never written is a clean no-op', async () => {
  // 库还没写过时目录不存在：锁文件建不出来，早期实现会以 ENOENT 失败。
  await withBank(async (bank, home) => {
    const result = await bank.purge({ scope: 'project', confirm: 'DELETE', project: PROJECT });
    assert.equal(result.ok, true);
    assert.equal(result.removed, 0);
    assert.deepEqual(result.moved, []);
    assert.equal(result.movedTo, null);
    const stats = await bank.stats({ project: PROJECT });
    assert.equal(stats.banks.project.total, 0, '空库清理后仍是空库');
  });
});

test('a corrupt bank file is reported, not silently emptied', async () => {
  await withBank(async (bank, home) => {
    const dir = join(home, '--D--AgentPrograms-demo--');
    await bank.retain({ text: '构建用 pnpm', project: PROJECT });
    await writeFile(join(dir, 'memory.json'), 'garbage');
    const stats = await bank.stats({ project: PROJECT });
    assert.equal(stats.corrupt.project, true);
    assert.equal(stats.banks.project.total, 0);
  });
});

test('two bank instances can write the same project without losing rows', async () => {
  await withBank(async (bank, home) => {
    const other = new MemoryBank({ home });
    await Promise.all([
      bank.retain({ text: '并行写入甲', project: PROJECT }),
      other.retain({ text: '并行写入乙', project: PROJECT }),
    ]);
    const { memories } = await bank.recall({ query: '并行写入', limit: 10, project: PROJECT });
    assert.equal(memories.length, 2);
  });
});
