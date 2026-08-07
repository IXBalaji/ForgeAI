import "dotenv/config";

const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;

export function isGitHubConfigured(): boolean {
  return Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
}

async function ghFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
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

export async function openPullRequest(params: {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<{ url: string; number: number } | null> {
  if (!isGitHubConfigured()) {
    console.warn(`[github] GitHub not configured — branch "${params.head}" was pushed but no PR was opened.`);
    return null;
  }
  const pr = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      head: params.head,
      base: params.base,
      title: params.title,
      body: params.body,
      draft: params.draft ?? true,
    }),
  });
  return { url: pr.html_url, number: pr.number };
}

export async function mergePullRequest(prNumber: number, mergeMethod: "squash" | "merge" = "squash"): Promise<string | null> {
  if (!isGitHubConfigured()) {
    console.warn(`[github] GitHub not configured — PR #${prNumber} was not merged.`);
    return null;
  }
  const result = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${prNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: mergeMethod }),
  });
  return result.sha ?? null;
}

/**
 * Creates a lightweight tag pointing at commitSha via the Git References API —
 * this is the rollback mechanism from the guardrails doc: "redeploy the last-
 * good tag" instead of a git-archaeology exercise. Uses the API rather than a
 * local git checkout so the Deploy agent doesn't need its own worktree.
 */
export async function createTag(tagName: string, commitSha: string): Promise<string | null> {
  if (!isGitHubConfigured()) {
    console.warn(`[github] GitHub not configured — tag "${tagName}" was not created.`);
    return null;
  }
  await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/tags/${tagName}`, sha: commitSha }),
  });
  return tagName;
}
