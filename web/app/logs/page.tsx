"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface LoggedCycle {
  cycleId: string;
  mode: string;
  startedAt: string;
  endedAt: string | null;
}

const PAGE_SIZE = 10;

export default function LogsPage() {
  const router = useRouter();
  const [cycles, setCycles] = useState<LoggedCycle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    fetch("/api/logs")
      .then((res) => res.json())
      .then((data) => setCycles(data.cycles))
      .catch(() => setError("Failed to load cycles"));
  }, []);

  if (error) {
    return (
      <main className="container">
        <header className="page-header">
          <h1>Cycle Logs</h1>
        </header>
        <p>{error}</p>
      </main>
    );
  }
  if (!cycles) {
    return (
      <main className="container">
        <header className="page-header">
          <h1>Cycle Logs</h1>
        </header>
        <p>Loading…</p>
      </main>
    );
  }

  const totalPages = Math.max(1, Math.ceil(cycles.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageCycles = cycles.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <main className="container">
      <header className="page-header">
        <h1>Cycle Logs</h1>
      </header>
      {cycles.length === 0 ? (
        <p className="muted">No cycle logs recorded yet.</p>
      ) : (
        <>
          <div className="results-table-wrap">
            <table className="results-table">
              <thead>
                <tr>
                  <th scope="col" className="num">Sr No</th>
                  <th scope="col">Cycle</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Started</th>
                  <th scope="col">Ended</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageCycles.map((c, i) => (
                  <tr key={c.cycleId}>
                    <td className="num">{pageStart + i + 1}</td>
                    <td>{c.cycleId}</td>
                    <td>{c.mode}</td>
                    <td>{new Date(c.startedAt).toLocaleString()}</td>
                    <td>{c.endedAt ? new Date(c.endedAt).toLocaleString() : "running"}</td>
                    <td>
                      <button
                        type="button"
                        className="button-secondary button-small"
                        onClick={() => router.push(`/logs/${c.cycleId}`)}
                      >
                        View Logs
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              Previous
            </button>
            <span className="pagination__info">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              Next
            </button>
          </div>
        </>
      )}
    </main>
  );
}
