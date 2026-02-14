# HookClaw Architecture & Technical Guide

## Overview

HookClaw is an OpenClaw plugin that solves the **post-compaction amnesia problem** — when AI agents lose context after their conversation is compacted to fit within token limits, they forget prior decisions, preferences, and ongoing work.

HookClaw intercepts every prompt via OpenClaw's `before_agent_start` lifecycle hook, searches the agent's memory index for relevant context, and injects the top-k results as prepended context before the model begins reasoning. The agent sees relevant memories alongside the user's message without needing to decide to search — it happens automatically on every turn.

### The Problem

```
JP: "What did we decide about the logging format?"
              │
              ▼
Agent (post-compaction): "I don't have context about a previous
logging discussion. Could you remind me what you're referring to?"
```

### The Solution

```
JP: "What did we decide about the logging format?"
              │
              ▼
  ┌─── HookClaw fires ────────────────────────────────┐
  │ 1. Embed prompt via Gemini embedding API           │
  │ 2. Vector search SQLite index (58 chunks)          │
  │ 3. Format top-5 results as XML                     │
  │ 4. Return { prependContext: "<relevant_memories>…"} │
  └────────────────────────────────────────────────────┘
              │
              ▼
Agent sees: [5 relevant memory snippets] + JP's question
              │
              ▼
Agent: "Based on our earlier discussion, we decided to use
structured logging with Serilog…"
```

## Architecture

### System Context

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                        │
│                                                             │
│  ┌─────────┐    ┌──────────┐    ┌────────────────────────┐  │
│  │Telegram │───▶│ Inbound  │───▶│ Hook Runner            │  │
│  │Channel  │    │ Pipeline │    │                        │  │
│  └─────────┘    └──────────┘    │  before_agent_start:   │  │
│                                 │  ┌──────────────────┐  │  │
│                                 │  │   HookClaw       │  │  │
│                                 │  │   (priority 10)  │──┼──┼──┐
│                                 │  └──────────────────┘  │  │  │
│                                 └───────────┬────────────┘  │  │
│                                             │               │  │
│                                    prependContext            │  │
│                                             │               │  │
│                                 ┌───────────▼────────────┐  │  │
│                                 │   Agent Runner         │  │  │
│                                 │   (Claude Opus 4.6)    │  │  │
│                                 └────────────────────────┘  │  │
└─────────────────────────────────────────────────────────────┘  │
                                                                 │
  ┌──────────────────────────────────────────────────────────────┘
  │  Memory Search Pipeline
  │
  │  ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
  └─▶│ Embedding    │────▶│ Vector Search │────▶│ Context      │
     │ (Gemini API) │     │ (sqlite-vec)  │     │ Formatter    │
     └──────────────┘     └───────────────┘     └──────────────┘
           │                     │                     │
           ▼                     ▼                     ▼
     gemini-embedding-001  main.sqlite (~20MB)   XML or Markdown
     3072 dimensions       58 chunks indexed     ≤4000 chars
     ~116 cached entries   sqlite-vec extension
```

### File Structure

```
hookclaw/
├── index.js                  # Plugin definition + config resolution
├── openclaw.plugin.json      # Plugin manifest with config schema
├── package.json              # ES module, zero runtime dependencies
├── src/
│   ├── hook-handler.js       # before_agent_start orchestration
│   ├── memory-client.js      # Wraps createMemorySearchTool with caching
│   └── context-formatter.js  # XML + Markdown formatters with char limits
├── test/
│   ├── context-formatter.test.js  # 15 tests
│   └── hook-handler.test.js       # 15 tests
├── docs/
│   └── ARCHITECTURE.md       # This file
├── .gitignore
└── README.md
```

### Module Dependency Graph

```
index.js
  └── src/hook-handler.js
        ├── src/memory-client.js
        │     └── api.runtime.tools.createMemorySearchTool (OpenClaw internal)
        │           └── getMemorySearchManager → SQLite + Gemini embeddings
        └── src/context-formatter.js
              └── (pure functions, no external deps)
```

## Performance Profile

### Measured Latency (Production, Axle VM)

| Phase | Time | Notes |
|-------|------|-------|
| **First call (cold)** | ~237ms | Includes tool init + embedding + search |
| **Subsequent calls (warm)** | ~150-250ms | Tool cached, embedding cache may hit |
| **Embedding API call** | ~100-200ms | Gemini embedding-001, network to Google |
| **SQLite vector search** | <20ms | sqlite-vec, 58 chunks, 3072 dims |
| **Context formatting** | <1ms | Pure string operations |

### Bottleneck Analysis

```
Total latency: ~237ms (measured)
├── Gemini embedding API:     ~150-200ms  (67-85% of total)
│   └── Network round-trip to Google's API
├── SQLite vector search:       ~10-20ms  (4-8%)
│   └── sqlite-vec cosine similarity over 58 chunks × 3072 dims
├── Tool initialization:          ~5ms    (2%) [first call only]
├── Result mapping + formatting:  ~1-2ms  (<1%)
└── Hook dispatch overhead:       ~1ms    (<1%)
```

**The Gemini embedding API is the dominant cost** (~80% of latency). Everything else is negligible.

### Memory Index Statistics

| Metric | Value |
|--------|-------|
| Memory files | 4 (daily markdown files) |
| Total chunks | 58 |
| Vector dimensions | 3072 |
| SQLite DB size | ~20 MB |
| Embedding cache | 116 entries (enabled) |
| Embedding model | gemini-embedding-001 |

### Scaling Characteristics

| Memory size | Expected impact |
|-------------|-----------------|
| 58 chunks (current) | <20ms search |
| ~500 chunks | ~50ms search (linear scan) |
| ~5,000 chunks | ~200ms search (may need ANN index) |
| ~50,000 chunks | Needs ANN index or partitioning |

SQLite-vec performs brute-force cosine similarity by default. For the current index size (58 chunks), this is fast. At ~5K+ chunks, consider approximate nearest neighbor (ANN) indexing.

## Pipeline Deep Dive

### 1. Hook Registration (startup)

On gateway start, OpenClaw's plugin loader:
1. Discovers `hookclaw` via `package.json` → `openclaw.extensions`
2. Imports `index.js`, calls `register(api)`
3. HookClaw resolves config (merging defaults with `openclaw.json` overrides)
4. Registers `handleBeforeAgentStart` on the `before_agent_start` hook at priority 10

### 2. Hook Execution (per prompt)

When a message arrives via Telegram:

```
1. SKIP CHECK
   - If prompt is null/undefined/non-string → return (pass through)
   - If prompt.trim().length < skipShortPrompts (10) → return (skip "hi", "ok", etc.)

2. MEMORY SEARCH
   a. Get/create memory search tool (cached after first call)
      - Uses api.runtime.tools.createMemorySearchTool()
      - Internally initializes MemorySearchManager (SQLite + Gemini)
   b. Execute search with timeout race
      - tool.execute("hookclaw-search", { query: prompt, maxResults: 5, minScore: 0.3 })
      - Promise.race against 2000ms timeout
   c. Map results to normalized format
      - { text, source, path, lines, score }

3. CONTEXT FORMATTING
   - Format results as XML (default) or Markdown
   - Enforce maxContextChars (4000) with truncation
   - Escape XML special characters

4. RETURN
   - Return { prependContext: formattedContext }
   - OpenClaw prepends this to the model's input
```

### 3. What the Model Sees

Before HookClaw:
```
[System prompt]
[User message: "What did we decide about the logging format?"]
```

After HookClaw:
```
[System prompt]
<relevant_memories>
  <memory source="memory" path="memory/2026-02-12.md" lines="45-52" score="0.481">
    Decided to use structured logging with Serilog across all services.
    Key patterns: use extension methods (LogInformation not Log), include
    OperationId for correlation, send to Axiom for centralized viewing.
  </memory>
  <memory source="memory" path="memory/2026-02-13.md" lines="12-18" score="0.412">
    ...
  </memory>
</relevant_memories>
[User message: "What did we decide about the logging format?"]
```

### 4. Error Handling Philosophy

**Every failure mode is non-fatal.** If anything goes wrong, the prompt passes through unmodified — the agent simply doesn't get memory context for that turn.

| Failure | Behavior |
|---------|----------|
| Tool creation returns null | Logged once, all future searches skipped |
| Gemini API timeout | Caught by Promise.race, returns empty results |
| SQLite error | Handled inside memory search manager |
| Formatting produces empty string | Logged, no injection |
| Handler throws | Caught by OpenClaw hook runner |

## Configuration Reference

All config lives in `~/.openclaw/openclaw.json` under `plugins.entries.hookclaw.config`:

```json
{
  "plugins": {
    "entries": {
      "hookclaw": {
        "enabled": true,
        "config": {
          "maxResults": 5,
          "minScore": 0.3,
          "maxContextChars": 4000,
          "timeoutMs": 2000,
          "logInjections": true,
          "formatTemplate": "xml",
          "skipShortPrompts": 10
        }
      }
    }
  }
}
```

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `maxResults` | 5 | 1-20 | Max memory chunks to inject. Higher = more context but more tokens consumed. |
| `minScore` | 0.3 | 0.0-1.0 | Minimum cosine similarity threshold. Lower = more results but noisier. |
| `maxContextChars` | 4000 | 500-20000 | Total character budget for injected context. Entries are truncated to fit. |
| `timeoutMs` | 2000 | 500-10000 | Max time to wait for embedding + search. Exceeding this skips injection. |
| `logInjections` | true | bool | Log each hook invocation with timing and result count. |
| `formatTemplate` | "xml" | xml/markdown | Output format for context block. XML recommended for Claude models. |
| `skipShortPrompts` | 10 | 0-100 | Skip prompts shorter than N chars. Avoids searching on "hi", "ok", "yes". |

### Tuning Guidance

**For tighter relevance** (fewer but better matches):
```json
{ "maxResults": 3, "minScore": 0.5 }
```

**For broader recall** (more context, looser matching):
```json
{ "maxResults": 8, "minScore": 0.2, "maxContextChars": 6000 }
```

**For latency-sensitive environments**:
```json
{ "timeoutMs": 1000, "maxResults": 3 }
```

## Optimization Opportunities

### Near-term (Low Effort)

#### 1. Embedding Cache Warmup
The OpenClaw memory system already caches embeddings (116 entries currently). Repeated or similar queries benefit from cache hits. **No action needed** — this is already working.

#### 2. Tune `skipShortPrompts` Threshold
Currently set to 10 characters. Messages like "thanks!" (7 chars) are skipped. Consider raising to 15-20 to also skip "sounds good" or "got it" which rarely benefit from memory injection.

#### 3. Adjust `minScore` Based on Observation
Current 0.3 threshold is generous. If logs show many low-score (0.3-0.4) injections that aren't useful, raise to 0.4-0.5 to reduce noise and save tokens.

### Medium-term (Moderate Effort)

#### 4. Session-Scoped Search
The hook currently searches all memory sources. OpenClaw's memory search supports `sessionKey` scoping — passing the current session key could prioritize recent conversation context over older memories.

#### 5. Prompt Deduplication / Digest
If the same prompt is sent multiple times (e.g., retries), the embedding is recomputed each time. A simple in-memory LRU cache of `hash(prompt) → results` could skip redundant API calls. The embedding cache in OpenClaw partially addresses this, but a result-level cache would be faster.

#### 6. Adaptive `maxResults`
Instead of fixed top-k, vary the count based on score distribution:
- If top result has score >0.7, inject only 1-2 (strong match)
- If top result has score 0.4-0.7, inject 3-5 (moderate match)
- If top result has score <0.4, inject none (weak match, likely noise)

#### 7. Cost-Aware Token Budgeting
Currently `maxContextChars` is a simple character limit. A token-aware approach would estimate the token cost of injected context and respect a token budget rather than character count. This prevents memory injection from consuming too much of the model's context window on long conversations.

### Long-term (Significant Effort)

#### 8. Local Embedding Model
The Gemini API call is ~80% of latency. Running a local embedding model (e.g., `nomic-embed-text`, `bge-small-en`) would eliminate the network round-trip entirely:
- **Pro**: Latency drops from ~200ms to ~20-50ms, zero API cost, works offline
- **Con**: Requires re-indexing all memory with the new model, lower embedding quality than Gemini
- **Feasibility**: OpenClaw's memory search config supports different providers; would need a local provider implementation

#### 9. Incremental Index with ANN
As memory grows beyond ~5K chunks, brute-force vector search becomes slow. Options:
- **sqlite-vec HNSW index**: If supported in future versions
- **LanceDB integration**: OpenClaw already has a `memory-lancedb` plugin with ANN
- **Hybrid search**: Combine FTS (already enabled in OpenClaw) with vector search for faster filtering

#### 10. Multi-Agent Memory Partitioning
If HookClaw is deployed on multiple agents (Axle + Drizzo), each agent currently searches its own memory index. Cross-agent memory sharing could be valuable — "What did Axle tell JP about X?" — but requires careful access control.

#### 11. Context Quality Feedback Loop
Track which injected memories the agent actually references in its response. Over time, this data could train a reranker or adjust per-topic score thresholds. Requires `agent_end` hook integration to analyze the response.

## OpenClaw Plugin SDK Reference

### Key Types Used

```typescript
// Plugin definition (what index.js exports)
type OpenClawPluginDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
  register: (api: OpenClawPluginApi) => void;
};

// Plugin API (received in register())
type OpenClawPluginApi = {
  config: OpenClawConfig;           // Full gateway config
  pluginConfig: Record<string, unknown>;  // Plugin-specific config
  runtime: PluginRuntime;           // Access to OpenClaw internals
  logger: PluginLogger;             // Structured logger
  on: (hookName, handler, opts?) => void;  // Register lifecycle hooks
  // ... registerTool, registerCommand, etc.
};

// Hook handler signature for before_agent_start
type Handler = (
  event: { prompt: string; messages?: unknown[] },
  ctx: { agentId?: string; sessionKey?: string; workspaceDir?: string }
) => Promise<{ prependContext?: string; systemPrompt?: string } | void>;

// Memory search result (from memory-core)
type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
};
```

### Hook Priority

HookClaw registers at **priority 10**. Lower numbers run first. If other plugins also use `before_agent_start`, priority determines execution order. Multiple plugins can return `prependContext` — OpenClaw concatenates them.

### Available Lifecycle Hooks

| Hook | When | Can Modify |
|------|------|------------|
| `before_agent_start` | Before model processes prompt | `prependContext`, `systemPrompt` |
| `agent_end` | After agent completes | Read-only |
| `before_compaction` | Before context compaction | Read-only |
| `after_compaction` | After context compaction | Read-only |
| `message_received` | Inbound message from channel | Read-only |
| `message_sending` | Before outbound message | `content`, `cancel` |
| `before_tool_call` | Before agent calls a tool | `params`, `block` |
| `after_tool_call` | After tool execution | Read-only |

## Testing

### Running Tests

```bash
node --test test/*.test.js
```

### Test Strategy

- **context-formatter.test.js** (15 tests): Pure function tests for XML/Markdown formatting, character limits, XML escaping, empty input handling, truncation behavior
- **hook-handler.test.js** (15 tests): Handler creation, skip logic (short prompts, null events, missing context), call counting, log verification. Uses a `fakeApi()` stub that returns `null` from `createMemorySearchTool` to simulate the test environment without OpenClaw runtime.

### Manual Verification

After deployment, verify via gateway logs:

```bash
# Check plugin loaded
journalctl --user -u openclaw-gateway --since "5 min ago" | grep hookclaw

# Expected on startup:
# hookclaw: registered before_agent_start hook (maxResults=5, ...)

# Expected on message:
# hookclaw: #1 injecting 5 memories (237ms, top score: 0.481)

# Expected on short message ("hi"):
# hookclaw: #2 skip — prompt too short (2 chars)

# Expected when no memories match:
# hookclaw: #3 no relevant memories found (180ms)
```

## Deployment

### Prerequisites

- OpenClaw >= 2026.2.9 with plugin SDK
- Memory search configured (Gemini embeddings + SQLite)
- Memory files indexed (`openclaw memory status` shows chunks > 0)

### Install

```bash
git clone https://github.com/jduar005/hookclaw.git ~/hookclaw
openclaw plugins install --link ~/hookclaw
```

The `--link` flag creates a symlink rather than copying — changes to `~/hookclaw` are live immediately after a gateway restart.

### Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "hookclaw": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

Empty config uses all defaults. Override individual values as needed.

### Update

```bash
cd ~/hookclaw && git pull
systemctl --user restart openclaw-gateway
```

### Disable

```bash
openclaw plugins disable hookclaw
systemctl --user restart openclaw-gateway
```

## Design Decisions

### Why Plain JavaScript (not TypeScript)?

OpenClaw's jiti loader transpiles TypeScript at runtime, but plain JS:
- Zero build step — edit and restart
- Easier to debug on the VM (no source maps needed)
- No compile errors to chase during rapid iteration
- The plugin is small enough (~300 lines) that type safety from TS isn't critical

### Why XML Format (not Markdown)?

XML tags (`<relevant_memories>`) provide clear delimiters that Claude models parse well. The structured attributes (source, path, lines, score) give the model metadata to cite sources. Markdown format is available via config for models that handle it better.

### Why `createMemorySearchTool` (not direct SQLite access)?

Using OpenClaw's built-in tool ensures:
- Correct embedding model + provider configuration
- Embedding cache reuse (116 entries)
- Consistent chunking and scoring
- Forward compatibility with OpenClaw updates
- No need to manage SQLite connections or embedding API keys

### Why Priority 10?

Low priority number = runs early. Memory injection should happen before other hooks that might modify the prompt, so the model gets memory context regardless of other transformations.

### Why Non-Fatal Error Handling?

A memory search failure should never prevent the agent from responding. The worst case is the agent responds without memory context — which is exactly what happens without HookClaw installed. The plugin is additive, never subtractive.
