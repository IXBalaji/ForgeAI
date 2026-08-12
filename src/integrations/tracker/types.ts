export interface TrackerProvider {
  readonly name: string;
  isConfigured(): boolean;

  /** Returns (creating once, reusing thereafter) the parent epic/grouping issue for a remediation cycle. */
  ensureEpic(cycleId: string): Promise<string | null>;

  /** description is plain Markdown — the adapter serializes to its own native rich-text format on write. */
  createTicket(params: {
    epicKey: string | null;
    summary: string;
    description: string;
    labels: string[];
    priority?: "P1" | "P2" | "P3" | "P4";
  }): Promise<string | null>;

  updateTicket(params: {
    key: string;
    summary?: string;
    description?: string;
    labels?: string[];
    priority?: "P1" | "P2" | "P3" | "P4";
  }): Promise<void>;

  /** Dedup check on triage re-runs — finds an existing open ticket matching a summary prefix + labels. */
  findExisting(params: { summaryPrefix: string; labels: string[] }): Promise<string | null>;

  /** Moves a ticket to a named workflow status ("In Progress", "Done", "To Do") — matched case-insensitively. */
  transitionTicket(key: string, statusName: string): Promise<void>;

  /** body is plain Markdown. */
  comment(key: string, body: string): Promise<void>;

  /** Neutral query — no JQL (or any provider query language) leaks past this interface. */
  search(query: { labels?: string[]; excludeStatus?: string[] }, maxResults?: number): Promise<TrackerIssue[]>;
}

export interface TrackerIssue {
  key: string;
  summary: string;
  descriptionMarkdown: string;
  priority?: string;
  parentKey?: string | null;
}
