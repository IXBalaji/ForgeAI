"use client";

import { useEffect, useState } from "react";
import { Hero } from "@/components/hero";
import { StartWorkflowButton } from "@/components/start-workflow-button";
import { StageTimeline } from "@/components/stage-timeline";
import { ActivityLog } from "@/components/activity-log";
import { ResultsSummary } from "@/components/results-summary";
import { ErrorPanel } from "@/components/error-panel";
import type { RunStatus } from "@/lib/types";

type ViewState = "idle" | "loading" | "running" | "completed" | "error";

export default function Home() {
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStalled, setIsStalled] = useState(false);

  // Check for active run on mount
  useEffect(() => {
    const checkActive = async () => {
      try {
        const response = await fetch("/api/workflow/active");
        const data = await response.json();

        if (data.active === true) {
          setActiveCycleId(data.cycleId);
          setViewState("running");
        } else if (data.active === "stalled") {
          setActiveCycleId(data.cycleId);
          setError("A previous run stalled (process died but DB row exists).");
          setIsStalled(true);
          setViewState("error");
        } else {
          setViewState("idle");
        }
      } catch (err) {
        console.error("Failed to check active run:", err);
        setViewState("idle");
      }
    };

    checkActive();
  }, []);

  // Poll status while running
  useEffect(() => {
    if (viewState !== "running" || !activeCycleId) return;

    // eslint-disable-next-line prefer-const
    let pollInterval: NodeJS.Timeout | undefined;
    let retryCount = 0;
    const MAX_RETRIES = 3;

    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/workflow/${activeCycleId}/status`);

        if (!response.ok) {
          retryCount++;
          if (retryCount >= MAX_RETRIES) {
            setError("Failed to fetch status after multiple retries");
            setViewState("error");
          }
          return;
        }

        retryCount = 0;
        const data: RunStatus = await response.json();
        setStatus(data);

        // Check if completed or failed
        if (data.endedAt) {
          setViewState("completed");
          clearInterval(pollInterval);
        } else if (data.failed && !data.processAlive) {
          setViewState("completed");
          clearInterval(pollInterval);
        }
      } catch (err) {
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
          console.error("Failed to poll status:", err);
          setError(
            err instanceof Error ? err.message : "Network error while polling status"
          );
          setViewState("error");
          clearInterval(pollInterval);
        }
      }
    };

    // Initial poll
    pollStatus();

    // Poll every 3 seconds
    pollInterval = setInterval(pollStatus, 3000);

    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [viewState, activeCycleId]);

  const handleStartSuccess = (cycleId: string) => {
    setActiveCycleId(cycleId);
    setViewState("running");
    setError(null);
    setIsStalled(false);
  };

  const handleStartError = (errorMessage: string) => {
    setError(errorMessage);
    setViewState("error");
  };

  const handleStartAnother = () => {
    setActiveCycleId(null);
    setStatus(null);
    setError(null);
    setIsStalled(false);
    setViewState("idle");
  };

  if (viewState === "loading") {
    return (
      <main className="container">
        <div className="loading">Loading...</div>
      </main>
    );
  }

  if (viewState === "error") {
    return (
      <main className="container">
        <Hero />
        <ErrorPanel error={error || "Unknown error"} isStalled={isStalled} />
        {!isStalled && (
          <div className="actions">
            <button
              type="button"
              onClick={handleStartAnother}
              className="button-secondary"
            >
              Back to start
            </button>
          </div>
        )}
      </main>
    );
  }

  if (viewState === "idle") {
    return (
      <main className="container">
        <Hero />
        <div className="actions">
          <StartWorkflowButton
            onStartSuccess={handleStartSuccess}
            onStartError={handleStartError}
          />
        </div>
      </main>
    );
  }

  if (viewState === "running" && status) {
    return (
      <main className="container">
        <Hero />
        <StageTimeline
          currentStage={status.stage}
          stageDetail={status.stageDetail}
          logsByStage={status.logsByStage}
          failed={status.failed}
        />
        <div className="stats-grid">
          <div className="stat">
            <div className="stat-value">{status.counts.ticketsOpen}</div>
            <div className="stat-label">Open</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.ticketsInReview}</div>
            <div className="stat-label">In Review</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.ticketsDone}</div>
            <div className="stat-label">Done</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.fixAttempts}</div>
            <div className="stat-label">Fix Attempts</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.reviewsApproved}</div>
            <div className="stat-label">Approved</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.deployments}</div>
            <div className="stat-label">Deployments</div>
          </div>
        </div>
        <ActivityLog lines={status.recentLog} />
      </main>
    );
  }

  if (viewState === "completed" && status) {
    return (
      <main className="container">
        <Hero />
        <StageTimeline
          currentStage={status.stage}
          stageDetail={null}
          logsByStage={status.logsByStage}
          failed={status.failed}
          allCompleted={!status.failed}
        />
        <div className="stats-grid">
          <div className="stat">
            <div className="stat-value">{status.counts.ticketsOpen}</div>
            <div className="stat-label">Open</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.ticketsInReview}</div>
            <div className="stat-label">In Review</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.ticketsDone}</div>
            <div className="stat-label">Done</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.fixAttempts}</div>
            <div className="stat-label">Fix Attempts</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.reviewsApproved}</div>
            <div className="stat-label">Approved</div>
          </div>
          <div className="stat">
            <div className="stat-value">{status.counts.deployments}</div>
            <div className="stat-label">Deployments</div>
          </div>
        </div>
        <ResultsSummary status={status} onStartAnother={handleStartAnother} />
        <ActivityLog lines={status.recentLog} />
      </main>
    );
  }

  return null;
}
