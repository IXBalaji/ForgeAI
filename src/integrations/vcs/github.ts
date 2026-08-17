import "dotenv/config";
import type { VcsProvider, PullRequestRef, PullRequestStatus, PrReviewComment } from "./types.js";

const MERGEABLE_POLL_ATTEMPTS = 4;
const MERGEABLE_POLL_DELAY_MS = 1500;

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

  private authenticatedLoginPromise: Promise<string | null> | null = null;

  /** The GitHub login this adapter's token authenticates as — cached for the process lifetime. */
  private async getAuthenticatedLogin(): Promise<string | null> {
    if (!this.authenticatedLoginPromise) {
      this.authenticatedLoginPromise = this.ghFetch("/user")
        .then((u) => u?.login ?? null)
        .catch(() => null);
    }
    return this.authenticatedLoginPromise;
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

  async findOpenPullRequest(head: string, base: string): Promise<PullRequestRef | null> {
    if (!this.isConfigured()) return null;
    const results = await this.ghFetch(
      `/repos/${this.owner}/${this.repo}/pulls?head=${encodeURIComponent(`${this.owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
    );
    const pr = Array.isArray(results) ? results[0] : null;
    if (!pr) return null;
    return { number: pr.number, url: pr.url, htmlUrl: pr.html_url, headSha: pr.head?.sha };
  }

  async createPullRequest(head: string, base: string, title: string, body: string): Promise<PullRequestRef | null> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — PR from "${head}" to "${base}" was not created.`);
      return null;
    }
    const pr = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, head, base, body }),
    });
    return { number: pr.number, url: pr.url, htmlUrl: pr.html_url, headSha: pr.head?.sha };
  }

  async getPullRequestStatus(prNumber: number): Promise<PullRequestStatus | null> {
    if (!this.isConfigured()) return null;

    let pr = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`);
    // GitHub computes `mergeable` asynchronously — poll briefly if still null.
    for (let attempt = 0; pr.mergeable === null && attempt < MERGEABLE_POLL_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, MERGEABLE_POLL_DELAY_MS));
      pr = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`);
    }

    const reviews = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`);
    let reviewState: PullRequestStatus["reviewState"] = "NONE";
    if (Array.isArray(reviews) && reviews.length > 0) {
      // Latest review per user wins; GitHub returns reviews in chronological order.
      const latestByUser = new Map<string, string>();
      for (const rv of reviews) {
        if (rv.state && rv.state !== "PENDING") latestByUser.set(rv.user?.login ?? rv.id, rv.state);
      }
      const states = [...latestByUser.values()];
      if (states.includes("CHANGES_REQUESTED")) reviewState = "CHANGES_REQUESTED";
      else if (states.includes("APPROVED")) reviewState = "APPROVED";
      else if (states.length > 0) reviewState = "COMMENTED";
    }

    const authenticatedLogin = await this.getAuthenticatedLogin();
    const selfAuthored = Boolean(authenticatedLogin && pr.user?.login && authenticatedLogin === pr.user.login);

    return {
      number: prNumber,
      merged: Boolean(pr.merged),
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state ?? null,
      headSha: pr.head?.sha,
      reviewState,
      selfAuthored,
    };
  }

  /**
   * Validates comments against the PR's current diff hunks before posting —
   * GitHub rejects comments on lines not present in the diff. Any comment
   * that can't be mapped falls back to a general issue comment so nothing is
   * silently dropped.
   */
  private async splitCommentsByDiffValidity(
    prNumber: number,
    comments: PrReviewComment[],
  ): Promise<{ valid: PrReviewComment[]; invalid: PrReviewComment[] }> {
    if (comments.length === 0) return { valid: [], invalid: [] };
    let files: any[] = [];
    try {
      files = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/files`);
    } catch {
      return { valid: [], invalid: comments };
    }
    const filesWithPatches = new Set((files ?? []).filter((f: any) => f.patch).map((f: any) => f.filename));
    const valid: PrReviewComment[] = [];
    const invalid: PrReviewComment[] = [];
    for (const c of comments) {
      if (filesWithPatches.has(c.path)) valid.push(c);
      else invalid.push(c);
    }
    return { valid, invalid };
  }

  private async postFallbackIssueComments(prNumber: number, comments: PrReviewComment[]): Promise<void> {
    if (comments.length === 0) return;
    const body = comments.map((c) => `**${c.path}${c.line ? `:${c.line}` : ""}**\n\n${c.body}`).join("\n\n---\n\n");
    await this.ghFetch(`/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async addReviewComments(prNumber: number, comments: PrReviewComment[]): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — review comments for PR #${prNumber} were not posted.`);
      return null;
    }
    const { valid, invalid } = await this.splitCommentsByDiffValidity(prNumber, comments);
    let reviewId: string | null = null;
    if (valid.length > 0) {
      const review = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`, {
        method: "POST",
        body: JSON.stringify({
          event: "COMMENT",
          comments: valid.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
        }),
      });
      reviewId = review?.id != null ? String(review.id) : null;
    }
    if (invalid.length > 0) {
      await this.postFallbackIssueComments(prNumber, invalid);
    }
    return reviewId;
  }

  async requestChanges(prNumber: number, summary: string, comments: PrReviewComment[] = []): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — PR #${prNumber} was not marked Changes Requested.`);
      return null;
    }
    const { valid, invalid } = await this.splitCommentsByDiffValidity(prNumber, comments);
    const review = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        event: "REQUEST_CHANGES",
        body: summary,
        comments: valid.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
      }),
    });
    if (invalid.length > 0) {
      await this.postFallbackIssueComments(prNumber, invalid);
    }
    return review?.id != null ? String(review.id) : null;
  }

  /** True for GitHub's "Can not approve your own pull request" 422 — expected whenever the PR author and the API token belong to the same account. */
  isSelfApprovalError(err: Error): boolean {
    return /can\s*not approve your own pull request/i.test(err.message);
  }

  async approvePullRequest(prNumber: number, summary: string): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — PR #${prNumber} was not approved.`);
      return null;
    }
    try {
      const review = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`, {
        method: "POST",
        body: JSON.stringify({ event: "APPROVE", body: summary }),
      });
      return review?.id != null ? String(review.id) : null;
    } catch (err) {
      if (this.isSelfApprovalError(err as Error)) {
        console.warn(`[github] PR #${prNumber} is authored by this same GitHub identity — GitHub disallows self-approval; relying on the internal review verdict instead.`);
        return null;
      }
      throw err;
    }
  }

  async mergePullRequest(prNumber: number, method: "merge" | "squash" = "merge"): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — PR #${prNumber} was not merged.`);
      return null;
    }
    const result = await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: method }),
    });
    return result?.sha ?? null;
  }

  async closePullRequest(prNumber: number, reason: string): Promise<void> {
    if (!this.isConfigured()) {
      console.warn(`[github] GitHub not configured — PR #${prNumber} was not closed.`);
      return;
    }
    try {
      await this.ghFetch(`/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: reason }),
      });
    } catch { /* best-effort closing comment */ }
    await this.ghFetch(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }
}
