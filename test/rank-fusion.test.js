import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuseResults } from "../src/rank-fusion.js";

describe("fuseResults", () => {
  it("returns empty for no inputs", () => {
    assert.deepEqual(fuseResults(), []);
    assert.deepEqual(fuseResults({ vectorResults: [], bm25Results: [] }), []);
  });

  it("returns vector-only results when no BM25", () => {
    const vectorResults = [
      { text: "result A", path: "a.md", source: "memory", lines: "", score: 0.9 },
      { text: "result B", path: "b.md", source: "memory", lines: "", score: 0.7 },
    ];
    const fused = fuseResults({ vectorResults, bm25Results: [] });
    assert.ok(fused.length > 0);
    // All vector results should be present
    assert.ok(fused.some((r) => r.path === "a.md"));
    assert.ok(fused.some((r) => r.path === "b.md"));
  });

  it("returns BM25-only results when no vector", () => {
    const bm25Results = [
      { text: "keyword match A", path: "a.md", source: "memory", lines: "", score: 5.2 },
    ];
    const fused = fuseResults({ vectorResults: [], bm25Results });
    assert.equal(fused.length, 1);
    assert.equal(fused[0].path, "a.md");
  });

  it("merges and deduplicates results from both signals", () => {
    const vectorResults = [
      { text: "shared doc content", path: "shared.md", source: "memory", lines: "", score: 0.9 },
      { text: "vector only doc", path: "vector.md", source: "memory", lines: "", score: 0.7 },
    ];
    const bm25Results = [
      { text: "shared doc content", path: "shared.md", source: "memory", lines: "", score: 4.5 },
      { text: "bm25 only doc", path: "bm25.md", source: "memory", lines: "", score: 3.2 },
    ];

    const fused = fuseResults({ vectorResults, bm25Results });

    // Should have 3 unique docs (shared is deduped)
    assert.equal(fused.length, 3);

    // Shared doc should rank highest (appears in both signals)
    assert.equal(fused[0].path, "shared.md");
  });

  it("respects maxResults", () => {
    const vectorResults = [
      { text: "a", path: "1.md", source: "memory", lines: "", score: 0.9 },
      { text: "b", path: "2.md", source: "memory", lines: "", score: 0.8 },
      { text: "c", path: "3.md", source: "memory", lines: "", score: 0.7 },
    ];
    const fused = fuseResults({ vectorResults, maxResults: 2 });
    assert.equal(fused.length, 2);
  });

  it("boosts documents appearing in both signals", () => {
    const vectorResults = [
      { text: "only in vector", path: "v.md", source: "memory", lines: "", score: 0.95 },
      { text: "in both signals", path: "both.md", source: "memory", lines: "", score: 0.6 },
    ];
    const bm25Results = [
      { text: "in both signals", path: "both.md", source: "memory", lines: "", score: 3.5 },
      { text: "only in bm25", path: "b.md", source: "memory", lines: "", score: 2.0 },
    ];

    const fused = fuseResults({ vectorResults, bm25Results });

    // Document appearing in both signals should rank #1 due to combined RRF score
    assert.equal(fused[0].path, "both.md");
  });

  it("includes recency signal in ranking", () => {
    const vectorResults = [
      { text: "old content", path: "memory/2025-01-01.md", source: "memory", lines: "", score: 0.8 },
      { text: "new content", path: "memory/2026-02-14.md", source: "memory", lines: "", score: 0.8 },
    ];

    // With equal vector scores, recency should break the tie
    const fused = fuseResults({
      vectorResults,
      bm25Results: [],
      weights: { vector: 0.3, bm25: 0, recency: 0.7, entity: 0 },
    });

    assert.equal(fused[0].path, "memory/2026-02-14.md");
  });

  it("applies temporal filter", () => {
    const vectorResults = [
      { text: "old result", path: "memory/2025-01-01.md", source: "memory", lines: "", score: 0.9 },
      { text: "recent result", path: "memory/2026-02-10.md", source: "memory", lines: "", score: 0.7 },
    ];

    const fused = fuseResults({
      vectorResults,
      temporalFilter: {
        startDate: new Date("2026-02-01T00:00:00Z"),
        endDate: new Date("2026-02-28T00:00:00Z"),
      },
    });

    // Only the February 2026 result should survive the filter
    assert.equal(fused.length, 1);
    assert.equal(fused[0].path, "memory/2026-02-10.md");
  });

  it("keeps docs without dates when temporal filter is active", () => {
    const vectorResults = [
      { text: "no date doc", path: "notes.md", source: "memory", lines: "", score: 0.8 },
      { text: "old doc", path: "memory/2020-01-01.md", source: "memory", lines: "", score: 0.7 },
    ];

    const fused = fuseResults({
      vectorResults,
      temporalFilter: {
        startDate: new Date("2026-01-01T00:00:00Z"),
        endDate: new Date("2026-12-31T00:00:00Z"),
      },
    });

    // notes.md has no date -> kept; old doc filtered out
    assert.equal(fused.length, 1);
    assert.equal(fused[0].path, "notes.md");
  });

  it("includes RRF details in results", () => {
    const vectorResults = [
      { text: "doc A", path: "a.md", source: "memory", lines: "", score: 0.9 },
    ];

    const fused = fuseResults({ vectorResults });
    assert.ok(fused[0]._rrfDetails);
    assert.equal(fused[0]._rrfDetails.vectorRank, 1);
  });

  it("handles custom weights", () => {
    const vectorResults = [
      { text: "doc A", path: "a.md", source: "memory", lines: "", score: 0.9 },
    ];
    const bm25Results = [
      { text: "doc B", path: "b.md", source: "memory", lines: "", score: 5.0 },
    ];

    // Weight BM25 very heavily
    const fused = fuseResults({
      vectorResults,
      bm25Results,
      weights: { vector: 0.1, bm25: 0.9, recency: 0, entity: 0 },
    });

    // BM25-only doc should rank higher with BM25-heavy weights
    assert.equal(fused[0].path, "b.md");
  });
});
