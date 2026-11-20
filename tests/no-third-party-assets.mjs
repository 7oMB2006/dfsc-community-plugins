/**
 * 验证 brainstorming 可视化伴侣默认不发起第三方请求。
 *
 * 复审关注点：server.cjs 生成的页面默认让浏览器请求第三方 Logo
 * （primeradiant.com），与「无第三方通信」的说法不一致。
 *
 * 本测试启动真实的 server.cjs，走完整的两步请求（带 key 的 bootstrap 页 →
 * 带 cookie 的内容页），再检查渲染结果里是否还有第三方资源引用。
 *
 * 运行：node tests/no-third-party-assets.mjs
 * 依赖：Node.js 内置模块；不需要浏览器、网络或模型。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(here, '../plugins/superpowers/skills/brainstorming');

function get(port, pathname, cookie) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: pathname, headers: cookie ? { Cookie: cookie } : {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolvePromise({ status: res.statusCode, body, headers: res.headers }));
      },
    );
    req.on('error', rejectPromise);
  });
}

/** 起一个 server.cjs，返回 { port, key, stop }。 */
async function startServer(sessionDir, extraEnv = {}) {
  const child = spawn(process.execPath, ['scripts/server.cjs'], {
    cwd: skillDir,
    env: {
      ...process.env,
      BRAINSTORM_DIR: sessionDir,
      BRAINSTORM_IDLE_TIMEOUT_MS: '20000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { err += String(d); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const port = out.match(/"port":(\d+)/);
    const key = out.match(/[?&]key=([a-f0-9]+)/);
    if (port && key) {
      return { port: Number(port[1]), key: key[1], stop: () => child.kill() };
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server.cjs 未在 15s 内报告端口与 key。stdout=${out.slice(0, 400)} stderr=${err.slice(0, 400)}`);
}

/** 取内容页的最终 HTML（先 bootstrap 拿 cookie，再取 /）。 */
async function contentPage(server) {
  const bootstrap = await get(server.port, `/?key=${server.key}`);
  const cookie = (bootstrap.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
  return get(server.port, '/', cookie);
}

function thirdPartyRefs(html) {
  return [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
}

const report = { cases: [] };
let failure;

try {
  // 场景 1：默认配置 + 有内容页（走 wrapInFrame 渲染路径）+ 等待页
  const dirA = await mkdtemp(join(tmpdir(), 'bs-notp-'));
  await mkdir(join(dirA, 'content'), { recursive: true });
  const a = await startServer(dirA);
  try {
    const waiting = await get(a.port, `/?key=${a.key}`);
    await writeFile(join(dirA, 'content', 'screen-1.html'), '<h1>Hello screen</h1>');
    await new Promise((r) => setTimeout(r, 900));
    const page = await contentPage(a);

    assert.equal(page.status, 200);
    assert.match(page.body, /Hello screen/, '内容页应渲染写入的屏幕文件');

    const refs = thirdPartyRefs(page.body);
    assert.equal(refs.length, 1, `默认只应有一个第三方引用，实际 ${JSON.stringify(refs)}`);
    assert.equal(refs[0], 'https://github.com/obra/superpowers', '唯一外链应是点击才跳转的仓库地址');
    assert.ok(!/<img[^>]*(primeradiant|src="https?:\/\/)/.test(page.body), '默认不得渲染远程图片');
    assert.match(page.body, /class="brand"/, '品牌文字块应存在');
    assert.match(page.body, /Superpowers v/, '品牌文字应包含版本号');

    report.cases.push({
      case: '默认配置',
      contentPage: 'ok',
      waitingPage: waiting.status,
      thirdPartyRefs: refs,
      remoteImages: 0,
    });
  } finally {
    a.stop();
    await rm(dirA, { recursive: true, force: true });
  }

  // 场景 2：显式 opt-in 时 Logo 才出现
  const dirB = await mkdtemp(join(tmpdir(), 'bs-notp-'));
  await mkdir(join(dirB, 'content'), { recursive: true });
  const b = await startServer(dirB, { BRAINSTORM_BRAND_LOGO: '1' });
  try {
    await writeFile(join(dirB, 'content', 'screen-1.html'), '<h1>Opt in</h1>');
    await new Promise((r) => setTimeout(r, 900));
    const page = await contentPage(b);
    assert.match(page.body, /<img[^>]*primeradiant\.com/, 'BRAINSTORM_BRAND_LOGO=1 时应加载 Logo');
    report.cases.push({ case: 'BRAINSTORM_BRAND_LOGO=1', logoLoaded: true });
  } finally {
    b.stop();
    await rm(dirB, { recursive: true, force: true });
  }

  // 场景 3：遥测退出开关优先于 opt-in
  const dirC = await mkdtemp(join(tmpdir(), 'bs-notp-'));
  await mkdir(join(dirC, 'content'), { recursive: true });
  const c = await startServer(dirC, { BRAINSTORM_BRAND_LOGO: '1', SUPERPOWERS_DISABLE_TELEMETRY: '1' });
  try {
    await writeFile(join(dirC, 'content', 'screen-1.html'), '<h1>Disabled</h1>');
    await new Promise((r) => setTimeout(r, 900));
    const page = await contentPage(c);
    assert.ok(!/<img[^>]*primeradiant\.com/.test(page.body), '遥测退出开关为真时不得加载 Logo');
    report.cases.push({ case: 'opt-in + SUPERPOWERS_DISABLE_TELEMETRY=1', logoLoaded: false });
  } finally {
    c.stop();
    await rm(dirC, { recursive: true, force: true });
  }

  report.ok = true;
} catch (err) {
  failure = err;
  report.ok = false;
  report.error = String(err?.stack ?? err);
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(failure?.message ?? '');
  process.exit(1);
}
