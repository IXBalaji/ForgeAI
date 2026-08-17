"use client";

import { useEffect, useState } from "react";

interface EmailSettings {
  emailTo: string;
  emailCc: string;
  emailBcc: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  emailFrom: string;
  smtpConfigured: boolean;
}

function parseEmails(raw: string): string[] {
  return raw.split(",").map((e) => e.trim()).filter(Boolean);
}

function RecipientGroup({ label, emails }: { label: string; emails: string[] }) {
  if (emails.length === 0) return null;
  return (
    <div className="recipient-group">
      <span className="recipient-group__label">{label}</span>
      <div className="recipient-group__tags">
        {emails.map((email) => (
          <span key={email} className="recipient-tag">{email}</span>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [savedTo, setSavedTo] = useState<string[]>([]);
  const [savedCc, setSavedCc] = useState<string[]>([]);
  const [savedBcc, setSavedBcc] = useState<string[]>([]);
  const [emailTo, setEmailTo] = useState("");
  const [emailCc, setEmailCc] = useState("");
  const [emailBcc, setEmailBcc] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const applySaved = (data: EmailSettings) => {
    setSavedTo(parseEmails(data.emailTo));
    setSavedCc(parseEmails(data.emailCc));
    setSavedBcc(parseEmails(data.emailBcc));
  };

  useEffect(() => {
    fetch("/api/settings/email")
      .then((res) => res.json())
      .then((data: EmailSettings) => {
        setSettings(data);
        setEmailTo(data.emailTo);
        setEmailCc(data.emailCc);
        setEmailBcc(data.emailBcc);
        applySaved(data);
        setLoading(false);
      })
      .catch(() => {
        setMessage({ type: "error", text: "Failed to load email settings." });
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailTo, emailCc, emailBcc }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSavedTo(parseEmails(emailTo));
      setSavedCc(parseEmails(emailCc));
      setSavedBcc(parseEmails(emailBcc));
      setMessage({ type: "success", text: "Email settings saved successfully." });
    } catch {
      setMessage({ type: "error", text: "Failed to save email settings." });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="container">
        <div className="loading">Loading settings...</div>
      </main>
    );
  }

  const hasRecipients = savedTo.length > 0 || savedCc.length > 0 || savedBcc.length > 0;

  return (
    <main className="container settings-page">
      <section className="settings-header">
        <h1>Email Settings</h1>
        <p className="settings-header__desc">
          Configure who receives pipeline reports, cycle summaries, and error alerts.
        </p>
      </section>

      {/* SMTP status */}
      {settings && (
        <div className={`settings-status ${settings.smtpConfigured ? "settings-status--ok" : "settings-status--warn"}`}>
          <span className="settings-status__icon">
            {settings.smtpConfigured ? "✓" : "⚠"}
          </span>
          <div>
            <strong>{settings.smtpConfigured ? "SMTP Configured" : "SMTP Not Configured"}</strong>
            {settings.smtpConfigured ? (
              <p>
                Host: <code>{settings.smtpHost}:{settings.smtpPort}</code> &middot;
                From: <code>{settings.emailFrom}</code>
              </p>
            ) : (
              <p>
                Set <code>SMTP_HOST</code>, <code>SMTP_USER</code>, and <code>SMTP_PASS</code> in
                your <code>.env</code> file to enable email delivery.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Current recipients summary */}
      {hasRecipients && (
        <div className="settings-card recipients-summary">
          <h2>Current Recipients</h2>
          <RecipientGroup label="To" emails={savedTo} />
          <RecipientGroup label="CC" emails={savedCc} />
          <RecipientGroup label="BCC" emails={savedBcc} />
        </div>
      )}

      {/* Form */}
      <div className="settings-card">
        <h2>Edit Recipients</h2>
        <div className="settings-field">
          <label htmlFor="emailTo">
            To (primary recipients)
            <span className="settings-field__hint">Comma-separated email addresses</span>
          </label>
          <input
            id="emailTo"
            type="text"
            value={emailTo}
            onChange={(e) => setEmailTo(e.target.value)}
            placeholder="alice@example.com, bob@example.com"
          />
        </div>

        <div className="settings-field">
          <label htmlFor="emailCc">
            CC (carbon copy)
            <span className="settings-field__hint">Optional &mdash; receives a visible copy</span>
          </label>
          <input
            id="emailCc"
            type="text"
            value={emailCc}
            onChange={(e) => setEmailCc(e.target.value)}
            placeholder="manager@example.com"
          />
        </div>

        <div className="settings-field">
          <label htmlFor="emailBcc">
            BCC (blind carbon copy)
            <span className="settings-field__hint">Optional &mdash; hidden from other recipients</span>
          </label>
          <input
            id="emailBcc"
            type="text"
            value={emailBcc}
            onChange={(e) => setEmailBcc(e.target.value)}
            placeholder="audit@example.com"
          />
        </div>

        {message && (
          <div className={`settings-message ${message.type === "success" ? "settings-message--success" : "settings-message--error"}`}>
            {message.text}
          </div>
        )}

        <div className="settings-actions">
          <button className="button-primary" onClick={handleSave} disabled={saving || !emailTo.trim()}>
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </main>
  );
}
