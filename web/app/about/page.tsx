import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About — ForgeAI",
  description:
    "Learn how ForgeAI autonomously detects and fixes WCAG accessibility violations using AI agents.",
};

const PIPELINE_STAGES = [
  {
    icon: "01",
    title: "Scan",
    description:
      "Playwright-powered accessibility audits run against your live application, detecting WCAG 2.1 AA violations including missing alt text, color contrast failures, ARIA issues, and keyboard navigation gaps.",
  },
  {
    icon: "02",
    title: "Triage",
    description:
      "Detected violations are automatically categorized by severity and impact, then created as actionable tickets with reproduction steps and remediation guidance.",
  },
  {
    icon: "03",
    title: "Fix",
    description:
      "AI developer agents analyze each ticket, locate the offending source code, and generate targeted fixes — from adding alt attributes to restructuring markup for screen reader compatibility.",
  },
  {
    icon: "04",
    title: "Review",
    description:
      "An independent AI reviewer evaluates every fix for correctness, WCAG compliance, code quality, and potential regressions before any code is merged.",
  },
  {
    icon: "05",
    title: "Deploy",
    description:
      "Approved fixes are automatically committed, pushed, and merged into your QA branch — ready for integration testing and stakeholder review.",
  },
  {
    icon: "06",
    title: "Release",
    description:
      "The pipeline closes the loop: completed tickets are resolved, reports are generated, and the cycle is ready to repeat for continuous compliance.",
  },
];

const CAPABILITIES = [
  {
    title: "WCAG 2.1 AA Coverage",
    description:
      "Detects missing alternative text, insufficient color contrast, improper ARIA usage, missing form labels, keyboard traps, and more.",
  },
  {
    title: "AI-Powered Code Fixes",
    description:
      "Developer agents understand your codebase structure and generate context-aware fixes — not generic templates.",
  },
  {
    title: "Automated Code Review",
    description:
      "Every fix passes through an independent reviewer agent that checks correctness, compliance, and code quality.",
  },
  {
    title: "Continuous Remediation",
    description:
      "Run the pipeline on every sprint or deploy cycle. Accessibility debt is resolved before it ships to production.",
  },
  {
    title: "Full Audit Trail",
    description:
      "Every scan, ticket, fix attempt, review verdict, and deployment is tracked with timestamps for compliance reporting.",
  },
  {
    title: "Zero Configuration",
    description:
      "Point ForgeAI at your application URL and repository. The pipeline handles scanning, branching, fixing, and merging autonomously.",
  },
];

const USE_CASES = [
  {
    title: "Enterprise Compliance",
    description:
      "Meet ADA, Section 508, and EAA requirements across your web portfolio without slowing down your development team.",
  },
  {
    title: "Accessibility Debt Reduction",
    description:
      "Tackle hundreds of existing WCAG violations systematically — the pipeline works through the backlog while your team ships new features.",
  },
  {
    title: "CI/CD Integration",
    description:
      "Run accessibility remediation as part of your existing deployment workflow. Catch and fix issues before they reach production.",
  },
];

export default function AboutPage() {
  return (
    <main className="container about-page">
      {/* Hero */}
      <section className="about-hero">
        <h1>
          Autonomous Accessibility
          <br />
          <span className="about-hero__accent">Remediation at Scale</span>
        </h1>
        <p className="about-hero__lead">
          ForgeAI is an end-to-end pipeline that detects WCAG violations,
          generates AI-powered fixes, reviews code quality, and deploys —
          without manual intervention.
        </p>
        <div className="about-hero__cta">
          <Link href="/" className="button-primary button-large">
            Launch Dashboard
          </Link>
        </div>
      </section>

      {/* Problem / Solution */}
      <section className="about-section">
        <div className="about-section__header">
          <h2>The Problem</h2>
          <p>
            Web accessibility violations affect over 1 billion people worldwide.
            Manual remediation is slow, expensive, and hard to maintain across
            fast-moving codebases. Most teams fall behind on compliance — not
            because they do not care, but because the volume of work overwhelms
            available developer time.
          </p>
        </div>
        <div className="about-section__header" style={{ marginTop: "2rem" }}>
          <h2>The Solution</h2>
          <p>
            ForgeAI replaces manual triage-fix-review cycles with an autonomous
            pipeline. AI agents scan your application, create tickets for every
            violation, write targeted code fixes, review each other&apos;s work, and
            deploy approved changes — all in a single automated run.
          </p>
        </div>
      </section>

      {/* Pipeline */}
      <section className="about-section">
        <div className="about-section__header">
          <h2>How It Works</h2>
          <p>
            Six stages, fully automated. Each stage feeds into the next,
            creating a closed-loop remediation cycle.
          </p>
        </div>
        <div className="pipeline-grid">
          {PIPELINE_STAGES.map((stage) => (
            <div key={stage.title} className="pipeline-card">
              <div className="pipeline-card__number">{stage.icon}</div>
              <h3 className="pipeline-card__title">{stage.title}</h3>
              <p className="pipeline-card__desc">{stage.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Capabilities */}
      <section className="about-section">
        <div className="about-section__header">
          <h2>Key Capabilities</h2>
        </div>
        <div className="capabilities-grid">
          {CAPABILITIES.map((cap) => (
            <div key={cap.title} className="capability-card">
              <h3>{cap.title}</h3>
              <p>{cap.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Use Cases */}
      <section className="about-section">
        <div className="about-section__header">
          <h2>Use Cases</h2>
        </div>
        <div className="use-cases-grid">
          {USE_CASES.map((uc) => (
            <div key={uc.title} className="use-case-card">
              <h3>{uc.title}</h3>
              <p>{uc.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="about-cta">
        <h2>Ready to automate accessibility?</h2>
        <p>
          Start your first remediation pipeline and see ForgeAI in action.
        </p>
        <Link href="/" className="button-primary button-large">
          Go to Dashboard
        </Link>
      </section>
    </main>
  );
}
