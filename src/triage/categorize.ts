/** Scan-rule id (any source: axe, lighthouse, pa11y) -> human category. Unmapped rules fall back to a readable default. */
const CATEGORY_MAP: Record<string, string> = {
  "image-alt": "Missing alt text on images",
  "color-contrast": "Insufficient color contrast",
  label: "Form inputs missing labels",
  "link-name": "Links without accessible names",
  "button-name": "Buttons without accessible names",
  "aria-required-attr": "Missing required ARIA attributes",
  "aria-roles": "Invalid ARIA roles",
  "html-has-lang": "Missing document language",
  "landmark-one-main": "Missing main landmark",
  region: "Content outside landmarks",
  "focus-order-semantics": "Focus order issues",
};

export function categorize(wcagRule: string): string {
  return CATEGORY_MAP[wcagRule] ?? `Accessibility issue: ${wcagRule}`;
}
