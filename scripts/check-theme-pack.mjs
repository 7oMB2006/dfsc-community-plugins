#!/usr/bin/env node
// Read bounded package data only. Never import an author's renderer or entry.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseThemeComposition } from './theme-contract/theme-composition.mjs';

const MiB = 1024 * 1024;
export const MARKET_FILE_BYTES = 8 * MiB;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max) => typeof value === 'string' && !!value.trim()
  && value.length <= max && !/[\u0000-\u001f]/u.test(value);
const guide = ' See docs/theme-authoring.md; fix the upstream package, pin its commit and sync again.';
const paletteKeys = ['bg', 'side', 'surface', 'ink', 'muted', 'border', 'code', 'accent'];

async function regular(root, name, limit) {
  const file = join(root, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error(`Expected a regular package file within its size limit: ${name}.`);
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new Error(`File exceeds its size limit: ${name}.`);
  return bytes;
}

async function json(root, name, limit) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await regular(root, name, limit)));
}

function luminance(hex) {
  const values = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}

function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

function size(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 8192 || height > 8192 || width * height > 32 * MiB) throw new Error('Invalid image dimensions.');
  return { width, height };
}

// These are header/structure checks, deliberately not a native image decoder.
export function imageHeader(bytes, filename) {
  if (filename === 'background.png') {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw new Error('Expected PNG signature.');
    let dimensions, data = false, offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type)
        || ['acTL', 'fcTL', 'fdAT'].includes(type) || !dimensions && type !== 'IHDR')
        throw new Error('Invalid or animated PNG structure.');
      if (type === 'IHDR') {
        if (dimensions || length !== 13) throw new Error('Invalid PNG header.');
        dimensions = size(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
        const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[bytes[offset + 17]]?.includes(bytes[offset + 16])
          || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1)
          throw new Error('Unsupported PNG header.');
      } else if (type === 'IDAT' && length) data = true;
      else if (type === 'IEND') {
        if (!dimensions || !data || length || offset + 12 !== bytes.length) throw new Error('Invalid PNG ending.');
        return dimensions;
      }
      offset += length + 12;
    }
    throw new Error('Incomplete PNG.');
  }
  if (filename !== 'background.jpg' || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error('Expected JPEG signature.');
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) break;
    if (frames.has(marker)) {
      const components = bytes[offset + 7];
      if (length < 11 || components < 1 || components > 4 || length !== 8 + components * 3) break;
      return size(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  throw new Error('Missing or invalid JPEG dimensions.');
}

export async function checkPackage(directory, { optional = false } = {}) {
  const issues = [];
  const add = (level, file, message) => issues.push({ level, file, message: message + guide });
  let root, raw;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid package directory.');
    root = await realpath(directory);
  } catch {
    add('error', 'dfsc.theme.json', 'Package directory must exist and must not be a symbolic link.');
    return { theme: true, issues };
  }
  try {
    raw = await json(root, 'dfsc.theme.json', 32 * 1024);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { theme: false, issues };
    add('error', 'dfsc.theme.json', 'Theme declaration must be a regular UTF-8 JSON file no larger than 32 KiB.');
    return { theme: true, issues };
  }
  let composition;
  try { composition = parseThemeComposition(raw); } catch {
    add('error', 'dfsc.theme.json', 'Unsupported theme composition: check schemaVersion, ui, background, source and accepts; unknown v2 fields are rejected.');
    return { theme: true, issues };
  }
  if (!bounded(raw.name, 80) || !['dark', 'light'].includes(raw.scheme)
    || composition.ui === 'stellar-v1' && raw.scheme !== 'dark')
    add('error', 'dfsc.theme.json', 'A bounded name and supported scheme are required; stellar-v1 UI supports dark only.');
  if (!object(raw.colors) || paletteKeys.some(key => !/^#[0-9a-f]{6}$/i.test(raw.colors[key] ?? ''))) {
    add('error', 'dfsc.theme.json', 'All eight palette fields must be six-digit hex colors.');
  } else {
    for (const fg of ['ink', 'muted']) for (const bg of ['bg', 'side', 'surface', 'code']) {
      if (contrast(raw.colors[fg], raw.colors[bg]) < 4.5)
        add('error', 'dfsc.theme.json', `Palette contrast for ${fg} against ${bg} must be at least 4.5:1.`);
    }
  }
  if (raw.schemaVersion === 1)
    add('warning', 'dfsc.theme.json', 'Legacy v1 retains its integrated Stellar UI/scene and has no replacement slot. New themes should use v2, even when accepts is empty.');
  try {
    const manifest = await json(root, 'step.plugin.json', 32 * 1024);
    if (!object(manifest) || typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(manifest.id)
      || typeof manifest.version !== 'string' || manifest.version.length > 32
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version))
      throw new Error('Invalid native identity.');
    if (['skills', 'commands', 'agents'].some(key => !Array.isArray(manifest[key]) || manifest[key].length)
      || manifest.mcpServers !== undefined && (!object(manifest.mcpServers) || Object.keys(manifest.mcpServers).length))
      add('warning', 'step.plugin.json', 'This is not an explicitly resource-free theme manifest. Pure-data themes declare empty skills, commands and agents and no MCP; mixed plugins retain normal runtime gates.');
  } catch {
    add('error', 'step.plugin.json', 'Theme identity must be valid regular JSON within 32 KiB; check id and version.');
  }
  if (composition.background.renderer === 'image-v1') {
    const filename = composition.background.source;
    try { imageHeader(await regular(root, filename, MARKET_FILE_BYTES), filename); } catch {
      add('error', filename, 'Missing or invalid static background: match PNG/JPEG content and filename, keep within the market 8 MiB file limit, 8192 per edge and 33,554,432 pixels; APNG is not supported.');
    }
  } else if (composition.background.renderer === 'stellar-v1') {
    try {
      if (!object(await json(root, 'scene.json', 6 * MiB))) throw new Error('Invalid scene.');
    } catch { add('error', 'scene.json', 'Stellar backgrounds require package-local scene.json object data within 6 MiB.'); }
  }
  if (raw.cover !== undefined) {
    try {
      if (raw.cover !== 'cover.png') throw new Error('Invalid cover name.');
      const dimensions = imageHeader(await regular(root, 'cover.png', 512 * 1024), 'background.png');
      if (dimensions.width > 1920 || dimensions.height > 1080) throw new Error('Invalid cover dimensions.');
    } catch {
      add('warning', 'dfsc.theme.json', 'Optional cover is unavailable or invalid; the host falls back. Use cover.png within 512 KiB and 1920x1080.');
    }
  }
  return { theme: true, composition, issues };
}

export async function checkMarketplace(root) {
  const registry = await json(root, 'registry.json', MiB);
  if (!object(registry) || !Array.isArray(registry.plugins)) throw new Error('Invalid registry.');
  if ((await lstat(join(root, 'plugins'))).isSymbolicLink()) throw new Error('Linked plugins directory.');
  let themes = 0;
  const issues = [];
  for (const plugin of registry.plugins) {
    if (!object(plugin) || typeof plugin.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(plugin.id))
      throw new Error('Invalid registry identity.');
    const result = await checkPackage(join(root, 'plugins', plugin.id), { optional: true });
    if (result.theme) themes++;
    issues.push(...result.issues.map(issue => ({ ...issue, plugin: plugin.id, file: `plugins/${plugin.id}/${issue.file}` })));
  }
  return { themes, issues };
}

const escape = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
export function formatIssue(issue, github = false) {
  const message = `${issue.plugin ?? 'Theme package'}: ${issue.message}`;
  return github ? `::${issue.level} file=${escape(issue.file).replaceAll(':', '%3A').replaceAll(',', '%2C')},title=Theme package::${escape(message)}`
    : `${issue.level.toUpperCase()} ${issue.file}: ${message}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || !['--root', '--package'].includes(args[0])))
    throw new Error('Usage: node scripts/check-theme-pack.mjs [--root MARKET | --package PACKAGE]');
  const root = args.length ? resolve(args[1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = args[0] === '--package' ? await checkPackage(root) : await checkMarketplace(root);
  for (const issue of result.issues) console.log(formatIssue(issue, process.env.GITHUB_ACTIONS === 'true'));
  const errors = result.issues.filter(issue => issue.level === 'error').length;
  console.log(JSON.stringify({ themes: result.themes ?? Number(result.theme), errors,
    warnings: result.issues.length - errors, scope: 'static-only', ...(result.composition ? { composition: result.composition } : {}) }));
  if (errors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error('Theme check failed: check arguments, registry and package files. Raw contents are not logged.');
    process.exitCode = 1;
  });
