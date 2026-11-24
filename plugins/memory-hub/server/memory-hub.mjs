#!/usr/bin/env node
/**
 * memory-hub — 本地项目记忆（MCP stdio server，零依赖）
 *
 * 分层：
 *   server/json-store.mjs  锁 + 原子读写（无业务语义）
 *   server/evolve.mjs      自进化纯函数：合并、打分、衰减、淘汰
 *   server/store.mjs       记忆语义层：分库与条目生命周期
 *   server/digest.mjs      会话素材摘录（有界读取）
 *   server/tools.mjs       八个工具的定义与分发
 *   server/memory-hub.mjs  协议层（本文件）：MCP over stdio 的 JSON-RPC 2.0
 *
 * 协议：换行分隔的 JSON-RPC 2.0。stdout 只走协议，日志走 stderr。
 *
 * 健壮性约定：
 *   - 请求串行处理：记忆写入必须按到达顺序生效
 *   - 单请求失败只影响该请求，不拖垮连接
 *   - 任何未预期异常都记 stderr，stdout 永远只有合法 JSON-RPC
 *   - 宿主关闭 stdin 时等当前请求做完再退出，避免写到一半
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool, createToolContext } from './tools.mjs';

const PROTOCOL_FALLBACK = '2024-11-05';
const SERVER_VERSION = '0.2.0';
// 单个工具调用的上限。写盘 + 锁等待的正常路径在毫秒级，超过这个值说明磁盘或锁出了问题，
// 与其让宿主一直等（模型的工具调用会挂住整个回合），不如明确超时并让它重试。
const TOOL_TIMEOUT_MS = 25_000;

function log(...args) {
  process.stderr.write(`[memory-hub] ${args.join(' ')}\n`);
}

// 宿主提前关闭 stdio 管道时安静退出，不抛未捕获的 EPIPE
for (const stream of [process.stdout, process.stdin]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
    log('stream error:', String(error?.message ?? error));
  });
}

// 兜底：任何漏网的 rejection 都不该让进程静默死掉——那会让宿主看到「MCP 已断开」，
// 而真正的错误信息完全丢失。
process.on('unhandledRejection', (reason) => {
  log('unhandled rejection:', String(reason?.stack ?? reason));
});
process.on('uncaughtException', (error) => {
  log('uncaught exception:', String(error?.stack ?? error));
});

function send(id, result) {
  try {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  } catch (error) {
    log('failed to write a response:', String(error?.message ?? error));
  }
}

function sendError(id, code, message) {
  try {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  } catch (error) {
    log('failed to write an error response:', String(error?.message ?? error));
  }
}

const ctx = createToolContext({ log });

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool call exceeded ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      send(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'memory-hub', version: SERVER_VERSION },
      });
      return;
    case 'ping':
      send(id, {});
      return;
    case 'tools/list':
      send(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== 'string' || !TOOLS.some((tool) => tool.name === name)) {
        sendError(id, -32602, `unknown tool: ${String(name)}`);
        return;
      }
      if (args !== null && (typeof args !== 'object' || Array.isArray(args))) {
        sendError(id, -32602, 'tool arguments must be an object');
        return;
      }
      try {
        const result = await withTimeout(callTool(name, args ?? {}, ctx), TOOL_TIMEOUT_MS);
        send(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        // 工具错误回给模型，让它自己决定改参数重试还是告诉用户，而不是直接断开连接。
        log(`tool ${name} failed:`, String(error?.stack ?? error));
        send(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(error?.message ?? error) }) }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (id !== undefined && id !== null) sendError(id, -32601, `method not found: ${String(method)}`);
  }
}

const lines = createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();
let closing = false;

lines.on('line', (line) => {
  if (closing) return;
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    // 一行坏输入不能拖垮整个连接：记一笔，继续读下一行。
    log('ignored a malformed JSON-RPC line');
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    log('ignored a non-object JSON-RPC message');
    return;
  }
  if (typeof message.method !== 'string' || message.method === '') {
    // 通知没有 id、也没有 method 是无法处理的东西；有 id 的则回一个明确的错误，
    // 免得调用方一直等一个永远不会到的响应。
    if (message.id !== undefined && message.id !== null) sendError(message.id, -32600, 'invalid request: missing method');
    return;
  }
  // 串行处理：记忆写入必须按到达顺序生效，否则同一会话的 retain 会互相覆盖。
  queue = queue
    .then(() => handleRequest(message))
    .catch((error) => {
      log('request failed:', String(error?.stack ?? error));
      if (message.id !== undefined && message.id !== null) sendError(message.id, -32603, 'internal error');
    });
});

// 宿主断开 stdin：不再接收新请求，但把手里的做完再退出——中途被杀会留下 .tmp 与 .lock。
function shutdown(reason) {
  if (closing) return;
  closing = true;
  log(`shutting down (${reason})`);
  queue
    .catch(() => {})
    .finally(() => process.exit(0));
}

lines.on('close', () => shutdown('stdin closed'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
