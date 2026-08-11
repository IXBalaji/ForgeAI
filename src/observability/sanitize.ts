const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]+/g,
  /x-access-token:[^@\s]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /ANTHROPIC_API_KEY[=:\s]+[^\s"']+/gi,
  /LANGSMITH_API_KEY[=:\s]+[^\s"']+/gi,
  /GITHUB_TOKEN[=:\s]+[^\s"']+/gi,
];

const MAX_TRACE_STRING_LENGTH = 8000;

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  if (out.length > MAX_TRACE_STRING_LENGTH) {
    return `${out.slice(0, MAX_TRACE_STRING_LENGTH)}… [truncated]`;
  }
  return out;
}

/** Recursively redact secrets and truncate large strings for LangSmith traces. */
export function sanitizeForTrace(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[max depth]";
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForTrace(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (/api[_-]?key|token|secret|password|authorization/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = sanitizeForTrace(val, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}
