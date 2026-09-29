"use client";

import { useEffect, useRef, useState } from "react";
import type { RunStatus } from "@/lib/types";
import { filterActivityLines } from "@/lib/activity-feed";
import { ACTIVITY_FEED_LIMIT, MODE_LABEL, RESULTS_COPY as COPY, STAGE_LABEL } from "@/lib/results-constants";
import { Tag } from "./results-parts";

interface RunProgressProps {
  status: RunStatus;
}

/**
 * Replaces the old always-visible ticket-count grid while a run is in
 * progress: those counts are almost always zero mid-run and tell the user
 * nothing about what's actually happening right now. This shows the current
 * stage, an elapsed timer, and a live tail of pipeline log lines instead.
 * Once the run completes, RunResults takes over and shows the real counts.
 */
export function RunProgress({ status }: RunProgressProps) {
  const elapsed = useElapsed(status.startedAt);
  const lines = filterActivityLines(status.recentLog, ACTIVITY_FEED_LIMIT);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div className="now-running">
      <header className="now-running__header">
        <span className="now-running__dot" aria-hidden="true" />
        <div className="now-running__info">
          <h2>
            {COPY.nowRunningTitle} — {STAGE_LABEL[status.stage]}
            {status.loopIterationHint ? ` (cycle ${status.loopIterationHint})` : ""}
          </h2>
          <p className="now-running__meta">
            <Tag tone="accent">{MODE_LABEL[status.mode]}</Tag>
            {status.stageDetail ? <code>{status.stageDetail}</code> : null}
          </p>
        </div>
        <div className="now-running__timer" aria-label={`Elapsed time: ${elapsed}`}>
          {elapsed}
        </div>
      </header>

      <div
        ref={feedRef}
        className="now-running__feed"
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-label={COPY.feedLabel}
      >
        {lines.length === 0 ? (
          <p className="now-running__feed-empty">{COPY.feedEmpty}</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="now-running__line">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function useElapsed(startedAtIso: string): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const totalSeconds = Math.max(0, Math.round((now - new Date(startedAtIso).getTime()) / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
