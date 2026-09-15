"use client";

import { useState } from "react";
import { ConfirmationDialog } from "./confirmation-dialog";
import type { RunMode } from "@/lib/types";

interface StartWorkflowButtonProps {
  onStartSuccess: (cycleId: string) => void;
  onStartError: (error: string) => void;
}

export function StartWorkflowButton({
  onStartSuccess,
  onStartError,
}: StartWorkflowButtonProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [mode, setMode] = useState<RunMode>("full");

  const handleClick = () => {
    setIsDialogOpen(true);
  };

  const handleCancel = () => {
    setIsDialogOpen(false);
  };

  const handleConfirm = async () => {
    setIsStarting(true);

    try {
      const response = await fetch("/api/workflow/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });

      if (response.status === 409) {
        const data = await response.json();
        onStartError(
          data.error === "stalled"
            ? "A previous run stalled (process died but DB row exists). Manual recovery required."
            : "A workflow is already running."
        );
        setIsDialogOpen(false);
        setIsStarting(false);
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        onStartError(data.error || "Failed to start workflow");
        setIsDialogOpen(false);
        setIsStarting(false);
        return;
      }

      const data = await response.json();
      onStartSuccess(data.cycleId);
      setIsDialogOpen(false);
      setIsStarting(false);
    } catch (err) {
      onStartError(
        err instanceof Error ? err.message : "Network error"
      );
      setIsDialogOpen(false);
      setIsStarting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="button-primary button-large"
      >
        Start Workflow
      </button>
      <ConfirmationDialog
        isOpen={isDialogOpen}
        mode={mode}
        onModeChange={setMode}
        onCancel={handleCancel}
        onConfirm={handleConfirm}
        isStarting={isStarting}
      />
    </>
  );
}
