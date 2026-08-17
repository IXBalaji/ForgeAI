import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(process.cwd(), "../.env");

const EMAIL_LIST_RE = /^[A-Za-z0-9._%+\-@, ]*$/;

function validateEmailList(value: string): string | null {
  if (value.length > 500) return "Value too long (max 500 characters)";
  if (/[\r\n\0]/.test(value)) return "Value contains invalid characters";
  if (!EMAIL_LIST_RE.test(value)) return "Value contains disallowed characters";
  return null;
}

function parseEnvFile(): Map<string, string> {
  const content = fs.readFileSync(ENV_PATH, "utf-8");
  const map = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const match = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.*)$/);
    if (match) {
      map.set(match[1], match[2].replace(/^["']|["']$/g, ""));
    }
  }
  return map;
}

const ALLOWED_KEYS = new Set(["EMAIL_TO", "EMAIL_CC", "EMAIL_BCC"]);

function updateEnvValue(key: string, value: string): void {
  if (!ALLOWED_KEYS.has(key)) throw new Error(`Key ${key} is not writable`);

  let content = fs.readFileSync(ENV_PATH, "utf-8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}="${value}"`);
  } else {
    const insertPoint = content.indexOf("EMAIL_TO=");
    if (insertPoint !== -1) {
      const lineEnd = content.indexOf("\n", insertPoint);
      content =
        content.slice(0, lineEnd + 1) +
        `${key}="${value}"${eol}` +
        content.slice(lineEnd + 1);
    } else {
      content += `${eol}${key}="${value}"${eol}`;
    }
  }
  fs.writeFileSync(ENV_PATH, content, "utf-8");
}

export async function GET() {
  try {
    const env = parseEnvFile();
    return NextResponse.json({
      emailTo: env.get("EMAIL_TO") ?? "",
      emailCc: env.get("EMAIL_CC") ?? "",
      emailBcc: env.get("EMAIL_BCC") ?? "",
      smtpHost: env.get("SMTP_HOST") ?? "",
      smtpPort: env.get("SMTP_PORT") ?? "587",
      smtpUser: env.get("SMTP_USER") ?? "",
      emailFrom: env.get("EMAIL_FROM") ?? "",
      smtpConfigured: Boolean(
        env.get("SMTP_HOST") && env.get("SMTP_USER") && env.get("SMTP_PASS"),
      ),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to read email settings", details: String(err) },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { emailTo, emailCc, emailBcc } = body as {
      emailTo?: string;
      emailCc?: string;
      emailBcc?: string;
    };

    const fields: [string, string | undefined][] = [
      ["EMAIL_TO", emailTo],
      ["EMAIL_CC", emailCc],
      ["EMAIL_BCC", emailBcc],
    ];

    for (const [key, value] of fields) {
      if (value === undefined) continue;
      const err = validateEmailList(value);
      if (err) {
        return NextResponse.json(
          { error: `Invalid ${key}: ${err}` },
          { status: 400 },
        );
      }
    }

    for (const [key, value] of fields) {
      if (value !== undefined) updateEnvValue(key, value);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to update email settings", details: String(err) },
      { status: 500 },
    );
  }
}
