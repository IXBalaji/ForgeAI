import "dotenv/config";
import { createTransport } from "nodemailer";
import { withRetry } from "../lib/retry.js";
import { redactSecrets } from "../observability/sanitize.js";

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO } = process.env;

export function isEmailConfigured(): boolean {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM && EMAIL_TO);
}

if (isEmailConfigured()) {
  console.log(`[email] SMTP configured: host=${SMTP_HOST}, port=${SMTP_PORT || 587}, from=${EMAIL_FROM}, to=${EMAIL_TO}`);
} else {
  const missing = [
    !SMTP_HOST && "SMTP_HOST",
    !SMTP_USER && "SMTP_USER",
    !SMTP_PASS && "SMTP_PASS",
    !EMAIL_FROM && "EMAIL_FROM",
    !EMAIL_TO && "EMAIL_TO",
  ].filter(Boolean);
  console.warn(`[email] SMTP not configured — missing: ${missing.join(", ")}. Email notifications will be skipped.`);
}

const transporter = isEmailConfigured()
  ? createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

export interface EmailAttachment {
  filename: string;
  path: string;
}

/**
 * Sends an email, retrying transient SMTP failures with backoff. Failures are
 * always logged and swallowed here (never thrown) — callers in the
 * orchestrator must never let an email problem fail the main workflow.
 */
export async function sendEmail(subject: string, text: string, html?: string, attachments?: EmailAttachment[]): Promise<void> {
  if (!transporter) {
    console.warn("[email] SMTP not configured — report was not emailed.");
    return;
  }

  const recipients = EMAIL_TO!.split(",").map((a) => a.trim());

  try {
    console.log(`[email] Sending report to ${recipients.join(", ")} — subject: "${subject}"`);
    const info = await withRetry(
      () =>
        transporter.sendMail({
          from: EMAIL_FROM,
          to: recipients,
          subject,
          text,
          html: html ?? text.replace(/\n/g, "<br>"),
          attachments,
        }),
      { retries: 3, delayMs: 2000, backoff: "exponential", label: `email "${subject}"` },
    );
    console.log(`[email] Report sent successfully — messageId: ${info.messageId}`);
  } catch (err) {
    console.error("[email] Failed to send report (giving up after retries):");
    console.error(`[email]   Error: ${err instanceof Error ? redactSecrets(err.message) : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(`[email]   Stack: ${redactSecrets(err.stack.split("\n").slice(1, 3).join(" | "))}`);
    }
    console.error(`[email]   Config: host=${SMTP_HOST}, port=${SMTP_PORT || 587}, user=${SMTP_USER}, from=${EMAIL_FROM}`);
    console.error(`[email]   Tip: If using Gmail, ensure you're using an App Password (not your regular password).`);
    console.error(`[email]   Generate one at: https://myaccount.google.com/apppasswords`);
  }
}

/**
 * Unrecoverable-error alert — distinct subject prefix so it's filterable from
 * routine cycle-report emails. Details are sanitized before sending.
 */
export async function sendErrorAlertEmail(subject: string, sanitizedDetails: string): Promise<void> {
  await sendEmail(`[ALERT] ${subject}`, redactSecrets(sanitizedDetails));
}
