/**
 * 统一错误类型。
 * McpToolError 面向调用方（模型/用户），message 必须是可读的中文说明，不含密钥。
 */

export class McpToolError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'McpToolError';
    this.code = options.code ?? 'TOOL_ERROR';
    this.details = options.details;
  }
}

/**
 * 把上游 API 的非 2xx 响应包装成 McpToolError。
 * 只保留 status 与响应体摘要，绝不透出 Authorization 头或 key。
 */
export function apiError(operation, response, bodyText) {
  const snippet = typeof bodyText === 'string' && bodyText.length > 0
    ? bodyText.slice(0, 500)
    : '(空响应体)';
  return new McpToolError(
    `${operation} 失败：上游返回 HTTP ${response.status}`,
    { code: 'UPSTREAM_HTTP_ERROR', details: { status: response.status, body: snippet } },
  );
}

/** 网络层错误（fetch 抛错）包装。 */
export function networkError(operation, cause) {
  return new McpToolError(
    `${operation} 失败：无法连接到上游服务（${cause?.message ?? '未知网络错误'}）`,
    { code: 'UPSTREAM_NETWORK_ERROR' },
  );
}
