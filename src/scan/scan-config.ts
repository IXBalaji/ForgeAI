import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WCAG_REGISTRY, type WcagCriterion, getEnabledAxeRules } from "./wcag-rules.js";

/**
 * Scan configuration — controls which WCAG criteria and axe-core rules are
 * active. Rules can be attached/detached via:
 *
 * 1. JSON config file (scan-config.json in project root or TARGET_REPO_PATH)
 * 2. Environment variables (AXE_ENABLE_RULES, AXE_DISABLE_RULES, AXE_ENABLE_CRITERIA, AXE_DISABLE_CRITERIA)
 * 3. Programmatic API (attach/detach methods)
 *
 * Priority: programmatic > env vars > config file > defaults (all enabled)
 */

export interface ScanRuleConfig {
  /** axe-core tags to include (e.g. "wcag2a", "wcag21aa", "best-practice") */
  axeTags: string[];
  /** Individual axe-core rules to enable beyond what tags provide */
  enableRules: string[];
  /** Individual axe-core rules to disable (overrides tags) */
  disableRules: string[];
  /** WCAG criterion IDs to enable (e.g. "1.1.1", "2.4.7") */
  enableCriteria: string[];
  /** WCAG criterion IDs to disable */
  disableCriteria: string[];
}

interface ScanConfigFile {
  axeTags?: string[];
  enableRules?: string[];
  disableRules?: string[];
  enableCriteria?: string[];
  disableCriteria?: string[];
}

const DEFAULT_AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

function loadConfigFile(): ScanConfigFile {
  const paths = [
    join(process.cwd(), "scan-config.json"),
    join(process.env.TARGET_REPO_PATH ?? "", "scan-config.json"),
  ];
  for (const p of paths) {
    if (p && existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        console.log(`[scan-config] Loaded config from ${p}`);
        return raw;
      } catch (err) {
        console.warn(`[scan-config] Failed to parse ${p}: ${(err as Error).message}`);
      }
    }
  }
  return {};
}

function parseEnvList(envVar: string | undefined): string[] {
  if (!envVar) return [];
  return envVar.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadScanConfig(): ScanRuleConfig {
  const file = loadConfigFile();

  return {
    axeTags: file.axeTags ?? parseEnvList(process.env.AXE_TAGS) ?? DEFAULT_AXE_TAGS,
    enableRules: [
      ...parseEnvList(process.env.AXE_ENABLE_RULES),
      ...(file.enableRules ?? []),
    ],
    disableRules: [
      ...parseEnvList(process.env.AXE_DISABLE_RULES),
      ...(file.disableRules ?? []),
    ],
    enableCriteria: [
      ...parseEnvList(process.env.AXE_ENABLE_CRITERIA),
      ...(file.enableCriteria ?? []),
    ],
    disableCriteria: [
      ...parseEnvList(process.env.AXE_DISABLE_CRITERIA),
      ...(file.disableCriteria ?? []),
    ],
  };
}

/**
 * Applies attach/detach config to the WCAG registry and returns the final
 * set of axe-core rule IDs and disabled rule IDs for the scan.
 */
export function resolveAxeConfig(config?: ScanRuleConfig): {
  tags: string[];
  enabledRules: string[];
  disabledRules: string[];
  criteria: WcagCriterion[];
} {
  const cfg = config ?? loadScanConfig();

  // Apply criteria-level enable/disable to the registry
  for (const c of WCAG_REGISTRY) {
    if (cfg.disableCriteria.includes(c.id)) {
      c.enabled = false;
    }
    if (cfg.enableCriteria.includes(c.id)) {
      c.enabled = true;
    }
  }

  const registryRules = new Set(getEnabledAxeRules());

  // Add explicitly enabled rules
  for (const r of cfg.enableRules) registryRules.add(r);

  // Build disabled set from: registry-disabled criteria + explicit disableRules
  const disabledRules = new Set(cfg.disableRules);
  for (const c of WCAG_REGISTRY) {
    if (!c.enabled) {
      for (const r of c.axeRules) disabledRules.add(r);
    }
  }

  // Remove disabled from enabled
  for (const r of disabledRules) registryRules.delete(r);

  const enabledCriteria = WCAG_REGISTRY.filter((c) => c.enabled);
  const disabledCriteria = WCAG_REGISTRY.filter((c) => !c.enabled);

  if (disabledCriteria.length > 0) {
    console.log(`[scan-config] ${disabledCriteria.length} WCAG criteria detached: ${disabledCriteria.map((c) => c.id).join(", ")}`);
  }
  if (cfg.disableRules.length > 0) {
    console.log(`[scan-config] ${cfg.disableRules.length} axe rules detached: ${cfg.disableRules.join(", ")}`);
  }
  console.log(`[scan-config] ${registryRules.size} axe rules active from ${enabledCriteria.length}/${WCAG_REGISTRY.length} WCAG criteria`);

  return {
    tags: cfg.axeTags.length > 0 ? cfg.axeTags : DEFAULT_AXE_TAGS,
    enabledRules: [...registryRules],
    disabledRules: [...disabledRules],
    criteria: enabledCriteria,
  };
}

// ── Programmatic attach/detach API ────────────────────────────────────

export function attachCriterion(id: string): boolean {
  const c = WCAG_REGISTRY.find((r) => r.id === id);
  if (!c) return false;
  c.enabled = true;
  return true;
}

export function detachCriterion(id: string): boolean {
  const c = WCAG_REGISTRY.find((r) => r.id === id);
  if (!c) return false;
  c.enabled = false;
  return true;
}

export function attachAll(): void {
  for (const c of WCAG_REGISTRY) c.enabled = true;
}

export function detachAll(): void {
  for (const c of WCAG_REGISTRY) c.enabled = false;
}

export function attachByLevel(level: "A" | "AA"): void {
  for (const c of WCAG_REGISTRY) {
    if (level === "AA" || c.level === "A") {
      c.enabled = true;
    }
  }
}

export function attachByOwner(owner: "UX/UI" | "Frontend" | "Shared"): void {
  for (const c of WCAG_REGISTRY) {
    if (c.owner === owner || c.owner === "Shared") {
      c.enabled = true;
    }
  }
}
