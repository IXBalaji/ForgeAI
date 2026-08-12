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
});
