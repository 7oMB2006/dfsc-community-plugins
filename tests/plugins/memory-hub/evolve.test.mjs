import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveWeight, score, findMergeCandidate, applyDecay, evictOverflow,
  MERGE_THRESHOLD, DECAY_DAYS, PROJECT_CAP, idfFactory, relevance, searchText,
} from '../../../plugins/memory-hub/server/evolve.mjs';
import { queryTokens, tokens } from '../../../plugins/memory-hub/server/text.mjs';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 23);

function memory(overrides = {}) {
  return {
    id: 'm_1', type: 'fact', text: 'alpha beta', tags: [], importance: 0.5,
    status: 'active', createdAt: new Date(now - 5 * DAY).toISOString(),
    updatedAt: new Date(now - 5 * DAY).toISOString(),
    hits: 0, lastHitAt: null, source: 'test', ...overrides,
  };
}

test('effectiveWeight grows with hits but stays bounded', () => {
  const cold = effectiveWeight(memory({ hits: 0 }), now);
  const warm = effectiveWeight(memory({ hits: 10 }), now);
  const hot = effectiveWeight(memory({ hits: 1000 }), now);
  assert.ok(cold < warm, 'recalled memories weigh more');
  assert.ok(warm < hot);
  assert.ok(hot <= 1, `weight must stay <= 1, got ${hot}`);
});

test('effectiveWeight prefers the stored importance when nothing was recalled', () => {
  const low = effectiveWeight(memory({ importance: 0.2 }), now);
  const high = effectiveWeight(memory({ importance: 0.9 }), now);
  assert.ok(high > low);
});

test('score ranks an exact match above an unrelated memory', () => {
  const query = 'build uses pnpm';
  const hit = score(memory({ text: 'build uses pnpm for everything' }), query, now);
  const miss = score(memory({ text: 'unrelated deployment trivia' }), query, now);
  assert.ok(hit > miss, `expected ${hit} > ${miss}`);
});

test('score rewards tag overlap', () => {
  const plain = score(memory({ text: 'zzz', tags: [] }), '构建', now, { queryTags: ['构建'] });
  const tagged = score(memory({ text: 'zzz', tags: ['构建'] }), '构建', now, { queryTags: ['构建'] });
  assert.ok(tagged > plain);
});

test('an unrelated memory scores near zero instead of a quality baseline', () => {
  // 早期实现里「权重 + 新近度」是无条件加分，零重叠条目也能拿 0.45。
  const unrelated = score(memory({ text: '完全无关的部署琐事', importance: 1, hits: 50 }), '构建用 pnpm', now);
  const relevant = score(memory({ text: '构建用 pnpm workspaces', importance: 0.3 }), '构建用 pnpm', now);
  assert.ok(unrelated < 0.1, `unrelated should be near zero, got ${unrelated}`);
  assert.ok(relevant > unrelated * 3, `relevant ${relevant} should clearly beat ${unrelated}`);
});

test('relevance weights rare tokens above words every memory shares', () => {
  const texts = ['记忆库存在 memories 目录', '记忆里有一条结论', '记忆会随时间归档'];
  const idf = idfFactory(texts);
  const rare = relevance(queryTokens('memories 在哪'), tokens(texts[0]), idf);
  const common = relevance(queryTokens('memories 在哪'), tokens(texts[1]), idf);
  assert.ok(rare > common, `rare token should win: ${rare} vs ${common}`);
  assert.equal(common, 0, 'a memory that never mentions the distinctive token is not relevant');
});

test('query fragments absent from every document do not dilute the denominator', () => {
  const texts = ['用户要求所有产出中文', '构建用 pnpm workspaces'];
  const idf = idfFactory(texts);
  // 「户喜」「欢什」「么风」这类碎片只属于这句问法，库里没有，不该占分母
  const value = relevance(queryTokens('用户喜欢什么风格'), tokens(texts[0]), idf);
  assert.ok(value >= 0.12, `expected the real match to clear the floor, got ${value}`);
});

test('a single shared character is heavily discounted', () => {
  const texts = ['必须靠工具参数 project 显式传', '构建用 pnpm workspaces'];
  const idf = idfFactory(texts);
  // 「数据库索引优化」里只有「数」在第一条出现过，属于偶然重合
  const coincidence = relevance(queryTokens('数据库索引优化'), tokens(texts[0]), idf);
  const unrelated = relevance(queryTokens('数据库索引优化'), tokens(texts[1]), idf);
  // 对照：一个真正讲到目标的二字组命中
  const genuine = relevance(queryTokens('构建怎么跑'), tokens(texts[1]), idf);
  assert.equal(unrelated, 0, 'no shared token at all');
  assert.ok(coincidence < genuine, `single-char coincidence ${coincidence} must rank below a real match ${genuine}`);
});

test('sharing only a single character is not relevance at all', () => {
  // 结构性规则，不是打分折扣：单字重合必须完全不计入结果，
  // 否则噪声条目会被返回、并让它的 hits 长期递增。
  const texts = ['必须靠工具参数 project 显式传', 'memory-hub 已重新生效'];
  const idf = idfFactory(texts);
  for (const text of texts) {
    assert.equal(relevance(queryTokens('数据库索引优化'), tokens(text), idf), 0,
      `single-character overlap must score 0 for: ${text}`);
  }
});

test('a real bigram still clears the floor on its own', () => {
  const texts = ['构建用 pnpm workspaces', '部署由运维手动触发'];
  const idf = idfFactory(texts);
  const value = relevance(queryTokens('构建用什么工具'), tokens(texts[0]), idf);
  assert.ok(value >= 0.12, `a genuine bigram hit must survive the floor, got ${value}`);
});

test('searchText includes tags so hand-written keywords are findable', () => {
  assert.match(searchText({ text: '正文', tags: ['构建', '测试'] }), /构建/u);
  assert.equal(searchText({ text: '正文' }), '正文');
});

test('queryTokens expands a small synonym table without touching stored text', () => {
  const expanded = queryTokens('用户喜欢什么风格');
  assert.ok(expanded.includes('偏好') || expanded.includes('要求'), `expected synonym expansion, got ${expanded.join(',')}`);
  assert.ok(!tokens('用户要求所有产出中文').includes('偏好'), 'stored text keeps the author wording');
});

test('findMergeCandidate merges identical normalised text', () => {
  const existing = [memory({ id: 'm_a', text: 'Build   uses pnpm' })];
  const found = findMergeCandidate(existing, { text: 'build uses pnpm' });
  assert.equal(found?.id, 'm_a');
});

test('findMergeCandidate merges near-duplicates above the threshold', () => {
  const existing = [memory({ id: 'm_a', text: 'run the test suite with node --test before commit' })];
  const found = findMergeCandidate(existing, { text: 'run the test suite with node --test, before commit' });
  assert.equal(found?.id, 'm_a');
  assert.ok(MERGE_THRESHOLD > 0.5 && MERGE_THRESHOLD < 1);
});

test('findMergeCandidate keeps distinct memories apart', () => {
  const existing = [memory({ id: 'm_a', text: 'the build uses pnpm workspaces' })];
  assert.equal(findMergeCandidate(existing, { text: '部署走 GitHub Actions 的 ubuntu runner' }), null);
});

test('findMergeCandidate ignores invalidated and archived memories', () => {
  const existing = [memory({ id: 'm_a', status: 'invalidated' })];
  assert.equal(findMergeCandidate(existing, { text: 'alpha beta' }), null);
});

test('findMergeCandidate keeps contradictory values apart', () => {
  // 这两条只差一个词，但结论相反；合并会静默丢掉一次改主意的历史。
  const existing = [memory({ id: 'm_a', type: 'fact', text: '构建用 pnpm' })];
  assert.equal(findMergeCandidate(existing, { type: 'fact', text: '构建用 npm' }), null);
});

test('findMergeCandidate does not merge across memory types', () => {
  const existing = [memory({ id: 'm_a', type: 'fact', text: 'run tests before commit' })];
  assert.equal(findMergeCandidate(existing, { type: 'lesson', text: 'run tests before commit' }), null);
});

test('applyDecay archives only stale active memories', () => {
  const memories = [
    memory({ id: 'stale', hits: 0, updatedAt: new Date(now - (DECAY_DAYS + 10) * DAY).toISOString() }),
    memory({ id: 'used', hits: 3, updatedAt: new Date(now - (DECAY_DAYS + 10) * DAY).toISOString() }),
    memory({ id: 'fresh', hits: 0, updatedAt: new Date(now - DAY).toISOString() }),
  ];
  const { archived } = applyDecay(memories, now, DECAY_DAYS);
  assert.deepEqual(archived, ['stale']);
  assert.equal(memories.find((m) => m.id === 'stale').status, 'archived');
  assert.equal(memories.find((m) => m.id === 'used').status, 'active');
});

test('evictOverflow archives the weakest memories until the cap holds', () => {
  const memories = Array.from({ length: 5 }, (_, index) =>
    memory({ id: `m_${index}`, importance: index / 10, text: `memory number ${index}` }));
  const { evicted } = evictOverflow(memories, 3, now);
  assert.equal(evicted.length, 2);
  const active = memories.filter((m) => m.status === 'active');
  assert.equal(active.length, 3);
  assert.ok(!active.some((m) => m.id === 'm_0'), 'the weakest entry is archived first');
  assert.ok(PROJECT_CAP >= 100);
});

test('evictOverflow reports nothing when under the cap', () => {
  const memories = [memory({ id: 'm_a' })];
  assert.deepEqual(evictOverflow(memories, 10, now).evicted, []);
});
