Update the application’s existing LangSmith integration to provide systematic
Anthropic usage tracing for every issue-resolution pipeline cycle.

CONTEXT
- LangSmith configuration is already available in .env.
- The pipeline contains these agents:
  1. scanner
  2. triage
  3. jira_sync
  4. developer
  5. reviewer
  6. deploy
  7. release
- The scanner agent currently makes no Anthropic or SDK calls. Exclude it from
  model-usage tracing for now.

TRACE STRUCTURE
Create one root trace for each pipeline execution:

Run name:
issue_resolution_pipeline

Child agent runs:
agent.triage
agent.jira_sync
agent.developer
agent.reviewer
agent.deploy
agent.release

Create a nested child run for every Anthropic request:

anthropic.<agent_name>.<operation_name>

Examples:
anthropic.triage.issue_classification
anthropic.developer.generate_fix
anthropic.reviewer.review_changes
anthropic.release.generate_release_notes

MODEL-CALL DATA
For every Anthropic call, record:

Inputs:
- Sanitized model input or messages
- Issue or task identifier
- Operation name

Outputs:
- Sanitized model response
- Completion status

Metadata:
- agent_name
- operation_name
- model_name
- provider: anthropic
- pipeline_run_id
- issue_id
- cycle_number

Usage metadata:
- input_tokens
- output_tokens
- total_tokens

Cost metadata:
- input_cost
- output_cost
- total_cost
- currency: USD

Use the actual usage returned by Anthropic. Do not estimate tokens when official
usage values are available.

ROOT AGGREGATION
At the end of the pipeline, calculate the sum across all traced Anthropic calls
and attach this summary to the root trace:

- anthropic_call_count
- input_tokens
- output_tokens
- total_tokens
- input_cost
- output_cost
- total_cost
- currency
- models_used
- usage_by_agent
- usage_by_model

The usage_by_agent value must contain separate totals for triage, jira_sync,
developer, reviewer, deploy, and release.

NAMING RULES
Use consistent snake_case for metadata and usage fields. Use dot-separated,
human-readable run names for trace hierarchy.

Use LangSmith-recognized token fields:
- input_tokens
- output_tokens
- total_tokens

Include the model identity through the standard model/provider metadata supported
by the installed LangSmith integration. Avoid custom names when an official
LangSmith field is available.

IMPLEMENTATION RULES
- Reuse the existing LangSmith client and environment configuration.
- Add a shared wrapper around Anthropic calls instead of duplicating tracing code.
- The wrapper must capture successful and failed calls.
- Preserve the parent-child relationship between the pipeline, agent, and model call.
- Do not log ANTHROPIC_API_KEY or other secrets.
- Redact sensitive issue data where necessary.
- Tracing failures must not break the application pipeline.
- Avoid double-counting retries or clearly mark each retry attempt.
- Record streaming usage only after the final usage information is available.

ACCEPTANCE CRITERIA
1. A pipeline execution appears as one root LangSmith trace.
2. Scanner does not produce an Anthropic usage run.
3. Every Anthropic call from the included agents appears as a child run.
4. Each call shows its model, inputs, outputs, tokens, and cost.
5. Root totals equal the sum of all child model calls.
6. Usage can be grouped by agent and model.
7. Failed calls and retries remain observable without corrupting totals.
8. No API keys or secrets appear in traces.
9. Existing pipeline behavior and responses remain unchanged.