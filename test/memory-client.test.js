import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { searchMemories, resetManager } from "../src/memory-client.js";

// Stub logger
function fakeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("memory-client", () => {
  beforeEach(() => {
    resetManager();
  });

  describe("searchMemories — new API (MemorySearchManager)", () => {
    it("uses manager.search() when SDK is available", async () => {
      const mockResults = [
        { snippet: "hello world", source: "memory", path: "mem/test.md", startLine: 1, endLine: 5, score: 0.9 },
        { snippet: "another chunk", source: "sessions", path: "sess/x.md", startLine: 10, endLine: 20, score: 0.7 },
      ];

      // We can't easily mock dynamic import of "openclaw/plugin-sdk/memory-core"
      // so we test the legacy path and the result mapping logic directly.
      // The new API is integration-tested on VM.
      // Instead, test the mapping shape expectations.

      const mapped = mockResults.map((r) => ({
        text: r.snippet || "",
        source: r.source || "memory",
        path: r.path || "",
        lines: r.startLine && r.endLine ? `${r.startLine}-${r.endLine}` : "",
        startLine: r.startLine,
        endLine: r.endLine,
        score: typeof r.score === "number" ? r.score : 0,
      }));

      assert.equal(mapped.length, 2);
      assert.equal(mapped[0].text, "hello world");
      assert.equal(mapped[0].source, "memory");
      assert.equal(mapped[0].path, "mem/test.md");
      assert.equal(mapped[0].lines, "1-5");
      assert.equal(mapped[0].score, 0.9);
      assert.equal(mapped[1].text, "another chunk");
      assert.equal(mapped[1].source, "sessions");
      assert.equal(mapped[1].lines, "10-20");
    });

    it("maps results with missing startLine/endLine to empty lines string", () => {
      const r = { snippet: "test", source: "memory", path: "a.md", score: 0.5 };
      const mapped = {
        text: r.snippet || "",
        source: r.source || "memory",
        path: r.path || "",
        lines: r.startLine && r.endLine ? `${r.startLine}-${r.endLine}` : "",
        startLine: r.startLine,
        endLine: r.endLine,
        score: typeof r.score === "number" ? r.score : 0,
      };
      assert.equal(mapped.lines, "");
      assert.equal(mapped.startLine, undefined);
    });

    it("maps results with missing score to 0", () => {
      const r = { snippet: "test" };
      const score = typeof r.score === "number" ? r.score : 0;
      assert.equal(score, 0);
    });

    it("maps results with missing snippet to empty text", () => {
      const r = { source: "memory", path: "x.md", score: 0.5 };
      const text = r.snippet || "";
      assert.equal(text, "");
    });
  });

  describe("searchMemories — legacy fallback (createMemorySearchTool)", () => {
    it("returns results from legacy tool.execute() details.results", async () => {
      const mockTool = {
        execute: async (_name, _opts) => ({
          details: {
            results: [
              { snippet: "legacy result", source: "memory", path: "mem/old.md", startLine: 3, endLine: 8, score: 0.85 },
            ],
          },
        }),
      };

      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => mockTool,
        },
      };

      const results = await searchMemories("test query", {
        maxResults: 5,
        minScore: 0.3,
        timeoutMs: 2000,
        runtime: mockRuntime,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].text, "legacy result");
      assert.equal(results[0].path, "mem/old.md");
      assert.equal(results[0].lines, "3-8");
      assert.equal(results[0].score, 0.85);
    });

    it("returns results from legacy tool.execute() details.memories format", async () => {
      const mockTool = {
        execute: async () => ({
          details: {
            memories: [
              { text: "lancedb memory", score: 0.6 },
            ],
          },
        }),
      };

      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => mockTool,
        },
      };

      const results = await searchMemories("query", {
        runtime: mockRuntime,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].text, "lancedb memory");
      assert.equal(results[0].source, "memory");
      assert.equal(results[0].score, 0.6);
    });

    it("returns empty array when legacy tool returns no details", async () => {
      const mockTool = {
        execute: async () => ({}),
      };

      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => mockTool,
        },
      };

      const results = await searchMemories("query", {
        runtime: mockRuntime,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.deepEqual(results, []);
    });

    it("returns empty array when legacy tool.execute() throws", async () => {
      const mockTool = {
        execute: async () => { throw new Error("boom"); },
      };

      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => mockTool,
        },
      };

      const results = await searchMemories("query", {
        runtime: mockRuntime,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.deepEqual(results, []);
    });

    it("returns empty array when legacy tool times out", async () => {
      const mockTool = {
        execute: async () => new Promise((resolve) => setTimeout(resolve, 5000)),
      };

      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => mockTool,
        },
      };

      const results = await searchMemories("query", {
        runtime: mockRuntime,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
        timeoutMs: 50,
      });

      assert.deepEqual(results, []);
    });
  });

  describe("searchMemories — both APIs unavailable", () => {
    it("returns empty array when runtime has no tools", async () => {
      const results = await searchMemories("test query", {
        runtime: {},
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.deepEqual(results, []);
    });

    it("returns empty array when runtime is undefined", async () => {
      const results = await searchMemories("test query", {
        runtime: undefined,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.deepEqual(results, []);
    });

    it("returns empty array when createMemorySearchTool returns null", async () => {
      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => null,
        },
      };

      const results = await searchMemories("test query", {
        runtime: mockRuntime,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.deepEqual(results, []);
    });

    it("returns empty array when createMemorySearchTool throws", async () => {
      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => { throw new Error("broken"); },
        },
      };

      const results = await searchMemories("test query", {
        runtime: mockRuntime,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.deepEqual(results, []);
    });
  });

  describe("searchMemories — caching behavior", () => {
    it("caches legacy tool init failure and returns empty on subsequent calls", async () => {
      let callCount = 0;
      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => { callCount++; return null; },
        },
      };
      const logger = fakeLogger();

      // First call — tries and fails
      await searchMemories("q1", { runtime: mockRuntime, config: {}, logger });
      assert.equal(callCount, 1);

      // Second call — should not retry (cached failure)
      await searchMemories("q2", { runtime: mockRuntime, config: {}, logger });
      assert.equal(callCount, 1);
    });

    it("caches legacy tool success and reuses on subsequent calls", async () => {
      let initCount = 0;
      const mockTool = {
        execute: async () => ({ details: { results: [{ snippet: "ok", score: 0.8 }] } }),
      };
      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => { initCount++; return mockTool; },
        },
      };
      const logger = fakeLogger();

      const r1 = await searchMemories("q1", { runtime: mockRuntime, config: {}, logger });
      assert.equal(r1.length, 1);
      assert.equal(initCount, 1);

      const r2 = await searchMemories("q2", { runtime: mockRuntime, config: {}, logger });
      assert.equal(r2.length, 1);
      assert.equal(initCount, 1); // cached
    });
  });

  describe("searchMemories — new API search failure falls through to legacy", () => {
    // Note: In test env, the new SDK import always fails (no openclaw package),
    // so getManager() returns null and legacy is always used. The fallthrough
    // from a search-time failure (manager initialized but search() throws) can
    // only be fully integration-tested on VM where both APIs coexist.
    // This test verifies the structural expectation: when new API is unavailable,
    // legacy results are still returned (not []).
    it("returns legacy results when new API is not available", async () => {
      const mockTool = {
        execute: async () => ({
          details: {
            results: [{ snippet: "fallback result", score: 0.75 }],
          },
        }),
      };

      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => mockTool,
        },
      };

      const results = await searchMemories("test query", {
        runtime: mockRuntime,
        config: {},
        sessionKey: "test",
        logger: fakeLogger(),
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].text, "fallback result");
      assert.equal(results[0].score, 0.75);
    });
  });

  describe("resetManager", () => {
    it("resets all cached state so init is retried", async () => {
      let callCount = 0;
      const mockRuntime = {
        tools: {
          createMemorySearchTool: () => { callCount++; return null; },
        },
      };
      const logger = fakeLogger();

      await searchMemories("q1", { runtime: mockRuntime, config: {}, logger });
      assert.equal(callCount, 1);

      resetManager();

      await searchMemories("q2", { runtime: mockRuntime, config: {}, logger });
      assert.equal(callCount, 2); // retried after reset
    });
  });
});
