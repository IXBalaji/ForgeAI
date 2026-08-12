import { TRACKER_PROVIDER } from "../../lib/config.js";
import type { TrackerProvider } from "./types.js";
import { JiraAdapter } from "./jira.js";

let instance: TrackerProvider | null = null;

export function getTrackerProvider(): TrackerProvider {
  if (instance) return instance;
  switch (TRACKER_PROVIDER) {
    case "jira":
      instance = new JiraAdapter();
      break;
    default:
      throw new Error(`Unknown TRACKER_PROVIDER "${TRACKER_PROVIDER}"`);
  }
  return instance;
}
