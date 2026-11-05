"use client";

import { useEffect, useRef } from "react";
import type { RunMode } from "@/lib/types";

interface ConfirmationDialogProps {
  isOpen: boolean;
  mode: RunMode;
  onModeChange: (mode: RunMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
  isStarting: boolean;
}

const MODE_OPTIONS: Array<{ value: RunMode; label: string; description: string }> = [
  { value: "scan", label: "Scan report", description: "Scan the site and generate the accessibility report only. No tickets, no fixes." },
  { value: "triage", label: "Scan + classify", description: "Scan and classify every issue found, then create tickets. Nothing gets fixed — tickets are left \"open\" for later." },
  { value: "full", label: "Scan + classify + fix", description: "The complete autonomous pipeline: scan, classify, fix, review, deploy to QA, verify, and release." },
];

export function ConfirmationDialog({
  isOpen,
  mode,
  onModeChange,
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

  const targetUrl = process.env.TARGET_FRONTEND_URL || "[not configured]";
  const githubRepo = process.env.GITHUB_OWNER && process.env.GITHUB_REPO
    ? `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`
    : "[not configured]";
  const qaBranch = process.env.GITHUB_QA_BRANCH || "[not configured]";
  const projectKey = process.env.PROJECT_KEY || "[not configured]";

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
          <fieldset className="mode-picker">
            <legend>Run depth</legend>
            {MODE_OPTIONS.map((option) => (
              // eslint-disable-next-line jsx-a11y/label-has-associated-control -- input is nested; label text is {option.label} (rule can't see past depth 2)
              <label key={option.value} className="mode-option">
                <input
                  type="radio"
                  name="run-mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => onModeChange(option.value)}
                  disabled={isStarting}
                />
                <span>
                  <strong>{option.label}</strong>
                  <br />
                  <span className="mode-option-description">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <ul className="side-effects-list">
            <li>
              <strong>Accessibility scan</strong> against{" "}
              <code>{targetUrl}</code>
            </li>
            {mode !== "scan" && (
              <li>
                <strong>Ticket creation</strong> in project{" "}
                <code>{projectKey}</code>
              </li>
            )}
            {mode === "full" && (
              <>
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
              </>
            )}
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
