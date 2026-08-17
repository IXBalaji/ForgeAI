export interface PullRequestRef {
  number: number;
  url: string;
  htmlUrl: string;
  headSha: string;
}

export interface PullRequestStatus {
  number: number;
  merged: boolean;
  /** null while GitHub is still computing mergeability — callers should poll. */
  mergeable: boolean | null;
  mergeableState: string | null;
  headSha: string;
  /** Most recent review state per reviewer login, e.g. "APPROVED" | "CHANGES_REQUESTED". */
  reviewState: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "NONE";
  /** True when the PR author is the same identity as the token used to call the API — GitHub forbids that identity from approving its own PR. */
  selfAuthored: boolean;
}

export interface PrReviewComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

export interface VcsProvider {
  readonly name: string;
  isConfigured(): boolean;

  /** Merges `head` into `base`; returns the merge commit SHA, or null if not configured/no-op. */
  mergeBranch(head: string, base: string, commitMessage: string): Promise<string | null>;

  /** Merges `base` into `head` to bring a stale branch up to date before retrying a merge. */
  updateBranchFromBase(head: string, base: string): Promise<string | null>;

  /** Creates a lightweight tag at commitSha — the rollback marker. */
  createTag(tagName: string, commitSha: string): Promise<string | null>;

  /** True if `err` represents this provider's merge-conflict response, vs. a hard failure. */
  isConflictError(err: Error): boolean;

  /** True if `err` represents this provider's "can't approve your own PR" response — expected when the PR author and API identity are the same. */
  isSelfApprovalError(err: Error): boolean;

  /** Authenticated HTTPS remote URL for raw `git fetch`/`push` via child_process. Returns null if not configured. */
  authenticatedRemoteUrl(): string | null;

  /** Idempotency check — finds an already-open PR for this head/base pair, if one exists. */
  findOpenPullRequest(head: string, base: string): Promise<PullRequestRef | null>;

  /** Creates a new PR. Callers must call findOpenPullRequest first and only call this on a miss. */
  createPullRequest(head: string, base: string, title: string, body: string): Promise<PullRequestRef | null>;

  /** Combined PR + review status, used for merge-gate checks. Polls briefly if `mergeable` is still computing. */
  getPullRequestStatus(prNumber: number): Promise<PullRequestStatus | null>;

  /** Posts a single batched review with line-level comments (event: COMMENT — non-blocking). */
  addReviewComments(prNumber: number, comments: PrReviewComment[]): Promise<string | null>;

  /** Marks the PR "Changes Requested" with a summary — may include comments in the same call. */
  requestChanges(prNumber: number, summary: string, comments?: PrReviewComment[]): Promise<string | null>;

  /** Approves the PR. */
  approvePullRequest(prNumber: number, summary: string): Promise<string | null>;

  /** Merges an approved PR. Returns the merge commit SHA, or null if not configured/no-op. */
  mergePullRequest(prNumber: number, method: "merge" | "squash"): Promise<string | null>;

  /** Closes a PR without merging — used when a cycle gives up on a ticket batch. */
  closePullRequest(prNumber: number, reason: string): Promise<void>;
}
