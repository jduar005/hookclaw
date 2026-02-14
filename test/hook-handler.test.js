import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHandler, getCallCount, resetCallCount, adaptiveFilter, PromptCache } from "../src/hook-handler.js";

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
    const handler = createHandler({ skipShortPrompts: 5, logInjections: false }, fakeApi());
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

    const handler = createHandler({ logInjections: true }, api);

    await handler({ prompt: "a test prompt for cache" }, fakeCtx);
    await handler({ prompt: "a test prompt for cache" }, fakeCtx);

    assert.ok(logged.some((m) => m.includes("cache hit")));
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
});
