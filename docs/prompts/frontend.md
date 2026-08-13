Analyze the entire existing codebase before making changes. Infer the product’s purpose, technology stack, routes, APIs, design language, and real agent workflow from the source code, README, configuration, and current UI. Do not invent unsupported features or replace the existing architecture.

Build a production-ready introductory landing page that serves as the entry point to the application.

Core interaction:
- Add a prominent “Start Workflow” button in the hero section.
- Clicking it must start the project’s real workflow using the existing API, action, route, or service found in the codebase.
- If required inputs are missing, collect them through a polished form before starting.
- Prevent accidental duplicate submissions.
- Show clear loading, running, success, failure, cancellation, and retry states.
- If the workflow runs asynchronously, use the project’s existing polling, streaming, WebSocket, or event mechanism to display live updates.
- On completion, show the result or navigate to the existing results/workspace page.
- If backend integration is unavailable, isolate a clearly labeled demo adapter while keeping the UI ready for the real API. Do not present simulated activity as real execution.

Live agentic-flow visualization:
- Display the actual stages inferred from the codebase, such as request intake, planning, agent execution, tool calls, validation, and result.
- Highlight the current stage and show completed, pending, failed, and retried steps.
- Include timestamps, progress, safe activity logs, and useful status messages.
- Never expose chain-of-thought, private reasoning, credentials, internal prompts, or sensitive backend data.

Page requirements:
- Explain the product clearly using copy derived from the repository.
- Match the existing design system and reuse current components, assets, and dependencies.
- Connect all CTAs and navigation to valid routes.
- Make the page responsive, accessible, SEO-friendly, performant, and keyboard-friendly.
- Support reduced motion and provide clear focus states.
- Handle API errors, timeouts, malformed responses, and page refreshes gracefully.
- Avoid placeholder text, fake metrics, broken links, and unnecessary dependencies.

Implementation process:
1. Inspect the repository and identify the workflow entry point and status mechanism.
2. Briefly summarize the inferred product, workflow, integration plan, and files to modify.
3. Implement the complete landing page and working “Start Workflow” interaction.
4. Run formatting, linting, type-checking, tests, and a production build.
5. Report changed files, API/routes connected, important decisions, and verification results.

Do not stop at a static mockup. Deliver functional, production-ready code without breaking existing behavior.