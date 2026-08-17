import { sendErrorAlertEmail } from "../integrations/email.js";
import { redactSecrets } from "../observability/sanitize.js";
import { logAudit } from "./audit-log.js";

export async function notifySlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log("[notify] SLACK_WEBHOOK_URL not set — report only printed to console.");
    return;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export interface UnrecoverableErrorContext {
  cycleId: string;
  stage: string;
  action: string;
  error: unknown;
  details?: Record<string, unknown>;
}

/**
 * Fired only at genuinely terminal points (review-retry budget exhausted,
 * merge failure that survives retries/conflict resolution) — not for routine
 * "requesting changes" or "blocked, will retry" states, to avoid alert
 * fatigue. Notifies both Slack and email, and records a failure audit row.
 */
export async function notifyUnrecoverableError(ctx: UnrecoverableErrorContext): Promise<void> {
  const errMessage = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
  const errStack = ctx.error instanceof Error ? ctx.error.stack : undefined;
  const sanitizedMessage = redactSecrets(errMessage).slice(0, 500);

  const summaryLine = `[UNRECOVERABLE] cycle ${ctx.cycleId} — ${ctx.stage}/${ctx.action}: ${sanitizedMessage}`;

  try {
    await notifySlack(summaryLine);
  } catch (err) {
    console.warn("[notify] Failed to post Slack alert:", (err as Error).message?.slice(0, 200));
  }

  try {
    const detailLines = [
      `Cycle: ${ctx.cycleId}`,
      `Stage: ${ctx.stage}`,
      `Action: ${ctx.action}`,
      `Error: ${sanitizedMessage}`,
      errStack ? `Stack:\n${redactSecrets(errStack).slice(0, 1500)}` : null,
      ctx.details ? `Details: ${redactSecrets(JSON.stringify(ctx.details)).slice(0, 1000)}` : null,
    ].filter(Boolean);
    await sendErrorAlertEmail(`Unrecoverable error in cycle ${ctx.cycleId}`, detailLines.join("\n\n"));
  } catch (err) {
    console.warn("[notify] Failed to send error alert email:", (err as Error).message?.slice(0, 200));
  }

  await logAudit({
    cycleId: ctx.cycleId,
    action: `unrecoverable.${ctx.action}`,
    actor: "orchestrator",
    entityType: "cycle",
    entityId: ctx.cycleId,
    details: { stage: ctx.stage, error: sanitizedMessage, ...ctx.details },
    status: "failure",
  });
}
