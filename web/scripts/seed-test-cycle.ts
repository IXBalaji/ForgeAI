/**
 * Seed a complete test cycle with realistic data to verify UI rendering.
 *
 * Creates:
 * - One iteration_cycles row
 * - Multiple tickets across all status values
 * - Fix attempts for some tickets
 * - Review results (approved/rejected)
 * - Deployment records
 *
 * Run with: tsx web/scripts/seed-test-cycle.ts [--complete]
 * --complete: marks the cycle as ended (for testing completed view)
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../.env") });

import { db } from "../lib/db";
import { iterationCycles, tickets, fixAttempts, reviewResults, deployments } from "../lib/schema";

async function seedTestCycle(markComplete = false) {
  console.log("[seed] Creating iteration_cycles row...");

  const [cycle] = await db
    .insert(iterationCycles)
    .values({
      cycleNumber: 1,
      openIssueCount: 12,
    })
    .returning();

  console.log(`[seed] Created cycle ${cycle.id}`);

  // Create tickets across different stages and statuses
  const baseTime = cycle.startedAt.getTime();

  const ticketData = [
    { jiraKey: "ELMS-101", category: "wcag_keyboard", status: "done" as const, offset: 1000 },
    { jiraKey: "ELMS-102", category: "wcag_aria", status: "done" as const, offset: 1200 },
    { jiraKey: "ELMS-103", category: "wcag_color_contrast", status: "done" as const, offset: 1400 },
    { jiraKey: "ELMS-104", category: "wcag_keyboard", status: "in_review" as const, offset: 2000 },
    { jiraKey: "ELMS-105", category: "wcag_forms", status: "in_review" as const, offset: 2200 },
    { jiraKey: "ELMS-106", category: "wcag_aria", status: "parked" as const, offset: 2400 },
    { jiraKey: "ELMS-107", category: "wcag_headings", status: "parked" as const, offset: 2600 },
    { jiraKey: "ELMS-108", category: "wcag_color_contrast", status: "flagged" as const, offset: 2800 },
    { jiraKey: "ELMS-109", category: "wcag_keyboard", status: "open" as const, offset: 3000 },
    { jiraKey: "ELMS-110", category: "wcag_aria", status: "open" as const, offset: 3200 },
  ];

  console.log("[seed] Creating tickets...");
  const createdTickets = [];
  for (const t of ticketData) {
    const [ticket] = await db
      .insert(tickets)
      .values({
        jiraKey: t.jiraKey,
        category: t.category,
        status: t.status,
        summary: `Test ${t.category} issue`,
        description: `Automated test ticket for ${t.jiraKey}`,
        createdAt: new Date(baseTime + t.offset),
      })
      .returning();
    createdTickets.push(ticket);
    console.log(`  - ${ticket.jiraKey} (${ticket.status})`);
  }

  // Create fix attempts for the first 8 tickets (done, in_review, parked, flagged)
  console.log("[seed] Creating fix_attempts...");
  const attemptPromises = createdTickets.slice(0, 8).map(async (ticket, idx) => {
    const [attempt] = await db
      .insert(fixAttempts)
      .values({
        ticketId: ticket.id,
        branch: `fix/${ticket.jiraKey.toLowerCase()}`,
        commitSha: `abc${idx.toString().padStart(4, "0")}def`,
        developerAgentRunId: `run-${idx.toString().padStart(3, "0")}`,
        attemptNumber: 1,
        pushStatus: "pushed",
        createdAt: new Date(baseTime + 5000 + idx * 500),
      })
      .returning();
    console.log(`  - Attempt for ${ticket.jiraKey}`);
    return attempt;
  });
  const createdAttempts = await Promise.all(attemptPromises);

  // Create review results for the first 6 attempts
  console.log("[seed] Creating review_results...");
  const reviewPromises = createdAttempts.slice(0, 6).map(async (attempt, idx) => {
    const verdict = idx < 3 ? "approved" : "rejected";
    const [review] = await db
      .insert(reviewResults)
      .values({
        fixAttemptId: attempt.id,
        verdict: verdict as "approved" | "rejected",
        reviewerComments: verdict === "approved"
          ? "LGTM — fixes the accessibility issue correctly"
          : "Needs changes — missing ARIA labels",
        createdAt: new Date(baseTime + 10000 + idx * 600),
      })
      .returning();
    console.log(`  - Review ${verdict} for attempt ${attempt.id}`);
    return review;
  });
  await Promise.all(reviewPromises);

  // Create deployments for the approved fixes (first 3)
  console.log("[seed] Creating deployments...");
  const deployPromises = createdAttempts.slice(0, 3).map(async (attempt, idx) => {
    const [deployment] = await db
      .insert(deployments)
      .values({
        env: "qa",
        commitSha: attempt.commitSha || `deploy-${idx}`,
        tag: `v1.0.${idx}`,
        status: "success",
        deployedAt: new Date(baseTime + 15000 + idx * 700),
      })
      .returning();
    console.log(`  - Deployment to ${deployment.env} (${deployment.commitSha})`);
    return deployment;
  });
  await Promise.all(deployPromises);

  if (markComplete) {
    console.log("[seed] Marking cycle as complete...");
    const { eq } = await import("drizzle-orm");
    await db
      .update(iterationCycles)
      .set({ endedAt: new Date(baseTime + 20000) })
      .where(eq(iterationCycles.id, cycle.id));
    console.log("[seed] Cycle marked complete");
  }

  console.log("\n[seed] ✓ Test cycle seeded successfully");
  console.log(`[seed] Cycle ID: ${cycle.id}`);
  console.log(`[seed] Summary:`);
  console.log(`  - Tickets: ${createdTickets.length} (3 done, 2 in_review, 2 parked, 1 flagged, 2 open)`);
  console.log(`  - Fix attempts: ${createdAttempts.length}`);
  console.log(`  - Reviews: 6 (3 approved, 3 rejected)`);
  console.log(`  - Deployments: 3`);
  console.log(`  - Status: ${markComplete ? "completed" : "running (incomplete)"}`);
  console.log(`\nTest in browser: http://localhost:3000`);

  process.exit(0);
}

const args = process.argv.slice(2);
const markComplete = args.includes("--complete");

seedTestCycle(markComplete).catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
