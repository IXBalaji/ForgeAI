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

  /** Authenticated HTTPS remote URL for raw `git fetch`/`push` via child_process. Returns null if not configured. */
  authenticatedRemoteUrl(): string | null;
}
