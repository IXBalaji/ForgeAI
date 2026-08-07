import "dotenv/config";

const { SENDGRID_API_KEY, EMAIL_FROM, EMAIL_TO } = process.env;

export function isEmailConfigured(): boolean {
  return Boolean(SENDGRID_API_KEY && EMAIL_FROM && EMAIL_TO);
}

/**
 * Sends the release report by email via SendGrid's v3 API — a plain fetch
 * call rather than the SendGrid SDK, matching the pattern of the other
 * integrations (Jira, GitHub, Slack) rather than adding a client dependency
 * for a single POST. Gracefully no-ops (with a warning) if unconfigured,
 * same as every other optional integration in this system.
 */
export async function sendEmail(subject: string, body: string): Promise<void> {
  if (!isEmailConfigured()) {
    console.warn("[email] SendGrid not configured — report was not emailed.");
    return;
  }

  const recipients = EMAIL_TO!.split(",").map((addr) => ({ email: addr.trim() }));

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: recipients }],
      from: { email: EMAIL_FROM },
      subject,
      content: [{ type: "text/plain", value: body }],
    }),
  });

  if (!res.ok) {
    throw new Error(`SendGrid send failed: ${res.status} ${await res.text()}`);
  }
}
