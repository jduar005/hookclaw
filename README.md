# HookClaw — OpenClaw Memory RAG Plugin

Automatically injects relevant memories into every prompt via the `before_agent_start` hook. No more context loss after compaction.

## How It Works

1. OpenClaw fires `before_agent_start` before the model processes each prompt
2. HookClaw embeds the prompt and searches the memory vector index
3. Top-k relevant memories are formatted as XML (or markdown) context
4. Context is prepended to the prompt via `prependContext`

The model sees relevant memories alongside the user's message without any agent-side tool calls.

## Installation

```bash
git clone https://github.com/jduar005/hookclaw.git ~/hookclaw
openclaw plugins install --link ~/hookclaw
systemctl --user restart openclaw-gateway
```

## Configuration

Override defaults in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "hookclaw": {
        "enabled": true,
        "config": {
          "maxResults": 3,
          "minScore": 0.5,
          "maxContextChars": 2000,
          "timeoutMs": 2000,
          "logInjections": true,
          "formatTemplate": "xml",
          "skipShortPrompts": 20
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxResults` | 3 | Max memory chunks to inject per prompt |
| `minScore` | 0.5 | Minimum similarity score threshold (0-1) |
| `maxContextChars` | 2000 | Max total characters of injected context |
| `timeoutMs` | 2000 | Memory search timeout (ms) |
| `logInjections` | true | Log injection/skip events to gateway logs |
| `formatTemplate` | "xml" | Context format: `"xml"` or `"markdown"` |
| `skipShortPrompts` | 20 | Skip prompts shorter than N chars (saves embedding calls) |

All settings are optional — omit any key to use the default.

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

### Watching the logs

With `logInjections: true`, every prompt produces a log line:

```
hookclaw: #1 injecting 3 memories (189ms, top score: 0.529)   — context injected
hookclaw: #2 no relevant memories found (193ms)                — searched but nothing passed minScore
hookclaw: #3 skip — prompt too short (5 chars)                 — skipped entirely, no API call
```

OpenClaw's own `agent/embedded` subsystem independently confirms each injection:

```
hooks: prepended context to prompt (1847 chars)
```

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

## Error Handling

Every failure mode is non-fatal — the prompt passes through unmodified:

- Memory search tool unavailable: logged once, all future searches skipped
- Embedding API timeout: caught by timeout race
- SQLite errors: graceful fallback
- Handler throws: caught by OpenClaw hook runner (`catchErrors: true`)

## Verification

1. Check gateway logs for `hookclaw: registered before_agent_start hook` on startup
2. Send a message that relates to indexed memories
3. Verify logs show: `hookclaw: #1 injecting N memories (Xms, top score: X.XXX)`
4. Verify OpenClaw confirms: `hooks: prepended context to prompt (XXXX chars)`
5. Send "hi" — verify skip: `hookclaw: #1 skip — prompt too short`
