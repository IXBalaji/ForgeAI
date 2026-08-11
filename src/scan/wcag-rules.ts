/**
 * WCAG 2.2 Level A + AA rule registry — maps each of the 55 success criteria
 * to the axe-core rules that test for it. Every rule is individually toggleable
 * via the scan config (env var, JSON file, or programmatic API).
 *
 * Source: docs/WCAG_2.2_Level_A_AA_Accessibility_Guide.docx
 */

export type WcagLevel = "A" | "AA";
export type RuleOwner = "UX/UI" | "Frontend" | "Shared";

export interface WcagCriterion {
  /** WCAG criterion number, e.g. "1.1.1" */
  id: string;
  level: WcagLevel;
  name: string;
  owner: RuleOwner;
  /** axe-core rule IDs that map to this criterion */
  axeRules: string[];
  /** Whether this criterion is enabled for scanning */
  enabled: boolean;
}

/**
 * Complete WCAG 2.2 Level A + AA registry. Each criterion lists the axe-core
 * rules that detect violations of it. Some criteria have no direct axe-core
 * mapping (manual-only checks) — they're included with empty axeRules arrays
 * so the registry is a complete reference and they can be flagged for manual QA.
 */
export const WCAG_REGISTRY: WcagCriterion[] = [
  // ── 1. Perceivable ──────────────────────────────────────────────────

  // 1.1 Text Alternatives
  {
    id: "1.1.1", level: "A", name: "Non-text Content", owner: "Shared",
    axeRules: ["image-alt", "input-image-alt", "area-alt", "object-alt", "svg-img-alt", "role-img-alt"],
    enabled: true,
  },

  // 1.2 Time-based Media
  {
    id: "1.2.1", level: "A", name: "Audio-only and Video-only (Prerecorded)", owner: "Shared",
    axeRules: ["audio-caption", "video-caption"],
    enabled: true,
  },
  {
    id: "1.2.2", level: "A", name: "Captions (Prerecorded)", owner: "Shared",
    axeRules: ["video-caption"],
    enabled: true,
  },
  {
    id: "1.2.3", level: "A", name: "Audio Description or Media Alternative (Prerecorded)", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "1.2.4", level: "AA", name: "Captions (Live)", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "1.2.5", level: "AA", name: "Audio Description (Prerecorded)", owner: "Shared",
    axeRules: [],
    enabled: true,
  },

  // 1.3 Adaptable
  {
    id: "1.3.1", level: "A", name: "Info and Relationships", owner: "Shared",
    axeRules: [
      "aria-required-parent", "aria-required-children", "definition-list", "dlitem",
      "list", "listitem", "th-has-data-cells", "td-headers-attr", "td-has-header",
      "table-fake-caption", "p-as-heading", "landmark-one-main", "landmark-no-duplicate-main",
      "landmark-no-duplicate-banner", "landmark-no-duplicate-contentinfo", "form-field-multiple-labels",
    ],
    enabled: true,
  },
  {
    id: "1.3.2", level: "A", name: "Meaningful Sequence", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "1.3.3", level: "A", name: "Sensory Characteristics", owner: "UX/UI",
    axeRules: [],
    enabled: true,
  },
  {
    id: "1.3.4", level: "AA", name: "Orientation", owner: "Shared",
    axeRules: ["css-orientation-lock"],
    enabled: true,
  },
  {
    id: "1.3.5", level: "AA", name: "Identify Input Purpose", owner: "Shared",
    axeRules: ["autocomplete-valid"],
    enabled: true,
  },

  // 1.4 Distinguishable
  {
    id: "1.4.1", level: "A", name: "Use of Color", owner: "UX/UI",
    axeRules: ["link-in-text-block"],
    enabled: true,
  },
  {
    id: "1.4.2", level: "A", name: "Audio Control", owner: "Shared",
    axeRules: ["no-autoplay-audio"],
    enabled: true,
  },
  {
    id: "1.4.3", level: "AA", name: "Contrast (Minimum)", owner: "UX/UI",
    axeRules: ["color-contrast"],
    enabled: true,
  },
  {
    id: "1.4.4", level: "AA", name: "Resize Text", owner: "Shared",
    axeRules: ["meta-viewport"],
    enabled: true,
  },
  {
    id: "1.4.5", level: "AA", name: "Images of Text", owner: "UX/UI",
    axeRules: [],
    enabled: true,
  },
  {
    id: "1.4.10", level: "AA", name: "Reflow", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "1.4.11", level: "AA", name: "Non-text Contrast", owner: "UX/UI",
    axeRules: [],
    enabled: true,
  },
  {
    id: "1.4.12", level: "AA", name: "Text Spacing", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "1.4.13", level: "AA", name: "Content on Hover or Focus", owner: "Shared",
    axeRules: [],
    enabled: true,
  },

  // ── 2. Operable ─────────────────────────────────────────────────────

  // 2.1 Keyboard Accessible
  {
    id: "2.1.1", level: "A", name: "Keyboard", owner: "Frontend",
    axeRules: ["scrollable-region-focusable", "server-side-image-map"],
    enabled: true,
  },
  {
    id: "2.1.2", level: "A", name: "No Keyboard Trap", owner: "Frontend",
    axeRules: [],
    enabled: true,
  },
  {
    id: "2.1.4", level: "A", name: "Character Key Shortcuts", owner: "Frontend",
    axeRules: [],
    enabled: true,
  },

  // 2.2 Enough Time
  {
    id: "2.2.1", level: "A", name: "Timing Adjustable", owner: "Shared",
    axeRules: ["meta-refresh"],
    enabled: true,
  },
  {
    id: "2.2.2", level: "A", name: "Pause, Stop, Hide", owner: "Shared",
    axeRules: ["blink", "marquee"],
    enabled: true,
  },

  // 2.3 Seizures and Physical Reactions
  {
    id: "2.3.1", level: "A", name: "Three Flashes or Below Threshold", owner: "UX/UI",
    axeRules: [],
    enabled: true,
  },

  // 2.4 Navigable
  {
    id: "2.4.1", level: "A", name: "Bypass Blocks", owner: "Frontend",
    axeRules: ["bypass", "region"],
    enabled: true,
  },
  {
    id: "2.4.2", level: "A", name: "Page Titled", owner: "Shared",
    axeRules: ["document-title"],
    enabled: true,
  },
  {
    id: "2.4.3", level: "A", name: "Focus Order", owner: "Shared",
    axeRules: ["tabindex"],
    enabled: true,
  },
  {
    id: "2.4.4", level: "A", name: "Link Purpose (In Context)", owner: "UX/UI",
    axeRules: ["link-name"],
    enabled: true,
  },
  {
    id: "2.4.5", level: "AA", name: "Multiple Ways", owner: "UX/UI",
    axeRules: [],
    enabled: true,
  },
  {
    id: "2.4.6", level: "AA", name: "Headings and Labels", owner: "Shared",
    axeRules: ["empty-heading", "empty-table-header"],
    enabled: true,
  },
  {
    id: "2.4.7", level: "AA", name: "Focus Visible", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "2.4.11", level: "AA", name: "Focus Not Obscured (Minimum)", owner: "Shared",
    axeRules: [],
    enabled: true,
  },

  // 2.5 Input Modalities
  {
    id: "2.5.1", level: "A", name: "Pointer Gestures", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "2.5.2", level: "A", name: "Pointer Cancellation", owner: "Frontend",
    axeRules: [],
    enabled: true,
  },
  {
    id: "2.5.3", level: "A", name: "Label in Name", owner: "Shared",
    axeRules: ["label-content-name-mismatch"],
    enabled: true,
  },
  {
    id: "2.5.4", level: "A", name: "Motion Actuation", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "2.5.7", level: "AA", name: "Dragging Movements", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "2.5.8", level: "AA", name: "Target Size (Minimum)", owner: "UX/UI",
    axeRules: ["target-size"],
    enabled: true,
  },

  // ── 3. Understandable ───────────────────────────────────────────────

  // 3.1 Readable
  {
    id: "3.1.1", level: "A", name: "Language of Page", owner: "Frontend",
    axeRules: ["html-has-lang", "html-lang-valid"],
    enabled: true,
  },
  {
    id: "3.1.2", level: "AA", name: "Language of Parts", owner: "Shared",
    axeRules: ["valid-lang"],
    enabled: true,
  },

  // 3.2 Predictable
  {
    id: "3.2.1", level: "A", name: "On Focus", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "3.2.2", level: "A", name: "On Input", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "3.2.3", level: "AA", name: "Consistent Navigation", owner: "UX/UI",
    axeRules: [],
    enabled: true,
  },
  {
    id: "3.2.4", level: "AA", name: "Consistent Identification", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "3.2.6", level: "A", name: "Consistent Help", owner: "UX/UI",
    axeRules: [],
    enabled: true,
  },

  // 3.3 Input Assistance
  {
    id: "3.3.1", level: "A", name: "Error Identification", owner: "Shared",
    axeRules: ["aria-input-field-name"],
    enabled: true,
  },
  {
    id: "3.3.2", level: "A", name: "Labels or Instructions", owner: "Shared",
    axeRules: ["label", "input-button-name", "select-name"],
    enabled: true,
  },
  {
    id: "3.3.3", level: "AA", name: "Error Suggestion", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "3.3.4", level: "AA", name: "Error Prevention (Legal, Financial, Data)", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "3.3.7", level: "A", name: "Redundant Entry", owner: "Shared",
    axeRules: [],
    enabled: true,
  },
  {
    id: "3.3.8", level: "AA", name: "Accessible Authentication (Minimum)", owner: "Shared",
    axeRules: [],
    enabled: true,
  },

  // ── 4. Robust ───────────────────────────────────────────────────────

  {
    id: "4.1.2", level: "A", name: "Name, Role, Value", owner: "Frontend",
    axeRules: [
      "aria-allowed-attr", "aria-allowed-role", "aria-command-name", "aria-dialog-name",
      "aria-hidden-body", "aria-hidden-focus", "aria-meter-name", "aria-progressbar-name",
      "aria-roles", "aria-text", "aria-toggle-field-name", "aria-tooltip-name",
      "aria-treeitem-name", "button-name", "frame-title", "frame-title-unique",
      "aria-valid-attr", "aria-valid-attr-value",
    ],
    enabled: true,
  },
  {
    id: "4.1.3", level: "AA", name: "Status Messages", owner: "Frontend",
    axeRules: ["aria-allowed-attr"],
    enabled: true,
  },
];

// ── Lookup helpers ──────────────────────────────────────────────────────

const _byId = new Map(WCAG_REGISTRY.map((c) => [c.id, c]));

export function getCriterion(id: string): WcagCriterion | undefined {
  return _byId.get(id);
}

export function getCriteriaByLevel(level: WcagLevel): WcagCriterion[] {
  if (level === "AA") return WCAG_REGISTRY;
  return WCAG_REGISTRY.filter((c) => c.level === "A");
}

export function getEnabledAxeRules(): string[] {
  const rules = new Set<string>();
  for (const c of WCAG_REGISTRY) {
    if (c.enabled) {
      for (const r of c.axeRules) rules.add(r);
    }
  }
  return [...rules];
}

export function getManualOnlyCriteria(): WcagCriterion[] {
  return WCAG_REGISTRY.filter((c) => c.enabled && c.axeRules.length === 0);
}
