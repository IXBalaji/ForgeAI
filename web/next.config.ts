import type { NextConfig } from "next";

// Env vars come from web/.env.local (local dev, via `vercel env pull`) or
// directly from Vercel's dashboard-configured env vars in deployed
// environments — never from the root ../.env, which isn't part of this
// deployment (only web/ is deployed).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    TARGET_FRONTEND_URL: process.env.TARGET_FRONTEND_URL ?? "",
    GITHUB_OWNER: process.env.GITHUB_OWNER ?? "",
    GITHUB_REPO: process.env.GITHUB_REPO ?? "",
    GITHUB_QA_BRANCH: process.env.GITHUB_QA_BRANCH ?? "qa",
    PROJECT_KEY: process.env.PROJECT_KEY ?? "",
  },
};

export default nextConfig;
