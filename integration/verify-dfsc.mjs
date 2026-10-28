// Optional native acceptance against a separately installed DFSC 0.6 desktop.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = process.env.DFSC_DESKTOP_ROOT;
const executablePath = process.env.DFSC_VERIFY_EXE;
assert.ok(desktop && executablePath, 'Set DFSC_DESKTOP_ROOT and DFSC_VERIFY_EXE to the tested desktop checkout and executable');
const require = createRequire(join(resolve(desktop), 'package.json'));
const { _electron: electron } = require('playwright');
const { closeDesktopFixture } = await import(pathToFileURL(join(resolve(desktop), 'scripts/close-desktop-fixture.mjs')).href);
const registry = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));
// This v1 native scenario exercises the real engineering-evidence skill and help command.
// Adding another registry entry must not silently change the scenario's target.
const selected = registry.plugins.find(item => item.id === 'hermes-engineering-bridge');
assert.ok(selected, 'This native scenario requires the hermes-engineering-bridge registry entry');
const manifest = JSON.parse(await readFile(join(root, 'plugins', selected.id, 'step.plugin.json'), 'utf8'));
const requestedSource = process.argv[2] ?? root;
// A local Git working copy is tested through file:// so the native git clone/pull
// path is exercised without copying ignored files or requiring private-network credentials.
const localGit = !/^[a-z]+:|^git@/i.test(requestedSource)
  && await access(join(resolve(requestedSource), '.git')).then(() => true, () => false);
const source = localGit ? pathToFileURL(resolve(requestedSource)).href : requestedSource;
const remote = /^(https?:\/\/|git@|ssh:\/\/)/.test(source);
const gitSource = remote || source.startsWith('file:');
if (!gitSource) assert.match(basename(resolve(source)), /^[A-Za-z0-9_.-]+$/, 'DFSC 0.6 needs a marketplace folder name without spaces; use dfsc-community-plugins');
const profile = await mkdtemp(join(tmpdir(), 'dfsc-community-'));
let modelRequests = 0;
const provider = createServer((_request, response) => {
  modelRequests++;
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'Model calls are forbidden in marketplace acceptance' } }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerPort = provider.address().port;
await mkdir(join(profile, 'step-runtime'));
await writeFile(join(profile, 'preferences.json'), JSON.stringify({ language: 'zh', theme: 'dark', workspaces: [] }));
await writeFile(join(profile, 'step-runtime/config.toml'), 'defaultProvider = "fixture"\ndefaultModel = "fixture"\n[telemetry]\nenabled = false\n');
await writeFile(join(profile, 'step-runtime/models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'fixture-only',
  models: [{ id: 'fixture', name: 'Offline community acceptance', contextWindow: 32768, maxTokens: 1024 }],
} } }));
const env = { ...process.env, DESKTOP_TEST_USER_DATA: profile, DESKTOP_TEST_NO_FOCUS: '1',
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'STEP_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']) delete env[key];
const app = await electron.launch({ executablePath, env, timeout: 60000 }).catch(async error => {
  await new Promise(resolve => provider.close(resolve)); throw error;
});
const errors = [];
const output = join(root, 'test-results');
await mkdir(output, { recursive: true });
let page;
try {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !page) {
    for (const candidate of app.windows()) {
      if (await candidate.evaluate(() => typeof window.desktop?.capabilityCatalog === 'function').catch(() => false)) {
        page = candidate; break;
      }
    }
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Native main window did not expose the capability manager');
  page.on('pageerror', error => errors.push(error.message));
  const catalog = () => page.evaluate(() => window.desktop.capabilityCatalog());
  const mutate = input => page.evaluate(input => window.desktop.capabilityMutate(input), input);
  // The first native runtime provisions built-in resources such as StepPage.
  // Establish that baseline before comparing changes made by this marketplace.
  const baseline = await page.evaluate(() => window.desktop.newIndependentSession());
  await page.evaluate(async id => window.desktop.command('get_commands', undefined, id), baseline.runtimeId);
  const before = await catalog();
  const added = await mutate({ action: 'marketplace-add', source });
  assert.deepEqual(added.warnings, []);
  const discovered = await catalog();
  const entry = discovered.available.find(item => item.name === selected.id && item.marketplace === registry.marketplaceName);
  assert.ok(entry && !entry.installed, 'The community entry was not discovered');
  const market = discovered.marketplaces.find(item => item.name !== 'builtin' && item.origin === source)
    ?? discovered.marketplaces.find(item => item.kind === (gitSource ? 'git' : 'local'));
  assert.ok(market);
  assert.equal(market.kind, gitSource ? 'git' : 'local');
  console.log('Community marketplace discovered through native', market.kind, 'source.');
  await page.getByRole('button', { name: '插件市场', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索资源' }).fill(selected.id);
  await page.getByRole('button', { name: `安装 ${selected.id}`, exact: true }).click();
  await page.getByText('已安装', { exact: true }).waitFor();
  const installed = (await catalog()).plugins.find(item => item.id === selected.id);
  assert.equal(installed?.version, manifest.version);
  assert.equal(installed.icon.kind, 'png');
  await page.screenshot({ path: join(output, `dfsc-${gitSource ? 'git' : 'local'}-installed.png`) });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const session = await page.evaluate(() => window.desktop.newIndependentSession());
  const commands = await page.evaluate(async id => (await window.desktop.command('get_commands', undefined, id)).commands, session.runtimeId);
  assert.ok(commands.some(item => item.name === 'hermes-bridge-help'));
  assert.ok(commands.some(item => item.name === 'skill:hermes-engineering-evidence'));
  if (gitSource) {
    const updated = await mutate({ action: 'marketplace-update', name: market.name });
    assert.deepEqual(updated.warnings, []);
    assert.equal((await catalog()).plugins.find(item => item.id === selected.id)?.version, manifest.version);
  }
  await mutate({ action: 'plugin-remove', id: selected.id });
  assert.equal((await catalog()).plugins.some(item => item.id === selected.id), false);
  await mutate({ action: 'plugin-install', name: selected.id, marketplace: registry.marketplaceName });
  assert.equal((await catalog()).plugins.find(item => item.id === selected.id)?.version, manifest.version);
  await mutate({ action: 'plugin-remove', id: selected.id });
  await mutate({ action: 'marketplace-remove', name: market.name });
  const after = await catalog();
  assert.deepEqual(after.plugins.map(item => item.id).sort(), before.plugins.map(item => item.id).sort());
  assert.deepEqual(errors, []);
  assert.equal(modelRequests, 0, 'Marketplace verification must not request model inference');
  const evidence = { passed: true, source, sourceKind: market.kind, marketplace: registry.marketplaceName,
    sourceTransport: remote ? 'network-git' : gitSource ? 'file-git' : 'local-directory',
    plugin: selected.id, version: manifest.version, platform: process.platform, arch: process.arch,
    nativeDiscovery: true, nativeUiInstall: true, nativeRuntimeResourcesLoaded: true,
    uninstallReinstall: true, gitRefresh: gitSource, originalPluginsRetained: true,
    realProfileModified: false, realFeishu: false, modelRequests };
  await writeFile(join(output, `dfsc-${gitSource ? 'git' : 'local'}.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'dfsc-failure.png') }).catch(() => {});
  throw error;
} finally {
  try { await closeDesktopFixture(app); }
  finally { await new Promise(resolve => provider.close(resolve)); }
}
