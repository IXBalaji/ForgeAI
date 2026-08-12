import { VCS_PROVIDER } from "../../lib/config.js";
import type { VcsProvider } from "./types.js";
import { GitHubAdapter } from "./github.js";

let instance: VcsProvider | null = null;

export function getVcsProvider(): VcsProvider {
  if (instance) return instance;
  switch (VCS_PROVIDER) {
    case "github":
      instance = new GitHubAdapter();
      break;
    default:
      throw new Error(`Unknown VCS_PROVIDER "${VCS_PROVIDER}"`);
  }
  return instance;
}
