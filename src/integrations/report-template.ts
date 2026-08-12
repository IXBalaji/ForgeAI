import { JIRA_BASE_URL } from "../lib/config.js";

interface TicketRow {
  jiraKey: string | null;
  id: string;
  category: string;
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
