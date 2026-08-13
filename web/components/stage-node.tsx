import type { Stage } from "@/lib/types";

interface StageNodeProps {
  stage: Stage;
  label: string;
  currentStage: Stage;
  isFailed: boolean;
  timestamp?: string;
}

export function StageNode({
  stage,
  label,
  currentStage,
  isFailed,
  timestamp,
}: StageNodeProps) {
  const stageOrder: Stage[] = [
    "scan",
    "triage",
    "fix",
    "review",
    "autofix",
    "deploy",
    "cleanup",
    "release",
  ];

  const currentIndex = stageOrder.indexOf(currentStage);
  const thisIndex = stageOrder.indexOf(stage);

  let status: "completed" | "current" | "pending" | "failed";

  if (isFailed && thisIndex === currentIndex) {
    status = "failed";
  } else if (thisIndex < currentIndex) {
    status = "completed";
  } else if (thisIndex === currentIndex) {
    status = "current";
  } else {
    status = "pending";
  }

  const icons = {
    completed: (
      <svg fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      </svg>
    ),
    current: (
      <svg fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="6" />
      </svg>
    ),
    pending: (
      <svg fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3" />
      </svg>
    ),
    failed: (
      <svg fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
          clipRule="evenodd"
        />
      </svg>
    ),
  };

  return (
    <div className={`stage-node stage-${status}`} role="listitem">
      <div className="stage-icon">{icons[status]}</div>
      <div className="stage-content">
        <div className="stage-label">{label}</div>
        {timestamp && <div className="stage-timestamp">{timestamp}</div>}
      </div>
    </div>
  );
}
