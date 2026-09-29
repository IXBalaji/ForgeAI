"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface LoggedCycle {
  cycleId: string;
  mode: string;
  startedAt: string;
  endedAt: string | null;
}

export default function LogsPage() {
  const [cycles, setCycles] = useState<LoggedCycle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/logs")
      .then((res) => res.json())
      .then((data) => setCycles(data.cycles))
      .catch(() => setError("Failed to load cycles"));
  }, []);

  if (error) {
    return (
      <main className="container">
        <p>{error}</p>
      </main>
    );
  }
  if (!cycles) {
    return (
      <main className="container">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="container">
      <h1>Cycle logs</h1>
      <table>
        <thead>
          <tr>
            <th>Cycle</th>
            <th>Mode</th>
            <th>Started</th>
            <th>Ended</th>
          </tr>
        </thead>
        <tbody>
          {cycles.map((c) => (
            <tr key={c.cycleId}>
              <td>
                <Link href={`/logs/${c.cycleId}`}>{c.cycleId}</Link>
              </td>
              <td>{c.mode}</td>
              <td>{new Date(c.startedAt).toLocaleString()}</td>
              <td>{c.endedAt ? new Date(c.endedAt).toLocaleString() : "running"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
