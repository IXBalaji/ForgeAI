import { run } from "./exec.js";

export async function ensureGitIdentity(cwd: string): Promise<void> {
  const name = process.env.GIT_AUTHOR_NAME ?? process.env.GIT_COMMITTER_NAME ?? process.env.GITHUB_ACTOR ?? "ForgeAI Bot";
  const email = process.env.GIT_AUTHOR_EMAIL ?? process.env.GIT_COMMITTER_EMAIL ?? "forgeai-bot@users.noreply.github.com";

  await run("git", ["config", "user.name", name], cwd);
  await run("git", ["config", "user.email", email], cwd);
}
