import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("dotenv/config", () => ({}));
vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("../../db/schema.js", () => ({ iterationCycles: {} }));

const ORIGINAL_ENV = { ...process.env };

describe("JiraAdapter.transitionTicket", () => {
  beforeEach(() => {
    // config.ts (imported transitively by jira.ts) requires PROJECT_KEY at
    // module load — mocking dotenv/config above means the real .env never
    // gets read for this test file, so it must be set explicitly here.
    process.env.PROJECT_KEY = "TEST";
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    process.env.JIRA_EMAIL = "bot@acme.com";
    process.env.JIRA_API_TOKEN = "tok";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("matches a transition name case-insensitively and posts its id", async () => {
    const { JiraAdapter } = await import("./jira.js");
    const adapter = new JiraAdapter();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          transitions: [
            { id: "31", name: "To Do" },
            { id: "21", name: "In Progress" },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => null } as Response);

    await adapter.transitionTicket("PROJ-1", "in progress");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const postCall = fetchMock.mock.calls[1];
    expect(postCall[0]).toBe("https://acme.atlassian.net/rest/api/3/issue/PROJ-1/transitions");
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({ transition: { id: "21" } });
  });

  it("warns and no-ops when no transition matches the name", async () => {
    const { JiraAdapter } = await import("./jira.js");
    const adapter = new JiraAdapter();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ transitions: [{ id: "31", name: "To Do" }] }),
    } as Response);

    await adapter.transitionTicket("PROJ-1", "Nonexistent Status");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No transition named "Nonexistent Status"'));
  });

  it("throws JiraAuthError (not a generic error) on a 401 response", async () => {
    const { JiraAdapter } = await import("./jira.js");
    const { JiraAuthError } = await import("./errors.js");
    const adapter = new JiraAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);

    await expect(adapter.transitionTicket("PROJ-1", "In Progress")).rejects.toThrow(JiraAuthError);
  });

  it("throws JiraApiError (not JiraAuthError) on a 429 rate-limit response", async () => {
    const { JiraAdapter } = await import("./jira.js");
    const { JiraApiError, JiraAuthError } = await import("./errors.js");
    const adapter = new JiraAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "Too Many Requests",
    } as Response);

    let caught: unknown;
    try {
      await adapter.transitionTicket("PROJ-1", "In Progress");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JiraApiError);
    expect(caught).not.toBeInstanceOf(JiraAuthError);
  });

  it("throws JiraApiError (not JiraAuthError) on a 403 that is actually a rate limit", async () => {
    const { JiraAdapter } = await import("./jira.js");
    const { JiraApiError, JiraAuthError } = await import("./errors.js");
    const adapter = new JiraAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "API rate limit exceeded for this account.",
    } as Response);

    let caught: unknown;
    try {
      await adapter.transitionTicket("PROJ-1", "In Progress");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JiraApiError);
    expect(caught).not.toBeInstanceOf(JiraAuthError);
  });

  it("throws JiraAuthError on a 403 that is not a rate limit (invalid/insufficient token)", async () => {
    const { JiraAdapter } = await import("./jira.js");
    const { JiraAuthError } = await import("./errors.js");
    const adapter = new JiraAdapter();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "You do not have permission to perform this action.",
    } as Response);

    await expect(adapter.transitionTicket("PROJ-1", "In Progress")).rejects.toThrow(JiraAuthError);
  });
});
