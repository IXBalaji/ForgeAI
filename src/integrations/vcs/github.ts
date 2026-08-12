import "dotenv/config";
import type { VcsProvider } from "./types.js";

export class GitHubAdapter implements VcsProvider {
  readonly name = "github";

  private readonly token: string | undefined;
  private readonly owner: string | undefined;
  private readonly repo: string | undefined;

  constructor() {
    this.token = process.env.GITHUB_TOKEN;
    this.owner = process.env.GITHUB_OWNER;
    this.repo = process.env.GITHUB_REPO;
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.owner && this.repo);
  }

  authenticatedRemoteUrl(): string | null {
    if (!this.isConfigured()) return null;
    return `https://x-access-token:${this.token}@github.com/${this.owner}/${this.repo}.git`;
  }

  isConflictError(err: Error): boolean {
    return /409|conflict|merge/i.test(err.message);
  }

  private async ghFetch(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async mergeBranch(head: string, base: string, commitMessage: string): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — branch "${head}" was not merged into "${base}".`);
      return null;
    }
    const result = await this.ghFetch(`/repos/${this.owner}/${this.repo}/merges`, {
      method: "POST",
      body: JSON.stringify({ base, head, commit_message: commitMessage }),
    });
    return result?.sha ?? null;
  }

  /**
   * Merges `base` into `head` to bring a stale branch up to date — implemented
   * as a merge with head/base swapped relative to `mergeBranch`.
   */
  async updateBranchFromBase(head: string, base: string): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — branch "${head}" was not updated from "${base}".`);
      return null;
    }
    const result = await this.ghFetch(`/repos/${this.owner}/${this.repo}/merges`, {
      method: "POST",
      body: JSON.stringify({ base: head, head: base, commit_message: `chore: merge ${base} into ${head} to resolve conflicts` }),
    });
    return result?.sha ?? null;
  }

  /**
   * Creates a lightweight tag via the Git References API rather than a local
   * checkout, so the caller doesn't need its own worktree — the rollback
   * mechanism is "redeploy the last-good tag."
   */
  async createTag(tagName: string, commitSha: string): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — tag "${tagName}" was not created.`);
      return null;
    }
    await this.ghFetch(`/repos/${this.owner}/${this.repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/tags/${tagName}`, sha: commitSha }),
    });
    return tagName;
  }
}
