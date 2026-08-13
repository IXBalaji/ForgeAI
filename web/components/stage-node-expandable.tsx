"use client";

import { useState, useEffect, useRef } from "react";
import type { Stage } from "@/lib/types";

interface StageNodeExpandableProps {
  stage: Stage;
  status: "pending" | "current" | "completed" | "failed";
  logs: string[];
}

const STAGE_LABELS: Record<Stage, string> = {
  scan: "Scan",
  triage: "Triage",
  fix: "Fix",
  review: "Review",
  autofix: "Auto-fix",
  deploy: "Deploy",
  cleanup: "Cleanup",
  release: "Release",
  unknown: "Unknown",
};

function getStatusIcon(status: string): string {
  switch (status) {
    case "completed": return "✓";
    case "failed": return "✗";
    case "current": return "●";
    default: return "○";
  }
}

export function StageNodeExpandable({ stage, status, logs }: StageNodeExpandableProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isExpanded && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [logs.length, isExpanded]);

  return (
    <div className={`stage-node stage-node--${status}`} role="listitem">
      <button
        className="stage-node__header"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls={`stage-logs-${stage}`}
      >
        <span className="stage-node__icon" aria-hidden="true">
          {getStatusIcon(status)}
        </span>
        <span className="stage-node__label">
          {STAGE_LABELS[stage]}
        </span>
        {logs.length > 0 && (
          <span className="stage-node__badge">
            {logs.length} {logs.length === 1 ? "line" : "lines"}
          </span>
        )}
        <span className="stage-node__chevron" aria-hidden="true">
          {"▶"}
        </span>
      </button>

      {isExpanded && (
        <div
          id={`stage-logs-${stage}`}
          className="stage-node__logs"
          role="region"
          aria-label={`${STAGE_LABELS[stage]} logs`}
        >
          {logs.length === 0 ? (
            <p className="stage-node__no-logs">No logs for this stage yet.</p>
          ) : (
            <pre className="stage-node__log-content">
              {logs.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              <div ref={logsEndRef} />
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
