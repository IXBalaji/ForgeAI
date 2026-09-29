import type { ReactNode } from "react";
import type { Severity, TicketStatus } from "@/lib/types";
import { RESULTS_COPY, SEVERITY_LABEL, TICKET_STATUS_LABEL } from "@/lib/results-constants";

/** Building blocks shared by every section of the results view, so all run modes look the same. */

export function SummaryTile({ value, label, detail, tone }: { value: ReactNode; label: string; detail?: string; tone?: "success" | "warning" | "error" }) {
  return (
    <div className={`summary-tile${tone ? ` summary-tile--${tone}` : ""}`}>
      <div className="summary-tile__value">{value}</div>
      <div className="summary-tile__label">{label}</div>
      {detail ? <div className="summary-tile__detail">{detail}</div> : null}
    </div>
  );
}

export function ResultsSection({ id, title, count, hint, children }: { id: string; title: string; count?: number; hint?: string; children: ReactNode }) {
  const headingId = `${id}-heading`;
  return (
    <section className="results-section" aria-labelledby={headingId}>
      <header className="results-section__header">
        <h3 id={headingId}>
          {title}
          {count !== undefined ? <span className="results-section__count">{count}</span> : null}
        </h3>
        {hint ? <p className="results-section__hint">{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="results-empty">{children}</p>;
}

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <span className={`severity-badge severity-badge--${severity}`}>
      {SEVERITY_LABEL[severity]}
      {count !== undefined ? <span className="severity-badge__count">{count}</span> : null}
    </span>
  );
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <span className={`status-badge status-badge--${status}`}>{TICKET_STATUS_LABEL[status] ?? status}</span>;
}

export function Tag({ children, tone }: { children: ReactNode; tone?: "accent" }) {
  return <span className={`results-tag${tone ? ` results-tag--${tone}` : ""}`}>{children}</span>;
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="results-link">
      {children}
      <span aria-hidden="true"> ↗</span>
      <span className="visually-hidden"> {RESULTS_COPY.opensInNewTab}</span>
    </a>
  );
}
