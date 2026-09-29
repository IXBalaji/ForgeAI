export class GitHubAuthError extends Error {
  constructor(status: number, path: string) {
    super(`GitHub token is invalid or expired (HTTP ${status} on ${path}). Update GITHUB_TOKEN and retry.`);
    this.name = "GitHubAuthError";
  }
}

export class GitHubApiError extends Error {
  constructor(status: number, method: string, path: string, body: string) {
    super(`GitHub API ${method} ${path} failed: ${status} ${body}`);
    this.name = "GitHubApiError";
  }
}
