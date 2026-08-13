"use client";

import { useEffect, useRef } from "react";

interface ConfirmationDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  isStarting: boolean;
}

export function ConfirmationDialog({
  isOpen,
  onCancel,
  onConfirm,
  isStarting,
}: ConfirmationDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (isOpen && cancelButtonRef.current) {
      cancelButtonRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isStarting) {
        onCancel();
      }
    };

    dialog.addEventListener("keydown", handleEscape);
    return () => dialog.removeEventListener("keydown", handleEscape);
  }, [onCancel, isStarting]);

  if (!isOpen) return null;

  const targetUrl = process.env.NEXT_PUBLIC_TARGET_FRONTEND_URL || "[not configured]";
  const githubRepo = process.env.NEXT_PUBLIC_GITHUB_OWNER && process.env.NEXT_PUBLIC_GITHUB_REPO
    ? `${process.env.NEXT_PUBLIC_GITHUB_OWNER}/${process.env.NEXT_PUBLIC_GITHUB_REPO}`
    : "[not configured]";
  const qaBranch = process.env.NEXT_PUBLIC_GITHUB_QA_BRANCH || "[not configured]";
  const projectKey = process.env.NEXT_PUBLIC_PROJECT_KEY || "[not configured]";

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog"
      role="alertdialog"
      aria-labelledby="dialog-title"
      aria-describedby="dialog-description"
    >
      <div className="dialog-content">
        <h2 id="dialog-title">Start Remediation Pipeline</h2>
        <div id="dialog-description" className="dialog-body">
          <p>
            ForgeAI will scan, triage, fix, review, and deploy accessibility
            improvements for your application.
          </p>
          <ul className="side-effects-list">
            <li>
              <strong>Accessibility scan</strong> against{" "}
              <code>{targetUrl}</code>
            </li>
            <li>
              <strong>Ticket creation</strong> in project{" "}
              <code>{projectKey}</code>
            </li>
            <li>
              <strong>AI-powered fixes</strong> committed to{" "}
              <code>{githubRepo}</code>
            </li>
            <li>
              <strong>Automated code review</strong> and quality checks
            </li>
            <li>
              <strong>Deploy to QA</strong> branch{" "}
              <code>{qaBranch}</code>
            </li>
          </ul>
        </div>
        <div className="dialog-actions">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            disabled={isStarting}
            className="button-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isStarting}
            className="button-primary"
          >
            {isStarting ? "Starting..." : "Start Pipeline"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
