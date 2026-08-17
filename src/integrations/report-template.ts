import { JIRA_BASE_URL } from "../lib/config.js";
import { redactSecrets } from "../observability/sanitize.js";

interface TicketRow {
  jiraKey: string | null;
  id: string;
  category: string;
}

function safe(value: string): string {
  return escapeHtml(redactSecrets(value));
}

export interface ReleaseReportData {
  projectLabel: string;
  cycleId: string;
  generatedAt: Date;
  fixed: TicketRow[];
  parked: TicketRow[];
  flagged: TicketRow[];
}

const STATUS_META = {
  fixed: { label: "Fixed & Verified", color: "#16a34a", bg: "#f0fdf4", icon: "✓" },
  parked: { label: "Parked — Needs Manual Fix", color: "#d97706", bg: "#fffbeb", icon: "⏸" },
  flagged: { label: "Flagged — Needs Manual Review", color: "#dc2626", bg: "#fef2f2", icon: "⚠" },
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jiraLink(jiraKey: string | null): string | null {
  if (!jiraKey || !JIRA_BASE_URL) return null;
  return `${JIRA_BASE_URL}/browse/${encodeURIComponent(jiraKey)}`;
}

function renderTicketRows(tickets: TicketRow[], accent: string): string {
  if (tickets.length === 0) {
    return `<tr><td style="padding:16px 20px;color:#94a3b8;font-size:14px;font-style:italic;">None this cycle.</td></tr>`;
  }

  return tickets
    .map((t, i) => {
      const label = escapeHtml(t.jiraKey ?? t.id);
      const link = jiraLink(t.jiraKey);
      const key = link
        ? `<a href="${link}" style="color:${accent};text-decoration:none;font-weight:600;">${label}</a>`
        : `<span style="color:#1e293b;font-weight:600;">${label}</span>`;
      const border = i === tickets.length - 1 ? "" : "border-bottom:1px solid #f1f5f9;";
      return `
        <tr>
          <td style="padding:12px 20px;${border}font-size:14px;color:#334155;">
            ${key}
            <div style="color:#64748b;font-size:13px;margin-top:2px;">${escapeHtml(t.category)}</div>
          </td>
        </tr>`;
    })
    .join("");
}

function renderSection(key: keyof typeof STATUS_META, tickets: TicketRow[]): string {
  const meta = STATUS_META[key];
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
    <tr>
      <td style="background:${meta.bg};padding:14px 20px;border-bottom:1px solid #e2e8f0;">
        <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:50%;background:${meta.color};color:#ffffff;font-size:12px;font-weight:700;margin-right:10px;">${meta.icon}</span>
        <span style="font-size:15px;font-weight:700;color:#0f172a;vertical-align:middle;">${meta.label}</span>
        <span style="float:right;background:${meta.color};color:#ffffff;font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px;">${tickets.length}</span>
      </td>
    </tr>
    ${renderTicketRows(tickets, meta.color)}
  </table>`;
}

function renderStatCard(count: number, label: string, color: string): string {
  return `
    <td width="33%" style="padding:0 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;">
        <tr>
          <td align="center" style="padding:18px 8px;">
            <div style="font-size:28px;font-weight:800;color:${color};line-height:1;">${count}</div>
            <div style="font-size:12px;color:#64748b;margin-top:4px;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;">${label}</div>
          </td>
        </tr>
      </table>
    </td>`;
}

export function renderReleaseReportHtml(data: ReleaseReportData): string {
  const { projectLabel, cycleId, generatedAt, fixed, parked, flagged } = data;
  const total = fixed.length + parked.length + flagged.length;
  const dateStr = generatedAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:28px 32px;">
                <div style="color:#e0e7ff;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(projectLabel)} · Accessibility Remediation</div>
                <div style="color:#ffffff;font-size:22px;font-weight:800;margin-top:6px;">Cycle Report</div>
                <div style="color:#c7d2fe;font-size:13px;margin-top:4px;">Cycle ${escapeHtml(cycleId)} &nbsp;•&nbsp; ${dateStr}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 26px 0 26px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    ${renderStatCard(total, "Issues Processed", "#4f46e5")}
                    ${renderStatCard(fixed.length, "Fixed", "#16a34a")}
                    ${renderStatCard(parked.length + flagged.length, "Need Review", "#d97706")}
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 26px 4px 26px;">
                ${renderSection("fixed", fixed)}
                ${renderSection("parked", parked)}
                ${renderSection("flagged", flagged)}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px;border-top:1px solid #f1f5f9;">
                <div style="font-size:12px;color:#94a3b8;">
                  Generated automatically by the ${escapeHtml(projectLabel)} accessibility agent. Jira keys above link directly to their tickets.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ── Pre-process email ───────────────────────────────────────────────────────

export interface PreProcessEmailData {
  projectLabel: string;
  cycleId: string;
  generatedAt: Date;
  totalIssues: number;
  severityCounts: Record<string, number>;
  tickets: TicketRow[];
  plannedBranch: string | null;
}

export function renderPreProcessEmailText(data: PreProcessEmailData): string {
  const { cycleId, totalIssues, severityCounts, tickets: ticketRows, plannedBranch } = data;
  const severityLines = Object.entries(severityCounts).map(([sev, count]) => `  - ${sev}: ${count}`);
  return [
    `Cycle ${cycleId} — initial analysis complete: ${totalIssues} issue(s) identified.`,
    ``,
    `By severity:`,
    ...severityLines,
    ``,
    `Jira tickets created (${ticketRows.length}):`,
    ...ticketRows.map((t) => `  - ${t.jiraKey ?? t.id}: ${t.category}`),
    ``,
    plannedBranch ? `Planned branch: ${plannedBranch}` : `Branch/PR: to be created once fixes start.`,
    ``,
    `Full testing report is attached.`,
  ].join("\n");
}

export function renderPreProcessEmailHtml(data: PreProcessEmailData): string {
  const { projectLabel, cycleId, generatedAt, totalIssues, severityCounts, tickets: ticketRows, plannedBranch } = data;
  const dateStr = generatedAt.toLocaleString();

  const severityRows = Object.entries(severityCounts)
    .map(
      ([sev, count]) => `
      <tr>
        <td style="padding:8px 20px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-transform:capitalize;">${safe(sev)}</td>
        <td style="padding:8px 20px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:right;font-weight:700;">${count}</td>
      </tr>`,
    )
    .join("");

  const ticketRowsHtml = ticketRows
    .map((t) => {
      const label = safe(t.jiraKey ?? t.id);
      const link = jiraLink(t.jiraKey);
      const key = link
        ? `<a href="${link}" style="color:#4f46e5;text-decoration:none;font-weight:600;">${label}</a>`
        : `<span style="color:#1e293b;font-weight:600;">${label}</span>`;
      return `<tr><td style="padding:10px 20px;border-bottom:1px solid #f1f5f9;font-size:14px;">${key} <span style="color:#64748b;">— ${safe(t.category)}</span></td></tr>`;
    })
    .join("") || `<tr><td style="padding:16px 20px;color:#94a3b8;font-style:italic;">No tickets created.</td></tr>`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:28px 32px;">
                <div style="color:#e0e7ff;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${safe(projectLabel)} · Pre-Process Report</div>
                <div style="color:#ffffff;font-size:22px;font-weight:800;margin-top:6px;">Analysis Complete — ${totalIssues} Issue(s) Found</div>
                <div style="color:#c7d2fe;font-size:13px;margin-top:4px;">Cycle ${safe(cycleId)} &nbsp;•&nbsp; ${safe(dateStr)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 26px 4px 26px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                  <tr><td style="background:#f8fafc;padding:12px 20px;font-size:13px;font-weight:700;color:#0f172a;">Issues by severity</td></tr>
                  ${severityRows}
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                  <tr><td style="background:#f8fafc;padding:12px 20px;font-size:13px;font-weight:700;color:#0f172a;">Jira tickets created (${ticketRows.length})</td></tr>
                  ${ticketRowsHtml}
                </table>
                <div style="font-size:13px;color:#334155;margin-bottom:16px;">
                  ${plannedBranch ? `Planned branch: <code>${safe(plannedBranch)}</code>` : "Branch/PR will be created once fixes start."}
                </div>
                <div style="font-size:12px;color:#94a3b8;">The full accessibility testing report is attached to this email.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ── Post-process email ──────────────────────────────────────────────────────

export interface PostProcessTicketRow extends TicketRow {
  status: string;
}

export interface PostProcessEmailData {
  projectLabel: string;
  cycleId: string;
  generatedAt: Date;
  resolvedCount: number;
  unresolvedCount: number;
  tickets: PostProcessTicketRow[];
  prUrl: string | null;
  prNumber: number | null;
  mergeStatus: string | null;
  testSummary: string;
  remainingBlockers: Array<{ jiraKey: string | null; id: string; category: string; reason: string }>;
}

export function renderPostProcessEmailText(data: PostProcessEmailData): string {
  const { cycleId, resolvedCount, unresolvedCount, tickets: ticketRows, prUrl, mergeStatus, testSummary, remainingBlockers } = data;
  return [
    `Cycle ${cycleId} complete: ${resolvedCount} resolved, ${unresolvedCount} unresolved/failed.`,
    ``,
    `Tickets:`,
    ...ticketRows.map((t) => `  - ${t.jiraKey ?? t.id} [${t.status}]: ${t.category}`),
    ``,
    prUrl ? `Pull request: ${prUrl} (${mergeStatus ?? "unknown"})` : `Pull request: none this cycle.`,
    ``,
    `Test summary: ${testSummary}`,
    ``,
    `Remaining blockers (${remainingBlockers.length}):`,
    ...remainingBlockers.map((b) => `  - ${b.jiraKey ?? b.id}: ${b.reason}`),
    ``,
    `The final report is attached.`,
  ].join("\n");
}

export function renderPostProcessEmailHtml(data: PostProcessEmailData): string {
  const { projectLabel, cycleId, generatedAt, resolvedCount, unresolvedCount, tickets: ticketRows, prUrl, prNumber, mergeStatus, testSummary, remainingBlockers } = data;
  const dateStr = generatedAt.toLocaleString();

  const ticketRowsHtml = ticketRows
    .map((t) => {
      const label = safe(t.jiraKey ?? t.id);
      const link = jiraLink(t.jiraKey);
      const key = link
        ? `<a href="${link}" style="color:#4f46e5;text-decoration:none;font-weight:600;">${label}</a>`
        : `<span style="color:#1e293b;font-weight:600;">${label}</span>`;
      return `<tr><td style="padding:10px 20px;border-bottom:1px solid #f1f5f9;font-size:14px;">${key} <span style="color:#64748b;">[${safe(t.status)}] — ${safe(t.category)}</span></td></tr>`;
    })
    .join("") || `<tr><td style="padding:16px 20px;color:#94a3b8;font-style:italic;">No tickets this cycle.</td></tr>`;

  const prSection = prUrl
    ? `<a href="${safe(prUrl)}" style="color:#4f46e5;font-weight:600;">PR #${prNumber ?? "?"}</a> — ${safe(mergeStatus ?? "unknown")}`
    : `No pull request this cycle.`;

  const blockersHtml = remainingBlockers
    .map(
      (b) => `<tr><td style="padding:10px 20px;border-bottom:1px solid #f1f5f9;font-size:14px;"><strong>${safe(b.jiraKey ?? b.id)}</strong> — ${safe(b.reason)}</td></tr>`,
    )
    .join("") || `<tr><td style="padding:16px 20px;color:#94a3b8;font-style:italic;">None.</td></tr>`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:28px 32px;">
                <div style="color:#e0e7ff;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${safe(projectLabel)} · Post-Process Report</div>
                <div style="color:#ffffff;font-size:22px;font-weight:800;margin-top:6px;">Cycle Complete</div>
                <div style="color:#c7d2fe;font-size:13px;margin-top:4px;">Cycle ${safe(cycleId)} &nbsp;•&nbsp; ${safe(dateStr)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 26px 0 26px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    ${renderStatCard(resolvedCount, "Resolved", "#16a34a")}
                    ${renderStatCard(unresolvedCount, "Unresolved", "#dc2626")}
                    ${renderStatCard(remainingBlockers.length, "Blockers", "#d97706")}
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 26px 4px 26px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                  <tr><td style="background:#f8fafc;padding:12px 20px;font-size:13px;font-weight:700;color:#0f172a;">Tickets (${ticketRows.length})</td></tr>
                  ${ticketRowsHtml}
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                  <tr><td style="background:#f8fafc;padding:12px 20px;font-size:13px;font-weight:700;color:#0f172a;">Pull request</td></tr>
                  <tr><td style="padding:12px 20px;font-size:14px;">${prSection}</td></tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                  <tr><td style="background:#f8fafc;padding:12px 20px;font-size:13px;font-weight:700;color:#0f172a;">Remaining blockers (${remainingBlockers.length})</td></tr>
                  ${blockersHtml}
                </table>
                <div style="font-size:13px;color:#334155;margin-bottom:8px;"><strong>Test summary:</strong> ${safe(testSummary)}</div>
                <div style="font-size:12px;color:#94a3b8;">The final generated report is attached to this email.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ── Final report ─────────────────────────────────────────────────────────────

export interface FinalReportData {
  projectLabel: string;
  cycleId: string;
  generatedAt: Date;
  epicKey: string | null;
  tickets: Array<{
    jiraKey: string | null;
    id: string;
    category: string;
    status: string;
  }>;
  fixAttempts: Array<{
    ticketId: string;
    branch: string;
    commitSha: string | null;
    prUrl: string | null;
    prNumber: number | null;
    attemptNumber: number;
  }>;
  reviewResults: Array<{
    fixAttemptId: string;
    verdict: string;
    blockingFindingsCount: number;
    comments: string;
  }>;
  deployments: Array<{
    commitSha: string;
    tag: string | null;
    prNumber: number | null;
    prUrl: string | null;
    status: string;
    deployedAt: Date;
  }>;
  auditLog: Array<{
    timestamp: Date;
    action: string;
    actor: string;
    status: string;
  }>;
}

function renderTable(title: string, headers: string[], rows: string[][]): string {
  const headerHtml = headers.map((h) => `<th style="text-align:left;padding:8px 12px;font-size:12px;color:#64748b;border-bottom:1px solid #e2e8f0;">${safe(h)}</th>`).join("");
  const rowsHtml = rows
    .map((r) => `<tr>${r.map((cell) => `<td style="padding:8px 12px;font-size:13px;border-bottom:1px solid #f1f5f9;color:#334155;">${cell}</td>`).join("")}</tr>`)
    .join("") || `<tr><td colspan="${headers.length}" style="padding:12px;color:#94a3b8;font-style:italic;font-size:13px;">None.</td></tr>`;
  return `
  <h3 style="font-size:14px;color:#0f172a;margin:24px 0 8px;">${safe(title)}</h3>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:collapse;">
    <thead><tr style="background:#f8fafc;">${headerHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>`;
}

export function renderFinalReportHtml(data: FinalReportData): string {
  const { projectLabel, cycleId, generatedAt, epicKey, tickets: ticketRows, fixAttempts: attempts, reviewResults: reviews, deployments: deploys, auditLog: audit } = data;
  const dateStr = generatedAt.toLocaleString();

  const ticketsTable = renderTable(
    "Tickets",
    ["Jira Key", "Category", "Status"],
    ticketRows.map((t) => [safe(t.jiraKey ?? t.id), safe(t.category), safe(t.status)]),
  );

  const fixAttemptsTable = renderTable(
    "Fix Attempts",
    ["Branch", "Commit", "PR", "Attempt #"],
    attempts.map((a) => [
      safe(a.branch),
      safe(a.commitSha?.slice(0, 7) ?? "—"),
      a.prUrl ? `<a href="${safe(a.prUrl)}">#${a.prNumber}</a>` : "—",
      String(a.attemptNumber),
    ]),
  );

  const reviewsTable = renderTable(
    "Review Results",
    ["Verdict", "Blocking Findings", "Comments"],
    reviews.map((r) => [safe(r.verdict), String(r.blockingFindingsCount), safe(r.comments.slice(0, 300))]),
  );

  const deploysTable = renderTable(
    "Deployments / Merges",
    ["Commit", "Tag", "PR", "Status", "Deployed At"],
    deploys.map((d) => [
      safe(d.commitSha.slice(0, 7)),
      safe(d.tag ?? "—"),
      d.prUrl ? `<a href="${safe(d.prUrl)}">#${d.prNumber}</a>` : "—",
      safe(d.status),
      safe(d.deployedAt.toLocaleString()),
    ]),
  );

  const auditTable = renderTable(
    "Audit Log",
    ["Timestamp", "Action", "Actor", "Status"],
    audit.map((a) => [safe(a.timestamp.toLocaleString()), safe(a.action), safe(a.actor), safe(a.status)]),
  );

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <h1 style="font-size:20px;">${safe(projectLabel)} — Final Cycle Report</h1>
    <div style="font-size:13px;color:#64748b;margin-bottom:16px;">Cycle ${safe(cycleId)}${epicKey ? ` &nbsp;•&nbsp; Epic ${safe(epicKey)}` : ""} &nbsp;•&nbsp; Generated ${safe(dateStr)}</div>
    ${ticketsTable}
    ${fixAttemptsTable}
    ${reviewsTable}
    ${deploysTable}
    ${auditTable}
  </body>
</html>`;
}

export function renderReleaseReportText(data: ReleaseReportData): string {
  const { cycleId, fixed, parked, flagged } = data;
  const line = (t: TicketRow) => `- ${t.jiraKey ?? t.id}: ${t.category}`;
  return [
    `Accessibility remediation cycle ${cycleId} complete: ${fixed.length} fixed, ${parked.length} parked, ${flagged.length} flagged.`,
    ``,
    `Fixed & verified (${fixed.length}):`,
    ...fixed.map(line),
    ``,
    `Parked — needs a manual fix (${parked.length}):`,
    ...parked.map(line),
    ``,
    `Flagged — needs manual review (${flagged.length}):`,
    ...flagged.map(line),
  ].join("\n");
}
