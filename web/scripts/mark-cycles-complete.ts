import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../.env") });

import { db } from "../lib/db";
import { iterationCycles } from "../lib/schema";
import { isNull } from "drizzle-orm";

async function markCyclesComplete() {
  const result = await db
    .update(iterationCycles)
    .set({ endedAt: new Date() })
    .where(isNull(iterationCycles.endedAt))
    .returning();

  console.log(`Marked ${result.length} incomplete cycle(s) as complete:`);
  result.forEach((cycle) => {
    console.log(`  - ${cycle.id} (started: ${cycle.startedAt.toISOString()})`);
  });

  process.exit(0);
}

markCyclesComplete().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
