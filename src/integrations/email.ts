import "dotenv/config";
import { createTransport } from "nodemailer";

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO } = process.env;

export function isEmailConfigured(): boolean {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM && EMAIL_TO);
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
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: recipients,
      subject,
      text,
      html: html ?? text.replace(/\n/g, "<br>"),
    });
  } catch (err) {
    console.warn("[email] Failed to send report:", err instanceof Error ? err.message : err);
  }
}
