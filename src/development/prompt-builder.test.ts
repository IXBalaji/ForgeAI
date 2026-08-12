import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
  };
});

import { buildSystemPrompt } from "./prompt-builder.js";

describe("buildSystemPrompt", () => {
  it("includes worktree safety rules, build validation, and verification steps", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("CRITICAL: You are working inside a git worktree");
    expect(prompt).toContain("BUILD VALIDATION (MANDATORY");
    expect(prompt).toContain("VERIFICATION:");
    expect(prompt).toContain("Fix every instance listed in the findings");
  });

  it("contains no ticket-specific content, so it's byte-identical across every ticket/retry in a run", () => {
    // This is what makes it eligible for prompt caching — the SDK/API can
    // reuse the cached prefix instead of re-billing it on every call.
    expect(buildSystemPrompt()).toBe(buildSystemPrompt());
    const prompt = buildSystemPrompt();
    expect(prompt).not.toMatch(/ticket|jiraKey|wcagRule/i);
  });
});
