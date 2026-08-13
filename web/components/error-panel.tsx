interface ErrorPanelProps {
  error: string;
  isStalled?: boolean;
}

export function ErrorPanel({ error, isStalled }: ErrorPanelProps) {
  return (
    <div className="error-panel" role="alert">
      <div className="error-icon">
        <svg
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </div>
      <div className="error-content">
        <h3>{isStalled ? "Pipeline Stalled" : "Error"}</h3>
        <p>{error}</p>
        {isStalled && (
          <p className="error-guidance">
            The previous pipeline run did not complete. Please check the
            activity logs and resolve any issues before starting a new run.
          </p>
        )}
      </div>
    </div>
  );
}
