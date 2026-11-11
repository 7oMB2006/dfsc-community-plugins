// Optional native acceptance against a separately installed DFSC 0.6 desktop.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = process.env.DFSC_DESKTOP_ROOT;
const requestedExecutable = process.env.DFSC_VERIFY_EXE;
assert.ok(desktop && requestedExecutable, 'Set DFSC_DESKTOP_ROOT and DFSC_VERIFY_EXE to the tested desktop checkout and executable');
const executablePath = await realpath(requestedExecutable);
const require = createRequire(join(resolve(desktop), 'package.json'));
const { _electron: electron } = require('playwright');
const { closeDesktopFixtureAndWait } = await import(pathToFileURL(join(resolve(desktop), 'scripts/close-desktop-fixture.mjs')).href);
const registry = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));
// This v1 native scenario exercises the real engineering-evidence skill and help command.
// Adding another registry entry must not silently change the scenario's target.
const selected = registry.plugins.find(item => item.id === 'hermes-engineering-bridge');
assert.ok(selected, 'This native scenario requires the hermes-engineering-bridge registry entry');
const manifest = JSON.parse(await readFile(join(root, 'plugins', selected.id, 'step.plugin.json'), 'utf8'));
const metadata = JSON.parse(await readFile(join(root, 'plugins', selected.id, 'dfsc.plugin.json'), 'utf8'));
const expectedRequirements = { ...metadata.requirements,
  external: metadata.requirements.external.map(item => ({
    ...item, ...(item.url ? { url: new URL(item.url).href } : {}),
  })) };
const { icon: expectedDesktopIcons, ...expectedDesktop } = metadata.desktop;
const requestedSource = process.argv[2] ?? root;
// A local Git working copy is tested through file:// so the native git clone/pull
// path is exercised without copying ignored files or requiring private-network credentials.
const localGit = !/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(requestedSource)
  && await access(join(resolve(requestedSource), '.git')).then(() => true, () => false);
const source = localGit ? pathToFileURL(resolve(requestedSource)).href : requestedSource;
const remote = /^(https?:\/\/|git@|ssh:\/\/)/.test(source);
const gitSource = remote || source.startsWith('file:');
if (!gitSource) assert.match(basename(resolve(source)), /^[A-Za-z0-9_.-]+$/, 'DFSC 0.6 needs a marketplace folder name without spaces; use dfsc-community-plugins');
const output = resolve(process.env.DFSC_VERIFY_OUTPUT
  || join(root, 'test-results', `dfsc-${new Date().toISOString().replace(/[:.]/g, '-')}`));
await mkdir(output, { recursive: true });
const evidenceName = `dfsc-${gitSource ? 'git' : 'local'}`;
for (const name of [`${evidenceName}.json`, `${evidenceName}-installed.png`, 'dfsc-failure.png']) {
  const present = await access(join(output, name)).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  assert.equal(present, false, 'Preserve prior evidence by selecting a new DFSC_VERIFY_OUTPUT directory');
}
const profile = await realpath(await mkdtemp(join(tmpdir(), 'dfsc-community-')));
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
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(STEP|STEPCODE|STEPFUN|OPENAI|ANTHROPIC|OPENROUTER|HERMES_|DESKTOP_|DFSC_)/i.test(key)
    || /(?:^|_)(?:TOKEN|API_KEY|SECRET|PASSWORD|COOKIE)(?:_|$)/i.test(key)
    || key === 'ELECTRON_RUN_AS_NODE' || key === 'GH_CONFIG_DIR') delete env[key];
}
Object.assign(env, { DESKTOP_TEST_USER_DATA: profile, DESKTOP_TEST_NO_FOCUS: '1',
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
const app = await electron.launch({ executablePath, env, timeout: 60000 }).catch(async error => {
  await new Promise(resolve => provider.close(resolve)); throw error;
});
const errors = [];
const child = app.process();
let page, evidence, shutdown;
try {
  const identity = await app.evaluate(({ app }) => ({
    executable: process.execPath, userData: app.getPath('userData'),
    packaged: app.isPackaged, version: app.getVersion(),
  }));
  assert.equal(await realpath(identity.executable), executablePath);
  assert.equal(await realpath(identity.userData), profile);
  assert.equal(identity.packaged, true, 'Marketplace acceptance must launch the requested packaged executable');
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
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('.new-chat')?.disabled === false,
    undefined, { timeout: 90000 });
  const center = page.getByRole('region', { name: '插件中心', exact: true });
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
  // Available entries omit desktop contributions; dependencies and the native description remain public.
  assert.equal(entry.description, selected.description);
  assert.deepEqual(entry.package?.requirements, expectedRequirements,
    'The discovered market must contain the reviewed current requirements, not an older same-version resource');
  const market = discovered.marketplaces.find(item => item.name !== 'builtin' && item.origin === source)
    ?? discovered.marketplaces.find(item => item.kind === (gitSource ? 'git' : 'local'));
  assert.ok(market);
  assert.equal(market.kind, gitSource ? 'git' : 'local');
  console.log('Community marketplace discovered through native', market.kind, 'source.');
  await page.getByRole('button', { name: '插件市场', exact: true }).click();
  await center.getByRole('tab', { name: /^发现/ }).click();
  await center.getByRole('textbox', { name: '搜索插件', exact: true }).fill(selected.id);
  const card = center.locator('.pc-plugin-row').filter({ hasText: manifest.name });
  await card.getByRole('button', { name: '安装', exact: true }).click();
  await center.getByRole('heading', { name: manifest.name, exact: true, level: 2 }).waitFor();
  const installed = (await catalog()).plugins.find(item => item.id === selected.id);
  assert.equal(installed?.version, manifest.version);
  assert.equal(installed.icon.kind, 'png');
  assert.equal(installed.package?.provenance, 'recorded');
  const { icon: installedDesktopIcons, ...installedDesktop } = installed.package.desktop ?? {};
  assert.deepEqual(installedDesktop, expectedDesktop);
  assert.deepEqual(installed.package.requirements, expectedRequirements);
  // Recorded installations project package-local icon paths to host-validated image data URLs.
  assert.deepEqual(Object.keys(installedDesktopIcons ?? {}).sort(), Object.keys(expectedDesktopIcons).sort());
  for (const [mode, path] of Object.entries(expectedDesktopIcons)) {
    const bytes = await readFile(join(root, 'plugins', selected.id, path));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(installedDesktopIcons[mode], `data:image/png;base64,${bytes.toString('base64')}`);
  }
  await center.getByRole('tab', { name: '使用说明', exact: true }).click();
  await page.screenshot({ path: join(output, `${evidenceName}-installed.png`) });
  await center.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.locator('.composer > .composer-input').waitFor();
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
  evidence = { passed: true, source, sourceKind: market.kind, marketplace: registry.marketplaceName,
    sourceTransport: remote ? 'network-git' : gitSource ? 'file-git' : 'local-directory',
    plugin: selected.id, version: manifest.version, platform: process.platform, arch: process.arch,
    executablePath, userData: profile, appVersion: identity.version, packaged: identity.packaged,
    nativeDiscovery: true, nativeUiInstall: true, nativeRuntimeResourcesLoaded: true,
    reviewedRequirementsMatched: true, installedDesktopMatched: true, desktopIconBytesMatched: true,
    uninstallReinstall: true, gitRefresh: gitSource, originalPluginsRetained: true,
    realProfileModified: false, realFeishu: false, modelRequests };
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'dfsc-failure.png') }).catch(() => {});
  throw error;
} finally {
  try {
    await closeDesktopFixtureAndWait(app);
    shutdown = { exitCode: child.exitCode, remainingWindows: app.windows().filter(page => !page.isClosed()).length };
    assert.equal(shutdown.exitCode, 0);
    assert.equal(shutdown.remainingWindows, 0);
  }
  finally { await new Promise(resolve => provider.close(resolve)); }
}
assert.deepEqual(errors, []);
assert.equal(modelRequests, 0, 'Marketplace verification must not request model inference, including shutdown');
evidence.modelRequests = modelRequests;
evidence.shutdown = shutdown;
await writeFile(join(output, `${evidenceName}.json`), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(evidence));
