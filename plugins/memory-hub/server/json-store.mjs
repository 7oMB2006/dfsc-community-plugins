/**
 * json-store.mjs — 通用 JSON 文件存储：锁 + 读-改-写 + 原子替换
 *
 * 这里没有任何记忆业务语义，只解决一个问题：多个 MCP 进程（宿主可能为每个会话
 * 各起一个）读写同一份文件时，不能用旧快照覆盖对方的写入。
 *
 * 约定：
 *   - read() 只读，损坏时返回 corrupt: true，绝不改文件
 *   - mutate(fn) 持锁读盘、fn 返回 { result, next }、写临时文件后 rename 替换
 *   - 锁超时报错（不静默继续写）；陈旧锁（默认 15 秒）可接管
 *   - fn 抛错时释放锁，不留下残锁
 *
 * 缓存纪律（踩过的坑）：read() 的缓存只能被「刚刚成功写入的内容」或「刚刚读到的
 * 同一份文件内容」更新。早期实现里 mutate 之后紧接 read 可能命中另一进程写入之前的
 * 旧缓存，表现为「刚写的记忆查不到」。所有写入后都会把 _cache 置为写出的内容，
 * 但读写之间仍可能有第三方写入，所以真正的写路径一律走 mutate，不用 read 的缓存。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 15_000;
const RETRY_MS = 5;
// 单份库文件的上限：600 条 × 2 KB 正文远超这个值，出现说明文件被外部改坏或误放。
export const MAX_STORE_BYTES = 16 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JsonStore {
  constructor(file, {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    maxBytes = MAX_STORE_BYTES,
    log = () => {},
  } = {}) {
    this.file = file;
    this.lockFile = `${file}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleMs = staleMs;
    this.maxBytes = maxBytes;
    this.log = log;
    this._cache = null;
    this._cachedRaw = null;
    this._corruptBackup = null;
  }

  _parse(raw) {
    if (!raw) return { data: null, corrupt: false };
    try {
      const data = JSON.parse(raw);
      const usable = data && typeof data === 'object' && !Array.isArray(data);
      return usable ? { data, corrupt: false } : { data: null, corrupt: true };
    } catch {
      return { data: null, corrupt: true };
    }
  }

  /** 只读：任何失败都退化为「没有数据」，绝不改文件、绝不抛给调用方。 */
  async read() {
    let raw;
    try {
      const info = await fs.promises.stat(this.file);
      if (info.size > this.maxBytes) {
        this.log(`store exceeds ${this.maxBytes} bytes; reporting as corrupt`);
        return { data: null, corrupt: true, backup: this._corruptBackup };
      }
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 瞬时读错误不能伪装成空库：沿用最近一次成功的缓存。
        if (this._cache) return this._cache;
        this.log(`read failed: ${error?.message ?? error}`);
        return { data: null, corrupt: false, backup: null };
      }
      // 文件确实不存在（首次使用或被清空）：清掉缓存，避免继续返回旧内容。
      this._cache = null;
      this._cachedRaw = null;
      return { data: null, corrupt: false, backup: null };
    }
    if (raw === this._cachedRaw && this._cache) return this._cache;
    const parsed = this._parse(raw);
    const result = { ...parsed, backup: parsed.corrupt ? this._corruptBackup : null };
    this._cache = result;
    this._cachedRaw = raw;
    return result;
  }

  async _acquire() {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = await fs.promises.open(this.lockFile, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const info = await fs.promises.stat(this.lockFile);
          if (Date.now() - info.mtimeMs > this.staleMs) {
            // 持锁进程崩溃或被强杀：锁文件过期后接管。删失败说明别人刚释放，直接重试。
            await fs.promises.unlink(this.lockFile).catch(() => {});
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`lock timeout (${this.lockTimeoutMs}ms) on ${path.basename(this.lockFile)}; `
            + 'another memory-hub process may be stuck');
        }
        await sleep(RETRY_MS);
      }
    }
  }

  async _release() {
    await fs.promises.unlink(this.lockFile).catch(() => {});
  }

  async mutate(fn) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await this._acquire();
    try {
      let raw = null;
      let corrupt = false;
      try {
        const info = await fs.promises.stat(this.file);
        if (info.size > this.maxBytes) {
          corrupt = true;
        } else {
          raw = await fs.promises.readFile(this.file, 'utf8');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const parsed = corrupt ? { data: null, corrupt: true } : raw === null ? { data: null, corrupt: false } : this._parse(raw);
      let current = parsed.data;
      if (parsed.corrupt) {
        // 损坏文件的备份只能在锁内做：锁外的 rename 会让两个进程互相覆盖备份。
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await fs.promises.rename(this.file, backup);
        this._corruptBackup = backup;
        this.log(`corrupt store moved to ${path.basename(backup)}`);
        current = null;
      }
      const outcome = fn(current);
      const next = outcome && typeof outcome === 'object' && 'next' in outcome ? outcome.next : outcome;
      const serialized = JSON.stringify(next ?? {}, null, 2);
      if (serialized.length > this.maxBytes) {
        throw new Error(`refusing to write ${serialized.length} bytes, over the ${this.maxBytes} byte limit`);
      }
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        await fs.promises.writeFile(tmp, serialized);
        await fs.promises.rename(tmp, this.file);
      } catch (error) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw error;
      }
      this._cache = { data: next ?? {}, corrupt: false, backup: null };
      this._cachedRaw = serialized;
      if (!parsed.corrupt) this._corruptBackup = null;
      return outcome && typeof outcome === 'object' && 'result' in outcome ? outcome.result : outcome;
    } finally {
      await this._release();
    }
  }

  /**
   * 持锁执行一段只读逻辑，保证读到的就是当前磁盘内容。
   *
   * 用在「读出来要基于它做判断、随后可能删除文件」的路径上（例如 purge）：
   * 单纯 read() 之后删除，中间别的进程可能刚写入，删掉的就不是读到的那份。
   * 文件不存在时回调收到 null（而不是空的解析结果），让调用方区分「没有库」和「库是空的」。
   */
  async inspect(fn) {
    await this._acquire();
    try {
      let raw = null;
      try {
        const info = await fs.promises.stat(this.file);
        if (info.size <= this.maxBytes) raw = await fs.promises.readFile(this.file, 'utf8');
        else return fn({ data: null, corrupt: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return fn(null);
      }
      return fn(this._parse(raw));
    } finally {
      await this._release();
    }
  }
}
