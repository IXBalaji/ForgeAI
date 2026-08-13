"use client";

import { useEffect, useRef } from "react";

interface ActivityLogProps {
  lines: string[];
}

export function ActivityLog({ lines }: ActivityLogProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const prevLinesCountRef = useRef(0);

  useEffect(() => {
    if (lines.length > prevLinesCountRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
    prevLinesCountRef.current = lines.length;
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div className="activity-log">
        <h2>Activity Log</h2>
        <div className="log-empty">No log output yet</div>
      </div>
    );
  }

  return (
    <div className="activity-log">
      <h2>Activity Log</h2>
      <div
        ref={logRef}
        className="log-content"
        role="log"
        aria-live="polite"
        aria-atomic="false"
      >
        {lines.map((line, i) => (
          <div key={i} className="log-line">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
