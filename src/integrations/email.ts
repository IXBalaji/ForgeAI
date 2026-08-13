import "dotenv/config";
import { createTransport } from "nodemailer";

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

export async function sendEmail(subject: string, text: string, html?: string): Promise<void> {
  if (!transporter) {
    console.warn("[email] SMTP not configured — report was not emailed.");
    return;
  }

  const recipients = EMAIL_TO!.split(",").map((a) => a.trim());

  try {
    console.log(`[email] Sending report to ${recipients.join(", ")} — subject: "${subject}"`);
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to: recipients,
      subject,
      text,
      html: html ?? text.replace(/\n/g, "<br>"),
    });
    console.log(`[email] Report sent successfully — messageId: ${info.messageId}`);
  } catch (err) {
    console.error("[email] Failed to send report:");
    console.error(`[email]   Error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(`[email]   Stack: ${err.stack.split("\n").slice(1, 3).join(" | ")}`);
    }
    console.error(`[email]   Config: host=${SMTP_HOST}, port=${SMTP_PORT || 587}, user=${SMTP_USER}, from=${EMAIL_FROM}`);
    console.error(`[email]   Tip: If using Gmail, ensure you're using an App Password (not your regular password).`);
    console.error(`[email]   Generate one at: https://myaccount.google.com/apppasswords`);
  }
}
