/**
 * evolve.mjs — 记忆的「自进化」全部在这里，且全是纯函数
 *
 * 不调模型、不读时间以外的外部状态，因此可以在测试里用固定 now 精确验证：
 *   - findMergeCandidate：写入时与已有条目比对，重复则并入而不是新增
 *   - effectiveWeight + score：召回时按相似度、历史命中、新近度、标签排序
 *   - applyDecay：长期没人用的条目归档（保留历史，不删除）
 *   - evictOverflow：超过容量时先归档最弱的，并把归档清单回报给调用方
 *
 * 常数集中在此，改行为只改这里。
 */
import { cosine, isStopword, normalize, queryTokens, tokens } from './text.mjs';

// 0.92 而不是更低：中文二元组让「构建用 pnpm」和「构建用 npm」相似度就到 0.83，
// 阈值一松就会把互相矛盾的结论并入同一条，等于丢掉「后来改主意了」这件事。
// 标点/空白差异的重复文本相似度为 1，仍会合并。
export const MERGE_THRESHOLD = 0.92;
export const DECAY_DAYS = 60;
export const HIT_BOOST = 0.05;
export const PROJECT_CAP = 600;
export const GLOBAL_CAP = 300;
export const MAX_TEXT = 2000;
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 32;
export const RECALL_LIMIT_MAX = 20;

const DAY_MS = 86_400_000;
// 相关度是乘数，不是加数。早期实现把「权重 + 新近度」当独立加分项，
// 实测零重叠的条目也能拿 0.45 分（查 "pnpm" 时一条无关记忆排到第二），
// 于是检索结果被重要度和时间主导，而不是被「是否真的讲到这件事」主导。
const QUALITY = { weight: 0.5, recency: 0.3, tags: 0.2 };
// 中文单字几乎出现在每句中文里，只配单字等于没配；二字组才有区分度。
const BIGRAM_WEIGHT = 1;
const UNIGRAM_WEIGHT = 0.35;
const LATIN_WEIGHT = 1;
// 只共享单个汉字不算相关（见 relevance 的规则 1），因此不再需要按比例打折。
// 与 query 完全无关的条目给一个极低的底分，而不是 0：让「没有匹配」可被调用方
// 用阈值判断（recall 自己会按 relevance 过滤，这个底分只影响排序稳定性）。
const FLOOR = 0.02;

function daysSince(iso, now) {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return 365;
  return Math.max(0, (now - time) / DAY_MS);
}

/** 有效权重：基础重要度 + 命中带来的对数增益，封顶 1。 */
export function effectiveWeight(memory, now = Date.now()) {
  const base = Number.isFinite(memory?.importance) ? Math.min(1, Math.max(0, memory.importance)) : 0.5;
  const hits = Number.isFinite(memory?.hits) ? Math.max(0, memory.hits) : 0;
  return Math.min(1, base + HIT_BOOST * Math.log1p(hits));
}

function recency(memory, now) {
  return 1 / (1 + daysSince(memory?.updatedAt ?? memory?.createdAt, now) / 30);
}

/** 条目参与检索的正文：text + tags。标签是作者手写的关键词，理应可被检索。 */
export function searchText(memory) {
  const tags = Array.isArray(memory?.tags) ? memory.tags.join(' ') : '';
  return tags ? `${memory?.text ?? ''} ${tags}` : String(memory?.text ?? '');
}

/** 召回打分：相关度（乘）质量（加）。queryTags 命中提升相关度。 */
export function score(memory, query, now = Date.now(), { queryTags = [], idf = undefined } = {}) {
  const wantedTokens = queryTokens(query);
  const memoryTokens = tokens(searchText(memory));
  const relevant = relevance(wantedTokens, memoryTokens, idf);
  const wanted = new Set(queryTags.map((tag) => normalize(tag)).filter(Boolean));
  const owned = new Set((memory?.tags ?? []).map((tag) => normalize(tag)));
  let tagHits = 0;
  for (const tag of wanted) if (owned.has(tag)) tagHits += 1;
  const tagScore = wanted.size === 0 ? 0 : tagHits / wanted.size;
  const quality = QUALITY.weight * effectiveWeight(memory, now)
    + QUALITY.recency * recency(memory, now)
    + QUALITY.tags * tagScore;
  // 正文重合决定是否相关；标签相同可以加权，但最多把相关度补到 0.5——
  // 它不能把「正文完全没讲到」的条目抬到和真命中一样高。
  // recall 另有一道正文相关度过滤，所以标签只能提升排序，不能决定是否返回。
  const relevanceScore = Math.max(relevant, tagScore * 0.5);
  return FLOOR + relevanceScore * quality;
}

/** 有区分度的词元：拉丁整词与中文二字组。单字不算。 */
export function isDistinctive(token) {
  return /^[a-z0-9_+-]+$/u.test(token) || [...token].length >= 2;
}

/**
 * 按 idf 加权的重合度，0..1。
 *
 * 三条规则，前两条是结构性的（不是可调常数）：
 *
 *   1. **只共享单个汉字不算相关**。中文单字偶然重合太常见：「数据库索引优化」
 *      与「工具参数」「重新」这类条目只共享 `数`、`库`，却被算成命中并返回，
 *      还会把这条噪声的命中数 +1、长期强化它。所以要求至少有一个
 *      拉丁整词或中文二字组命中，否则直接 0。
 *   2. **停用单字不进分母**（「是/什么/的」几乎每句都有）。
 *   3. **库里从未出现过的查询词也不进分母**。中文按二字组切分，一句问法会带出
 *      「户喜」「欢什」「么风」这类只属于这句话的碎片；它们不可能命中任何条目，
 *      留在分母里只会把真正的命中摊薄到门槛以下。
 */
export function relevance(needles, memoryTokens, idf = undefined) {
  if (!needles?.length || !memoryTokens?.length) return 0;
  const memorySet = new Set(memoryTokens);
  const weighted = [];
  for (const token of new Set(needles)) {
    const weight = tokenWeight(token) * (idf ? idf(token) : 1);
    if (weight > 0) weighted.push({ token, weight });
  }
  if (!weighted.length) return 0;
  let matched = 0;
  let total = 0;
  let distinctiveHit = false;
  for (const { token, weight } of weighted) {
    total += weight;
    if (!memorySet.has(token)) continue;
    matched += weight;
    if (isDistinctive(token)) distinctiveHit = true;
  }
  // 规则 1：只有单字重合，视为不相关。
  if (!distinctiveHit) return 0;
  return total === 0 ? 0 : matched / total;
}

function tokenWeight(token) {
  // 拉丁整词最有区分度。
  if (/^[a-z0-9_+-]+$/u.test(token)) return LATIN_WEIGHT;
  // 二字组次之。
  if ([...token].length >= 2) return BIGRAM_WEIGHT;
  // 单字只作补充：能否返回由上方的「至少一个区分词命中」决定，
  // 单字只影响分母与轻微的得分加成。
  return UNIGRAM_WEIGHT;
}

/** 从一批条目估 idf：只在越少条目出现越重要，用对数压缩。 */
export function idfFactory(texts) {
  const documentFrequency = new Map();
  for (const text of texts) {
    for (const token of new Set(tokens(text))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = Math.max(1, texts.length);
  return (token) => {
    const df = documentFrequency.get(token);
    // 从未出现在任何文档里的词权重为 0：它不可能命中任何一条，
    // 留在分母里只会稀释真正的命中。停用单字同样归零。
    if (!df || isStopword(token)) return 0;
    return Math.log(1 + total / (1 + df));
  };
}

/**
 * 找可以合并的条目：归一化文本相同，或同类型且相似度达到阈值。
 * 只在 active 里找；跨类型不合并——一条「事实」和一条「教训」讲同一件事时，
 * 两者的用途不同，合成一条会同时削弱两边。
 */
export function findMergeCandidate(memories, candidate, threshold = MERGE_THRESHOLD) {
  const text = normalize(candidate?.text);
  if (!text) return null;
  const candidateTokens = tokens(text);
  const sameType = candidate?.type === undefined;
  for (const memory of memories ?? []) {
    if (memory?.status !== 'active') continue;
    if (!sameType && memory.type !== candidate.type) continue;
    if (normalize(memory.text) === text) return memory;
    if (cosine(candidateTokens, tokens(memory.text)) >= threshold) return memory;
  }
  return null;
}

/** 过期归档：active + 从未命中 + 超过窗口。返回被归档的 id。 */
export function applyDecay(memories, now = Date.now(), days = DECAY_DAYS) {
  const archived = [];
  for (const memory of memories ?? []) {
    if (memory?.status !== 'active') continue;
    if ((memory.hits ?? 0) > 0) continue;
    const stamp = memory.lastHitAt ?? memory.updatedAt ?? memory.createdAt;
    if (daysSince(stamp, now) <= days) continue;
    memory.status = 'archived';
    memory.updatedAt = new Date(now).toISOString();
    archived.push(memory.id);
  }
  return { archived };
}

/** 容量淘汰：active 超过 cap 时按有效权重从低到高归档。 */
export function evictOverflow(memories, cap, now = Date.now()) {
  const active = (memories ?? []).filter((memory) => memory?.status === 'active');
  if (active.length <= cap) return { evicted: [] };
  const weakestFirst = [...active].sort((a, b) => {
    const delta = effectiveWeight(a, now) - effectiveWeight(b, now);
    if (delta !== 0) return delta;
    return String(a.updatedAt ?? a.createdAt).localeCompare(String(b.updatedAt ?? b.createdAt));
  });
  const evicted = [];
  for (const memory of weakestFirst.slice(0, active.length - cap)) {
    memory.status = 'archived';
    memory.updatedAt = new Date(now).toISOString();
    evicted.push(memory.id);
  }
  return { evicted };
}
