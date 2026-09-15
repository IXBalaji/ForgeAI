import { StageNodeExpandable } from "./stage-node-expandable";
import type { RunMode, Stage } from "@/lib/types";

// Each mode only ever visits a prefix of the full pipeline — showing the
// unreached tail as "pending" would misrepresent a run that was never going
// to fix anything in the first place.
const STAGES_BY_MODE: Record<RunMode, Stage[]> = {
  scan: ["scan"],
  triage: ["scan", "triage"],
  full: ["scan", "triage", "fix", "review", "autofix", "deploy", "cleanup", "verify", "release"],
};

interface StageTimelineProps {
  currentStage: Stage;
  stageDetail: string | null;
  logsByStage: Record<Stage, string[]>;
  failed: boolean;
  allCompleted?: boolean;
  mode?: RunMode;
  /** "Cycle N" while looping back through fix→review→deploy→verify a 2nd+ time. */
  loopIterationHint?: number | null;
}

export function StageTimeline({
  currentStage,
  stageDetail,
  logsByStage,
  failed,
  allCompleted,
  mode = "full",
  loopIterationHint,
}: StageTimelineProps) {
  const stages = STAGES_BY_MODE[mode];
  // currentStage can be a stage this mode's own array doesn't include (e.g.
  // a stale poll landing on "triage" for a "scan"-mode run) — clamp rather
  // than let indexOf's -1 mark every node "pending".
  const currentIndex = Math.max(stages.indexOf(currentStage), 0);

  return (
    <div className="stage-timeline">
      <h2>Pipeline Progress</h2>
      {stageDetail && (
        <div className="stage-detail">
          <strong>Current activity:</strong> <code>{stageDetail}</code>
        </div>
      )}
      {!allCompleted && loopIterationHint && loopIterationHint > 1 && (
        <div className="stage-detail stage-cycle-badge">
          <strong>Cycle {loopIterationHint}:</strong> some tickets weren&apos;t verified fixed last pass — fixing, reviewing, and re-verifying again.
        </div>
      )}
      <div className="stage-list" role="list">
        {stages.map((stage, i) => {
          let status: "pending" | "current" | "completed" | "failed";
          if (allCompleted) {
            status = "completed";
          } else if (i < currentIndex) {
            status = "completed";
          } else if (i === currentIndex) {
            status = failed ? "failed" : "current";
          } else {
            status = "pending";
          }

          return (
            <StageNodeExpandable
              key={stage}
              stage={stage}
              status={status}
              logs={logsByStage[stage] || []}
            />
          );
        })}
      </div>
    </div>
  );
}
