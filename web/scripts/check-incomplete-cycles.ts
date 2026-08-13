import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../.env.local") });

import { db } from "../lib/db";
import { iterationCycles } from "../lib/schema";
import { isNull } from "drizzle-orm";

async function checkIncompleteCycles() {
  const incomplete = await db
    .select()
    .from(iterationCycles)
    .where(isNull(iterationCycles.endedAt))
    .limit(5);

  console.log(`Found ${incomplete.length} incomplete cycle(s):`);
  incomplete.forEach((cycle) => {
    console.log(`  - ${cycle.id} (started: ${cycle.startedAt.toISOString()})`);
  });

  process.exit(0);
}

checkIncompleteCycles().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
