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

Add to `~/.openclaw/openclaw.json`:

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

| Option | Default | Description |
|--------|---------|-------------|
| `maxResults` | 5 | Max memory chunks to inject |
| `minScore` | 0.3 | Minimum similarity score (0-1) |
| `maxContextChars` | 4000 | Max total characters of context |
| `timeoutMs` | 2000 | Memory search timeout (ms) |
| `logInjections` | true | Log injection events |
| `formatTemplate` | "xml" | Format: "xml" or "markdown" |
| `skipShortPrompts` | 10 | Skip prompts shorter than N chars |

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

- Memory manager init fails: logged once, all future searches skipped
- Embedding API timeout: caught by timeout race
- SQLite errors: graceful fallback
- Handler throws: caught by OpenClaw hook runner (`catchErrors: true`)

## Verification

1. Check gateway logs for `[hookclaw] Registered before_agent_start hook` on startup
2. Send a message that relates to indexed memories
3. Verify logs: `[hookclaw] #1 injecting N memories (Xms)`
4. Send "hi" — verify skip: `[hookclaw] #1 skip — prompt too short`
