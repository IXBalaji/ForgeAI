import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../.env") });

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new pg.Pool({
      connectionString,
      max: 10,
    })
  : null;

export const db = (pool ? drizzle(pool) : null) as ReturnType<typeof drizzle> | null;

export function requireDb() {
  if (!db) {
    throw new Error("DATABASE_URL is required in the root .env file");
  }
  return db;
}
