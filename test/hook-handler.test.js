import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createHandler,
  getCallCount,
  resetCallCount,
  adaptiveFilter,
  PromptCache,
  matchesSkipPattern,
  parseDateFromPath,
  applyTemporalDecay,
  tokenize,
  jaccardSimilarity,
  mmrFilter,
} from "../src/hook-handler.js";

// Fake api object matching OpenClawPluginApi shape
function fakeApi(configOverrides = {}) {
  return {
    config: { /* OpenClawConfig stub */ },
    pluginConfig: configOverrides,
    runtime: {
      tools: {
        createMemorySearchTool: () => null, // No memory available in test env
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

// Fake hook context matching PluginHookAgentContext
const fakeCtx = {
  agentId: "test-agent",
  sessionKey: "test-session",
  workspaceDir: "/tmp",
};

describe("createHandler", () => {
  beforeEach(() => {
    resetCallCount();
  });

  it("returns a function", () => {
    const handler = createHandler({}, fakeApi());
    assert.equal(typeof handler, "function");
  });

  it("skips when event has no prompt", async () => {
    const handler = createHandler({ logInjections: false }, fakeApi());
    const result = await handler({}, fakeCtx);
    assert.equal(result, undefined);
  });

  it("skips when prompt is not a string", async () => {
    const handler = createHandler({ logInjections: false }, fakeApi());
    const result = await handler({ prompt: 42 }, fakeCtx);
    assert.equal(result, undefined);
  });

  it("skips short prompts based on config", async () => {
    const handler = createHandler({ skipShortPrompts: 10, logInjections: false }, fakeApi());
    const result = await handler({ prompt: "hi" }, fakeCtx);
    assert.equal(result, undefined);
  });

  it("skips prompts that are exactly at the threshold", async () => {
    const handler = createHandler({ skipShortPrompts: 5, logInjections: false }, fakeApi());
    const result = await handler({ prompt: "hey" }, fakeCtx);
    assert.equal(result, undefined);
  });

  it("does not skip prompts at or above threshold", async () => {
    const handler = createHandler({ skipShortPrompts: 5, logInjections: false, enableSkipPatterns: false }, fakeApi());
    // Will proceed to memory search (which fails gracefully in test env)
    const result = await handler({ prompt: "hello world, how are you?" }, fakeCtx);
    // Memory manager can't init in test env — returns undefined (no results)
    assert.equal(result, undefined);
  });

  it("increments call count on each invocation", async () => {
    const handler = createHandler({ logInjections: false }, fakeApi());
    assert.equal(getCallCount(), 0);

    await handler({ prompt: "test prompt one here" }, fakeCtx);
    assert.equal(getCallCount(), 1);

    await handler({ prompt: "test prompt two here" }, fakeCtx);
    assert.equal(getCallCount(), 2);
  });

  it("handles null event gracefully", async () => {
    const handler = createHandler({ logInjections: false }, fakeApi());
    const result = await handler(null, fakeCtx);
    assert.equal(result, undefined);
  });

  it("handles undefined event gracefully", async () => {
    const handler = createHandler({ logInjections: false }, fakeApi());
    const result = await handler(undefined, fakeCtx);
    assert.equal(result, undefined);
  });

  it("trims prompt before length check", async () => {
    const handler = createHandler({ skipShortPrompts: 10, logInjections: false }, fakeApi());
    const result = await handler({ prompt: "   hi   " }, fakeCtx);
    assert.equal(result, undefined);
  });

  it("handles missing ctx gracefully", async () => {
    const handler = createHandler({ logInjections: false }, fakeApi());
    // No ctx parameter — should not throw
    const result = await handler({ prompt: "a longer test prompt" }, undefined);
    assert.equal(result, undefined);
  });

  it("uses default config values when none provided", () => {
    const handler = createHandler({}, fakeApi());
    assert.equal(typeof handler, "function");
  });

  it("logs skip message when logInjections is true", async () => {
    const logged = [];
    const api = fakeApi();
    api.logger.info = (msg) => logged.push(msg);

    const handler = createHandler({ skipShortPrompts: 10, logInjections: true }, api);
    await handler({ prompt: "hi" }, fakeCtx);

    assert.ok(logged.some((m) => m.includes("skip") && m.includes("too short")));
  });

  it("logs cache hit when same prompt is sent twice", async () => {
    const logged = [];
    const api = fakeApi();
    api.logger.info = (msg) => logged.push(msg);

    const handler = createHandler({ logInjections: true, enableSkipPatterns: false }, api);

    await handler({ prompt: "a test prompt for cache" }, fakeCtx);
    await handler({ prompt: "a test prompt for cache" }, fakeCtx);

    assert.ok(logged.some((m) => m.includes("cache hit")));
  });

  it("skips prompts matching skip patterns", async () => {
    const logged = [];
    const api = fakeApi();
    api.logger.info = (msg) => logged.push(msg);

    const handler = createHandler({ logInjections: true, enableSkipPatterns: true }, api);
    const result = await handler({ prompt: "write a poem about the ocean" }, fakeCtx);

    assert.equal(result, undefined);
    assert.ok(logged.some((m) => m.includes("skip") && m.includes("skip pattern")));
  });

  it("does not skip when enableSkipPatterns is false", async () => {
    const handler = createHandler({ logInjections: false, enableSkipPatterns: false }, fakeApi());
    // "write a poem" would normally be skipped, but patterns are disabled
    const result = await handler({ prompt: "write a poem about the ocean" }, fakeCtx);
    // Proceeds to memory search (fails in test env)
    assert.equal(result, undefined);
  });

  it("uses custom skip patterns from config", async () => {
    const logged = [];
    const api = fakeApi();
    api.logger.info = (msg) => logged.push(msg);

    const handler = createHandler({
      logInjections: true,
      enableSkipPatterns: true,
      skipPatterns: ["^deploy\\b"],
    }, api);

    const result = await handler({ prompt: "deploy the application to production" }, fakeCtx);
    assert.equal(result, undefined);
    assert.ok(logged.some((m) => m.includes("skip pattern")));
  });
});

describe("getCallCount / resetCallCount", () => {
  it("starts at zero after reset", () => {
    resetCallCount();
    assert.equal(getCallCount(), 0);
  });

  it("resets to zero", async () => {
    const handler = createHandler({ logInjections: false }, fakeApi());
    await handler({ prompt: "some prompt text here" }, fakeCtx);
    assert.ok(getCallCount() > 0);
    resetCallCount();
    assert.equal(getCallCount(), 0);
  });
});

// -----------------------------------------------------------------------
// adaptiveFilter tests
// -----------------------------------------------------------------------
describe("adaptiveFilter", () => {
  it("returns empty array for null/undefined input", () => {
    assert.deepEqual(adaptiveFilter(null, 5), []);
    assert.deepEqual(adaptiveFilter(undefined, 5), []);
    assert.deepEqual(adaptiveFilter([], 5), []);
  });

  it("returns empty when top score < 0.4", () => {
    const results = [
      { text: "a", score: 0.39 },
      { text: "b", score: 0.35 },
    ];
    assert.deepEqual(adaptiveFilter(results, 5), []);
  });

  it("returns at most 2 when top score > 0.7", () => {
    const results = [
      { text: "a", score: 0.85 },
      { text: "b", score: 0.72 },
      { text: "c", score: 0.65 },
      { text: "d", score: 0.50 },
    ];
    const filtered = adaptiveFilter(results, 5);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].text, "a");
    assert.equal(filtered[1].text, "b");
  });

  it("returns at most maxResults when top score is 0.4–0.7", () => {
    const results = [
      { text: "a", score: 0.55 },
      { text: "b", score: 0.50 },
      { text: "c", score: 0.45 },
      { text: "d", score: 0.42 },
    ];
    const filtered = adaptiveFilter(results, 3);
    assert.equal(filtered.length, 3);
  });

  it("respects maxResults cap even for high scores", () => {
    const results = [
      { text: "a", score: 0.95 },
      { text: "b", score: 0.90 },
      { text: "c", score: 0.80 },
    ];
    const filtered = adaptiveFilter(results, 1);
    assert.equal(filtered.length, 1);
  });

  it("treats score exactly 0.7 as moderate (not strong)", () => {
    const results = [
      { text: "a", score: 0.7 },
      { text: "b", score: 0.65 },
      { text: "c", score: 0.55 },
    ];
    const filtered = adaptiveFilter(results, 5);
    assert.equal(filtered.length, 3);
  });

  it("treats score exactly 0.4 as moderate (not noise)", () => {
    const results = [
      { text: "a", score: 0.4 },
      { text: "b", score: 0.35 },
    ];
    const filtered = adaptiveFilter(results, 5);
    assert.equal(filtered.length, 2);
  });

  it("handles single result with high score", () => {
    const results = [{ text: "a", score: 0.9 }];
    const filtered = adaptiveFilter(results, 5);
    assert.equal(filtered.length, 1);
  });

  it("handles missing score (defaults to 0)", () => {
    const results = [{ text: "a" }];
    const filtered = adaptiveFilter(results, 5);
    assert.deepEqual(filtered, []);
  });
});

// -----------------------------------------------------------------------
// PromptCache tests
// -----------------------------------------------------------------------
describe("PromptCache", () => {
  it("returns undefined for missing key", () => {
    const cache = new PromptCache(10, 60000);
    assert.equal(cache.get("missing"), undefined);
  });

  it("stores and retrieves results", () => {
    const cache = new PromptCache(10, 60000);
    const results = [{ text: "a", score: 0.5 }];
    cache.set("key1", results);
    assert.deepEqual(cache.get("key1"), results);
  });

  it("evicts oldest entry when over capacity", () => {
    const cache = new PromptCache(2, 60000);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("c", [3]); // Should evict "a"
    assert.equal(cache.get("a"), undefined);
    assert.deepEqual(cache.get("b"), [2]);
    assert.deepEqual(cache.get("c"), [3]);
  });

  it("moves accessed entry to end (LRU)", () => {
    const cache = new PromptCache(2, 60000);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.get("a"); // Touch "a" — now "b" is oldest
    cache.set("c", [3]); // Should evict "b"
    assert.deepEqual(cache.get("a"), [1]);
    assert.equal(cache.get("b"), undefined);
    assert.deepEqual(cache.get("c"), [3]);
  });

  it("expires entries after TTL", async () => {
    const cache = new PromptCache(10, 50); // 50ms TTL
    cache.set("key", [1]);
    assert.deepEqual(cache.get("key"), [1]);

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cache.get("key"), undefined);
  });

  it("clear removes all entries", () => {
    const cache = new PromptCache(10, 60000);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get("a"), undefined);
  });

  it("reports correct size", () => {
    const cache = new PromptCache(10, 60000);
    assert.equal(cache.size, 0);
    cache.set("a", [1]);
    assert.equal(cache.size, 1);
    cache.set("b", [2]);
    assert.equal(cache.size, 2);
  });

  it("overwrites existing key without growing size", () => {
    const cache = new PromptCache(10, 60000);
    cache.set("a", [1]);
    cache.set("a", [2]);
    assert.equal(cache.size, 1);
    assert.deepEqual(cache.get("a"), [2]);
  });

  it("stores empty arrays (cached no-result)", () => {
    const cache = new PromptCache(10, 60000);
    cache.set("key", []);
    const result = cache.get("key");
    assert.deepEqual(result, []);
    assert.equal(result.length, 0);
  });

  it("returns fuzzy match for near-duplicate prompts", () => {
    const cache = new PromptCache(10, 60000, 0.8); // 80% threshold
    const results = [{ text: "match", score: 0.9 }];
    cache.set("how do I configure the logging system", results);

    // Very similar prompt (same words, slightly different phrasing)
    const fuzzyHit = cache.get("how do I configure logging system");
    assert.deepEqual(fuzzyHit, results);
  });

  it("does not fuzzy match dissimilar prompts", () => {
    const cache = new PromptCache(10, 60000, 0.8);
    cache.set("how do I configure the logging system", [{ text: "a", score: 0.9 }]);

    // Very different prompt
    const miss = cache.get("what is the deployment process for production");
    assert.equal(miss, undefined);
  });

  it("disables fuzzy matching when threshold is 1.0", () => {
    const cache = new PromptCache(10, 60000, 1.0);
    const results = [{ text: "a", score: 0.9 }];
    cache.set("exact match only test", results);

    const miss = cache.get("exact match only testing");
    assert.equal(miss, undefined); // Would fuzzy match at lower threshold
  });
});

// -----------------------------------------------------------------------
// matchesSkipPattern tests
// -----------------------------------------------------------------------
describe("matchesSkipPattern", () => {
  it("matches creative prompts", () => {
    assert.equal(matchesSkipPattern("write a poem about clouds"), true);
    assert.equal(matchesSkipPattern("Write me a story"), true);
    assert.equal(matchesSkipPattern("create a function that"), true);
    assert.equal(matchesSkipPattern("generate a random number"), true);
    assert.equal(matchesSkipPattern("imagine a world where"), true);
    assert.equal(matchesSkipPattern("compose a song"), true);
  });

  it("matches procedural prompts", () => {
    assert.equal(matchesSkipPattern("format this JSON"), true);
    assert.equal(matchesSkipPattern("convert celsius to fahrenheit"), true);
    assert.equal(matchesSkipPattern("translate this to Spanish"), true);
    assert.equal(matchesSkipPattern("calculate the sum of 1+2+3"), true);
  });

  it("matches meta prompts", () => {
    assert.equal(matchesSkipPattern("clear"), true);
    assert.equal(matchesSkipPattern("reset everything"), true);
    assert.equal(matchesSkipPattern("help me understand"), true);
    assert.equal(matchesSkipPattern("thanks for the help"), true);
    assert.equal(matchesSkipPattern("ok sounds good"), true);
    assert.equal(matchesSkipPattern("yes please proceed"), true);
    assert.equal(matchesSkipPattern("no that's not right"), true);
    assert.equal(matchesSkipPattern("sure go ahead"), true);
  });

  it("does not match memory-worthy prompts", () => {
    assert.equal(matchesSkipPattern("what did we discuss about the API design"), false);
    assert.equal(matchesSkipPattern("fix the bug in the login flow"), false);
    assert.equal(matchesSkipPattern("how does the authentication work"), false);
    assert.equal(matchesSkipPattern("explain the NOAA scraper architecture"), false);
    assert.equal(matchesSkipPattern("debug the deployment failure"), false);
  });

  it("is case-insensitive", () => {
    assert.equal(matchesSkipPattern("WRITE a poem"), true);
    assert.equal(matchesSkipPattern("Format this text"), true);
    assert.equal(matchesSkipPattern("THANKS"), true);
  });

  it("only matches at start of string", () => {
    assert.equal(matchesSkipPattern("please write a poem"), false);
    assert.equal(matchesSkipPattern("can you create something"), false);
    assert.equal(matchesSkipPattern("I need help with"), false);
  });

  it("supports custom string patterns", () => {
    const patterns = ["^deploy\\b", "^rollback\\b"];
    assert.equal(matchesSkipPattern("deploy the app", patterns), true);
    assert.equal(matchesSkipPattern("rollback changes", patterns), true);
    assert.equal(matchesSkipPattern("check deploy status", patterns), false);
  });

  it("handles empty patterns array", () => {
    assert.equal(matchesSkipPattern("write a poem", []), false);
  });
});

// -----------------------------------------------------------------------
// parseDateFromPath tests
// -----------------------------------------------------------------------
describe("parseDateFromPath", () => {
  it("parses YYYY-MM-DD from memory paths", () => {
    const d = parseDateFromPath("memory/2026-02-12.md");
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 1); // 0-indexed
    assert.equal(d.getUTCDate(), 12);
  });

  it("parses date from nested paths", () => {
    const d = parseDateFromPath("some/deep/path/2025-12-25.md");
    assert.equal(d.getUTCFullYear(), 2025);
    assert.equal(d.getUTCMonth(), 11);
    assert.equal(d.getUTCDate(), 25);
  });

  it("returns null for paths without dates", () => {
    assert.equal(parseDateFromPath("memory/notes.md"), null);
    assert.equal(parseDateFromPath("src/index.js"), null);
  });

  it("returns null for null/empty/undefined", () => {
    assert.equal(parseDateFromPath(null), null);
    assert.equal(parseDateFromPath(""), null);
    assert.equal(parseDateFromPath(undefined), null);
  });

  it("returns null for invalid dates", () => {
    assert.equal(parseDateFromPath("memory/9999-99-99.md"), null);
  });
});

// -----------------------------------------------------------------------
// applyTemporalDecay tests
// -----------------------------------------------------------------------
describe("applyTemporalDecay", () => {
  // Fixed "now" for deterministic tests: 2026-02-14 12:00:00 UTC
  const NOW = new Date("2026-02-14T12:00:00Z").getTime();

  it("returns empty array for null/undefined/empty", () => {
    assert.deepEqual(applyTemporalDecay(null, 24, NOW), []);
    assert.deepEqual(applyTemporalDecay(undefined, 24, NOW), []);
    assert.deepEqual(applyTemporalDecay([], 24, NOW), []);
  });

  it("preserves score for results without dates", () => {
    const results = [{ text: "a", score: 0.8, path: "notes.md" }];
    const decayed = applyTemporalDecay(results, 24, NOW);
    assert.equal(decayed[0].score, 0.8);
  });

  it("reduces score for older results", () => {
    const results = [
      { text: "old", score: 0.9, path: "memory/2026-02-10.md" }, // 4+ days old
      { text: "new", score: 0.8, path: "memory/2026-02-14.md" }, // same day
    ];
    const decayed = applyTemporalDecay(results, 24, NOW);

    // New result should have higher score than old after decay
    const newResult = decayed.find((r) => r.text === "new");
    const oldResult = decayed.find((r) => r.text === "old");
    assert.ok(newResult.score > oldResult.score);
  });

  it("re-sorts by decayed score", () => {
    const results = [
      { text: "old-high", score: 0.95, path: "memory/2026-01-01.md" }, // very old
      { text: "new-low", score: 0.5, path: "memory/2026-02-14.md" },  // today
    ];
    const decayed = applyTemporalDecay(results, 24, NOW);

    // Recent low-score should now outrank ancient high-score
    assert.equal(decayed[0].text, "new-low");
  });

  it("preserves original score in _originalScore", () => {
    const results = [{ text: "a", score: 0.9, path: "memory/2026-02-10.md" }];
    const decayed = applyTemporalDecay(results, 24, NOW);
    assert.equal(decayed[0]._originalScore, 0.9);
    assert.ok(decayed[0].score < 0.9);
  });

  it("returns results unchanged when halfLifeHours <= 0", () => {
    const results = [{ text: "a", score: 0.9, path: "memory/2026-01-01.md" }];
    const decayed = applyTemporalDecay(results, 0, NOW);
    assert.equal(decayed[0].score, 0.9);
  });

  it("applies ~50% decay at exactly half-life", () => {
    // Half-life = 24 hours, age = 24 hours (yesterday)
    const yesterday = new Date(NOW - 24 * 60 * 60 * 1000);
    const dateStr = yesterday.toISOString().split("T")[0];
    const results = [{ text: "a", score: 1.0, path: `memory/${dateStr}.md` }];
    const decayed = applyTemporalDecay(results, 24, NOW);

    // Score should be ~0.5 (exp(-ln2) = 0.5), but path dates are midnight-based
    // so age might not be exactly 24h. Allow some tolerance.
    assert.ok(decayed[0].score > 0.3 && decayed[0].score < 0.7,
      `Expected ~0.5 decay, got ${decayed[0].score}`);
  });
});

// -----------------------------------------------------------------------
// tokenize + jaccardSimilarity tests
// -----------------------------------------------------------------------
describe("tokenize", () => {
  it("tokenizes to lowercase word set", () => {
    const tokens = tokenize("Hello World hello");
    assert.ok(tokens.has("hello"));
    assert.ok(tokens.has("world"));
    assert.equal(tokens.size, 2); // deduped
  });

  it("handles empty string", () => {
    assert.equal(tokenize("").size, 0);
  });

  it("strips punctuation", () => {
    const tokens = tokenize("hello, world! how's it going?");
    assert.ok(tokens.has("hello"));
    assert.ok(tokens.has("world"));
    assert.ok(tokens.has("how"));
    assert.ok(tokens.has("s"));
    assert.ok(tokens.has("it"));
    assert.ok(tokens.has("going"));
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const a = new Set(["hello", "world"]);
    const b = new Set(["hello", "world"]);
    assert.equal(jaccardSimilarity(a, b), 1);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["hello"]);
    const b = new Set(["world"]);
    assert.equal(jaccardSimilarity(a, b), 0);
  });

  it("returns correct value for partial overlap", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection=2, union=4
    assert.equal(jaccardSimilarity(a, b), 0.5);
  });

  it("returns 1 for two empty sets", () => {
    assert.equal(jaccardSimilarity(new Set(), new Set()), 1);
  });

  it("returns 0 when one set is empty", () => {
    assert.equal(jaccardSimilarity(new Set(["a"]), new Set()), 0);
    assert.equal(jaccardSimilarity(new Set(), new Set(["a"])), 0);
  });
});

// -----------------------------------------------------------------------
// mmrFilter tests
// -----------------------------------------------------------------------
describe("mmrFilter", () => {
  it("returns empty array for null/undefined/empty", () => {
    assert.deepEqual(mmrFilter(null), []);
    assert.deepEqual(mmrFilter(undefined), []);
    assert.deepEqual(mmrFilter([]), []);
  });

  it("returns single result unchanged", () => {
    const results = [{ text: "only one", score: 0.9 }];
    assert.deepEqual(mmrFilter(results), results);
  });

  it("always selects first result (highest score)", () => {
    const results = [
      { text: "best match found here", score: 0.9 },
      { text: "second best match here", score: 0.7 },
    ];
    const filtered = mmrFilter(results, 0.7);
    assert.equal(filtered[0].text, "best match found here");
  });

  it("penalizes redundant results", () => {
    const results = [
      { text: "the cat sat on the mat", score: 0.9 },
      { text: "the cat sat on the mat today", score: 0.85 }, // very similar
      { text: "the dog ran through the park", score: 0.7 },  // diverse
    ];
    const filtered = mmrFilter(results, 0.7, 2);

    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].text, "the cat sat on the mat");
    // Second result should be the diverse one, not the near-duplicate
    assert.equal(filtered[1].text, "the dog ran through the park");
  });

  it("respects maxResults", () => {
    const results = [
      { text: "result one about coding", score: 0.9 },
      { text: "result two about testing", score: 0.8 },
      { text: "result three about deployment", score: 0.7 },
    ];
    const filtered = mmrFilter(results, 0.7, 2);
    assert.equal(filtered.length, 2);
  });

  it("with lambda=1.0 acts as pure relevance (no diversity penalty)", () => {
    const results = [
      { text: "identical content here", score: 0.9 },
      { text: "identical content here", score: 0.8 }, // exact duplicate
      { text: "different content entirely", score: 0.7 },
    ];
    const filtered = mmrFilter(results, 1.0, 3);
    // Lambda=1.0 means no diversity penalty, so order follows score
    assert.equal(filtered[0].score, 0.9);
    assert.equal(filtered[1].score, 0.8);
    assert.equal(filtered[2].score, 0.7);
  });
});
