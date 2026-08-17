import { db } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { redactSecrets, sanitizeForTrace } from "../observability/sanitize.js";

export interface AuditLogEntry {
  cycleId: string;
  action: string;
  actor: "orchestrator" | "reviewer" | "developer" | "deploy";
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
  status: "success" | "failure";
}

/**
 * Best-effort audit trail write — never throws, so a broken audit insert
 * never blocks the pipeline. `details` is always sanitized first since it
 * may echo agent- or error-produced text.
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
  try {
    const sanitizedDetails = sanitizeForTrace(entry.details ?? {}) as Record<string, unknown>;
    await db.insert(auditLog).values({
      cycleId: entry.cycleId,
      action: entry.action,
      actor: entry.actor,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      details: sanitizedDetails,
      status: entry.status,
    });
  } catch (err) {
    console.warn(
      `[audit-log] Failed to write audit entry for action "${entry.action}":`,
      redactSecrets((err as Error).message ?? String(err)).slice(0, 300),
    );
  }
}
