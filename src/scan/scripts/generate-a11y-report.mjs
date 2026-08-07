import fs from "node:fs";
import path from "node:path";

const REPORT_DIR = path.join(process.cwd(), "a11y-reports");
const htmlPath = path.join(REPORT_DIR, "index.html");

const impactRank = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const impactColor = { critical: "#b3261e", serious: "#d93025", moderate: "#e37400", minor: "#9e9e00" };

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const files = fs.existsSync(REPORT_DIR)
  ? fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith(".json")).sort()
  : [];

if (files.length === 0) {
  console.error(`No axe JSON reports found in ${REPORT_DIR} — run \`npm run test:a11y\` first.`);
  process.exit(1);
}

const pages = files.map((file) => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, file), "utf-8"));
  const violations = [...raw.violations].sort((a, b) => (impactRank[a.impact] ?? 4) - (impactRank[b.impact] ?? 4));
  return { slug: file.replace(/\.json$/, ""), url: raw.url, timestamp: raw.timestamp, violations, passes: raw.passes.length };
});

const totalViolationTypes = pages.reduce((sum, p) => sum + p.violations.length, 0);
const totalNodes = pages.reduce((sum, p) => sum + p.violations.reduce((s, v) => s + v.nodes.length, 0), 0);
const counts = pages.reduce((acc, p) => {
  p.violations.forEach((v) => {
    acc[v.impact ?? "unknown"] = (acc[v.impact ?? "unknown"] || 0) + 1;
  });
  return acc;
}, {});

const summaryCards = ["critical", "serious", "moderate", "minor"]
  .map(
    (impact) => `
    <div class="card">
      <div class="card-count" style="color:${impactColor[impact]}">${counts[impact] || 0}</div>
      <div class="card-label">${impact}</div>
    </div>`,
  )
  .join("");

const pageSections = pages
  .map((p) => {
    const rows = p.violations
      .map((v) => {
        const nodesHtml = v.nodes
          .map(
            (n) => `
            <div class="node">
              <div class="node-selector">${escapeHtml(n.target.join(" "))}</div>
              <pre class="node-html">${escapeHtml(n.html)}</pre>
              ${n.failureSummary ? `<div class="node-fix">${escapeHtml(n.failureSummary)}</div>` : ""}
            </div>`,
          )
          .join("");

        return `
        <details class="violation">
          <summary>
            <span class="badge" style="background:${impactColor[v.impact] || "#666"}">${v.impact ?? "n/a"}</span>
            <span class="rule-id">${escapeHtml(v.id)}</span>
            <span class="rule-help">${escapeHtml(v.help)}</span>
            <span class="node-count">${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"}</span>
          </summary>
          <div class="violation-body">
            <p class="description">${escapeHtml(v.description)}</p>
            <a class="help-link" href="${v.helpUrl}" target="_blank" rel="noopener noreferrer">View rule documentation &rarr;</a>
            ${nodesHtml}
          </div>
        </details>`;
      })
      .join("");

    return `
    <section class="page-section">
      <h2 id="${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</h2>
      <p class="meta">${escapeHtml(p.url ?? "")} &nbsp;|&nbsp; ${p.violations.length} violation type(s) &nbsp;|&nbsp; ${p.passes} rule(s) passed</p>
      ${rows || '<p class="none">No violations found.</p>'}
    </section>`;
  })
  .join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Accessibility Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#5f5f5f; --card-bg:#f5f5f5; --border:#e0e0e0; --code-bg:#f0f0f0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14171a; --fg:#e8e8e8; --muted:#a0a0a0; --card-bg:#1f2428; --border:#2c3339; --code-bg:#1b1f23; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; line-height:1.5; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  h2 { font-size: 1.15rem; margin: 0 0 6px; font-family: ui-monospace, SFMono-Regular, monospace; }
  .subtitle { color: var(--muted); margin-top: 0; font-size: 0.95rem; }
  .summary-cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 24px 0 32px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; min-width: 100px; text-align: center; }
  .card-count { font-size: 1.8rem; font-weight: 700; }
  .card-label { color: var(--muted); text-transform: capitalize; font-size: 0.85rem; }
  .meta { color: var(--muted); font-size: 0.85rem; margin-bottom: 16px; word-break: break-all; }
  .page-section { border-top: 2px solid var(--border); padding-top: 20px; margin-top: 32px; }
  .none { color: var(--muted); }
  .violation { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 14px; overflow: hidden; background: var(--card-bg); }
  .violation summary { cursor: pointer; padding: 14px 16px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; list-style: none; }
  .violation summary::-webkit-details-marker { display: none; }
  .badge { color: white; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; padding: 3px 8px; border-radius: 6px; letter-spacing: 0.03em; }
  .rule-id { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85rem; color: var(--muted); }
  .rule-help { font-weight: 600; flex: 1; }
  .node-count { color: var(--muted); font-size: 0.85rem; }
  .violation-body { padding: 0 16px 16px; border-top: 1px solid var(--border); }
  .description { color: var(--muted); }
  .help-link { font-size: 0.85rem; }
  .node { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-top: 12px; background: var(--bg); }
  .node-selector { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.78rem; color: var(--muted); margin-bottom: 6px; }
  .node-html { background: var(--code-bg); padding: 8px 10px; border-radius: 6px; overflow-x: auto; font-size: 0.8rem; margin: 0 0 6px; }
  .node-fix { font-size: 0.82rem; color: var(--muted); white-space: pre-line; }
  .toc { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .toc a { font-size: 0.82rem; text-decoration: none; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Accessibility Report</h1>
  <p class="subtitle">Playwright + axe-core, ${pages.length} page/state scan(s)</p>
  <p class="meta">${totalViolationTypes} violation type(s) across ${totalNodes} element(s), across all scanned pages/states</p>

  <div class="summary-cards">${summaryCards}</div>

  <div class="toc">${pages.map((p) => `<a href="#${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</a>`).join("")}</div>

  ${pageSections}
</div>
</body>
</html>
`;

fs.writeFileSync(htmlPath, html);
console.log(`Accessibility HTML report written to ${htmlPath}`);
