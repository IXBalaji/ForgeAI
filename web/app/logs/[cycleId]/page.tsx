"use client";

import { use, useEffect, useState } from "react";

export default function LogDetailPage({ params }: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = use(params);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/logs/${cycleId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to load log");
        }
        return res.text();
      })
      .then(setContent)
      .catch((err) => setError(err.message));
  }, [cycleId]);

  return (
    <main className="container">
      <h1>Cycle {cycleId}</h1>
      {error && <p>{error}</p>}
      {content !== null && <pre className="log-view">{content}</pre>}
    </main>
  );
}
