"use client";

import { useEffect, useState } from "react";
import type { IssueGroup, RunResults as RunResultsData, RunStatus, ScanResults, TicketRow } from "@/lib/types";
import {
  MODE_LABEL,
  NODES_PREVIEW_LIMIT,
  RESULTS_COPY as COPY,
  REVIEW_VERDICT_LABEL,
  RUN_MODE,
  SEVERITIES,
  TICKET_STATUS,
  reportApiPath,
  resultsApiPath,
} from "@/lib/results-constants";
import { EmptyState, ExternalLink, ResultsSection, SeverityBadge, StatusBadge, SummaryTile, Tag } from "./results-parts";

interface RunResultsProps {
  status: RunStatus;
  onStartAnother: () => void;
}

/**
 * Unified results view for every run mode. The layout never changes between
 * modes — later phases only add sections:
 *   scan   → Issues
 *   triage → Issues + Tickets
 *   full   → Issues + Tickets (with fix columns)
 */
export function RunResults({ status, onStartAnother }: RunResultsProps) {
  const [data, setData] = useState<RunResultsData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(resultsApiPath(status.cycleId))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: RunResultsData) => !cancelled && setData(json))
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
    };
  }, [status.cycleId]);

  const isFull = status.mode === RUN_MODE.full;
  const prUrl = status.result?.prUrl ?? null;

  const handleStartAnother = () => {
    setIsStarting(true);
    onStartAnother();
  };

  return (
    <div className="run-results">
      <header className="run-results__header">
        <div>
          <h2 className={status.failed ? "result-failed" : "result-success"}>
            {status.failed ? COPY.titleFailed : COPY.titleComplete}
          </h2>
          <p className="run-results__meta">
            <Tag tone="accent">{MODE_LABEL[status.mode]}</Tag>
            {status.endedAt ? <span>{formatDuration(status.startedAt, status.endedAt)}</span> : null}
          </p>
        </div>
        <div className="run-results__links">
          {data?.scan.available ? <ExternalLink href={reportApiPath(status.cycleId)}>{COPY.openReport}</ExternalLink> : null}
          {isFull && prUrl ? <ExternalLink href={prUrl}>{COPY.viewPr}</ExternalLink> : null}
        </div>
      </header>

      {loadFailed ? (
        <EmptyState>{COPY.loadError}</EmptyState>
      ) : !data ? (
        <EmptyState>
          <span role="status">{COPY.loading}</span>
        </EmptyState>
      ) : (
        <>
          <SummaryStrip scan={data.scan} tickets={data.tickets} isFull={isFull} />
          <IssuesSection scan={data.scan} isFull={isFull} />
          {data.tickets ? <TicketsSection tickets={data.tickets} isFull={isFull} /> : null}
        </>
      )}

      <div className="result-actions">
        <button type="button" onClick={handleStartAnother} disabled={isStarting} className="button-primary button-with-loader">
          {isStarting ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              {COPY.starting}
            </>
          ) : (
            COPY.startAnother
          )}
        </button>
      </div>
    </div>
  );
}

function SummaryStrip({ scan, tickets, isFull }: { scan: ScanResults; tickets: TicketRow[] | null; isFull: boolean }) {
  const matching = (statuses: string[]) => tickets?.filter((t) => statuses.includes(t.status)) ?? [];
  const count = (statuses: string[]) => matching(statuses).length;
  const issues = (statuses: string[]) => matching(statuses).reduce((n, t) => n + t.issueCount, 0);
  const newCount = tickets?.filter((t) => t.isNew).length ?? 0;

  return (
    <>
      <div className="summary-strip">
        <SummaryTile value={scan.groups.length} label={COPY.statViolations} tone={scan.groups.length > 0 ? "error" : "success"} />
        <SummaryTile value={scan.elementCount} label={COPY.statElements} />
        <SummaryTile value={scan.pagesScanned} label={COPY.statPages} detail={COPY.statesSuffix(scan.statesScanned)} />
        {tickets ? (
          <SummaryTile
            value={tickets.length}
            label={COPY.statTickets}
            detail={`${COPY.ticketsDetail(newCount, tickets.length - newCount)} · ${COPY.issueCountDetail(issues(Object.values(TICKET_STATUS)))}`}
          />
        ) : null}
        {isFull && tickets ? (
          <>
            <SummaryTile value={count([TICKET_STATUS.done])} label={COPY.statFixed} detail={COPY.issueCountDetail(issues([TICKET_STATUS.done]))} tone="success" />
            <SummaryTile
              value={count([TICKET_STATUS.open, TICKET_STATUS.inProgress, TICKET_STATUS.inReview])}
              label={COPY.statOutstanding}
              detail={COPY.issueCountDetail(issues([TICKET_STATUS.open, TICKET_STATUS.inProgress, TICKET_STATUS.inReview]))}
            />
            <SummaryTile
              value={count([TICKET_STATUS.parked, TICKET_STATUS.flagged])}
              label={COPY.statNeedsAttention}
              detail={COPY.issueCountDetail(issues([TICKET_STATUS.parked, TICKET_STATUS.flagged]))}
              tone="warning"
            />
          </>
        ) : null}
      </div>
      {scan.groups.length > 0 ? (
        <div className="severity-row">
          {SEVERITIES.map((s) => (
            <SeverityBadge key={s} severity={s} count={scan.bySeverity[s]} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function IssuesSection({ scan, isFull }: { scan: ScanResults; isFull: boolean }) {
  return (
    <ResultsSection
      id="issues"
      title={isFull ? COPY.issuesTitleFull : COPY.issuesTitle}
      count={scan.available ? scan.groups.length : undefined}
      hint={isFull ? COPY.issuesHintFull : undefined}
    >
      {!scan.available ? (
        <EmptyState>{COPY.issuesUnavailable}</EmptyState>
      ) : scan.groups.length === 0 ? (
        <EmptyState>{COPY.issuesEmpty(scan.pagesScanned)}</EmptyState>
      ) : (
        <div className="issue-list">
          <div className="issue-row issue-row--head" aria-hidden="true">
            <span>{COPY.colSeverity}</span>
            <span>{COPY.colRule}</span>
            <span>{COPY.colWcag}</span>
            <span className="num">{COPY.colPages}</span>
            <span className="num">{COPY.colElements}</span>
          </div>
          {scan.groups.map((g) => (
            <IssueItem key={g.ruleId} group={g} />
          ))}
        </div>
      )}
    </ResultsSection>
  );
}

function IssueItem({ group }: { group: IssueGroup }) {
  return (
    <details className="issue-item">
      <summary className="issue-row">
        <span>
          <SeverityBadge severity={group.severity} />
        </span>
        <span className="issue-row__rule">
          <code>{group.ruleId}</code>
          <span>{group.help}</span>
        </span>
        <span className="issue-row__wcag">{group.wcag.join(", ") || COPY.none}</span>
        <span className="num">
          {group.pageCount}
          <span className="visually-hidden"> {COPY.colPages.toLowerCase()}</span>
        </span>
        <span className="num">
          {group.elementCount}
          <span className="visually-hidden"> {COPY.colElements.toLowerCase()}</span>
        </span>
      </summary>
      <div className="issue-item__body">
        <ExternalLink href={group.helpUrl}>{group.ruleId}</ExternalLink>
        {group.pages.map((p) => (
          <div key={p.state} className="issue-page">
            <div className="issue-page__url">
              <span>{p.url}</span>
              <Tag>{p.state}</Tag>
            </div>
            {p.nodes.slice(0, NODES_PREVIEW_LIMIT).map((n, i) => (
              <div key={`${n.selector}-${i}`} className="issue-node">
                <code className="issue-node__selector">{n.selector}</code>
                <pre className="issue-node__html">{n.html}</pre>
                {n.failureSummary ? <p className="issue-node__fix">{n.failureSummary}</p> : null}
              </div>
            ))}
            {p.nodes.length > NODES_PREVIEW_LIMIT ? (
              <p className="issue-page__more">{COPY.moreNodes(p.nodes.length - NODES_PREVIEW_LIMIT)}</p>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function TicketsSection({ tickets, isFull }: { tickets: TicketRow[]; isFull: boolean }) {
  return (
    <ResultsSection id="tickets" title={isFull ? COPY.ticketsTitleFull : COPY.ticketsTitle} count={tickets.length}>
      {tickets.length === 0 ? (
        <EmptyState>{COPY.ticketsEmpty}</EmptyState>
      ) : (
        <div className="results-table-wrap">
          <table className="results-table">
            <thead>
              <tr>
                <th scope="col">{COPY.colTicket}</th>
                <th scope="col">{COPY.colCategory}</th>
                <th scope="col">{COPY.colSeverity}</th>
                <th scope="col" className="num">{COPY.colIssues}</th>
                <th scope="col" className="num">{COPY.colPages}</th>
                <th scope="col">{COPY.colChange}</th>
                <th scope="col">{COPY.colStatus}</th>
                {isFull ? (
                  <>
                    <th scope="col" className="num">{COPY.colAttempts}</th>
                    <th scope="col">{COPY.colReview}</th>
                    <th scope="col">{COPY.colPr}</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.jiraUrl ? (
                      <ExternalLink href={t.jiraUrl}>{t.jiraKey}</ExternalLink>
                    ) : (
                      <span className="muted">{t.jiraKey ?? COPY.noJiraKey}</span>
                    )}
                  </td>
                  <td>{t.category}</td>
                  <td>{t.severity ? <SeverityBadge severity={t.severity} /> : COPY.none}</td>
                  <td className="num">{t.issueCount}</td>
                  <td className="num">{t.pageCount}</td>
                  <td>
                    <Tag tone={t.isNew ? "accent" : undefined}>{t.isNew ? COPY.tagNew : COPY.tagUpdated}</Tag>
                  </td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  {isFull ? (
                    <>
                      <td className="num">{t.attempts}</td>
                      <td>{t.reviewVerdict ? REVIEW_VERDICT_LABEL[t.reviewVerdict] : COPY.none}</td>
                      <td>{t.prUrl ? <ExternalLink href={t.prUrl}>{COPY.colPr}</ExternalLink> : COPY.none}</td>
                    </>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ResultsSection>
  );
}

function formatDuration(startIso: string, endIso: string): string {
  const totalSeconds = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
