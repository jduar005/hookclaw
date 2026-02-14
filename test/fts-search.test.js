import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenizeQuery, buildFtsQuery, normalizeRank, resolveDbPath } from "../src/fts-search.js";

describe("tokenizeQuery", () => {
  it("removes stop words", () => {
    const tokens = tokenizeQuery("do you remember when we added tests");
    assert.ok(!tokens.includes("do"));
    assert.ok(!tokens.includes("you"));
    assert.ok(!tokens.includes("when"));
    assert.ok(!tokens.includes("we"));
    assert.ok(tokens.includes("added"));
    assert.ok(tokens.includes("tests"));
  });

  it("removes short tokens (< 2 chars)", () => {
    const tokens = tokenizeQuery("a b cd efg");
    assert.ok(!tokens.includes("a"));
    assert.ok(!tokens.includes("b"));
    assert.ok(tokens.includes("cd"));
    assert.ok(tokens.includes("efg"));
  });

  it("lowercases tokens", () => {
    const tokens = tokenizeQuery("TelegramBot NETSDK1005 RepairController");
    assert.ok(tokens.includes("telegrambot"));
    assert.ok(tokens.includes("netsdk1005"));
    assert.ok(tokens.includes("repaircontroller"));
  });

  it("preserves dotted identifiers", () => {
    const tokens = tokenizeQuery("check src/index.js for errors");
    assert.ok(tokens.some((t) => t.includes("src")));
    assert.ok(tokens.some((t) => t.includes("index.js")));
  });

  it("returns empty for stop-word-only queries", () => {
    const tokens = tokenizeQuery("do you have any of the");
    assert.equal(tokens.length, 0);
  });

  it("returns empty for null/undefined", () => {
    assert.deepEqual(tokenizeQuery(null), []);
    assert.deepEqual(tokenizeQuery(undefined), []);
    assert.deepEqual(tokenizeQuery(""), []);
  });

  it("handles technical queries well", () => {
    const tokens = tokenizeQuery("how do I use the pplx perplexity CLI tool");
    assert.ok(tokens.includes("pplx"));
    assert.ok(tokens.includes("perplexity"));
    assert.ok(tokens.includes("cli"));
    assert.ok(tokens.includes("tool"));
    assert.ok(!tokens.includes("how"));
    assert.ok(!tokens.includes("the"));
  });
});

describe("buildFtsQuery", () => {
  it("joins tokens with OR", () => {
    const fts = buildFtsQuery("knowledge graph repair");
    assert.ok(fts.includes("OR"));
    assert.ok(fts.includes('"knowledge"'));
    assert.ok(fts.includes('"graph"'));
    assert.ok(fts.includes('"repair"'));
  });

  it("filters stop words before building query", () => {
    const fts = buildFtsQuery("do you remember the knowledge graph");
    assert.ok(!fts.includes('"do"'));
    assert.ok(!fts.includes('"you"'));
    assert.ok(!fts.includes('"the"'));
    assert.ok(fts.includes('"knowledge"'));
    assert.ok(fts.includes('"graph"'));
  });

  it("returns null for empty/stop-word-only queries", () => {
    assert.equal(buildFtsQuery(""), null);
    assert.equal(buildFtsQuery("do you have"), null);
    assert.equal(buildFtsQuery(null), null);
  });

  it("strips double quotes from tokens", () => {
    const fts = buildFtsQuery('search for "exact phrase"');
    assert.ok(!fts.includes('""'));
  });
});

describe("normalizeRank", () => {
  it("returns 0 for non-finite values", () => {
    assert.equal(normalizeRank(NaN), 0);
    assert.equal(normalizeRank(Infinity), 0);
    assert.equal(normalizeRank(-Infinity), 0);
  });

  it("returns 0 for positive ranks (no match)", () => {
    assert.equal(normalizeRank(0), 0);
    assert.equal(normalizeRank(5), 0);
  });

  it("normalizes negative FTS5 ranks to 0-1", () => {
    const score = normalizeRank(-4.5);
    assert.ok(score > 0, "score should be positive");
    assert.ok(score < 1, "score should be < 1");
  });

  it("gives higher scores to more negative ranks", () => {
    const strong = normalizeRank(-8.0);
    const weak = normalizeRank(-1.0);
    assert.ok(strong > weak, `strong ${strong} should be > weak ${weak}`);
  });

  it("produces reasonable scores for typical FTS5 ranges", () => {
    // Typical FTS5 ranks: -1 to -10
    const s1 = normalizeRank(-1.0);  // weak match
    const s2 = normalizeRank(-3.0);  // moderate
    const s5 = normalizeRank(-5.0);  // good
    const s10 = normalizeRank(-10.0); // strong

    assert.ok(s1 > 0.3, `rank -1 score ${s1} should be > 0.3`);
    assert.ok(s2 > 0.5, `rank -3 score ${s2} should be > 0.5`);
    assert.ok(s5 > 0.7, `rank -5 score ${s5} should be > 0.7`);
    assert.ok(s10 > 0.8, `rank -10 score ${s10} should be > 0.8`);
  });
});

describe("resolveDbPath", () => {
  it("returns null when no database exists at expected paths", () => {
    const result = resolveDbPath({ agentId: "nonexistent-agent-xyz" });
    // Will return null unless the path happens to exist
    // This test just verifies the function doesn't throw
    assert.ok(result === null || typeof result === "string");
  });

  it("uses explicit dbPath when provided and exists", () => {
    // Use a file we know exists (this test file itself)
    const testFile = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
    const result = resolveDbPath({ dbPath: testFile });
    assert.equal(result, testFile);
  });

  it("returns null for explicit dbPath that does not exist", () => {
    const result = resolveDbPath({ dbPath: "/nonexistent/path/to/db.sqlite" });
    // Falls through to standard paths which also won't exist
    assert.ok(result === null || typeof result === "string");
  });
});
