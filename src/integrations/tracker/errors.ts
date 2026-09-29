export class JiraAuthError extends Error {
  constructor(status: number, path: string) {
    super(`Jira API token is invalid or expired (HTTP ${status} on ${path}). Update JIRA_API_TOKEN and retry.`);
    this.name = "JiraAuthError";
  }
}

export class JiraApiError extends Error {
  constructor(status: number, method: string, path: string, body: string) {
    super(`Jira API ${method} ${path} failed: ${status} ${body}`);
    this.name = "JiraApiError";
  }
}
