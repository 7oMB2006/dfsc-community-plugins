/**
 * state.mjs — team-gate 状态层
 *
 * 职责：按团队分组的状态存储 + 多进程安全的持久化。
 *   - 每个 team 有独立的 signals / presence / messages，互不串扰
 *   - 状态落盘到 <插件目录>/state/teams.json（可用 TEAM_GATE_STATE_FILE 覆盖）
 *   - 宿主可能为每个会话各起一个 MCP 进程，这些进程共用同一个状态文件：
 *     写入一律经过状态文件锁 + 读-改-写，不同进程不会用旧快照覆盖对方
 *   - 读取走内存缓存，文件变化（其他进程写过）时按 mtime/size 自动重读
 * 本层不感知 MCP 协议，也不含工具逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TEAM = 'default';
const MAX_SIGNALS = 200;
const MAX_MESSAGES = 200;
const MAX_TEAMS = 50;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 15000;
const LOCK_RETRY_MS = 5;
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATE_VERSION = 3;

export function resolveStatePath() {
  if (process.env.TEAM_GATE_STATE_FILE?.trim()) return process.env.TEAM_GATE_STATE_FILE.trim();
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'state', 'teams.json');
}

/** 归一化团队标识；非法返回 null。 */
export function normalizeTeamId(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return DEFAULT_TEAM;
  return TEAM_ID_RE.test(t) ? t : null;
}

function emptyTeam(now) {
  return { signals: [], presence: {}, messages: [], createdAt: now, updatedAt: now };
}

function capList(list, max) {
  if (list.length > max) list.splice(0, list.length - max);
}

/** 等锁时让出事件循环：写入窗口是毫秒级，不阻塞同进程的其他 MCP 请求。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TeamStore {
  constructor(file = resolveStatePath(), { log = () => {} } = {}) {
    this.file = file;
    this.lockFile = `${file}.lock`;
    this.log = log;
    /** @type {{nextMessageId:number,nextSignalId:number,teams:Map<string,any>}|null} */
    this._cache = null;
    this._cachedRaw = null;
  }

  // ---------- 持久化 ----------

  /**
   * 解析状态文件内容。**只解析，不碰文件**。
   *
   * 损坏文件的备份/改名是写操作，必须在持锁的写入路径里做（见 _mutate）。
   * 早期版本在解析时顺带 rename，只读查询也会改文件、且在锁外操作，
   * 两个进程同时判损坏会互相覆盖备份。
   */
  _parse(raw) {
    const now = new Date().toISOString();
    const state = { nextMessageId: 1, nextSignalId: 1, teams: new Map(), corrupt: false };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      state.corrupt = true;
      return state;
    }
    const teams = parsed?.teams;
    if (teams && typeof teams === 'object' && !Array.isArray(teams)) {
      for (const [id, value] of Object.entries(teams)) {
        if (!normalizeTeamId(id) || !value || typeof value !== 'object') continue;
        const team = emptyTeam(value.createdAt ?? now);
        team.updatedAt = value.updatedAt ?? team.createdAt;
        if (Array.isArray(value.signals)) team.signals = value.signals.slice(-MAX_SIGNALS);
        if (value.presence && typeof value.presence === 'object' && !Array.isArray(value.presence)) {
          team.presence = value.presence;
        }
        if (Array.isArray(value.messages)) team.messages = value.messages.slice(-MAX_MESSAGES);
        state.teams.set(id, team);
      }
    }
    if (Number.isFinite(parsed?.nextMessageId)) state.nextMessageId = parsed.nextMessageId;
    if (Number.isFinite(parsed?.nextSignalId)) state.nextSignalId = parsed.nextSignalId;
    return state;
  }

  /** 读磁盘的当前状态（绕过缓存）。
   *
   * 只读路径：读取失败或文件损坏都返回空状态，**不做任何文件改动**。
   * 写入路径不经过这里，而是由 _mutate 在持锁状态下读原文并处理损坏备份。
   */
  _readDisk() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.log('状态读取失败，按空状态处理:', String(err?.message ?? err));
      }
      this._cache = this._parse('{}');
      this._cachedRaw = null;
      return this._cache;
    }
    const state = this._parse(raw);
    if (state.corrupt) {
      // 只读路径只把损坏状态当成空来看；备份与恢复由 _mutate 在锁内完成。
      this.log('状态文件损坏（只读路径不做修复）');
      state.corrupt = false;
    }
    this._cache = state;
    this._cachedRaw = raw;
    return state;
  }

  /**
   * 取当前状态。
   *
   * 优先用缓存，但**必须**检测其他进程的写入。不能用 mtime+size 做判据：
   * Windows 上 mtimeMs 精度约 1ms，同长度内容的两次写入可能落在同一毫秒，
   * 会误判成「没变」而读到旧缓存。这里改为在每次读取时比对文件内容，
   * 状态文件很小（几十 KB 上限），代价可忽略且不受时钟精度影响。
   */
  _snapshot() {
    if (!this._cache) return this._readDisk();
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // 读不到就不能假装是空状态：沿用上一次成功读到的缓存，
        // 避免把一次瞬时故障显示成「什么数据都没有」。
        this.log('状态读取失败，沿用缓存:', String(err?.message ?? err));
        return this._cache;
      }
      // 文件确实被删（手动清理/停用）：丢掉缓存，从空状态重新开始。
      this._cache = null;
      this._cachedRaw = null;
      return this._readDisk();
    }
    if (raw === this._cachedRaw) return this._cache;
    this._cache = this._parse(raw);
    this._cachedRaw = raw;
    return this._cache;
  }

  _serialize(state) {
    return JSON.stringify({
      version: STATE_VERSION,
      nextMessageId: state.nextMessageId,
      nextSignalId: state.nextSignalId,
      teams: Object.fromEntries(state.teams),
    });
  }

  async _acquire() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        try {
          const st = fs.statSync(this.lockFile);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            // 持锁进程崩溃或被杀：锁文件过期后可接管
            fs.unlinkSync(this.lockFile);
            continue;
          }
        } catch {
          continue; // 锁刚好被释放，立刻重试
        }
        if (Date.now() >= deadline) {
          throw new Error(`状态文件锁超时（${LOCK_TIMEOUT_MS}ms）：${this.lockFile}`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  _release() {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      /* 已被接管或已删，忽略 */
    }
  }

  /**
   * 加锁读-改-写：fn 拿到磁盘上的最新状态，就地修改；返回 fn 的返回值。
   * 每次写入都基于磁盘最新内容，不会用本进程的旧快照覆盖其他进程的写入。
   * 等锁时让出事件循环，同进程的其他 MCP 请求不会被卡住。
   */
  async _mutate(fn) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    await this._acquire();
    try {
      // 损坏文件的备份必须在锁内做：两个进程同时判损坏时，锁外的 rename 会
      // 互相覆盖备份，甚至把刚备份的空状态再当成损坏文件递归处理。
      const raw = this._readRawForWrite();
      let state;
      if (raw.corrupt) {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, backup);
        this.log(`状态文件损坏，已备份到 ${backup}`);
        state = this._parse('{}');
      } else {
        state = raw.state;
      }
      const result = fn(state);
      const tmp = `${this.file}.${process.pid}.tmp`;
      const serialized = this._serialize(state);
      try {
        fs.writeFileSync(tmp, serialized);
        fs.renameSync(tmp, this.file); // 同目录原子替换
      } catch (err) {
        this.log('状态落盘失败:', String(err?.message ?? err));
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
        throw err;
      }
      // 刚写的内容就是磁盘内容：同步缓存，避免紧接着的读取重复解析，
      // 也避免本进程的下一次读取把自己刚写的状态当成"外部写入"。
      this._cache = state;
      this._cachedRaw = serialized;
      return result;
    } finally {
      this._release();
    }
  }

  /** 持锁状态下取磁盘内容：返回 { state } 或 { corrupt: true }。读错误照常抛出。 */
  _readRawForWrite() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      return { state: this._parse('{}') };
    }
    const state = this._parse(raw);
    if (state.corrupt) return { corrupt: true };
    return { state };
  }

  // ---------- 团队管理 ----------

  team(id) {
    return this._snapshot().teams.get(id) ?? emptyTeam(new Date().toISOString());
  }

  _evictIfNeeded(state) {
    if (state.teams.size < MAX_TEAMS) return;
    const oldest = [...state.teams.entries()].sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)))[0];
    if (oldest) {
      state.teams.delete(oldest[0]);
      this.log(`团队数超过 ${MAX_TEAMS}，淘汰最久未更新的团队 ${oldest[0]}`);
    }
  }

  _teamFor(state, id) {
    let team = state.teams.get(id);
    if (!team) {
      this._evictIfNeeded(state);
      team = emptyTeam(new Date().toISOString());
      state.teams.set(id, team);
    }
    team.updatedAt = new Date().toISOString();
    return team;
  }

  resetTeam(id) {
    return this._mutate((state) => {
      const team = this._teamFor(state, id);
      team.signals = [];
      team.presence = {};
      team.messages = [];
    });
  }

  listTeams() {
    return [...this._snapshot().teams.entries()]
      .map(([id, t]) => ({
        id,
        onlineCount: Object.keys(t.presence).length,
        signalCount: t.signals.length,
        messageCount: t.messages.length,
        updatedAt: t.updatedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---------- 信号 ----------

  recordSignal(id, signal) {
    return this._mutate((state) => {
      const team = this._teamFor(state, id);
      const seq = state.nextSignalId++;
      const stored = { ...signal, seq };
      team.signals.push(stored);
      capList(team.signals, MAX_SIGNALS);
      const p = team.presence[signal.label];
      if (p) {
        p.status = signal.status === 'success' ? 'done' : signal.status === 'failure' ? 'failed' : 'blocked';
        p.updatedAt = signal.at;
      }
      return stored;
    });
  }

  /** 当前最大的信号序号；team_wait 用它区分「本次等待之后的新信号」。 */
  signalCursor(id) {
    const signals = this._snapshot().teams.get(id)?.signals ?? [];
    return signals.reduce((max, s) => (Number.isFinite(s?.seq) && s.seq > max ? s.seq : max), 0);
  }

  signalsSince(id, cursor) {
    const signals = this._snapshot().teams.get(id)?.signals ?? [];
    // 老版本写入的信号没有 seq：没有游标时全部算新信号。
    return cursor === 0 ? signals.slice() : signals.filter((s) => Number.isFinite(s?.seq) && s.seq > cursor);
  }

  signalLabels(id) {
    return new Set((this._snapshot().teams.get(id)?.signals ?? []).map((s) => s.label));
  }

  /**
   * 只统计「游标之后」的信号标签。
   *
   * team_wait 必须用它而不是 signalLabels：后者包含历史信号，同一个 label 在上一轮
   * 发过之后，本轮刚一调用就会被判为已完成，把旧结果算成本轮完成。
   */
  signalLabelsSince(id, cursor) {
    return new Set(this.signalsSince(id, cursor).map((s) => s.label));
  }

  recentSignals(id, limit = 20) {
    const signals = this._snapshot().teams.get(id)?.signals ?? [];
    return limit > 0 ? signals.slice(-limit) : signals.slice();
  }

  signalCount(id) {
    return (this._snapshot().teams.get(id)?.signals ?? []).length;
  }

  // ---------- 在线状态 ----------

  upsertPresence(id, { label, role, task, status }) {
    return this._mutate((state) => {
      const team = this._teamFor(state, id);
      const prev = team.presence[label];
      const now = new Date().toISOString();
      team.presence[label] = {
        label,
        role: role ?? prev?.role ?? 'agent',
        task: task ?? prev?.task ?? '',
        status,
        joinedAt: prev?.joinedAt ?? now,
        updatedAt: now,
      };
      return team.presence[label];
    });
  }

  roster(id) {
    return Object.values(this._snapshot().teams.get(id)?.presence ?? {})
      .sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt)));
  }

  presenceOf(id, label) {
    return this._snapshot().teams.get(id)?.presence?.[label] ?? null;
  }

  // ---------- 消息 ----------

  addMessage(id, { from, to, content }) {
    return this._mutate((state) => {
      const team = this._teamFor(state, id);
      const msg = { id: state.nextMessageId++, from, to, content, at: new Date().toISOString(), readBy: [] };
      team.messages.push(msg);
      capList(team.messages, MAX_MESSAGES);
      return msg;
    });
  }

  unreadFor(id, label) {
    const messages = this._snapshot().teams.get(id)?.messages ?? [];
    return messages.filter((m) => (m.to === label || m.to === '*') && !m.readBy.includes(label));
  }

  markRead(id, label, msgs) {
    if (!msgs.length) return 0;
    const ids = new Set(msgs.map((m) => m.id));
    return this._mutate((state) => {
      const team = this._teamFor(state, id);
      let changed = 0;
      for (const m of team.messages) {
        if (!ids.has(m.id) || m.readBy.includes(label)) continue;
        m.readBy.push(label);
        changed += 1;
      }
      return changed;
    });
  }
}
