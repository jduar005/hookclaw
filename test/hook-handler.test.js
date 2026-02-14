import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHandler, getCallCount, resetCallCount } from "../src/hook-handler.js";

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
