/**
 * store.mjs — 记忆语义层：分库、条目生命周期、四个动作的编排
 *
 * 与 json-store 的分工：这里决定「哪条记忆该合并、该归档、该失效」，
 * 但把加锁与原子写入交给 JsonStore。进化规则本身在 evolve.mjs（纯函数）。
 *
 * 库的位置：
 *   <home>/<project-slug>/memory.json   项目库
 *   <home>/_global/memory.json          跨项目偏好
 * home 默认 ~/.stepcode/agent/memories，可用 MEMORY_HUB_HOME 覆盖。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from './json-store.mjs';
import {
  DECAY_DAYS, GLOBAL_CAP, MAX_TAGS, MAX_TAG_LENGTH, MAX_TEXT, PROJECT_CAP,
  RECALL_LIMIT_MAX, applyDecay, effectiveWeight, evictOverflow, findMergeCandidate, idfFactory, relevance, score, searchText,
} from './evolve.mjs';
import { clip, normalize, queryTokens, redact, tidy, tokens } from './text.mjs';
import { resolveProject } from './project.mjs';

export const TYPES = ['fact', 'decision', 'lesson', 'preference', 'pitfall'];
export const STATUSES = ['active', 'invalidated', 'archived'];
const BANK_VERSION = 1;
const GLOBAL_SLUG = '_global';
// idf 加权后，完全不沾边的查询大致落在 0.05 以下；0.12 能把「只共享通用词」的
// 条目挡掉，又不会误伤「只命中一个区分词」的条目（实测单命中约 0.2 以上）。
const RELEVANCE_FLOOR = 0.12;

export function defaultHome(env = process.env) {
  const override = String(env?.MEMORY_HUB_HOME ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.stepcode', 'agent', 'memories');
}

export function defaultSessionsRoot(env = process.env) {
  const override = String(env?.MEMORY_HUB_SESSIONS ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.stepcode', 'agent', 'sessions');
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const raw of value) {
    const tag = String(raw ?? '').replace(/[\u0000-\u001f]/gu, ' ').trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const folded = normalize(tag);
    if (seen.has(folded)) continue;
    seen.add(folded);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function unionTags(left, right) {
  return cleanTags([...(left ?? []), ...(right ?? [])]);
}

/**
 * 合并 source 标注：去重 + 保序 + 有界。
 *
 * 早期实现只判断子串是否已存在，于是 "session:a" 与 "session:a,b" 会互相包含，
 * 反复合并后 source 变成越来越长的重复串。这里改成按条目去重，并限制条数与总长度。
 */
const MAX_SOURCE_ITEMS = 4;
function mergeSource(existing, incoming) {
  const items = [];
  for (const raw of [existing, incoming]) {
    for (const part of String(raw ?? '').split(',')) {
      const value = tidy(part).slice(0, 80);
      if (!value) continue;
      if (items.some((item) => item.toLowerCase() === value.toLowerCase())) continue;
      items.push(value);
    }
  }
  const kept = items.slice(-MAX_SOURCE_ITEMS);
  if (items.length > MAX_SOURCE_ITEMS) kept[0] = `…(+${items.length - MAX_SOURCE_ITEMS})`;
  return clip(kept.join(', '), 200);
}

function emptyBank(slug) {
  return { version: BANK_VERSION, slug, memories: [], updatedAt: new Date().toISOString() };
}

function readBank(data, slug) {
  if (!data || !Array.isArray(data.memories)) return emptyBank(slug);
  return {
    version: BANK_VERSION,
    slug: typeof data.slug === 'string' ? data.slug : slug,
    memories: data.memories.filter((memory) => memory && typeof memory === 'object' && typeof memory.id === 'string'),
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
  };
}

function countsOf(memories) {
  const counts = { total: memories.length, active: 0, invalidated: 0, archived: 0 };
  for (const memory of memories) {
    if (memory.status === 'active') counts.active += 1;
    else if (memory.status === 'invalidated') counts.invalidated += 1;
    else if (memory.status === 'archived') counts.archived += 1;
  }
  return counts;
}

export class MemoryBank {
  constructor({ home, sessionsRoot, log = () => {}, env = process.env, clock = () => Date.now() } = {}) {
    this.home = path.resolve(home ?? defaultHome(env));
    this.sessionsRoot = sessionsRoot ?? defaultSessionsRoot(env);
    this.log = log;
    this.env = env;
    // 可注入时钟：衰减与淘汰依赖「现在」，测试要能站在几十天之后验证它们。
    this.clock = clock;
    this._stores = new Map();
  }

  store(slug) {
    if (!this._stores.has(slug)) {
      this._stores.set(slug, new JsonStore(path.join(this.home, slug, 'memory.json'), { log: this.log }));
    }
    return this._stores.get(slug);
  }

  resolve(project) {
    const resolved = resolveProject({ project, env: this.env, sessionsRoot: this.sessionsRoot });
    return { ...resolved, slug: resolved.slug === GLOBAL_SLUG ? '_default' : resolved.slug };
  }

  bankLabel(scope) {
    return scope === 'global' ? 'global' : 'project';
  }

  slugFor(scope, slug) {
    return this.bankLabel(scope) === 'global' ? GLOBAL_SLUG : slug;
  }

  // ---------- retain ----------

  async retain(input = {}) {
    const resolved = this.resolve(input.project);
    const scope = this.bankLabel(input.scope);
    const slug = this.slugFor(scope, resolved.slug);
    const source = clip(String(input.source ?? 'manual'), 200);
    const raw = redact(String(input.text ?? ''));
    // 折叠连续空白再落盘：否则「构建用  pnpm」这种手滑输入会原样存进去，
    // 并在合并时因为「更长」而覆盖掉干净的那条。
    const text = clip(tidy(raw.text), MAX_TEXT);
    if (!text) throw new Error('text is required: pass the fact, decision or lesson to remember');
    const type = TYPES.includes(input.type) ? input.type : 'fact';
    const tags = cleanTags(input.tags);
    const importance = clampNumber(input.importance, 0, 1, 0.5);
    const now = this.clock();
    const cap = Number.isFinite(input.cap) ? Math.max(1, input.cap) : scope === 'global' ? GLOBAL_CAP : PROJECT_CAP;
    const store = this.store(slug);

    const result = await store.mutate((data) => {
      const bank = readBank(data, slug);
      const candidate = { text, type, tags, importance };
      const existing = findMergeCandidate(bank.memories, candidate);
      // 两条分支共用同一套收尾：衰减与淘汰必须在每次写入后都跑，
      // 早期只在新增分支跑，于是「一直合并」的项目永远不会清理过期条目。
      const settle = () => {
        applyDecay(bank.memories, now, DECAY_DAYS);
        const evicted = evictOverflow(bank.memories, cap, now).evicted;
        bank.updatedAt = new Date(now).toISOString();
        return evicted;
      };
      if (existing) {
        existing.importance = Math.max(existing.importance ?? 0.5, importance);
        existing.tags = unionTags(existing.tags, tags);
        // 合并时保留更完整的说法，但不让手滑加的空格赢过干净文本：
        // 先比归一化后的长度，等长则保留已有（先写下的）那条。
        if (tidy(text).length > tidy(existing.text).length) existing.text = text;
        existing.updatedAt = new Date(now).toISOString();
        existing.source = mergeSource(existing.source, source);
        const evicted = settle();
        return {
          result: {
            ok: true, id: existing.id, action: 'merged', bank: scope, total: countsOf(bank.memories).active,
            evicted: evicted.length, redacted: raw.redacted, scope,
          },
          next: bank,
        };
      }
      const memory = {
        id: `m_${crypto.randomBytes(6).toString('hex')}`,
        type,
        text,
        tags,
        importance,
        status: 'active',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        hits: 0,
        lastHitAt: null,
        source,
      };
      bank.memories.push(memory);
      const evicted = settle();
      return {
        result: {
          ok: true, id: memory.id, action: 'added', bank: scope, total: countsOf(bank.memories).active,
          evicted: evicted.length, redacted: raw.redacted, scope,
        },
        next: bank,
      };
    });
    return { ...result, project: { root: resolved.root, slug: resolved.slug, source: resolved.source } };
  }

  // ---------- recall ----------

  async recall(input = {}) {
    const resolved = this.resolve(input.project);
    const scope = input.scope === 'global' || input.scope === 'all' ? input.scope : 'project';
    const limit = Math.round(clampNumber(input.limit, 1, RECALL_LIMIT_MAX, 8));
    const query = String(input.query ?? '').trim();
    const queryTags = cleanTags(input.tags);
    const now = this.clock();
    const wanted = new Set(queryTags.map((tag) => normalize(tag)));
    const status = input.status === 'all' ? 'all' : STATUSES.includes(input.status) ? input.status : 'active';
    const banks = [];

    if (scope === 'project' || scope === 'all') banks.push({ bank: 'project', slug: resolved.slug });
    if (scope === 'global' || scope === 'all') banks.push({ bank: 'global', slug: GLOBAL_SLUG });

    // 第一阶段：无锁读取 + 打分。查询不该为了算分而写盘。
    const pools = [];
    for (const { bank, slug } of banks) {
      const { data, corrupt } = await this.store(slug).read();
      if (corrupt) {
        this.log(`recall skipped a corrupt bank: ${slug}`);
        continue;
      }
      const memories = readBank(data, slug).memories.filter((memory) => {
        if (status !== 'all' && memory.status !== status) return false;
        if (TYPES.includes(input.type) && memory.type !== input.type) return false;
        if (wanted.size) {
          const owned = (memory.tags ?? []).map((tag) => normalize(tag));
          if (![...wanted].some((tag) => owned.includes(tag))) return false;
        }
        return true;
      });
      pools.push({ bank, slug, memories });
    }
    const scanned = pools.reduce((total, pool) => total + pool.memories.length, 0);

    // idf 在整个候选池上估一次，而不是每个库各估一次：否则同一个词在两个库里
    // 权重不同，跨库排序会偏向条目少的那个库。
    const needles = query ? queryTokens(query) : [];
    const idf = query
      ? idfFactory(pools.flatMap((pool) => pool.memories).map((memory) => searchText(memory)))
      : undefined;

    const scored = [];
    for (const pool of pools) {
      for (const memory of pool.memories) {
        if (query) {
          // 给了 query 就必须在正文或标签里真的讲到它：标签只用来收窄范围与加权，
          // 不能让一条完全没提到查询词的记忆因为标签相同而返回。
          if (relevance(needles, tokens(searchText(memory)), idf) < RELEVANCE_FLOOR) continue;
        }
        const value = query
          ? score(memory, query, now, { queryTags, idf })
          : effectiveWeight(memory, now);
        scored.push({ ...memory, score: value, bank: pool.bank, tags: memory.tags ?? [] });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const memories = scored.slice(0, limit);

    // 第二阶段：只给真正返回的条目记命中。
    // 早期实现给「所有匹配」都 +1，等于没返回的条目也在被强化，权重会长期失真。
    if (memories.length) {
      const byBank = new Map();
      for (const memory of memories) {
        if (!byBank.has(memory.bank)) byBank.set(memory.bank, new Set());
        byBank.get(memory.bank).add(memory.id);
      }
      for (const [bankLabel, ids] of byBank) {
        const slug = bankLabel === 'global' ? GLOBAL_SLUG : resolved.slug;
        await this.store(slug).mutate((data) => {
          const value = readBank(data, slug);
          let changed = false;
          for (const memory of value.memories) {
            if (!ids.has(memory.id)) continue;
            memory.hits = (memory.hits ?? 0) + 1;
            memory.lastHitAt = new Date(now).toISOString();
            changed = true;
          }
          return { result: null, next: changed ? value : data };
        });
        // 返回给调用方的 hit 计数要与落盘一致
        for (const memory of memories) {
          if (memory.bank !== bankLabel) continue;
          const stored = readBank((await this.store(slug).read()).data, slug).memories.find((item) => item.id === memory.id);
          if (stored) {
            memory.hits = stored.hits;
            memory.lastHitAt = stored.lastHitAt;
          }
        }
      }
    }

    return {
      ok: true,
      scope,
      project: { root: resolved.root, slug: resolved.slug, source: resolved.source },
      scanned,
      memories,
      note: query
        ? '按相关度排序；只把命中的条目当线索，冲突时以当前仓库与用户指令为准。'
        : '未提供 query，按权重与新近度列出。',
    };
  }

  // ---------- reflect ----------

  async reflect(input = {}) {
    const resolved = this.resolve(input.project);
    const limit = Math.round(clampNumber(input.limit, 1, RECALL_LIMIT_MAX, 10));
    const question = String(input.question ?? '').trim();
    const scope = input.scope === 'global' || input.scope === 'all' ? input.scope : 'project';
    const banks = [];
    if (scope === 'project' || scope === 'all') banks.push({ bank: 'project', slug: resolved.slug });
    if (scope === 'global' || scope === 'all') banks.push({ bank: 'global', slug: GLOBAL_SLUG });

    const rows = [];
    const superseded = [];
    for (const { bank, slug } of banks) {
      const { data } = await this.store(slug).read();
      const value = readBank(data, slug);
      for (const memory of value.memories) {
        const row = { ...memory, bank };
        if (memory.status === 'invalidated') superseded.push(row);
        else if (memory.status === 'active') rows.push(row);
      }
    }

    // reflect 是只读的：不写命中计数、不改文件，因此分值只用于排序。
    // 有 question 时必须和 recall 用同一道相关度门槛，否则证据包里会混进
    // 只共享一个通用词的条目（实测 0.033 分的那条被当成「相关证据」）。
    const now = this.clock();
    const needles = question ? queryTokens(question) : null;
    const idf = question ? idfFactory(rows.map((memory) => searchText(memory))) : undefined;
    const relevant = needles
      ? rows.filter((memory) => relevance(needles, tokens(searchText(memory)), idf) >= RELEVANCE_FLOOR)
      : rows;
    const ranked = relevant
      .map((memory) => ({ memory, score: question ? score(memory, question, now, { idf }) : effectiveWeight(memory, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory, score: value }) => ({ ...memory, score: value }));

    const groups = {};
    for (const memory of ranked) {
      groups[memory.type] = groups[memory.type] ?? [];
      groups[memory.type].push(memory);
    }
    // 冲突 = 同标签或高度相似、但其中一条已失效的证据组；不自动裁决，交回给调用方判断。
    const conflicts = [];
    for (const dead of superseded) {
      const peers = ranked.filter((memory) =>
        memory.tags?.some((tag) => dead.tags?.includes(tag)) ||
        (memory.text && dead.text && tokens(memory.text).some((token) => tokens(dead.text).includes(token) && token.length > 1)));
      if (peers.length) conflicts.push([dead, ...peers]);
    }

    return {
      ok: true,
      question,
      project: { root: resolved.root, slug: resolved.slug, source: resolved.source },
      groups,
      conflicts: conflicts.slice(0, 5),
      counts: { active: rows.length, superseded: superseded.length },
      note: 'reflect 只是把已存记忆按类型组装成证据包，不调用模型、不生成新结论；矛盾条目并列保留。',
    };
  }

  // ---------- edit ----------

  async edit(input = {}) {
    const resolved = this.resolve(input.project);
    const id = String(input.id ?? '').trim();
    if (!id) throw new Error('id is required');
    const op = String(input.op ?? '').trim();
    if (!['update', 'invalidate', 'restore', 'forget', 'archive'].includes(op)) {
      throw new Error('op must be one of update, invalidate, restore, forget, archive');
    }
    if (op === 'forget' && String(input.confirm ?? '') !== 'yes' && String(input.confirm ?? '').toUpperCase() !== 'DELETE') {
      throw new Error('forget requires confirm: "yes"');
    }
    const now = this.clock();
    // 没指定 scope 时先查项目库，找不到再查全局库：recall 可以跨库返回条目，
    // 如果 edit 只能改项目库，用户拿到一个全局记忆的 id 就永远改不了它。
    const scopeHint = input.scope === 'global' || input.scope === 'project' ? input.scope : null;
    const order = scopeHint ? [scopeHint] : ['project', 'global'];

    let lastMiss = null;
    for (const scope of order) {
      const slug = this.slugFor(scope, resolved.slug);
      const outcome = await this.store(slug).mutate((data) => {
        const bank = readBank(data, slug);
        const index = bank.memories.findIndex((memory) => memory.id === id);
        if (index === -1) return { result: { miss: true, bank: scope }, next: data };
        const memory = bank.memories[index];
        const done = (status, extra = {}) => {
          bank.updatedAt = new Date(now).toISOString();
          return { result: { ok: true, status, id, bank: scope, memory, ...extra }, next: bank };
        };
        if (op === 'forget') {
          bank.memories.splice(index, 1);
          bank.updatedAt = new Date(now).toISOString();
          return { result: { ok: true, status: 'deleted', id, bank: scope, memory }, next: bank };
        }
        if (op === 'update') {
          const raw = redact(String(input.text ?? ''));
          if (input.text !== undefined) {
            const text = clip(tidy(raw.text), MAX_TEXT);
            if (!text) throw new Error('update needs non-empty text');
            memory.text = text;
          }
          if (input.importance !== undefined) memory.importance = clampNumber(input.importance, 0, 1, memory.importance ?? 0.5);
          if (input.tags !== undefined) memory.tags = cleanTags(input.tags);
          if (input.type !== undefined && TYPES.includes(input.type)) memory.type = input.type;
          memory.updatedAt = new Date(now).toISOString();
          return done('updated', { redacted: raw.redacted });
        }
        if (op === 'invalidate') {
          memory.status = 'invalidated';
          memory.updatedAt = new Date(now).toISOString();
          if (input.replacementId) memory.supersededBy = String(input.replacementId);
          return done('invalidated');
        }
        if (op === 'archive') {
          memory.status = 'archived';
          memory.updatedAt = new Date(now).toISOString();
          return done('archived');
        }
        // restore
        memory.status = 'active';
        memory.updatedAt = new Date(now).toISOString();
        delete memory.supersededBy;
        return done('restored');
      });
      if (outcome && !outcome.miss) return outcome;
      lastMiss = outcome;
    }
    return { ok: false, status: 'not_found', id, bank: lastMiss?.bank ?? 'project', searched: order };
  }

  // ---------- maintenance ----------

  /** 手动触发一次衰减与容量淘汰；写入路径已自动执行，这里供 /memory 与排查使用。 */
  async maintenance({ project, days = DECAY_DAYS, cap = PROJECT_CAP, globalCap = GLOBAL_CAP } = {}) {
    const resolved = this.resolve(project);
    const window = Number.isFinite(Number(days)) ? Number(days) : DECAY_DAYS;
    const archived = [];
    const evicted = [];
    for (const [slug, limit] of [[resolved.slug, cap], [GLOBAL_SLUG, globalCap]]) {
      await this.store(slug).mutate((data) => {
        const bank = readBank(data, slug);
        const decay = applyDecay(bank.memories, this.clock(), window);
        const overflow = evictOverflow(bank.memories, limit, this.clock());
        archived.push(...decay.archived);
        evicted.push(...overflow.evicted);
        if (!decay.archived.length && !overflow.evicted.length) return { result: null, next: data };
        bank.updatedAt = new Date(this.clock()).toISOString();
        return { result: null, next: bank };
      });
    }
    return { ok: true, archived, evicted };
  }

  // ---------- stats ----------

  async stats({ project } = {}) {
    const resolved = this.resolve(project);
    const banks = {};
    const corrupt = {};
    const storage = {};
    for (const [label, slug] of [['project', resolved.slug], ['global', GLOBAL_SLUG]]) {
      const store = this.store(slug);
      const { data, corrupt: broken } = await store.read();
      const bank = readBank(broken ? null : data, slug);
      banks[label] = countsOf(bank.memories);
      corrupt[label] = Boolean(broken);
      storage[label] = store.file;
    }
    const projectData = await this.store(resolved.slug).read();
    const projectBank = readBank(projectData.corrupt ? null : projectData.data, resolved.slug);
    const tagCounts = new Map();
    for (const memory of projectBank.memories) {
      if (memory.status !== 'active') continue;
      for (const tag of memory.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));
    return {
      ok: true,
      project: { root: resolved.root, slug: resolved.slug, source: resolved.source },
      banks,
      caps: { project: PROJECT_CAP, global: GLOBAL_CAP },
      storage,
      corrupt,
      topTags,
      home: this.home,
    };
  }

  // ---------- purge ----------

  async purge({ scope = 'project', confirm, project } = {}) {
    if (String(confirm ?? '') !== 'DELETE') throw new Error('purge requires confirm: "DELETE"');
    const resolved = this.resolve(project);
    const targets = scope === 'global'
      ? [{ label: 'global', slug: GLOBAL_SLUG }]
      : scope === 'all'
        ? [{ label: 'project', slug: resolved.slug }, { label: 'global', slug: GLOBAL_SLUG }]
        : [{ label: 'project', slug: resolved.slug }];
    const moved = [];
    let removed = 0;
    for (const { label, slug } of targets) {
      const store = this.store(slug);
      // 计数与改名必须在同一把锁里完成：先 read 再 rename 的间隙里，
      // 另一个会话可能刚写入，那样「移走了 N 条」的 N 和实际文件对不上。
      const cleaned = await store.inspect(async (parsed) => {
        if (parsed === null) return null;
        const count = readBank(parsed.corrupt ? null : parsed.data, slug).memories.length;
        const stamp = new Date(this.clock()).toISOString().replace(/[:.]/gu, '-');
        const target = `${store.file}.trash-${stamp}`;
        await fs.promises.rename(store.file, target);
        return { count, target, corrupt: Boolean(parsed.corrupt) };
      });
      if (!cleaned) continue;
      removed += cleaned.count;
      moved.push({ bank: label, path: cleaned.target, memories: cleaned.count, corrupt: cleaned.corrupt });
    }
    return { ok: true, removed, moved, movedTo: moved[0]?.path ?? null };
  }
}
