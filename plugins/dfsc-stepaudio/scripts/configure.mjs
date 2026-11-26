#!/usr/bin/env node
/**
 * dfsc-StepAudio 独立模式配置 CLI。
 *
 * 市场安装的插件无法通过 mcpServers.env 携带用户真实 Key，因此私密配置
 * （API Key 等）保存在插件目录之外：<profile>/stepaudio/config.json 指向一个
 * 插件目录外的 env 文件。本命令负责写入与校验该配置。
 *
 * 用法：
 *   node scripts/configure.mjs --profile <目录> --mode independent --env-file <绝对路径> [--replace]
 *   node scripts/configure.mjs --profile <目录> --check
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from '../src/lib/env-file.js';
import { McpToolError } from '../src/lib/errors.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_KEY_CANDIDATES = ['STEP_API_KEY', 'STEPFUN_API_KEY'];
const MAX_ENV_FILE_BYTES = 128 * 1024;

export function parseArgs(argv) {
  const options = { mode: undefined, replace: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--replace') {
      options.replace = true;
      continue;
    }
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    const [flag, inlineValue] = argument.includes('=') ? splitOnce(argument, '=') : [argument, undefined];
    const value = inlineValue ?? argv[(index += 1)];
    if (value === undefined) throw new McpToolError(`参数 ${flag} 缺少取值`, { code: 'USAGE' });
    switch (flag) {
      case '--profile':
        options.profile = value;
        break;
      case '--mode':
        options.mode = value;
        break;
      case '--env-file':
        options.envFile = value;
        break;
      default:
        throw new McpToolError(`未知参数：${flag}`, { code: 'USAGE' });
    }
  }
  return options;
}

function splitOnce(text, separator) {
  const index = text.indexOf(separator);
  return [text.slice(0, index), text.slice(index + 1)];
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 读取并校验私密 env 文件；返回 { key, baseUrl, model }。不打印 Key。 */
export async function validateEnvFile(envFile, { pluginRoot = PLUGIN_ROOT } = {}) {
  if (!path.isAbsolute(envFile)) {
    throw new McpToolError('--env-file 必须使用绝对路径', { code: 'USAGE' });
  }
  if (isInside(pluginRoot, envFile)) {
    throw new McpToolError(
      '私密 env 文件必须位于插件目录之外（市场快照会公开插件目录内的文件）',
      { code: 'USAGE' },
    );
  }
  let info;
  try {
    info = await fs.stat(envFile);
  } catch {
    throw new McpToolError(`env 文件不存在：${envFile}`, { code: 'USAGE' });
  }
  if (!info.isFile() || info.size > MAX_ENV_FILE_BYTES) {
    throw new McpToolError(`env 文件不可读或超过 ${MAX_ENV_FILE_BYTES} 字节上限`, { code: 'USAGE' });
  }
  const settings = parseEnvFile(await fs.readFile(envFile, 'utf8'));
  const key = API_KEY_CANDIDATES.map((name) => settings[name]?.trim()).find((value) => value);
  if (!key) {
    throw new McpToolError(`env 文件未设置 API Key（${API_KEY_CANDIDATES.join(' 或 ')}）：${envFile}`, { code: 'USAGE' });
  }
  const baseUrl = settings.STEPAUDIO_BASE_URL?.trim();
  if (baseUrl !== undefined && !/^https?:\/\//.test(baseUrl)) {
    throw new McpToolError(`STEPAUDIO_BASE_URL 需以 http(s):// 开头：${baseUrl}`, { code: 'USAGE' });
  }
  return { key, baseUrl, model: settings.STEPAUDIO_MODEL?.trim(), official: isOfficialStepEndpoint(baseUrl) };
}

function isOfficialStepEndpoint(baseUrl) {
  if (!baseUrl) return true;
  const normalized = baseUrl.replace(/\/+$/, '');
  return [
    'https://api.stepfun.com/v1',
    'https://api.stepfun.com/step_plan/v1',
    'https://api.stepfun.ai/v1',
    'https://api.stepfun.ai/step_plan/v1',
  ].includes(normalized);
}

export function privateConfigPath(profile) {
  return path.join(path.resolve(profile), 'stepaudio', 'config.json');
}

/** 写入 <profile>/stepaudio/config.json；已存在时需 --replace。 */
export async function writePrivateConfig({ profile, envFile, replace }) {
  if (typeof profile !== 'string' || profile.trim() === '') {
    throw new McpToolError('缺少 --profile <目录>', { code: 'USAGE' });
  }
  if (typeof envFile !== 'string' || envFile.trim() === '') {
    throw new McpToolError('缺少 --env-file <绝对路径>', { code: 'USAGE' });
  }
  const configPath = privateConfigPath(profile);
  let exists = true;
  try {
    await fs.access(configPath);
  } catch {
    exists = false;
  }
  if (exists && !replace) {
    throw new McpToolError(`配置已存在：${configPath}；确认无误后使用 --replace 覆盖`, { code: 'USAGE' });
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const payload = { schemaVersion: 1, mode: 'independent', envFile: path.resolve(envFile) };
  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return configPath;
}

/** --check：校验已有配置与 env 文件，不发起任何网络请求。 */
export async function checkPrivateConfig({ profile }) {
  if (typeof profile !== 'string' || profile.trim() === '') {
    throw new McpToolError('缺少 --profile <目录>', { code: 'USAGE' });
  }
  const configPath = privateConfigPath(profile);
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (config?.schemaVersion === 2 && config.mode === 'dfsc') {
    throw new McpToolError('当前为跟随 DFSC 模式，需要宿主桥接支持；独立模式请用 --mode independent 重新配置', { code: 'CONFIG' });
  }
  if (config?.schemaVersion !== 1 || typeof config.envFile !== 'string') {
    throw new McpToolError(`配置不受支持（schemaVersion=${config?.schemaVersion}）：${configPath}`, { code: 'CONFIG' });
  }
  const summary = await validateEnvFile(config.envFile);
  return { configPath, envFile: config.envFile, ...summary, key: undefined };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    const result = await checkPrivateConfig(options);
    process.stdout.write(
      `独立模式配置 OK：${result.configPath}\n` +
        `env 文件：${result.envFile}\n` +
        `base URL：${result.baseUrl ?? '(未设置，按模式默认)'}${result.official ? '' : '（非阶跃官方地址，自定义网关）'}\n` +
        `模型：${result.model ?? '(未设置，默认 stepaudio-2.5-tts)'}\n未发起任何提供商请求。\n`,
    );
    return;
  }
  if (options.mode !== 'independent') {
    throw new McpToolError('--mode 当前仅支持 independent（跟随 DFSC 模式需宿主桥接，暂不支持）', { code: 'USAGE' });
  }
  await validateEnvFile(options.envFile ?? '');
  const configPath = await writePrivateConfig(options);
  process.stdout.write(
    `已写入私密配置：${configPath}\n` +
      `Key 保存在插件目录外的 env 文件中，未写入配置本身。\n` +
      `下一步：在 DFSC 中重载会话使 MCP 服务加载新配置；可用 --check 复查。\n`,
  );
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof McpToolError ? error.message : String(error?.message ?? error);
    process.stderr.write(`configure: ${message}\n`);
    process.exitCode = 1;
  });
}
