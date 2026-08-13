import { StageNodeExpandable } from "./stage-node-expandable";
import type { Stage } from "@/lib/types";

interface StageTimelineProps {
  currentStage: Stage;
  stageDetail: string | null;
  logsByStage: Record<Stage, string[]>;
  failed: boolean;
  allCompleted?: boolean;
}

export function StageTimeline({
  currentStage,
  stageDetail,
  logsByStage,
  failed,
  allCompleted,
}: StageTimelineProps) {
  const stages: Stage[] = ["scan", "triage", "fix", "review", "autofix", "deploy", "cleanup", "release"];
  const currentIndex = stages.indexOf(currentStage);

  return (
    <div className="stage-timeline">
      <h2>Pipeline Progress</h2>
      {stageDetail && (
        <div className="stage-detail">
          <strong>Current activity:</strong> <code>{stageDetail}</code>
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
