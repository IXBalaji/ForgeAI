import type { NextConfig } from "next";
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(process.cwd(), "../.env") });

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
