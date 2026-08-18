/**
 * Trigger the orchestrator via GitHub's workflow_dispatch REST API.
 *
 * Used in place of spawning a local child process when the dashboard runs
 * somewhere (Vercel) that shares no filesystem/process space with the
 * machine that actually executes the orchestrator (a GitHub Actions runner).
 */

const GH_API = "https://api.github.com";

export function isDispatchConfigured(): boolean {
  return Boolean(process.env.GH_ACTIONS_PAT);
}

export async function dispatchOrchestratorWorkflow(cycleId: string): Promise<void> {
  const token = process.env.GH_ACTIONS_PAT;
  const owner = process.env.GH_WORKFLOW_OWNER;
  const repo = process.env.GH_WORKFLOW_REPO;
  const workflowFile = process.env.GH_WORKFLOW_FILE || "orchestrate.yml";
  const ref = process.env.GH_WORKFLOW_REF || "deployment-fixes";

  if (!token || !owner || !repo) {
    throw new Error(
      "GH_ACTIONS_PAT, GH_WORKFLOW_OWNER, and GH_WORKFLOW_REPO must all be set to dispatch the orchestrator workflow",
    );
  }

  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref, inputs: { cycleId } }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub workflow dispatch failed: ${res.status} ${body}`);
  }
}
