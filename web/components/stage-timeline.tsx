"use client";

import { useState } from "react";
import { StageNodeExpandable } from "./stage-node-expandable";
import type { RunMode, Stage } from "@/lib/types";

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
  const currentIndex = Math.max(stages.indexOf(currentStage), 0);
  const [expandedStage, setExpandedStage] = useState<Stage | null>(null);

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
      <div className="hpipeline" role="list">
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

          const isLast = i === stages.length - 1;

          return (
            <div key={stage} className="hpipeline__step" role="listitem">
              <StageNodeExpandable
                stage={stage}
                status={status}
                logs={logsByStage[stage] || []}
                compact
                isExpanded={expandedStage === stage}
                onToggle={() => setExpandedStage(expandedStage === stage ? null : stage)}
              />
              {!isLast && (
                <div className={`hpipeline__connector hpipeline__connector--${i < currentIndex ? "completed" : i === currentIndex ? "active" : "pending"}`}>
                  <div className="hpipeline__connector-line" />
                  <div className="hpipeline__connector-arrow" />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {expandedStage && (
        <div className="hpipeline__logs-panel">
          <div className="hpipeline__logs-panel-header">
            <span className="hpipeline__logs-panel-title">
              {expandedStage.charAt(0).toUpperCase() + expandedStage.slice(1)} Logs
            </span>
            <button
              className="hpipeline__logs-close"
              onClick={() => setExpandedStage(null)}
              aria-label="Close logs"
            >
              ✕
            </button>
          </div>
          <div className="hpipeline__logs-content">
            {(logsByStage[expandedStage] || []).length === 0 ? (
              <p className="stage-node__no-logs">No logs for this stage yet.</p>
            ) : (
              <pre className="stage-node__log-content">
                {(logsByStage[expandedStage] || []).map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
