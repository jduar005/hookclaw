# HookClaw — OpenClaw Memory RAG Plugin

> **v2.1** on `feature/v2-multi-signal-retrieval` branch | **v1.1.0** on `master` (deployed)

Multi-signal memory retrieval plugin — automatically injects relevant memories into every prompt via the `before_agent_start` hook. No more context loss after compaction.

**v2.1 features**: Direct FTS5 keyword search (boosts vector scores), temporal decay, MMR diversity, intent-gating skip patterns, fuzzy semantic cache, entity extraction, temporal parsing, feedback loop via `agent_end` hook. Zero external dependencies.

## Why?

OpenClaw agents lose context after compaction. The built-in `memory-core` plugin indexes your conversations, but the agent only searches memory when it *decides* to — which means important context silently disappears when the context window fills up.

HookClaw fixes this by intercepting every prompt *before* the model starts reasoning. It embeds the prompt, searches the memory vector index, and prepends the top-k relevant chunks as context. The model sees relevant memories alongside the user's message without any agent-side tool calls.

**Result:** Your agent remembers what you discussed yesterday, last week, or last month — automatically, on every message.

## How It Works

1. User sends a message (Telegram, WhatsApp, etc.)
2. OpenClaw fires `before_agent_start` before the model processes the prompt
3. HookClaw embeds the prompt via the configured embedding provider (e.g. Gemini)
4. The embedding is searched against the memory vector index (SQLite + sqlite-vec)
5. Top-k results above the similarity threshold are formatted as XML context
6. Context is returned via `{ prependContext }` — OpenClaw prepends it to the prompt
7. The model sees: `[relevant memories] + [user's message]`

Typical latency: **150-350ms** (embedding API is the bottleneck; SQLite vector search is <20ms).

## Prerequisites

- **OpenClaw** v2026.2.9 or later (requires plugin SDK with `before_agent_start` hook support)
- **Node.js** 20+ (uses ES modules, `node:test` runner)
- **memory-core** plugin enabled and configured — HookClaw searches the index that memory-core builds. Without memory-core, there's nothing to search.

Verify memory-core is active and has indexed content:

```bash
openclaw memory status --json
# Look for: "files": N, "chunks": N (both should be > 0)
```

If `chunks: 0`, you need to build the index first. Memory-core indexes files in your workspace's `memory/` directory. See [OpenClaw memory docs](https://docs.openclaw.ai/cli/memory) for setup.

## Installation

```bash
# Clone the plugin
git clone https://github.com/jduar005/hookclaw.git ~/hookclaw

# Install as a linked plugin (symlink — enables live editing)
openclaw plugins install --link ~/hookclaw

# Restart the gateway to load the plugin
systemctl --user restart openclaw-gateway    # Linux (systemd)
# — or —
launchctl kickstart -k gui/$(id -u)/openclaw-gateway   # macOS (launchd)
# — or —
openclaw gateway restart                     # If running manually / Docker
```

### Verify installation

After restart, check the gateway logs for the registration message:

```bash
journalctl --user -u openclaw-gateway --since "1 min ago" | grep hookclaw
```

Expected output:

```
hookclaw: registered before_agent_start hook (maxResults=3, minScore=0.5, timeout=2000ms, format=xml)
```

You can also verify via the CLI:

```bash
openclaw plugins list
# Should show: HookClaw Memory RAG | hookclaw | loaded | ~/hookclaw/index.js | 2.1.0
```

## Configuration

All settings are optional. HookClaw works out of the box with sensible defaults. To override, add a `config` block to the plugin entry in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "hookclaw": {
        "enabled": true,
        "config": {
          "maxResults": 3,
          "minScore": 0.5,
          "maxContextChars": 2000
        }
      }
    }
  }
}
```

This merges with your existing `openclaw.json` — you only need to add the `hookclaw` key inside `plugins.entries`. Any keys you omit use the defaults below.

| Option | Default | Description |
|--------|---------|-------------|
| `maxResults` | 3 | Max memory chunks to inject per prompt |
| `minScore` | 0.5 | Minimum similarity score threshold (0-1) |
| `maxContextChars` | 2000 | Max total characters of injected context |
| `timeoutMs` | 2000 | Memory search timeout (ms) |
| `logInjections` | true | Log injection/skip events to gateway logs |
| `formatTemplate` | `"xml"` | Context format: `"xml"` or `"markdown"` |
| `skipShortPrompts` | 20 | Skip prompts shorter than N chars (saves embedding calls) |
| `cacheSize` | 20 | Max entries in the prompt dedup LRU cache |
| `cacheTtlMs` | 300000 | Cache TTL in ms (default 5 min) |
| `adaptiveResults` | true | Vary result count based on score quality |

#### v2.1 Options

| Option | Default | Description |
|--------|---------|-------------|
| `halfLifeHours` | 168 | Temporal decay half-life in hours (0 = disabled) |
| `enableSkipPatterns` | true | Intent-gating: skip creative/procedural/meta prompts |
| `skipPatterns` | null | Custom regex patterns (null = built-in defaults) |
| `enableFts` | true | Direct FTS5 keyword search to boost vector results |
| `ftsBoostWeight` | 0.3 | FTS5 boost weight added to vector score (0-1) |
| `ftsDbPath` | null | Override path to OpenClaw SQLite database (null = auto-discover) |
| `ftsAgentId` | `"main"` | OpenClaw agent ID for database path resolution |
| `enableTemporalParsing` | false | Parse "yesterday", "last week" from prompts (diagnostic-only) |
| `enableFeedbackLoop` | false | `agent_end` hook for utility score tracking |
| `enableMmr` | true | MMR diversity filtering to remove duplicate memories |
| `mmrLambda` | 0.7 | MMR relevance vs diversity (0=max diversity, 1=max relevance) |
| `fuzzyCacheThreshold` | 0.85 | Jaccard similarity for fuzzy cache matching (1.0 = exact only) |

### Glossary

- **Memory index** — The SQLite database where memory-core stores embedded chunks of your conversation history and memory files. Located at `~/.openclaw/memory/main.sqlite`.
- **Chunk** — A section of a memory file (typically 15-40 lines) that has been embedded as a vector. Each chunk is independently searchable.
- **Similarity score** — A 0-1 value indicating how semantically similar a chunk is to the current prompt. Higher = more relevant. Produced by comparing embedding vectors.
- **Embedding provider** — The API used to convert text into vectors (e.g. Gemini `embedding-001`, OpenAI `text-embedding-3-small`). Configured in memory-core, not HookClaw.

## Tuning Guide

The defaults are tuned for precision over recall. Here's how to adjust for your setup.

### minScore — the most important knob

This controls what counts as "relevant." Gemini embedding similarity scores typically range from 0.35 (noise) to 0.75+ (strong match). Setting this too low floods the model with irrelevant context; too high and useful memories get filtered out.

| minScore | Behavior | Use when... |
|----------|----------|-------------|
| 0.30 | Firehose — almost everything matches | Never recommended; even "hello" scores 0.40+ |
| 0.45 | Loose — some noise gets through | Large diverse memory index, want broad recall |
| **0.50** | **Balanced — default** | **Most setups; good precision/recall tradeoff** |
| 0.55 | Tight — only strong matches | Small focused memory index, want surgical precision |
| 0.65+ | Very strict — few injections | Only want near-exact topic matches |

**How to calibrate:** Enable `logInjections`, use your agent normally for a day, then check logs. If you see frequent `no relevant memories found` on prompts that *should* have matched, lower the threshold. If you see injections on generic prompts, raise it.

### maxResults — less is more

Each injected chunk consumes model context. More chunks = more distraction potential. In practice, 2-3 highly relevant chunks outperform 5 mediocre ones.

| maxResults | Context cost | Best for... |
|------------|-------------|-------------|
| 1-2 | ~500-1000 chars | Agents with tight context budgets or small memory indexes |
| **3** | **~1500-2000 chars** | **Default; good balance of breadth and focus** |
| 5 | ~3000-4000 chars | Large memory indexes with diverse topics |

### skipShortPrompts — save embedding API calls

Short prompts ("hi", "ok", "thanks") produce meaningless embeddings. Skip them to save latency and API costs.

| skipShortPrompts | Filters out... |
|------------------|---------------|
| 10 | Single words only ("hi", "ok") |
| **20** | **Short phrases ("hello how are you", "sounds good thanks")** |
| 40 | Most conversational messages |

### maxContextChars — budget your tokens

Controls total character limit across all injected chunks. Chunks are included in order of relevance score until this limit is reached.

| maxContextChars | Roughly... | Good for... |
|-----------------|-----------|-------------|
| 1000 | ~250 tokens | Very constrained contexts |
| **2000** | **~500 tokens** | **Default; enough for 2-3 meaningful chunks** |
| 4000 | ~1000 tokens | When you need full paragraphs of context |

### Recommended starting configs

**Surgical (small memory, focused agent):**
```json
{ "maxResults": 2, "minScore": 0.55, "maxContextChars": 1500, "skipShortPrompts": 20 }
```

**Balanced (default):**
```json
{ "maxResults": 3, "minScore": 0.50, "maxContextChars": 2000, "skipShortPrompts": 20 }
```

**Broad recall (large memory, general assistant):**
```json
{ "maxResults": 5, "minScore": 0.45, "maxContextChars": 4000, "skipShortPrompts": 15 }
```

**Full v2.1 features (all signals enabled):**
```json
{
  "maxResults": 3,
  "minScore": 0.45,
  "enableFts": true,
  "ftsBoostWeight": 0.3,
  "enableMmr": true,
  "enableSkipPatterns": true,
  "halfLifeHours": 168,
  "fuzzyCacheThreshold": 0.85
}
```

### Watching the logs

With `logInjections: true`, every prompt produces a log line:

```
hookclaw: #1 injecting 3 memories (189ms, top score: 0.529)   — context injected
hookclaw: #2 no relevant memories found (193ms)                — searched but nothing passed minScore
hookclaw: #3 skip — prompt too short (5 chars)                 — skipped entirely, no API call
hookclaw: #4 cache hit (0ms)                                   — same prompt seen recently, reused result
hookclaw: #5 skip — matched pattern: creative                  — [v2.0] intent gating caught "write a poem"
hookclaw: #6 fuzzy cache hit (1ms)                             — [v2.0] Jaccard match to cached prompt
```

OpenClaw's own `agent/embedded` subsystem independently confirms each injection:

```
hooks: prepended context to prompt (1847 chars)
```

If you see the first line but not the second, the hook returned context but OpenClaw didn't apply it — check your OpenClaw version supports `prependContext` in hook results.

## Context Format

### XML (default)

```xml
<relevant_memories>
  <memory source="memory" path="memory/2026-02-12.md" lines="236-258" score="0.749">
    Chunk text here...
  </memory>
</relevant_memories>
```

### Markdown

```markdown
---
**Relevant Memories:**

> *memory* | `memory/2026-02-12.md` | lines 236-258 | (score: 0.749)
Chunk text here...

---
```

## Testing

```bash
node --test test/*.test.js
```

**162 tests** across 23 suites covering: handler logic, skip patterns, temporal decay, fuzzy cache, MMR diversity, FTS5 keyword search, entity extraction, temporal parsing, utility tracking, metrics collection, context formatting.

### Branching Workflow

- **`master`** = deployed on VMs (v1.1.0)
- **`feature/v2-multi-signal-retrieval`** = v2.1 (burn-in on Axle VM)

See `docs/HOOKCLAW-OPTIMIZATION-ROADMAP.md` for the full VM testing strategy.

## Error Handling

Every failure mode is non-fatal — the prompt passes through unmodified:

- **Memory search tool unavailable:** Logged once, all future searches skipped for the session
- **Embedding API timeout:** Caught by `Promise.race` with configurable `timeoutMs`
- **SQLite errors:** Graceful fallback, returns empty results
- **Handler throws:** Caught by OpenClaw hook runner (`catchErrors: true`)

If HookClaw fails, the user's prompt still reaches the model — just without memory context.

## Troubleshooting

**Plugin doesn't appear in `openclaw plugins list`:**
- Verify `package.json` contains `"openclaw": { "extensions": ["./index.js"] }`
- Re-run `openclaw plugins install --link ~/hookclaw`
- Check gateway logs for plugin load errors

**`no relevant memories found` on every prompt:**
- Check `openclaw memory status --json` — if `chunks: 0`, the memory index is empty
- Your `minScore` may be too high — try lowering to 0.45
- The embedding provider may differ between memory-core indexing and HookClaw search (they must match)

**`memory search tool unavailable` in logs:**
- The `memory-core` plugin isn't loaded or configured
- Check `openclaw plugins list` — memory-core should show as `loaded`

**High latency (>500ms):**
- Embedding API latency dominates — this is normal for remote providers like Gemini
- Check if embedding cache is enabled (`openclaw memory status --json` → `cache.enabled: true`)
- Consider enabling batch embeddings for bulk indexing

## Verification

Full end-to-end verification checklist:

1. **Startup:** Check gateway logs for `hookclaw: registered before_agent_start hook`
2. **Generic prompt:** Send "hello" — should see `skip — prompt too short` (no API call wasted)
3. **Relevant prompt:** Send a message about something in your memory index — should see `injecting N memories`
4. **Gateway confirmation:** Same log timestamp should show `hooks: prepended context to prompt (XXXX chars)`
5. **Irrelevant prompt:** Send something unrelated to any memory — should see `no relevant memories found`

## License

MIT — see [LICENSE](LICENSE).
