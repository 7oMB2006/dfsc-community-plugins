/**
 * 用「市场装出来的版本」验证技能脚本，而不是只跑源仓库副本。
 *
 * 复审关注点：市场同步后有些脚本丢了 Unix 可执行位，要求补测请用市场装出来的
 * 版本。本脚本先把 `plugins/superpowers` 导出成一份安装副本，再在临时 Git 仓库
 * 里按技能文档的调用方式实际运行脚本。
 *
 * 平台说明（重要，也写进了市场说明）：
 * - Windows 上 Git 默认 core.fileMode=false，工作区文件不带可执行位，`spawn`
 *   直接执行会 ENOENT。因此本脚本在 Windows 上统一用 `bash <脚本>` 调用，这正是
 *   技能文档里的写法（19 处调用全部显式写 bash）。
 * - macOS / Linux 上先检查可执行位，再优先走直接执行路径，验证 bit 真的可用。
 *
 * 运行：
 *   node tests/market-installed-scripts.mjs   # 默认验证 plugins/superpowers
 * 不设该变量时按打包仓库的 plugins/superpowers 目录验证。
 * 依赖：git、bash；不调用模型、不发网络请求。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const bundledRoot = resolve(here, '../../../plugins/superpowers');
const sourceRoot = process.env.SUPERPOWERS_PLUGIN_ROOT
  ? resolve(process.env.SUPERPOWERS_PLUGIN_ROOT)
  : bundledRoot;
const isWindows = process.platform === 'win32';

async function git(cwd, ...args) {
  return (await run('git', args, { cwd })).stdout.trim();
}

async function isExecutable(path) {
  // Windows 不表达 POSIX 权限位：真正能生效的地方是 Git 索引与 POSIX 平台。
  if (isWindows) return null;
  return ((await stat(path)).mode & 0o111) !== 0;
}

/** 按技能文档的方式调用脚本：POSIX 直接执行，Windows 显式走 bash。 */
async function invoke(script, args, cwd) {
  if (isWindows) return run('bash', [script, ...args], { cwd });
  return run(script, args, { cwd });
}

/** 随包分发的脚本（技能文档里称为 scripts/xxx 的那些）。 */
async function bundledScripts() {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.sh$/.test(full) || /[\\/]scripts[\\/]/.test(full)) {
        if (/\.(html|js|json|md)$/.test(full)) continue;
        found.push(full);
      }
    }
  }
  await walk(join(sourceRoot, 'skills'));
  return found.sort();
}

/** 从 “wrote <path>: N lines” 里取路径（路径可能含空格与盘符冒号）。 */
function wrotePath(output) {
  const match = output.match(/wrote (.+?): (\d+ )?(lines?|commit)/);
  return match ? match[1].trim() : null;
}

const report = { sourceRoot, platform: process.platform, invocation: isWindows ? 'bash <script>' : 'direct exec', scripts: [], flows: [] };
let failure;

try {
  await stat(join(sourceRoot, 'skills'));

  // 导出成一份独立副本，模拟“市场装出来的版本”，避免误用源仓库工作区路径。
  const stage = await mkdtemp(join(tmpdir(), 'sp-market-copy-'));
  const installed = join(stage, 'superpowers');
  await cp(sourceRoot, installed, { recursive: true });

  const scripts = await bundledScripts();
  assert.ok(scripts.length > 0, '未找到随包脚本');
  for (const script of scripts) {
    report.scripts.push({
      script: script.slice(sourceRoot.length + 1).split('\\').join('/'),
      executable: await isExecutable(script.replace(sourceRoot, installed)),
    });
  }

  const repo = join(stage, 'repo');
  await mkdir(join(repo, '.superpowers', 'plans'), { recursive: true });
  await writeFile(join(repo, '.superpowers', 'plans', 'demo.md'), '# Demo\n\n## Task 1\nDo the thing.\n');
  await git(repo, 'init', '-q', '.');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'baseline');
  const base = await git(repo, 'rev-parse', 'HEAD');

  const script = (relative) => join(installed, 'skills', relative);
  const plan = '.superpowers/plans/demo.md';

  // 1. executing-plans/task-start
  const start = await invoke(script('executing-plans/scripts/task-start'), [plan, '1'], repo);
  assert.match(start.stdout, /brief:/, 'task-start 应输出 brief 路径');
  assert.match(start.stdout, /base:/, 'task-start 应输出基线提交');
  report.flows.push({ flow: 'executing-plans/task-start', ok: true });

  // 2. subagent-driven-development/task-brief
  const brief = await invoke(script('subagent-driven-development/scripts/task-brief'), [plan, '1'], repo);
  const briefPath = wrotePath(brief.stdout);
  assert.ok(briefPath, 'task-brief 未报告输出路径');
  assert.match(await readFile(briefPath, 'utf8'), /Do the thing/, '简报应包含任务正文');
  report.flows.push({ flow: 'subagent-driven-development/task-brief', ok: true });

  // 3. sdd-workspace
  const workspace = await invoke(script('subagent-driven-development/scripts/sdd-workspace'), [plan], repo);
  assert.match(workspace.stdout.trim(), /\.superpowers[\\/]sdd[\\/]demo$/, 'sdd-workspace 应输出工作区路径');
  report.flows.push({ flow: 'subagent-driven-development/sdd-workspace', ok: true });

  // 4. sdd-repo
  const root = await invoke(script('subagent-driven-development/scripts/sdd-repo'), [], repo);
  assert.equal((await stat(root.stdout.trim())).isDirectory(), true, 'sdd-repo 应输出存在的目录');
  report.flows.push({ flow: 'subagent-driven-development/sdd-repo', ok: true });

  // 5. review-package
  await writeFile(join(repo, 'change.txt'), 'change\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'task 1');
  const pack = await invoke(script('subagent-driven-development/scripts/review-package'),
    [plan, base, 'HEAD'], repo);
  const diffPath = wrotePath(pack.stdout);
  assert.ok(diffPath, 'review-package 未报告 diff 路径');
  assert.match(await readFile(diffPath, 'utf8'), /change\.txt/, '评审包应包含改动文件');
  report.flows.push({ flow: 'subagent-driven-development/review-package', ok: true });

  // 6. executing-plans/task-done
  const done = await invoke(script('executing-plans/scripts/task-done'), [plan, '1', base, '--', 'true'], repo);
  assert.match(done.stdout, /complete/, 'task-done 应记录完成');
  report.flows.push({ flow: 'executing-plans/task-done', ok: true });

  // 7. systematic-debugging/find-polluter.sh
  const polluter = await run('bash', [script('systematic-debugging/find-polluter.sh'), '.git', 'src/**/*.test.ts'], { cwd: repo });
  assert.match(polluter.stdout, /No polluter found|Found 0 test files/, 'find-polluter 应报告未找到污染源');
  report.flows.push({ flow: 'systematic-debugging/find-polluter.sh', ok: true });

  await rm(stage, { recursive: true, force: true });

  report.scriptsChecked = report.scripts.length;
  report.flowsRun = report.flows.length;
  report.ok = true;
} catch (err) {
  failure = err;
  report.ok = false;
  report.error = String(err?.message ?? err);
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(failure?.stack ?? '');
  process.exit(1);
}
