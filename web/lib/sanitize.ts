/**
 * Sanitize log output before serving over HTTP.
 *
 * Reuses patterns from src/observability/sanitize.ts — this log becomes a new
 * trust boundary the moment it's reachable via a browser GET request.
 */

const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]+/g,
  /x-access-token:[^@\s]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /ANTHROPIC_API_KEY[=:\s]+[^\s"']+/gi,
  /LANGSMITH_API_KEY[=:\s]+[^\s"']+/gi,
  /GITHUB_TOKEN[=:\s]+[^\s"']+/gi,
  /JIRA_API_TOKEN[=:\s]+[^\s"']+/gi,
];

/**
 * Redact secrets from a single log line.
 */
export function sanitizeLogLine(line: string): string {
  let sanitized = line;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

/**
 * Sanitize an array of log lines.
 */
export function sanitizeLogLines(lines: string[]): string[] {
  return lines.map(sanitizeLogLine);
}
