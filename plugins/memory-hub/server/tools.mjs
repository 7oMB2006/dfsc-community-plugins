/**
 * tools.mjs — MCP 工具定义与调用分发
 *
 * 每个工具的 description 是写给模型看的：说清「什么时候该用」，而不只是「这个工具做什么」，
 * 因为 DFSC 没有会话钩子，写入与检索的时机完全由代理按这段话自己判断。
 *
 * 输入一律按「不可信」处理：长度、数量、枚举、路径都夹紧后再进存储层。
 */
import { MemoryBank, defaultHome, defaultSessionsRoot } from './store.mjs';
import { digestSessions } from './digest.mjs';
import { RECALL_LIMIT_MAX, MAX_TAGS, MAX_TEXT } from './evolve.mjs';

const SCOPE = { type: 'string', enum: ['project', 'global', 'all'], description: '检索或写入的记忆库范围。' };
const PROJECT = {
  type: 'string',
  description: '当前工作区的绝对路径（如 D:\\\\AgentPrograms\\\\my-repo）。强烈建议每次都传：MCP 进程不知道你在哪个项目里，缺省会从最近会话推断，可能落到错误的库。',
};

function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

export const TOOLS = [
  tool(
    'retain',
    '把一条值得长期记住的结论写进项目记忆（事实、决策、可复用做法、用户偏好、踩过的坑）。'
      + '当用户确认了一个方向、你查清了项目约定、或刚解决了一个以后还会再遇到的坑时调用。'
      + '一句一条、写结论不写过程；重复内容会自动并入已有条目。凭据类文本会被自动脱敏。',
    {
      text: { type: 'string', description: `一句话结论，最长 ${MAX_TEXT} 字符。写「构建用 pnpm workspaces」，不要写排查过程。` },
      type: { type: 'string', enum: ['fact', 'decision', 'lesson', 'preference', 'pitfall'], description: '记忆类型，影响召回时的分组。默认 fact。' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS, description: '可选标签，用于按主题过滤，最多 8 个。' },
      importance: { type: 'number', minimum: 0, maximum: 1, description: '重要度 0–1，默认 0.5。影响召回排序与淘汰顺序。' },
      scope: SCOPE,
      project: PROJECT,
      source: { type: 'string', description: '可选来源标注，例如会话 id 或文件路径，便于以后追溯。' },
    },
    ['text'],
  ),
  tool(
    'recall',
    '按查询取回相关记忆。开工前、用户提到「上次/之前/我们说好的」、或要确认项目约定与历史决策时先调用。'
      + '返回结果按相关度排序，被返回的条目会被记为一次命中（这是记忆强化机制，不是只读查询）。'
      + '把命中内容当线索，不要当事实：与当前仓库状态冲突时以仓库为准。',
    {
      query: { type: 'string', description: '要检索的关键词或一句话描述。留空则按权重与新近度列出。' },
      type: { type: 'string', enum: ['fact', 'decision', 'lesson', 'preference', 'pitfall'], description: '只看某一类型。' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS, description: '按标签过滤（须命中任一标签）。' },
      limit: { type: 'integer', minimum: 1, maximum: RECALL_LIMIT_MAX, description: `返回条数上限，默认 8，最大 ${RECALL_LIMIT_MAX}。` },
      status: { type: 'string', enum: ['active', 'invalidated', 'archived', 'all'], description: '默认只看 active；查历史结论时用 all。' },
      scope: SCOPE,
      project: PROJECT,
    },
  ),
  tool(
    'reflect',
    '围绕一个问题把已存记忆按类型组装成证据包，并列出与之矛盾的已失效条目。'
      + '适合「我们之前怎么定架构的」「这个项目有哪些已知坑」这类需要综合多个片段的提问。'
      + '注意：它只做检索与分组，不调用模型、不生成新结论——结论由你自己下。',
    {
      question: { type: 'string', description: '要综合回答的问题。' },
      limit: { type: 'integer', minimum: 1, maximum: RECALL_LIMIT_MAX, description: '每组最多几条。' },
      scope: SCOPE,
      project: PROJECT,
    },
  ),
  tool(
    'memory_edit',
    '改写一条已有记忆：update 改内容/标签/重要度，invalidate 标记被推翻（推荐，保留历史），'
      + 'restore 恢复，archive 手动归档，forget 物理删除（需要 confirm: "yes"）。'
      + '推翻旧结论时优先用 invalidate 并填 replacementId，不要直接 forget——历史本身是信息。',
    {
      op: { type: 'string', enum: ['update', 'invalidate', 'restore', 'archive', 'forget'], description: '变更类型。' },
      id: { type: 'string', description: 'recall 返回的记忆 id，形如 m_1a2b3c4d5e6f。' },
      text: { type: 'string', description: 'update 时的新文本。' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS, description: 'update 时的完整标签集合。' },
      importance: { type: 'number', minimum: 0, maximum: 1, description: 'update 时的新重要度。' },
      type: { type: 'string', enum: ['fact', 'decision', 'lesson', 'preference', 'pitfall'], description: 'update 时的新类型。' },
      replacementId: { type: 'string', description: 'invalidate 时指向取而代之的条目 id。' },
      confirm: { type: 'string', description: 'forget 必须填 "yes"。' },
      scope: { type: 'string', enum: ['project', 'global'], description: '条目所在库，默认 project。' },
      project: PROJECT,
    },
    ['op', 'id'],
  ),
  tool(
    'stats',
    '查看记忆库概况：各库条目数与状态分布、容量上限、热门标签、存储路径，以及本次解析到的项目与来源。'
      + '排查「写进去的怎么找不到了」时先看它：常见原因是 project 归属不同或库文件损坏。',
    { project: PROJECT },
  ),
  tool(
    'history_digest',
    '取出本项目最近若干会话的正文摘录，作为记忆巩固的素材。'
      + '用法：用户说「把这次学到的东西记下来」或执行 /memory consolidate 时，先取素材，再据此调用 retain。'
      + '它会跳过子代理会话与工具输出，并严格限制总字符数；truncated 为 true 表示还有更多内容没取。',
    {
      sessions: { type: 'integer', minimum: 1, maximum: 10, description: '取最近几个会话，默认 3。' },
      maxChars: { type: 'integer', minimum: 1000, maximum: 60000, description: '总字符预算，默认 12000。' },
      project: PROJECT,
    },
  ),
  tool(
    'memory_maintain',
    '手动跑一次记忆维护：把长期没命中、超过保留期的条目归档，并按容量上限淘汰最弱的条目。'
      + '写入时已经自动做过这件事，所以只在一个项目很久没有新写入、而你想手动清理时才需要。'
      + '归档不是删除：条目仍能用 recall(status: "archived") 查到，需要时可 memory_edit restore。',
    {
      days: { type: 'integer', minimum: 1, maximum: 3650, description: '保留天数窗口，默认 60；命中过 0 次且早于窗口的条目会被归档。' },
      cap: { type: 'integer', minimum: 1, maximum: 5000, description: '项目库 active 上限，默认 600。' },
      project: PROJECT,
    },
  ),
  tool(
    'memory_purge',
    '清空记忆库：把库文件移到同目录的 .trash-<时间戳> 文件而不是直接删除。'
      + '不可撤销地丢弃数据前必须先向用户确认；需要 confirm: "DELETE"。',
    {
      scope: { type: 'string', enum: ['project', 'global', 'all'], description: '清空哪个库，默认 project。' },
      confirm: { type: 'string', description: '必须填 "DELETE"。' },
      project: PROJECT,
    },
    ['confirm'],
  ),
];

export function createToolContext({ log = () => {}, env = process.env } = {}) {
  const bank = new MemoryBank({ home: defaultHome(env), sessionsRoot: defaultSessionsRoot(env), log, env });
  return {
    log,
    env,
    bank,
    home: bank.home,
    sessionsRoot: bank.sessionsRoot,
    async digest(args = {}) {
      const resolved = bank.resolve(args.project);
      return digestSessions({
        sessionsRoot: bank.sessionsRoot,
        slug: resolved.slug,
        count: args.sessions,
        maxChars: args.maxChars,
      });
    },
  };
}

const HANDLERS = {
  retain: (args, ctx) => ctx.bank.retain(args),
  recall: (args, ctx) => ctx.bank.recall(args),
  reflect: (args, ctx) => ctx.bank.reflect(args),
  memory_edit: (args, ctx) => ctx.bank.edit(args),
  stats: (args, ctx) => ctx.bank.stats(args),
  history_digest: (args, ctx) => ctx.digest(args),
  memory_maintain: (args, ctx) => ctx.bank.maintenance(args),
  memory_purge: (args, ctx) => ctx.bank.purge(args),
};

export const TOOL_NAMES = new Set(Object.keys(HANDLERS));

export async function callTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`unknown tool: ${String(name)}`);
  return handler(args ?? {}, ctx);
}
