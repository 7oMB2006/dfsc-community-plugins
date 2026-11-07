// Optional packaged-app acceptance; never uses the owner's profile or credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = process.env.DFSC_DESKTOP_ROOT;
const executablePath = process.env.DFSC_VERIFY_EXE;
assert.ok(desktop && executablePath, 'Set DFSC_DESKTOP_ROOT and DFSC_VERIFY_EXE to the tested checkout and packaged executable');
const require = createRequire(join(resolve(desktop), 'package.json'));
const { _electron: electron } = require('playwright');
const { closeDesktopFixtureAndWait } = await import(pathToFileURL(join(resolve(desktop), 'scripts/close-desktop-fixture.mjs')).href);
const output = join(root, 'test-results/stellar');
await mkdir(output, { recursive: true });
// Copy only installable resources, never this checkout's .git or test profiles.
const marketSource = await mkdtemp(join(output, 'marketplace-'));
for (const name of ['.step-plugin', 'plugins']) {
  await cp(join(root, name), join(marketSource, name), { recursive: true });
}
const profile = await realpath(await mkdtemp(join(tmpdir(), 'dfsc-stellar-')));
await mkdir(join(profile, 'step-runtime'));
const registry = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));
const entry = registry.plugins.find(plugin => plugin.id === 'stellar-cruise');
assert.ok(entry, 'Missing reviewed Stellar source');
const manifest = JSON.parse(await readFile(join(root, 'plugins/stellar-cruise/step.plugin.json'), 'utf8'));
const errors = [], checks = [], requests = [];
const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({
  id: 'stellar-marketplace', object: 'chat.completion.chunk', created: 1, model: 'fixture',
  choices: [{ index: 0, delta, finish_reason }],
})}\n\n`;
const provider = createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(chunk({ role: 'assistant', content: '星辰巡航主题已就绪。这条回复来自本地离线验收，不调用真实模型。' })
    + chunk({}, 'stop') + 'data: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
await writeFile(join(profile, 'preferences.json'), JSON.stringify({ theme: 'original-dark', language: 'zh', workspaces: [] }));
await writeFile(join(profile, 'step-runtime/config.toml'),
  'defaultProvider = "fixture"\ndefaultModel = "fixture"\n[telemetry]\nenabled = false\n');
await writeFile(join(profile, 'step-runtime/models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-only',
  models: [{ id: 'fixture', name: 'Offline theme acceptance', contextWindow: 32768, maxTokens: 1024 }],
} } }));
const env = { ...process.env, DESKTOP_TEST_USER_DATA: profile, DESKTOP_TEST_NO_FOCUS: '1',
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
for (const name of ['DESKTOP_DEV_URL', 'ELECTRON_RUN_AS_NODE', 'STEP_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']) delete env[name];
let app, page;
const launch = async () => {
  app = await electron.launch({ executablePath, args: [], cwd: dirname(resolve(executablePath)), env, timeout: 60000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setOpacity(0); window.setIgnoreMouseEvents(true); window.showInactive(); window.setSize(1440, 960);
  });
  await page.waitForURL('**/renderer/index.html');
  await page.locator('.sidebar-bottom > button').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.desktop));
};
const snapshot = () => page.evaluate(() => window.desktop.snapshot());
const catalog = () => page.evaluate(() => window.desktop.capabilityCatalog());
const mutate = value => page.evaluate(value => window.desktop.capabilityMutate(value), value);
const poll = async (predicate, description) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = await snapshot();
    if (predicate(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out: ${description}`);
};
const settings = async () => {
  await page.locator('.sidebar-bottom > button').click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
};
const closeSettings = () => page.getByRole('button', { name: 'Close', exact: true }).click();
const ready = () => page.locator('.stellar-workspace-scene canvas[data-ready=true]').waitFor({ timeout: 60000, state: 'attached' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  await launch();
  // First runtime startup provisions built-ins; record that before testing this pack.
  const baselineSession = await page.evaluate(() => window.desktop.newIndependentSession());
  await page.evaluate(async id => window.desktop.command('get_commands', undefined, id), baselineSession.runtimeId);
  await page.evaluate(() => window.desktop.beginSession());
  const baseline = (await catalog()).plugins.map(plugin => plugin.id).sort();
  const added = await mutate({ action: 'marketplace-add', source: marketSource });
  assert.deepEqual(added.warnings, []);
  const discovered = await catalog();
  assert.ok(discovered.available.some(plugin => plugin.name === entry.id && plugin.marketplace === registry.marketplaceName && !plugin.installed));
  const market = discovered.marketplaces.find(market => market.origin === marketSource)
    ?? discovered.marketplaces.find(market => market.kind === 'local');
  assert.ok(market, 'Missing local source record');
  assert.equal(market.kind, 'local');
  await page.getByRole('button', { name: '插件市场', exact: true }).click();
  await page.getByRole('tab', { name: /^发现/ }).click();
  await page.getByRole('textbox', { name: '搜索插件', exact: true }).fill(entry.id);
  const card = page.locator('.pc-plugin-row').filter({
    has: page.getByRole('button', { name: '查看 星辰巡航 使用说明', exact: true }),
  });
  await card.getByRole('button', { name: '安装', exact: true }).click();
  await poll(value => value.themePacks.some(pack => pack.id === 'plugin:stellar-cruise'), 'installed theme registration');
  const installed = (await catalog()).plugins.find(plugin => plugin.id === entry.id);
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.icon.kind, 'png');
  const installedDirectory = join(profile, 'step-runtime/plugins', entry.id);
  for (const name of ['cover.png', 'dfsc.plugin.json', 'dfsc.theme.json', 'icon.png', 'scene.json', 'step.plugin.json', 'README.md']) {
    assert.equal(hash(await readFile(join(installedDirectory, name))), hash(await readFile(join(root, 'plugins', entry.id, name))), name);
  }
  assert.equal((await snapshot()).preferences.theme, 'original-dark');
  checks.push('community-discovery-ui-install-and-exact-resource-hashes');
  await page.getByRole('tab', { name: '使用说明', exact: true }).click();
  await page.getByText('双龙星海，落在日常工作里。', { exact: true }).waitFor();
  assert.match(await page.locator('.pc-document-markdown').innerText(), /DFSC theme schema 1/);
  checks.push('installed-reviewed-chinese-guide');
  await page.screenshot({ path: join(output, 'installed.png') });
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  assert.equal(requests.length, 0, 'Installation and discovery must not request a model');
  await settings();
  await page.getByRole('button', { name: '星辰巡航', exact: true }).click();
  await closeSettings();
  await ready();
  await page.waitForTimeout(1000);
  const clip = { x: 730, y: 450, width: 250, height: 250 };
  const frameA = await page.screenshot({ clip });
  await page.waitForTimeout(600);
  const frameB = await page.screenshot({ clip });
  assert.notEqual(hash(frameA), hash(frameB), 'The stellar scene must animate');
  const pixels = await app.evaluate(({ nativeImage }, encoded) => {
    const bytes = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64')).toBitmap();
    let visible = 0, colored = 0;
    for (let index = 0; index < bytes.length; index += 4) {
      const channels = [bytes[index], bytes[index + 1], bytes[index + 2]];
      if (Math.max(...channels) > 25) visible++;
      if (Math.max(...channels) - Math.min(...channels) > 15) colored++;
    }
    return { visible, colored };
  }, frameB.toString('base64'));
  assert.ok(pixels.visible > 200 && pixels.colored > 100, 'Decoded scene pixels must not be blank');
  checks.push('dynamic-scene-and-decoded-pixels');
  await settings();
  await page.getByLabel('星海动态背景').click();
  await page.getByLabel('背景亮度').fill('65');
  await poll(value => value.preferences.themeMotion === false && value.preferences.themeBrightness === 65, 'appearance preferences');
  assert.match(await page.evaluate(() => window.desktop.themePoster('plugin:stellar-cruise')), /^data:image\/png;base64,/);
  assert.equal((await page.evaluate(() => window.desktop.themeScene('plugin:stellar-cruise'))).dragons.groups.length, 2);
  await closeSettings();
  await ready();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(output, 'welcome.png') });
  await closeDesktopFixtureAndWait(app); app = undefined;
  await launch();
  const restored = await snapshot();
  assert.equal(restored.preferences.theme, 'plugin:stellar-cruise');
  assert.equal(restored.preferences.themeMotion, false);
  assert.equal(restored.preferences.themeBrightness, 65);
  assert.equal((await page.evaluate(() => window.desktopTheme.firstFrame())).palette, 'plugin:stellar-cruise');
  await ready();
  checks.push('appearance-persistence-and-restart-first-frame');
  await settings();
  await page.getByRole('button', { name: '原版浅色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'original-light');
  assert.equal(await page.locator('.theme-stellar-stage').count(), 0);
  await page.getByRole('button', { name: '星辰巡航', exact: true }).click();
  await closeSettings();
  await ready();
  checks.push('builtin-theme-switch-releases-scene-and-return-remounts');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('确认星辰巡航主题下的会话与侧栏正常显示。');
  await page.getByRole('textbox', { name: '消息', exact: true }).press('Enter');
  await poll(value => !value.state.isStreaming && value.messages.some(message =>
    message.role === 'assistant' && JSON.stringify(message.content).includes('星辰巡航主题已就绪')), 'offline chat');
  await page.locator('.message.assistant').waitFor();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(output, 'chat.png') });
  assert.ok(requests.length > 0);
  checks.push('packaged-runtime-offline-conversation-and-sidebar');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 760));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(output, 'chat-narrow.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');
  checks.push('narrow-chat');
  await mutate({ action: 'plugin-remove', id: entry.id });
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'original-dark');
  assert.equal(await page.locator('.theme-stellar-stage').count(), 0);
  assert.equal(JSON.parse(await readFile(join(profile, 'preferences.json'), 'utf8')).theme, 'original-dark');
  assert.deepEqual((await catalog()).plugins.map(plugin => plugin.id).sort(), baseline);
  await mutate({ action: 'plugin-install', name: entry.id, marketplace: registry.marketplaceName });
  assert.equal((await catalog()).plugins.find(plugin => plugin.id === entry.id).version, manifest.version);
  assert.equal((await snapshot()).preferences.theme, 'original-dark');
  await mutate({ action: 'plugin-remove', id: entry.id });
  await mutate({ action: 'marketplace-remove', name: market.name });
  assert.deepEqual((await catalog()).plugins.map(plugin => plugin.id).sort(), baseline);
  checks.push('uninstall-fallback-scene-disposal-reinstall-and-baseline-preserved');
  assert.deepEqual(errors, []);
  await closeDesktopFixtureAndWait(app); app = undefined;
  const result = { passed: true, plugin: entry.id, version: manifest.version, source: entry.source,
    marketplace: registry.marketplaceName, sourceKind: 'local-directory', platform: process.platform, arch: process.arch,
    hostRevision: process.env.DFSC_VERIFY_REVISION ?? null, checks, pixels, offlineModelRequests: requests.length,
    rendererErrors: errors, realProfileModified: false, realAccountTested: false, profile };
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  console.error(await page?.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  try { if (app) await closeDesktopFixtureAndWait(app); }
  finally { await new Promise(resolve => provider.close(resolve)); }
}
