#!/usr/bin/env node
// Validate declarations as data only; do not import or execute plugin code.
import { readFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max) => typeof value === 'string' && !!value.trim()
  && value.length <= max && !/[\u0000-\u001f]/u.test(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const https = value => {
  if (!bounded(value, 2048)) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
};
const guide = ' See CONTRIBUTING.md (marketplace declarations); fix the upstream file, pin its commit and sync again.';

export function checkMetadata(value) {
  const issues = [];
  const add = (level, message) => issues.push({ level, message: message + guide });
  if (value === undefined) {
    add('warning', 'Missing dfsc.plugin.json: declare authors, requirements.dfsc and requirements.external.');
    return issues;
  }
  if (!object(value) || value.schemaVersion !== 1) {
    add('error', 'dfsc.plugin.json must be an object with schemaVersion: 1.');
    return issues;
  }
  if (value.authors === undefined || Array.isArray(value.authors) && value.authors.length === 0) {
    add('warning', 'authors is not declared; maintainers do not replace plugin authors.');
  } else if (!Array.isArray(value.authors) || value.authors.length > 8
    || value.authors.some(person => !object(person) || !bounded(person.name, 160))) {
    add('error', 'authors must contain at most 8 people with nonempty names of at most 160 UTF-16 code units.');
  }
  const requirements = value.requirements;
  if (requirements !== undefined && !keys(requirements, ['dfsc', 'external'])) {
    add('error', 'requirements must be an object containing only dfsc and external.');
    return issues;
  }
  if (requirements?.dfsc === undefined) {
    add('warning', 'requirements.dfsc is not declared; omission does not mean all DFSC versions are supported.');
  } else if (!bounded(requirements.dfsc, 128) || !semver.validRange(requirements.dfsc.trim())) {
    add('error', 'requirements.dfsc must be a valid npm semver range of at most 128 UTF-16 code units.');
  }
  const external = requirements?.external;
  if (external === undefined) {
    add('warning', 'requirements.external is not declared; use [] only if no extra requirements are needed.');
  } else if (!Array.isArray(external) || external.length > 12) {
    add('error', 'requirements.external must be an array with at most 12 items.');
  } else {
    external.forEach((item, index) => {
      if (!keys(item, ['name', 'description', 'url', 'optional']) || !bounded(item.name, 160)
        || item.description !== undefined && !bounded(item.description, 512)
        || item.url !== undefined && !https(item.url)
        || item.optional !== undefined && typeof item.optional !== 'boolean') {
        add('error', `requirements.external[${index}] needs a bounded name, optional single-line description, credential-free HTTPS URL and boolean optional; no other keys.`);
      }
    });
  }
  return issues;
}

export async function checkMarketplace(root) {
  const config = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));
  if (!object(config) || !Array.isArray(config.plugins)) throw new Error('Invalid registry.');
  const issues = [];
  for (const plugin of config.plugins) {
    // Paths and annotation properties never come from unvalidated author text.
    if (!object(plugin) || typeof plugin.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(plugin.id))
      throw new Error('Invalid plugin identifier.');
    const file = `plugins/${plugin.id}/dfsc.plugin.json`;
    let value;
    try {
      const info = await lstat(join(root, file));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
        throw new Error('Invalid presentation file.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(root, file)));
      value = JSON.parse(text);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        issues.push({ plugin: plugin.id, file, level: 'error',
          message: 'dfsc.plugin.json must be a regular UTF-8 JSON file no larger than 64 KiB.' + guide });
        continue;
      }
    }
    issues.push(...checkMetadata(value).map(issue => ({ plugin: plugin.id, file, ...issue })));
  }
  return { plugins: config.plugins.length, issues };
}

const escapeMessage = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
export function formatIssue(issue, github = false) {
  const text = `${issue.plugin}: ${issue.message}`;
  if (!github) return `${issue.level.toUpperCase()}: ${text}`;
  const file = escapeMessage(issue.file).replaceAll(':', '%3A').replaceAll(',', '%2C');
  return `::${issue.level} file=${file},title=Plugin metadata::${escapeMessage(text)}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--root'))
    throw new Error('Usage: node scripts/check-plugin-metadata.mjs [--root PATH]');
  const root = args.length ? resolve(args[1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await checkMarketplace(root);
  for (const issue of result.issues) console.log(formatIssue(issue, process.env.GITHUB_ACTIONS === 'true'));
  const errors = result.issues.filter(issue => issue.level === 'error').length;
  console.log(JSON.stringify({ plugins: result.plugins, errors, warnings: result.issues.length - errors }));
  if (errors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Plugin metadata check failed: verify the registry and presentation files. Raw file contents are not logged.');
    process.exitCode = 1;
  });
}
