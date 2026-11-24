/**
 * text.mjs — 文本归一化、分词、相似度、脱敏
 *
 * 记忆的价值取决于「查得到」与「不写脏东西」，这两件事都在这里：
 *   - tokens 同时产出拉丁整词与中文单字 + 相邻二字组；中文没有空格，
 *     只切整词会让「写」这种单字查询永远匹配不上。
 *   - cosine 用多重集合向量，相同文本恒为 1，互不相交恒为 0。
 *   - redact 在写入与输出前统一处理常见凭据形态，替换为 [redacted] 并计数，
 *     让调用方知道有内容被抹掉（而不是静默丢字）。
 */

const CJK = /\p{Script=Han}+/gu;
const LATIN = /[\p{L}\p{N}_-]+/gu;

// 少量同义展开：只覆盖真实出现过的检索失败（"用户喜欢什么风格" 查不到只写「要求」的条目）。
// 刻意保持很小：表越大，错配越难解释；宁可漏召回，不可乱召回。
const SYNONYMS = new Map([
  ['风格', ['偏好', '要求', '口味', '习惯']],
  ['喜欢', ['偏好', '要求', '习惯']],
  ['偏好', ['要求', '习惯']],
  ['口味', ['偏好', '要求']],
  ['规范', ['约定', '要求']],
  ['约定', ['规范', '要求']],
  ['坑', ['陷阱', '注意', '问题']],
  ['踩坑', ['陷阱', '注意']],
  ['报错', ['错误', '失败', '异常']],
  ['存哪', ['路径', '位置', '存放']],
  ['在哪', ['路径', '位置']],
]);

// 停用词：不承载检索信息，只会在分母里稀释真正的命中文档。
// 中文疑问句几乎句句带这些字，若不剔除，「构建是用什么工具跑的」里的
// 「构建」会被「是/用/什/么/的」摊薄到门槛以下（实测 0.1126，门槛 0.12）。
const STOPWORDS = new Set([
  '的', '是', '在', '有', '和', '与', '或', '就', '也', '都', '而', '及', '等',
  '我', '你', '他', '它', '这', '那', '哪', '个', '些', '之', '其',
  '什', '么', '怎', '样', '吗', '呢', '吧', '啊', '呀', '着', '过', '了',
  '用', '把', '被', '让', '给', '对', '从', '到', '为', '以', '于',
  '如', '何', '要', '会', '能', '可', '该', '请', '说', '做', '来', '去',
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in',
  'on', 'at', 'for', 'and', 'or', 'it', 'this', 'that', 'with', 'do', 'does',
]);

/**
 * 停用词判定：只看单字。
 *
 * 二字组不按「含停用字」剔除：`用户`、`要求`、`偏好` 都含停用字，但它们是
 * 真正有区分度的检索词。按字剔除会把它们一起删掉（实测让「用户喜欢什么风格」
 * 从命中变成查不到）。疑问噪声主要来自单字层面的「是/什么/的」。
 */
export function isStopword(token) {
  return [...token].length === 1 && STOPWORDS.has(token);
}

export function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** 记忆正文的落盘形态：一条一句，折叠连续空白，但保留原样大小写。 */
export function tidy(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function tokens(value) {
  const text = String(value ?? '').normalize('NFKC');
  const out = [];
  // 先把汉字整段取走，再做拉丁词扫描：\p{L} 也覆盖汉字，
  // 不排除的话「构建用」会被当成一个拉丁整词，中文查询就永远匹配不上。
  for (const match of text.matchAll(CJK)) {
    const run = match[0];
    for (const char of run) out.push(char);
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  for (const match of text.replace(CJK, ' ').matchAll(LATIN)) {
    const word = match[0].toLowerCase().replace(/^-+|-+$/gu, '');
    if (word) out.push(word);
  }
  return out;
}

/**
 * 查询侧的分词：在 tokens 之上加同义展开。
 *
 * 只在查询侧展开，写入侧保持原样：记忆文件里存的是作者原话，
 * 不会被同义词表改写；检索时多给几个等价说法。
 */
export function queryTokens(value) {
  const base = tokens(value);
  const extra = [];
  for (const token of new Set(base)) {
    for (const synonym of SYNONYMS.get(token) ?? []) extra.push(...tokens(synonym));
  }
  return extra.length ? [...base, ...extra] : base;
}

function counts(items) {
  const map = new Map();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

export function cosine(left, right) {
  const a = Array.isArray(left) ? left : tokens(left);
  const b = Array.isArray(right) ? right : tokens(right);
  if (!a.length || !b.length) return 0;
  const leftCounts = counts(a);
  const rightCounts = counts(b);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of leftCounts.values()) normA += value * value;
  for (const value of rightCounts.values()) normB += value * value;
  for (const [token, value] of leftCounts) {
    const other = rightCounts.get(token);
    if (other) dot += value * other;
  }
  const value = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // 相同文本必须精确为 1，不能因为浮点误差变成 0.9999999999999998：
  // 调用方会用 >= 阈值判断「是否同一条记忆」。
  return value > 1 - 1e-12 ? 1 : value;
}

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/giu, '$1 [redacted]'],
  [/\b(?:sk|rk|pk|ghp|gho|ghu|ghs|ghr|glpat|github_pat|xoxa|xoxb|xoxp)[-_][A-Za-z0-9_-]{8,}/gu, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, '[redacted]'],
  [/\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gu, '$1=[redacted]'],
  // 只抹长十六进制串：通用的「40 位以上字母数字」规则会把正常的长标识符、
  // 路径和成段文本一起吃掉，代价高于收益；带前缀或赋值的密钥已由上面前缀/赋值规则覆盖。
  [/\b[A-Fa-f0-9]{32,}\b/gu, '[redacted]'],
];

export function redact(value) {
  let text = String(value ?? '');
  let redacted = 0;
  for (const [pattern, replacement] of RULES) {
    text = text.replace(pattern, (...args) => {
      redacted += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement.replace(/\$(\d+)/gu, (_, index) => args[Number(index)] ?? '');
    });
  }
  return { text, redacted };
}

/** 硬截断：返回值长度不超过 max（省略号计入预算），调用方可直接用它保证上限。 */
export function clip(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  if (max <= 1) return '…'.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1)}…`;
}
