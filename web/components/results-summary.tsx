"use client";

import { useState } from "react";
import type { RunStatus } from "@/lib/types";

interface ResultsSummaryProps {
  status: RunStatus;
  onStartAnother: () => void;
}

export function ResultsSummary({ status, onStartAnother }: ResultsSummaryProps) {
  const { result } = status;
  const [isStarting, setIsStarting] = useState(false);

  if (!result) {
    return null;
  }

  const totalFixed = result.fixed.length;
  const totalParked = result.parked.length;
  const totalFlagged = result.flagged.length;
  const totalOpen = result.open.length;

  const handleStartAnother = () => {
    setIsStarting(true);
    onStartAnother();
  };

  return (
    <div className="results-summary">
      <h2>
        {status.failed ? (
          <span className="result-failed">Run Failed</span>
        ) : (
          <span className="result-success">Run Complete</span>
        )}
      </h2>

      <div className="results-grid">
        <div className="result-card result-fixed">
          <div className="result-count">{totalFixed}</div>
          <div className="result-label">Fixed</div>
        </div>
        <div className="result-card result-parked">
          <div className="result-count">{totalParked}</div>
          <div className="result-label">Parked</div>
        </div>
        <div className="result-card result-flagged">
          <div className="result-count">{totalFlagged}</div>
          <div className="result-label">Flagged</div>
        </div>
        <div className="result-card result-open">
          <div className="result-count">{totalOpen}</div>
          <div className="result-label">Open</div>
        </div>
      </div>

      {result.fixed.length > 0 && (
        <details className="result-details">
          <summary>Fixed tickets ({result.fixed.length})</summary>
          <ul>
            {result.fixed.map((ticket) => (
              <li key={ticket.id}>
                {ticket.jiraKey || ticket.id} — {ticket.category}
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.parked.length > 0 && (
        <details className="result-details">
          <summary>Parked tickets ({result.parked.length})</summary>
          <ul>
            {result.parked.map((ticket) => (
              <li key={ticket.id}>
                {ticket.jiraKey || ticket.id} — {ticket.category}
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.flagged.length > 0 && (
        <details className="result-details">
          <summary>Flagged tickets ({result.flagged.length})</summary>
          <ul>
            {result.flagged.map((ticket) => (
              <li key={ticket.id}>
                {ticket.jiraKey || ticket.id} — {ticket.category}
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.open.length > 0 && (
        <details className="result-details" open={totalFixed === 0 && totalParked === 0 && totalFlagged === 0}>
          <summary>Open tickets awaiting a fix ({result.open.length})</summary>
          <ul>
            {result.open.map((ticket) => (
              <li key={ticket.id}>
                {ticket.jiraKey || ticket.id} — {ticket.category}
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.prUrl && (
        <div className="result-pr">
          <a
            href={result.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pr-link"
          >
            View Pull Request →
          </a>
        </div>
      )}

      <div className="result-actions">
        <button
          type="button"
          onClick={handleStartAnother}
          disabled={isStarting}
          className="button-primary button-with-loader"
        >
          {isStarting ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              Starting…
            </>
          ) : (
            "Start another run"
          )}
        </button>
      </div>
    </div>
  );
}
