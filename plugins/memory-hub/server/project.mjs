/**
 * project.mjs — 决定一条记忆属于哪个项目
 *
 * MCP server 的工作目录被宿主锚定到插件目录，进程里也拿不到用户项目路径，
 * 所以按优先级解析：
 *   1. 工具参数 project（代理最清楚当前工作区，技能里要求优先传）
 *   2. 环境变量 MEMORY_HUB_PROJECT（给自动化与测试）
 *   3. 会话探测：读 ~/.stepcode/agent/sessions/ 下最近修改的会话文件首行的 cwd
 *   4. 回退 _default，并如实报告 source，让归属错误当场可见
 *
 * slug 规则与 DFSC 的会话目录一致（非字母数字折成 '-'，首尾包 '--'），
 * 这样用户找记忆和找会话是同一个习惯。
 */
import fs from 'node:fs';
import path from 'node:path';

export const FALLBACK_SLUG = '_default';
const SESSION_PROBE_BYTES = 400;
const SESSION_FILES_CONSIDERED = 40;

export function projectSlug(absPath) {
  // 与 DFSC 的会话目录逐字符一致：每个路径分隔符各折成一个 '-'（连续两个分隔符
  // 产生两个 '-'），空格等其它字符原样保留，再首尾包 '--'。
  const normalized = path.resolve(String(absPath)).replace(/[\\/]+$/u, '');
  return `--${normalized.replace(/[\\/:]/gu, '-')}--`;
}

function absolute(value) {
  const text = String(value ?? '').trim().replace(/^["']|["']$/gu, '');
  if (!text) return null;
  if (!path.isAbsolute(text)) return null;
  return path.normalize(text);
}

function newestSessionFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      let inner;
      try {
        inner = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of inner) {
        if (!child.isFile() || !child.name.endsWith('.jsonl')) continue;
        const file = path.join(full, child.name);
        try {
          files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
        } catch {
          /* 文件刚被删除或不可读：跳过 */
        }
      }
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        files.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        /* 同上 */
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, SESSION_FILES_CONSIDERED);
}

/** 读会话文件首行里的 cwd；只读前若干字节，不加载整份会话。 */
function cwdOfSession(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(SESSION_PROBE_BYTES);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, read).toString('utf8');
    const newline = head.indexOf('\n');
    const line = newline === -1 ? head : head.slice(0, newline);
    const value = JSON.parse(line);
    return typeof value?.cwd === 'string' ? value.cwd : null;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

export function resolveProject({ project, env = process.env, sessionsRoot } = {}) {
  const fromArg = absolute(project);
  if (fromArg) return { root: fromArg, slug: projectSlug(fromArg), source: 'arg' };
  const fromEnv = absolute(env?.MEMORY_HUB_PROJECT);
  if (fromEnv) return { root: fromEnv, slug: projectSlug(fromEnv), source: 'env' };
  if (sessionsRoot) {
    for (const { file } of newestSessionFiles(sessionsRoot)) {
      const cwd = absolute(cwdOfSession(file));
      if (cwd) return { root: cwd, slug: projectSlug(cwd), source: 'session' };
    }
  }
  return { root: null, slug: FALLBACK_SLUG, source: 'fallback' };
}
