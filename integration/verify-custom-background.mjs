// Optional real-package acceptance; only this run's temporary profile is opened.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { access, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = process.env.DFSC_DESKTOP_ROOT, requestedExecutable = process.env.DFSC_VERIFY_EXE;
assert.ok(desktop && requestedExecutable, 'Set DFSC_DESKTOP_ROOT and DFSC_VERIFY_EXE');
const executablePath = await realpath(requestedExecutable);
const require = createRequire(join(resolve(desktop), 'package.json'));
const { _electron: electron } = require('playwright');
const { closeDesktopFixtureAndWait } = await import(pathToFileURL(join(resolve(desktop), 'scripts/close-desktop-fixture.mjs')));
const registry = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));
const selected = registry.plugins.find(item => item.id === 'custom-background');
assert.ok(selected);
assert.equal(registry.marketplaceName, 'dfsc-community');
const manifest = JSON.parse(await readFile(join(root, 'plugins', selected.id, 'step.plugin.json'), 'utf8'));
const expectedReadme = await readFile(join(root, selected.readme));
assert.deepEqual(await readFile(join(root, 'plugins', selected.id, 'README.md')), expectedReadme);
const requestedSource = process.argv[2] ?? root;
const localGit = !/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(requestedSource)
  && await access(join(resolve(requestedSource), '.git')).then(() => true, () => false);
const source = localGit ? pathToFileURL(resolve(requestedSource)).href : requestedSource;
const gitSource = /^(?:https?:\/\/|git@|ssh:\/\/|file:)/.test(source);
const output = resolve(process.env.DFSC_VERIFY_OUTPUT
  || join(root, 'test-results', `background-${new Date().toISOString().replace(/[:.]/g, '-')}`));
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Existing evidence directories are never reused.
const profile = await realpath(await mkdtemp(join(tmpdir(), 'dfsc-community-background-')));
const png = join(profile, 'background sample.png');
await cp(join(resolve(desktop), '../theme-marketplace/plugins/stellar-cruise/cover.png'), png);
await mkdir(join(profile, 'step-runtime'));
let modelRequests = 0, app, page;
const errors = [], launches = [], shutdowns = [], checks = [];
const provider = createServer((_request, response) => {
  modelRequests++;
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'Model calls are forbidden in background acceptance' } }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
await writeFile(join(profile, 'preferences.json'), JSON.stringify({
  language: 'en', theme: 'original-dark', workspaces: [], autoCheckUpdates: false,
}));
await writeFile(join(profile, 'step-runtime/config.toml'), 'defaultProvider = "fixture"\ndefaultModel = "fixture"\n[telemetry]\nenabled = false\n');
await writeFile(join(profile, 'step-runtime/models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-only',
  models: [{ id: 'fixture', name: 'Offline background acceptance', contextWindow: 32768, maxTokens: 1024 }],
} } }));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(STEP|STEPCODE|STEPFUN|OPENAI|ANTHROPIC|OPENROUTER|HERMES_|DESKTOP_|DFSC_)/i.test(key)
    || /(?:^|_)(?:TOKEN|API_KEY|SECRET|PASSWORD|COOKIE)(?:_|$)/i.test(key)
    || key === 'ELECTRON_RUN_AS_NODE' || key === 'GH_CONFIG_DIR') delete env[key];
}
Object.assign(env, { DESKTOP_TEST_USER_DATA: profile, DESKTOP_TEST_NO_FOCUS: '1',
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
async function launch() {
  app = await electron.launch({ executablePath, env, cwd: dirname(executablePath), timeout: 60000 });
  const identity = await app.evaluate(({ app }) => ({
    executable: process.execPath, userData: app.getPath('userData'), packaged: app.isPackaged,
    appPath: app.getAppPath(), mainModule: process.mainModule?.filename, version: app.getVersion(),
  }));
  assert.equal(await realpath(identity.executable), executablePath);
  assert.equal(await realpath(identity.userData), profile);
  assert.equal(identity.packaged, true);
  assert.match(identity.mainModule.replaceAll('\\', '/'), /\/resources\/app\.asar\/dist\/main\.cjs$/);
  launches.push(identity);
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop?.capabilityCatalog), undefined, { timeout: 60000 });
  const mainId = await (await app.browserWindow(page)).evaluate(view => view.id);
  assert.deepEqual(await app.evaluate(({ app, BrowserWindow }, id) => {
    const view = BrowserWindow.fromId(id), prefs = view.webContents.getLastWebPreferences();
    view.setOpacity(0); view.setIgnoreMouseEvents(true); view.showInactive();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration, globalBypass: app.commandLine.hasSwitch('no-sandbox') };
  }, mainId), { sandbox: true, contextIsolation: true, nodeIntegration: false, globalBypass: false });
  await page.evaluate(() => window.desktop.finishFirstRun('skipped'));
  await page.reload();
  await page.locator('.sidebar-settings').waitFor({ timeout: 60000 });
  await app.evaluate(({ dialog }) => {
    globalThis.backgroundPicker = { original: dialog.showOpenDialog, selection: null };
    dialog.showOpenDialog = async () => ({ canceled: !globalThis.backgroundPicker.selection,
      filePaths: globalThis.backgroundPicker.selection ? [globalThis.backgroundPicker.selection] : [] });
  });
}
async function close() {
  if (!app) return;
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.backgroundPicker.original; }).catch(() => {});
  const child = app.process();
  await closeDesktopFixtureAndWait(app, 30000);
  const shutdown = { exitCode: child.exitCode, remainingWindows: app.windows().filter(view => !view.isClosed()).length };
  assert.deepEqual(shutdown, { exitCode: 0, remainingWindows: 0 });
  shutdowns.push(shutdown); app = undefined;
}
const catalog = () => page.evaluate(() => window.desktop.capabilityCatalog());
const mutate = input => page.evaluate(input => window.desktop.capabilityMutate(input), input);
const state = () => page.evaluate(() => window.desktop.customBackgroundState());
const settings = () => page.getByRole('region', { name: 'Custom background settings', exact: true });
const ready = () => page.waitForFunction(() => {
  const image = document.querySelector('.custom-background-plane .theme-workspace-image');
  return image?.complete && image.naturalWidth > 0;
});
async function configure() {
  const center = page.getByRole('region', { name: 'Plugin center', exact: true });
  if (!await center.isVisible()) await page.getByRole('button', { name: 'Plugin marketplace', exact: true }).click();
  if (!await settings().isVisible()) {
    if (await center.locator('.pc-detail').isVisible())
      await center.getByRole('tab', { name: 'Configuration', exact: true }).click();
    else await center.getByRole('button', { name: `Configure ${manifest.name}`, exact: true }).click();
  }
  await settings().getByRole('button', { name: 'Import background image', exact: true }).waitFor();
}
let evidence;
try {
  await launch();
  const session = await page.evaluate(() => window.desktop.newIndependentSession());
  await page.evaluate(async id => window.desktop.command('get_commands', undefined, id), session.runtimeId);
  await page.evaluate(() => window.desktop.beginSession());
  const baseline = (await catalog()).plugins.map(item => item.id).sort();
  assert.deepEqual((await mutate({ action: 'marketplace-add', source })).warnings, []);
  const discovered = await catalog();
  const entry = discovered.available.find(item => item.name === selected.id && item.marketplace === registry.marketplaceName);
  assert.ok(entry && !entry.installed && entry.package?.ref);
  assert.equal(entry.description, selected.description);
  const market = discovered.marketplaces.find(item => item.origin === source);
  assert.ok(market); assert.equal(market.kind, gitSource ? 'git' : 'local');
  await page.getByRole('button', { name: 'Plugin marketplace', exact: true }).click();
  const center = page.getByRole('region', { name: 'Plugin center', exact: true });
  await center.getByRole('tab', { name: /^Discover/ }).click();
  await center.getByRole('textbox', { name: 'Search plugins', exact: true }).fill(selected.id);
  await center.locator('.pc-plugin-row').filter({ hasText: manifest.name }).getByRole('button', { name: 'Install', exact: true }).click();
  await page.waitForFunction(async () => (await window.desktop.customBackgroundState()).available);
  const installed = (await catalog()).plugins.find(item => item.id === selected.id);
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.package.provenance, 'recorded');
  assert.equal(installed.package.hostConfiguration, 'custom-background-v1');
  assert.equal(installed.installationSource.status, 'recorded');
  assert.deepEqual(installed.mcpServers, []);
  const copied = await app.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
    const base = path.join(app.getPath('userData'), 'step-runtime/plugins/custom-background');
    return { readme: fs.readFileSync(path.join(base, 'README.md')).toString('base64'),
      manifest: JSON.parse(fs.readFileSync(path.join(base, 'step.plugin.json'), 'utf8')) };
  });
  assert.equal(copied.readme, expectedReadme.toString('base64'));
  for (const key of ['skills', 'commands', 'agents']) assert.deepEqual(copied.manifest[key], []);
  assert.deepEqual(copied.manifest.mcpServers, {});
  assert.equal((await state()).options.enabled, false);
  checks.push('community discovery, UI install, recorded adapter, exact reviewed README and empty resources');
  await configure();
  await app.evaluate((_electron, selection) => { globalThis.backgroundPicker.selection = selection; }, png);
  await settings().getByRole('button', { name: 'Import background image', exact: true }).click();
  await ready();
  const imported = await state(); assert.equal(imported.options.enabled, true);
  await page.screenshot({ path: join(output, 'installed-background.png') });
  await settings().getByRole('checkbox', { name: 'Enable background', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.custom-background-plane'));
  assert.equal((await state()).options.enabled, false); assert.deepEqual((await state()).image, imported.image);
  await settings().getByRole('checkbox', { name: 'Enable background', exact: true }).click();
  await ready(); const saved = await state();
  await close(); await launch(); await ready();
  assert.deepEqual((await state()).options, saved.options); assert.deepEqual((await state()).image, saved.image);
  checks.push('native import, disable/enable, retained image and orderly restart persistence');
  await mutate({ action: 'plugin-remove', id: selected.id });
  await page.waitForFunction(() => !document.querySelector('.custom-background-plane'));
  assert.equal((await state()).available, false); assert.deepEqual((await state()).image, saved.image);
  const available = (await catalog()).available.find(item => item.name === selected.id && item.marketplace === registry.marketplaceName);
  assert.ok(available?.package?.ref);
  await mutate({ action: 'plugin-install', name: selected.id, marketplace: registry.marketplaceName, ref: available.package.ref });
  assert.equal((await state()).available, true); assert.equal((await state()).options.enabled, false);
  assert.deepEqual((await state()).image, saved.image);
  assert.equal(await page.locator('.custom-background-plane').count(), 0);
  await mutate({ action: 'plugin-remove', id: selected.id });
  await mutate({ action: 'marketplace-remove', name: market.name });
  assert.deepEqual((await catalog()).plugins.map(item => item.id).sort(), baseline);
  checks.push('uninstall revokes activation, reinstall stays disabled, market removal preserves baseline');
  evidence = { passed: true, plugin: selected.id, version: manifest.version, source, sourceKind: market.kind,
    marketplace: registry.marketplaceName, sourceTransport: source.startsWith('file:') ? 'file-git' : gitSource ? 'network-git' : 'local-directory',
    platform: process.platform, arch: process.arch, checks, launches, profile, realProfileModified: false,
    networkGitAuthenticationTested: false, publiclyListed: false, realAccountTested: false };
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, modelRequests }, null, 2), { flag: 'wx' });
  throw error;
} finally {
  try { await close(); } finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
}
assert.deepEqual(errors, []); assert.equal(modelRequests, 0);
Object.assign(evidence, { rendererErrors: errors, modelRequests, shutdowns });
await writeFile(join(output, 'results.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(evidence));
