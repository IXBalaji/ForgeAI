"use client";

import type { Stage } from "@/lib/types";

interface StageNodeExpandableProps {
  stage: Stage;
  status: "pending" | "current" | "completed" | "failed";
  logs: string[];
  compact?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
}

const STAGE_LABELS: Record<Stage, string> = {
  scan: "Scan",
  triage: "Classify",
  fix: "Fix",
  review: "Review",
  autofix: "Auto-fix",
  deploy: "Deploy",
  cleanup: "Cleanup",
  verify: "Verify",
  release: "Release",
  unknown: "Unknown",
};

const STAGE_ICONS: Record<Stage, string> = {
  scan: "🔍",
  triage: "📋",
  fix: "🔧",
  review: "🔎",
  autofix: "⚡",
  deploy: "🚀",
  cleanup: "🧹",
  verify: "✅",
  release: "📦",
  unknown: "❓",
};

function getStatusIndicator(status: string): string {
  switch (status) {
    case "completed": return "✓";
    case "failed": return "✗";
    case "current": return "";
    default: return "";
  }
}

export function StageNodeExpandable({
  stage,
  status,
  logs,
  compact,
  isExpanded,
  onToggle,
}: StageNodeExpandableProps) {
  if (compact) {
    return (
      <button
        className={`hcard hcard--${status}${isExpanded ? " hcard--expanded" : ""}`}
        onClick={onToggle}
        role="listitem"
        aria-expanded={isExpanded}
        aria-controls={`stage-logs-${stage}`}
      >
        <span className="hcard__icon">{STAGE_ICONS[stage]}</span>
        <span className="hcard__label">{STAGE_LABELS[stage]}</span>
        {status === "current" && <span className="hcard__pulse" />}
        {status === "completed" && <span className="hcard__check">{getStatusIndicator(status)}</span>}
        {status === "failed" && <span className="hcard__fail">{getStatusIndicator(status)}</span>}
      </button>
    );
  }

  // Fallback: legacy accordion mode (unused in horizontal pipeline)
  return (
    <div className={`stage-node stage-node--${status}`} role="listitem">
      <button
        className="stage-node__header"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={`stage-logs-${stage}`}
      >
        <span className="stage-node__icon" aria-hidden="true">
          {getStatusIndicator(status) || (status === "current" ? "●" : "○")}
        </span>
        <span className="stage-node__label">{STAGE_LABELS[stage]}</span>
        <span className="stage-node__chevron" aria-hidden="true">▶</span>
      </button>
    </div>
  );
}
