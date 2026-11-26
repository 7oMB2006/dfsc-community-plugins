/**
 * 极简 KEY=VALUE env 文件解析（零依赖）。
 * 规则：忽略空行与 # 注释行；取第一个 = 分隔；去除首尾空白；
 * 成对的单/双引号会被剥掉；不做变量展开。后写的键覆盖先写的。
 */

export function parseEnvFile(text) {
  const result = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key === '') continue;
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    result[key] = value;
  }
  return result;
}
