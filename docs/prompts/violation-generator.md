You are working on an authorized accessibility-testing project. Your task is to intentionally introduce a specified number of accessibility violations into the target repository so the existing Playwright and axe tests can detect them.

REQUIRED QUESTION

Before changing any files, ask:

"How many accessibility violations should I generate in the target repository?"

Do not proceed until the user provides a positive integer. Treat this number as the exact total number of distinct intentional violations to introduce.

REFERENCE FILES

Read these before making changes:

- ./.env.example — identify the target repository and relevant configuration.
- ./docs/** — review generated test cases, axe rules, expected violations, selectors, and acceptance criteria.
- ./playwright/tests/** — inspect the existing Playwright accessibility tests.
- If that directory is unavailable, also check ./playwrite/tests/**.

MANDATORY CONSIDERATIONS

- All existing test cases in the target repository must continue to pass.
- Do not install, add, remove, or upgrade any package or dependency.
- Do not run npm install, npm update, yarn add, pnpm add, bun install, or equivalent commands.
- Do not modify package.json, lockfiles, dependency manifests, or package-manager configuration.
- Use only the packages, tools, scripts, and dependencies already available in the project.
- Do not disable, skip, delete, weaken, or rewrite existing tests.
- Do not change test expectations merely to make the changes pass.
- Do not disable axe rules or exclude affected elements from accessibility scans.
- If the requested violations cannot be introduced without failing an existing test, stop and explain the conflict instead of changing or bypassing the test.
- Do not push any changes unless the complete existing test suite passes.

WORKFLOW

1. Ask the user for the required violation count.
2. Identify and obtain the target repository using .env.example.
3. Confirm that the target repository has a qa branch and that push access is available.
4. Fetch the latest remote changes and check out the qa branch.
5. Pull the latest qa branch before making changes. Do not overwrite or discard existing work.
6. Inspect the target repository's existing scripts and available dependencies without installing anything.
7. Run the current test suite before making changes to establish a passing baseline.
8. If the baseline tests fail, stop and report the failures. Do not make or push changes.
9. Extract all eligible axe rules and test cases from docs/ and the Playwright tests.
10. Prepare a proposed plan containing exactly the requested number of violations.

For each planned violation, specify:

- Violation number
- Axe rule ID
- Target page or component
- Relevant selector
- Test file and test case covering it
- Planned source-code change
- Why the change will not break existing functional, unit, integration, or end-to-end tests

11. If fewer eligible violations exist than requested, stop and report:

- Requested count
- Maximum safely supported count
- Missing test or rule coverage
- Tests that prevent additional violations

Do not invent unsupported violations unless the user explicitly authorizes creating additional tests.

12. Ask the user to confirm the plan before editing the target repository.
13. After confirmation, introduce exactly the approved number of distinct violations.
14. Keep the violations deterministic and limited to the tested pages or components.
15. Preserve all unrelated application behavior, navigation, security, visual design, build stability, and existing test expectations.
16. Add the following comment beside every intentional violation, using the syntax appropriate for the source file:

INTENTIONAL A11Y VIOLATION: Authorized accessibility testing fixture.
Violation: <number>/<total>
Rule: <axe-rule-id>
Test: <test-file/test-name>

17. Run the relevant existing Playwright and axe tests using only the project's currently available commands and dependencies.
18. Run the complete existing test suite after making the changes.
19. Verify all of the following:

- Every existing test case passes.
- Exactly the requested intentional accessibility violations are detected.
- No additional unintended accessibility violations are introduced.
- No dependency or package files are changed.
- No tests or test expectations are modified.
- The build succeeds using the existing project setup.

20. If any existing test fails, fix only the implementation changes responsible for the failure and rerun the complete suite.
21. If the failures cannot be resolved while retaining the requested violations, revert the changes and report the conflict. Do not bypass or suppress the failures.
22. Review the final diff and ensure it contains only the approved intentional accessibility changes.
23. Confirm that package.json, lockfiles, dependency manifests, test files, and test configurations are unchanged.
24. Commit the changes to the qa branch using this commit-message format:

test(a11y): add <count> intentional accessibility violations

25. Push the commit to the remote qa branch of the target repository:

git push origin qa

26. Never force-push. If the push is rejected because the remote branch changed, fetch and safely integrate the latest qa changes, rerun the complete test suite, and push again.
27. Stop and report the issue if there are merge conflicts, failed tests, missing dependencies, missing credentials, insufficient permissions, or uncertainty about the correct target repository.
28. Do not install missing dependencies to resolve an issue.
29. Do not bypass branch protection.
30. Do not push to main, master, production, or any branch other than qa.
31. Do not deploy the application or create a pull request unless explicitly requested.

FINAL REPORT

Provide:

- Requested violation count
- Actual detected violation count
- Target repository used
- Branch pushed: qa
- Baseline test result
- Final complete test-suite result
- Playwright and axe test results
- Build result
- Files changed
- Confirmation that no packages were installed
- Confirmation that no dependency files changed
- Confirmation that no tests were disabled, skipped, weakened, or modified
- Each intentional violation and its axe rule ID
- Violation-to-test mapping
- Commands executed
- Commit hash and commit message
- Push result
- Any mismatch between requested and generated counts
- Any limitations or unsupported rules
- Clear instructions for reverting the commit and every intentional violation

Treat all changes as authorized testing fixtures. They are intentionally inaccessible examples for validating accessibility tooling and must not be presented as production accessibility recommendations.