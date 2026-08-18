import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// DATABASE_URL comes from web/.env.local (local dev) or Vercel's
// dashboard-configured env vars in deployed environments — Next.js loads
// both automatically, no explicit dotenv config needed.
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
    throw new Error("DATABASE_URL is required (web/.env.local locally, or a Vercel env var when deployed)");
  }
  return db;
}
