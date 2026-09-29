import "dotenv/config";
import { createTransport } from "nodemailer";
import { withRetry } from "../lib/retry.js";
import { redactSecrets } from "../observability/sanitize.js";
import { logger } from "../lib/logger.js";

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO, EMAIL_CC, EMAIL_BCC } = process.env;

export function isEmailConfigured(): boolean {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM && EMAIL_TO);
}

if (isEmailConfigured()) {
  const extras = [EMAIL_CC && `cc=${EMAIL_CC}`, EMAIL_BCC && `bcc=${EMAIL_BCC}`].filter(Boolean).join(", ");
  logger.info(`email`, `SMTP configured: host=${SMTP_HOST}, port=${SMTP_PORT || 587}, from=${EMAIL_FROM}, to=${EMAIL_TO}${extras ? `, ${extras}` : ""}`);
} else {
  const missing = [
    !SMTP_HOST && "SMTP_HOST",
    !SMTP_USER && "SMTP_USER",
    !SMTP_PASS && "SMTP_PASS",
    !EMAIL_FROM && "EMAIL_FROM",
    !EMAIL_TO && "EMAIL_TO",
  ].filter(Boolean);
  logger.warn(`email`, `SMTP not configured — missing: ${missing.join(", ")}. Email notifications will be skipped.`);
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
    logger.warn("email", "SMTP not configured — report was not emailed.");
    return;
  }

  const recipients = EMAIL_TO!.split(",").map((a) => a.trim());
  const ccList = EMAIL_CC ? EMAIL_CC.split(",").map((a) => a.trim()) : [];
  const bccList = EMAIL_BCC ? EMAIL_BCC.split(",").map((a) => a.trim()) : [];

  try {
    logger.info(`email`, `Sending report to ${recipients.join(", ")}${ccList.length ? ` cc=${ccList.join(", ")}` : ""}${bccList.length ? ` bcc=${bccList.join(", ")}` : ""} — subject: "${subject}"`);
    const info = await withRetry(
      () =>
        transporter.sendMail({
          from: EMAIL_FROM,
          to: recipients,
          ...(ccList.length && { cc: ccList }),
          ...(bccList.length && { bcc: bccList }),
          subject,
          text,
          html: html ?? text.replace(/\n/g, "<br>"),
          attachments,
        }),
      { retries: 3, delayMs: 2000, backoff: "exponential", label: `email "${subject}"` },
    );
    logger.info(`email`, `Report sent successfully — messageId: ${info.messageId}`);
  } catch (err) {
    logger.error("email", "Failed to send report (giving up after retries):");
    logger.error(`email`, `  Error: ${err instanceof Error ? redactSecrets(err.message) : String(err)}`);
    if (err instanceof Error && err.stack) {
      logger.error(`email`, `  Stack: ${redactSecrets(err.stack.split("\n").slice(1, 3).join(" | "))}`);
    }
    logger.error(`email`, `  Config: host=${SMTP_HOST}, port=${SMTP_PORT || 587}, user=${SMTP_USER}, from=${EMAIL_FROM}`);
    logger.error(`email`, `  Tip: If using Gmail, ensure you're using an App Password (not your regular password).`);
    logger.error(`email`, `  Generate one at: https://myaccount.google.com/apppasswords`);
  }
}

/**
 * Unrecoverable-error alert — distinct subject prefix so it's filterable from
 * routine cycle-report emails. Details are sanitized before sending.
 */
export async function sendErrorAlertEmail(subject: string, sanitizedDetails: string): Promise<void> {
  await sendEmail(`[ALERT] ${subject}`, redactSecrets(sanitizedDetails));
}
