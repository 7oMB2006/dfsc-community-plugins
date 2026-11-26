/**
 * digest.mjs — 把最近的会话压缩成可读素材，供代理做记忆巩固
 *
 * 只做「取素材」，不做摘要：摘要需要模型，而插件进程拿不到宿主模型 Key。
 * 因此这里严格有界——限制会话数、单行大小、总字符数，超出即停并标记 truncated，
 * 避免一次巩固把几十 MB 的会话读进上下文。
 *
 * 跳过规则：
 *   - 子代理会话（*subagent-*.jsonl）：它们是被派发的临时工作，不是用户的主线
 *   - toolResult 消息：工具输出噪声大、体积大，且不是「人的决定」
 *   - 超过 8 KB 的单行：一条超长消息不值得占掉整个预算
 */
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './text.mjs';

const MAX_LINE_BYTES = 8 * 1024;
const MAX_LINE_CHARS = 2000;
// 单个会话文件上限。一次巩固读的是「素材」而不是归档，超过这个尺寸说明它不是
// 正常的人类对话（例如被粘贴了大段构建日志），直接跳过比读进内存更安全。
const MAX_SESSION_BYTES = 32 * 1024 * 1024;

export function listSessions(sessionsRoot, slug) {
  const dir = path.join(sessionsRoot, slug);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    if (entry.name.includes('subagent-')) continue;
    const file = path.join(dir, entry.name);
    try {
      const info = fs.statSync(file);
      if (info.size > MAX_SESSION_BYTES) continue;
      files.push({ file, name: entry.name, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      /* 文件在扫描后被删除：跳过 */
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** 流式按行读取，累计到预算即停；返回 { lines, truncated }。 */
async function readSession(file, budget) {
  const lines = [];
  let used = 0;
  let truncated = false;
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let carry = '';
  try {
    for await (const chunk of stream) {
      carry += chunk;
      let index = carry.indexOf('\n');
      while (index !== -1) {
        const line = carry.slice(0, index);
        carry = carry.slice(index + 1);
        index = carry.indexOf('\n');
        if (line.length > MAX_LINE_BYTES) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record?.type !== 'message') continue;
        const role = record.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = textOf(record.message).trim();
        if (!text) continue;
        const safe = redact(text.slice(0, MAX_LINE_CHARS)).text.replace(/\s+/gu, ' ');
        const rendered = `${role === 'user' ? '用户' : '助手'}: ${safe}`;
        if (used + rendered.length > budget) {
          truncated = true;
          return { lines, truncated };
        }
        lines.push(rendered);
        used += rendered.length + 1;
      }
    }
  } finally {
    stream.destroy();
  }
  return { lines, truncated };
}

export async function digestSessions({ sessionsRoot, slug, count = 1, maxChars = 12_000 } = {}) {
  const wanted = Math.min(10, Math.max(1, Math.floor(Number(count) || 1)));
  const budget = Math.min(60_000, Math.max(1000, Math.floor(Number(maxChars) || 12_000)));
  const files = listSessions(sessionsRoot, slug).slice(0, wanted);
  if (!files.length) return { ok: true, sessions: [], text: '', truncated: false, chars: 0 };

  const sessions = [];
  const blocks = [];
  let remaining = budget;
  let truncated = false;
  for (let index = 0; index < files.length; index += 1) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    // 按「剩余预算 / 剩余文件数」切分，且只按剩余文件数算——早期用
    // (files.length - sessions.length)，一个空会话就会让后面的文件多分预算并整体溢出。
    const filesLeft = files.length - index;
    const share = Math.max(200, Math.floor(remaining / filesLeft));
    const entry = files[index];
    const { lines, truncated: cut } = await readSession(entry.file, Math.min(share, remaining));
    truncated = truncated || cut;
    if (!lines.length) {
      // 空/全被过滤的会话不占预算，但要记一笔，避免调用方以为没扫到文件。
      sessions.push({ file: entry.name, messages: 0, chars: 0 });
      continue;
    }
    const header = `### 会话 ${entry.name}`;
    // 头部也算进预算，否则只有条文时总长仍会超出 maxChars。
    const body = `${header}\n${lines.join('\n')}`;
    if (body.length > remaining) {
      blocks.push(body.slice(0, remaining));
      remaining = 0;
      truncated = true;
      sessions.push({ file: entry.name, messages: lines.length, chars: remaining });
      break;
    }
    blocks.push(body);
    sessions.push({ file: entry.name, messages: lines.length, chars: body.length });
    remaining -= body.length + 2;
  }
  const text = blocks.join('\n\n');
  const clipped = text.length > budget ? text.slice(0, budget) : text;
  return {
    ok: true,
    sessions,
    text: clipped,
    truncated: truncated || clipped.length < text.length,
    chars: clipped.length,
  };
}
