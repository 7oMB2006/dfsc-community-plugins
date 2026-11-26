import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, appendFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestSessions } from '../../../plugins/memory-hub/server/digest.mjs';

const SLUG = '--D--AgentPrograms-demo--';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'memory-hub-digest-'));
  const dir = join(root, SLUG);
  await mkdir(dir, { recursive: true });
  return { root, dir };
}

function line(role, text) {
  return JSON.stringify({
    type: 'message',
    id: 'x',
    parentId: null,
    timestamp: '2026-11-23T10:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  });
}

test('digest skips subagent sessions and keeps real ones', async () => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, '2026-11-23T00-00-00-000Z_main.jsonl'), [
      JSON.stringify({ type: 'session', cwd: 'D:\\AgentPrograms\\demo' }),
      line('user', '构建用 pnpm'),
      line('assistant', '好的，记录一下。'),
    ].join('\n') + '\n');
    await writeFile(join(dir, '2026-11-23T00-00-01-000Z_subagent-abc.jsonl'), line('user', '子代理不该出现') + '\n');
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 5000 });
    assert.equal(result.sessions.length, 1);
    assert.ok(result.text.includes('构建用 pnpm'));
    assert.ok(!result.text.includes('子代理不该出现'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest orders sessions newest first', async () => {
  const { root, dir } = await fixture();
  try {
    const older = join(dir, '2026-11-20T00-00-00-000Z_a.jsonl');
    const newer = join(dir, '2026-11-22T00-00-00-000Z_b.jsonl');
    await writeFile(older, line('user', '旧的会话') + '\n');
    await writeFile(newer, line('user', '新的会话') + '\n');
    const now = Date.now() / 1000;
    await utimes(older, now - 7200, now - 7200);
    await utimes(newer, now, now);
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 5000 });
    assert.ok(result.text.indexOf('新的会话') < result.text.indexOf('旧的会话'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest honours the session count', async () => {
  const { root, dir } = await fixture();
  try {
    for (let i = 0; i < 4; i++) {
      await writeFile(join(dir, `2026-11-2${i}T00-00-00-000Z_s.jsonl`), line('user', `会话 ${i}`) + '\n');
    }
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 2, maxChars: 50_000 });
    assert.equal(result.sessions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest defaults to the single most recent session', async () => {
  // 没给 session 时退回「最近一个」，但这是兜底语义，不是「当前对话」的保证。
  const { root, dir } = await fixture();
  try {
    for (let i = 0; i < 4; i++) {
      await writeFile(join(dir, `2026-11-2${i}T00-00-00-000Z_s.jsonl`), line('user', `会话 ${i}`) + '\n');
    }
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG });
    assert.equal(result.sessions.length, 1, '默认只取最近一个会话');
    assert.ok(result.text.length > 0, '默认仍应返回正文摘录');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest reads exactly the session it is told to, not the newest one', async () => {
  // 「最近修改」不等于「当前对话」：另一个会话可能刚写过。指定 id 就必须读那个。
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, '2026-11-20T00-00-00-000Z_aaa.jsonl'), line('user', '旧的这次对话') + '\n');
    // 更晚写入的文件 mtime 更新，但它不是我们要的那次对话
    await writeFile(join(dir, '2026-11-26T00-00-00-000Z_bbb.jsonl'), line('user', '别人的对话') + '\n');
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, session: 'aaa' });
    assert.equal(result.sessions.length, 1);
    assert.match(result.sessions[0].file, /aaa/u, '必须读指定会话');
    assert.ok(result.text.includes('旧的这次对话'), '正文应来自指定会话');
    assert.ok(!result.text.includes('别人的对话'), '不得混入最近修改的其它会话');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest refuses an unknown session instead of guessing', async () => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, '2026-11-20T00-00-00-000Z_aaa.jsonl'), line('user', '某次对话') + '\n');
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, session: 'no-such-id' });
    assert.equal(result.ok, false, '找不到就报错，不退回猜最近一个');
    assert.match(result.error, /找不到会话/u);
    assert.equal(result.sessions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest redacts credentials and clips to the character budget', async () => {
  const { root, dir } = await fixture();
  try {
    const file = join(dir, '2026-11-23T00-00-00-000Z_main.jsonl');
    await writeFile(file, line('user', '我的 key 是 sk-live-abcdef1234567890') + '\n');
    for (let i = 0; i < 40; i++) await appendFile(file, line('assistant', `很长的回复 ${i} ${'填充'.repeat(60)}`) + '\n');
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 1200 });
    assert.ok(!result.text.includes('sk-live-abcdef1234567890'));
    assert.ok(result.text.length <= 1200, `got ${result.text.length} characters`);
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest respects the budget with pure Chinese input', async () => {
  // 中文一字三字节：按字节算预算会严重超发，按字符算才对。这里也从侧面确认
  // 单行裁剪不会把多字节字符切成半个。
  const { root, dir } = await fixture();
  try {
    const file = join(dir, '2026-11-23T00-00-00-000Z_zh.jsonl');
    await writeFile(file, line('user', '用中文写的结论') + '\n');
    for (let i = 0; i < 60; i++) {
      await appendFile(file, line('assistant', `第${i}段很长的中文回复，用来把预算吃满：` + '这是一段足够长的中文填充内容。'.repeat(12)) + '\n');
    }
    for (const maxChars of [1000, 3000]) {
      const result = await digestSessions({ sessionsRoot: root, slug: SLUG, maxChars });
      assert.ok(result.text.length <= maxChars, `预算 ${maxChars}，实际 ${result.text.length} 字符`);
      assert.ok(!/\uFFFD/u.test(result.text), '不得出现被截断的半个字符');
      assert.equal(result.truncated, true, '内容超预算时 truncated 必须为 true');
    }
    // 单行超长时也不能出现替换字符
    const line_clipped = await digestSessions({ sessionsRoot: root, slug: SLUG, maxChars: 60_000 });
    assert.ok(!/\uFFFD/u.test(line_clipped.text), '长行裁剪不得产生半个字符');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest returns an empty result when nothing exists', async () => {  const { root } = await fixture();
  try {
    const result = await digestSessions({ sessionsRoot: root, slug: '--missing--', count: 3, maxChars: 1000 });
    assert.deepEqual(result.sessions, []);
    assert.equal(result.text, '');
    assert.equal(result.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest ignores tool output and malformed lines', async () => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, '2026-11-23T00-00-00-000Z_main.jsonl'), [
      'not json',
      JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: '工具输出' }] } }),
      line('user', '人的提问'),
    ].join('\n') + '\n');
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 5000 });
    assert.ok(result.text.includes('人的提问'));
    assert.ok(!result.text.includes('工具输出'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty session does not give later sessions a bigger share', async () => {
  const { root, dir } = await fixture();
  try {
    // 三个文件：第一个几乎为空，后两个很长。按「剩余 / 剩余文件数」分配时，
    // 空文件不该把预算让给后来的文件而整体溢出。
    await writeFile(join(dir, '2026-11-23T00-00-00-000Z_empty.jsonl'), line('toolResult', 'x') + '\n');
    for (const name of ['2026-11-22T00-00-00-000Z_a.jsonl', '2026-11-21T00-00-00-000Z_b.jsonl']) {
      await writeFile(join(dir, name), line('user', '内容'.repeat(400)) + '\n');
    }
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 900 });
    assert.ok(result.text.length <= 900, `got ${result.text.length} characters`);
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an oversized session file is skipped instead of read into memory', async () => {
  const { root, dir } = await fixture();
  try {
    const small = join(dir, '2026-11-23T00-00-00-000Z_small.jsonl');
    await writeFile(small, line('user', '正常大小') + '\n');
    const huge = join(dir, '2026-11-23T00-00-00-000Z_huge.jsonl');
    // 稀疏文件：逻辑大小超过上限但不真的占 32 MiB 磁盘
    await writeFile(huge, '');
    await truncate(huge, 33 * 1024 * 1024);
    const { listSessions } = await import('../../../plugins/memory-hub/server/digest.mjs');
    const listed = listSessions(root, SLUG).map((entry) => entry.name);
    assert.deepEqual(listed, ['2026-11-23T00-00-00-000Z_small.jsonl'], `oversized file was not filtered: ${listed}`);
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 4000 });
    assert.ok(result.text.includes('正常大小'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
