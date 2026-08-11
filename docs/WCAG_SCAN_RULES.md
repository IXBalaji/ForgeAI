# WCAG 2.2 Scan Rules — ForgeAI

All 55 WCAG 2.2 Level A + AA success criteria mapped to axe-core rules in `src/scan/wcag-rules.ts`. Each criterion can be individually attached or detached via config.

Source: `docs/WCAG_2.2_Level_A_AA_Accessibility_Guide.docx`

---

## Currently Injected Rules

### 1. Perceivable

| WCAG | Level | Criterion | Owner | axe-core Rules |
|------|-------|-----------|-------|----------------|
| 1.1.1 | A | Non-text Content | Shared | `image-alt`, `input-image-alt`, `area-alt`, `object-alt`, `svg-img-alt`, `role-img-alt` |
| 1.2.1 | A | Audio-only and Video-only (Prerecorded) | Shared | `audio-caption`, `video-caption` |
| 1.2.2 | A | Captions (Prerecorded) | Shared | `video-caption` |
| 1.2.3 | A | Audio Description or Media Alternative | Shared | `video-description` |
| 1.2.4 | AA | Captions (Live) | Shared | Manual only |
| 1.2.5 | AA | Audio Description (Prerecorded) | Shared | `video-description` |
| 1.3.1 | A | Info and Relationships | Shared | `aria-required-parent`, `aria-required-children`, `definition-list`, `dlitem`, `list`, `listitem`, `th-has-data-cells`, `td-headers-attr`, `td-has-header`, `table-fake-caption`, `p-as-heading`, `landmark-one-main`, `landmark-no-duplicate-main`, `landmark-no-duplicate-banner`, `landmark-no-duplicate-contentinfo`, `form-field-multiple-labels` |
| 1.3.2 | A | Meaningful Sequence | Shared | Manual only |
| 1.3.3 | A | Sensory Characteristics | UX/UI | Manual only |
| 1.3.4 | AA | Orientation | Shared | `css-orientation-lock` |
| 1.3.5 | AA | Identify Input Purpose | Shared | `autocomplete-valid` |
| 1.4.1 | A | Use of Color | UX/UI | `link-in-text-block` |
| 1.4.2 | A | Audio Control | Shared | `no-autoplay-audio` |
| 1.4.3 | AA | Contrast (Minimum) | UX/UI | `color-contrast` |
| 1.4.4 | AA | Resize Text | Shared | `meta-viewport` |
| 1.4.5 | AA | Images of Text | UX/UI | Manual only |
| 1.4.10 | AA | Reflow | Shared | Manual only |
| 1.4.11 | AA | Non-text Contrast | UX/UI | Manual only |
| 1.4.12 | AA | Text Spacing | Shared | Manual only |
| 1.4.13 | AA | Content on Hover or Focus | Shared | Manual only |

### 2. Operable

| WCAG | Level | Criterion | Owner | axe-core Rules |
|------|-------|-----------|-------|----------------|
| 2.1.1 | A | Keyboard | Frontend | `scrollable-region-focusable`, `server-side-image-map` |
| 2.1.2 | A | No Keyboard Trap | Frontend | Manual only |
| 2.1.4 | A | Character Key Shortcuts | Frontend | Manual only |
| 2.2.1 | A | Timing Adjustable | Shared | `meta-refresh` |
| 2.2.2 | A | Pause, Stop, Hide | Shared | `blink`, `marquee` |
| 2.3.1 | A | Three Flashes or Below Threshold | UX/UI | Manual only |
| 2.4.1 | A | Bypass Blocks | Frontend | `bypass`, `region` |
| 2.4.2 | A | Page Titled | Shared | `document-title` |
| 2.4.3 | A | Focus Order | Shared | `tabindex` |
| 2.4.4 | A | Link Purpose (In Context) | UX/UI | `link-name` |
| 2.4.5 | AA | Multiple Ways | UX/UI | Manual only |
| 2.4.6 | AA | Headings and Labels | Shared | `empty-heading`, `empty-table-header` |
| 2.4.7 | AA | Focus Visible | Shared | Manual only |
| 2.4.11 | AA | Focus Not Obscured (Minimum) | Shared | Manual only |
| 2.5.1 | A | Pointer Gestures | Shared | Manual only |
| 2.5.2 | A | Pointer Cancellation | Frontend | Manual only |
| 2.5.3 | A | Label in Name | Shared | `label-content-name-mismatch` |
| 2.5.4 | A | Motion Actuation | Shared | Manual only |
| 2.5.7 | AA | Dragging Movements | Shared | Manual only |
| 2.5.8 | AA | Target Size (Minimum) | UX/UI | `target-size` |

### 3. Understandable

| WCAG | Level | Criterion | Owner | axe-core Rules |
|------|-------|-----------|-------|----------------|
| 3.1.1 | A | Language of Page | Frontend | `html-has-lang`, `html-lang-valid` |
| 3.1.2 | AA | Language of Parts | Shared | `valid-lang` |
| 3.2.1 | A | On Focus | Shared | Manual only |
| 3.2.2 | A | On Input | Shared | Manual only |
| 3.2.3 | AA | Consistent Navigation | UX/UI | Manual only |
| 3.2.4 | AA | Consistent Identification | Shared | Manual only |
| 3.2.6 | A | Consistent Help | UX/UI | Manual only |
| 3.3.1 | A | Error Identification | Shared | `aria-input-field-name` |
| 3.3.2 | A | Labels or Instructions | Shared | `label`, `input-button-name`, `select-name` |
| 3.3.3 | AA | Error Suggestion | Shared | Manual only |
| 3.3.4 | AA | Error Prevention (Legal, Financial, Data) | Shared | Manual only |
| 3.3.7 | A | Redundant Entry | Shared | Manual only |
| 3.3.8 | AA | Accessible Authentication (Minimum) | Shared | Manual only |

### 4. Robust

| WCAG | Level | Criterion | Owner | axe-core Rules |
|------|-------|-----------|-------|----------------|
| 4.1.2 | A | Name, Role, Value | Frontend | `aria-allowed-attr`, `aria-allowed-role`, `aria-command-name`, `aria-dialog-name`, `aria-hidden-body`, `aria-hidden-focus`, `aria-meter-name`, `aria-progressbar-name`, `aria-roles`, `aria-text`, `aria-toggle-field-name`, `aria-tooltip-name`, `aria-treeitem-name`, `button-name`, `frame-title`, `frame-title-unique`, `aria-valid-attr`, `aria-valid-attr-value` |
| 4.1.3 | AA | Status Messages | Frontend | `aria-allowed-attr` |

---

## Summary

- **55** total WCAG 2.2 A + AA criteria
- **34** criteria have automated axe-core rules (62%)
- **21** criteria require manual testing only
- **~70** unique axe-core rule IDs mapped

---

## Configuration

Rules are attached by default. Detach via any of these methods (highest priority first):

### 1. Programmatic API

```ts
import { attachCriterion, detachCriterion, detachAll, attachByLevel } from "./scan/scan-config.js";

detachCriterion("1.4.3");   // disable color-contrast checks
attachCriterion("1.4.3");   // re-enable
detachAll();                 // disable everything
attachByLevel("A");          // enable only Level A
```

### 2. Environment Variables

```bash
# Detach specific WCAG criteria
AXE_DISABLE_CRITERIA=1.4.3,2.5.8

# Re-attach specific criteria (overrides disable)
AXE_ENABLE_CRITERIA=1.4.3

# Detach individual axe rules
AXE_DISABLE_RULES=color-contrast,target-size

# Attach additional axe rules
AXE_ENABLE_RULES=color-contrast-enhanced

# Override axe tag set
AXE_TAGS=wcag2a,wcag2aa
```

### 3. Config File (`scan-config.json`)

Place in project root or `TARGET_REPO_PATH`:

```json
{
  "axeTags": ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
  "disableCriteria": ["1.4.3", "2.5.8"],
  "enableCriteria": [],
  "disableRules": ["color-contrast"],
  "enableRules": ["color-contrast-enhanced"]
}
```

### 4. CLI

```bash
# List all rules and their attach/detach status
npx a11y-agents scan:rules

# Filter by level
npx a11y-agents scan:rules --level A

# Filter by owner
npx a11y-agents scan:rules --owner Frontend

# Show only detached rules
npx a11y-agents scan:rules --detached
```

---

## Files

| File | Purpose |
|------|---------|
| `src/scan/wcag-rules.ts` | WCAG 2.2 registry — all 55 criteria with axe-core mappings |
| `src/scan/scan-config.ts` | Config loader + attach/detach API |
| `src/scan/axe-scan.ts` | Scanner that applies the resolved config |
| `scan-config.json` | Optional project-level config file |
