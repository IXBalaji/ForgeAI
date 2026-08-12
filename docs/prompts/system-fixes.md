You are a senior AI-platform engineer. Review and optimize the current agent implementation with the following objectives:

1. MODEL CONFIGURATION
- Change the development agent’s model from Claude Haiku 4.5 to Claude Sonnet 5.
- Verify that Sonnet 5 is actually used at runtime, not merely specified in configuration.
- Identify and fix any fallback, routing, environment-variable, or configuration issue that causes Haiku 4.5 to appear in traces.

2. TOKEN-USAGE OPTIMIZATION
Current usage is approximately 1,183,437 input/output tokens per ticket, which is too high.

Analyze token consumption across the complete workflow and identify:
- Repeated system prompts or instructions
- Full conversation history being resent unnecessarily
- Duplicate context across nodes
- Oversized tool responses
- Redundant retries or repeated model calls
- Unnecessary intermediate outputs
- Large documents included without filtering, chunking, or retrieval
- Trace or observability data accidentally added to model context

Implement the best optimizations without changing the quality, correctness, structure, or content of the final output. Prefer:
- Prompt caching for stable system instructions and reusable context
- Context deduplication
- History summarization or compaction
- Retrieval of only relevant content
- Tool-result filtering and truncation
- Passing references or structured state instead of repeating raw text
- Smaller prompts for intermediate calls
- Removing unnecessary model calls
- Sensible output-token limits

Do not reduce final-output quality or silently omit required information.

3. PROMPT CACHING
Evaluate and implement prompt caching for:
- Stable system prompts
- Agent instructions
- Tool definitions
- Reusable reference material
- Other repeated prompt prefixes

Ensure cached content has a stable ordering and byte-identical structure wherever possible. Report:
- What is cacheable
- What was changed
- Cache-hit behavior
- Estimated token and cost reduction

4. LANGSMITH TRACE CLEANUP
Simplify the LangSmith trace structure so that it retains only nodes that actually invoke an AI SDK model call or the Claude API.

Remove or suppress trace nodes created solely for:
- Internal orchestration
- Data transformation
- Formatting
- Routing
- Utility functions
- Non-model operations

Preserve enough metadata on retained nodes to inspect:
- Model name
- Provider
- Input, output, and total tokens
- Cached and uncached input tokens, where available
- Latency
- Cost
- Errors and retries
- Ticket or request identifier

Do not remove operational code—only eliminate unnecessary LangSmith nodes or spans.

5. VALIDATION
Run representative before-and-after tests and confirm:
- Sonnet 5 is used consistently
- Final outputs remain equivalent
- Required content is not lost
- Token consumption is materially reduced
- Prompt caching works
- LangSmith displays only genuine model-call nodes
- Error handling and retries continue to work

DELIVERABLES
Provide:
1. Root-cause analysis of the excessive token usage
2. Recommended optimization strategy, prioritized by impact and risk
3. Exact code and configuration changes
4. Before-and-after token measurements per workflow stage
5. Prompt-cache hit and miss statistics
6. Updated LangSmith trace example
7. Tests proving final-output equivalence
8. Any trade-offs, risks, and rollback instructions

First inspect the existing implementation and traces. Do not make speculative changes without identifying the relevant execution path.