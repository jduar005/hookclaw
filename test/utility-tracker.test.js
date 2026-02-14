import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { UtilityTracker, defaultStoragePath } from "../src/utility-tracker.js";

let tmpDir;
let storagePath;

describe("UtilityTracker", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hookclaw-test-"));
    storagePath = join(tmpDir, "utility-scores.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates with empty state", () => {
    const tracker = new UtilityTracker(storagePath);
    const summary = tracker.getSummary();
    assert.equal(summary.trackedChunks, 0);
    assert.equal(summary.totalRetrievals, 0);
    tracker.destroy();
  });

  it("records injections and increments retrievals", () => {
    const tracker = new UtilityTracker(storagePath);
    tracker.recordInjection("session1", [
      { path: "memory/2026-02-14.md", text: "important note" },
      { path: "memory/2026-02-13.md", text: "another note" },
    ]);

    const summary = tracker.getSummary();
    assert.equal(summary.trackedChunks, 2);
    assert.equal(summary.totalRetrievals, 2);
    assert.equal(summary.totalCitations, 0);
    tracker.destroy();
  });

  it("records responses and detects citations", () => {
    const tracker = new UtilityTracker(storagePath);

    tracker.recordInjection("session1", [
      { path: "memory/authentication-flow.md", text: "the authentication flow uses JWT tokens" },
    ]);

    // Response references authentication — should count as citation
    tracker.recordResponse("session1", "The authentication flow is handled by JWT tokens in the middleware");

    const entries = tracker.getAllEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].retrievals, 1);
    assert.equal(entries[0].citations, 1);
    tracker.destroy();
  });

  it("does not count citation when response is unrelated", () => {
    const tracker = new UtilityTracker(storagePath);

    tracker.recordInjection("session1", [
      { path: "memory/database-config.md", text: "database configuration" },
    ]);

    // Response doesn't reference database at all
    tracker.recordResponse("session1", "The weather today is sunny and warm");

    const entries = tracker.getAllEntries();
    assert.equal(entries[0].citations, 0);
    tracker.destroy();
  });

  it("returns neutral utility score with few observations", () => {
    const tracker = new UtilityTracker(storagePath);

    tracker.recordInjection("s1", [{ path: "a.md", text: "test" }]);

    // Only 1 retrieval — below MIN_RETRIEVALS_FOR_SCORE
    const score = tracker.getUtilityScore("a.md");
    assert.equal(score, 0.5); // Neutral default
    tracker.destroy();
  });

  it("computes Bayesian-smoothed utility score", () => {
    const tracker = new UtilityTracker(storagePath);

    // Simulate multiple retrievals with citations
    for (let i = 0; i < 5; i++) {
      tracker.recordInjection(`s${i}`, [{ path: "good.md", text: "useful memory content here" }]);
      tracker.recordResponse(`s${i}`, "memory content helped with useful context here");
    }

    for (let i = 0; i < 5; i++) {
      tracker.recordInjection(`n${i}`, [{ path: "bad.md", text: "irrelevant memory noise" }]);
      tracker.recordResponse(`n${i}`, "completely different topic about weather");
    }

    const goodScore = tracker.getUtilityScore("good.md");
    const badScore = tracker.getUtilityScore("bad.md");

    // Good memory should have higher utility
    assert.ok(goodScore > badScore, `Expected good (${goodScore}) > bad (${badScore})`);
    // Both should be between 0 and 1
    assert.ok(goodScore > 0 && goodScore <= 1);
    assert.ok(badScore >= 0 && badScore <= 1);
    tracker.destroy();
  });

  it("persists and loads scores from disk", async () => {
    const tracker1 = new UtilityTracker(storagePath);
    tracker1.recordInjection("s1", [{ path: "a.md", text: "test" }]);
    tracker1.recordInjection("s2", [{ path: "a.md", text: "test" }]);
    await tracker1.save();
    tracker1.destroy();

    const tracker2 = new UtilityTracker(storagePath);
    await tracker2.load();
    const entries = tracker2.getAllEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].retrievals, 2);
    tracker2.destroy();
  });

  it("handles load from non-existent file gracefully", async () => {
    const tracker = new UtilityTracker(join(tmpDir, "nonexistent.json"));
    await tracker.load(); // Should not throw
    assert.equal(tracker.getSummary().trackedChunks, 0);
    tracker.destroy();
  });

  it("handles response without prior injection gracefully", () => {
    const tracker = new UtilityTracker(storagePath);
    // No injection for this session — should not throw
    tracker.recordResponse("orphan-session", "some response text");
    assert.equal(tracker.getSummary().trackedChunks, 0);
    tracker.destroy();
  });

  it("clears all data", () => {
    const tracker = new UtilityTracker(storagePath);
    tracker.recordInjection("s1", [{ path: "a.md", text: "test" }]);
    assert.equal(tracker.getSummary().trackedChunks, 1);

    tracker.clear();
    assert.equal(tracker.getSummary().trackedChunks, 0);
    tracker.destroy();
  });

  it("gets utility scores for multiple chunks", () => {
    const tracker = new UtilityTracker(storagePath);
    const chunks = [
      { path: "a.md", text: "chunk a" },
      { path: "b.md", text: "chunk b" },
    ];

    const scores = tracker.getUtilityScores(chunks);
    assert.equal(scores.size, 2);
    assert.equal(scores.get("a.md"), 0.5); // Neutral for untracked
    assert.equal(scores.get("b.md"), 0.5);
    tracker.destroy();
  });

  it("provides meaningful summary", () => {
    const tracker = new UtilityTracker(storagePath);

    for (let i = 0; i < 3; i++) {
      tracker.recordInjection(`s${i}`, [{ path: "a.md", text: "content" }]);
    }

    const summary = tracker.getSummary();
    assert.equal(summary.trackedChunks, 1);
    assert.equal(summary.totalRetrievals, 3);
    assert.equal(summary.totalCitations, 0);
    assert.equal(summary.overallCitationRate, 0);
    tracker.destroy();
  });
});

describe("defaultStoragePath", () => {
  it("returns a path ending with utility-scores.json", () => {
    const path = defaultStoragePath();
    assert.ok(path.endsWith("utility-scores.json"));
  });

  it("uses pluginDir when provided", () => {
    const path = defaultStoragePath("/custom/dir");
    assert.ok(path.includes("custom"));
    assert.ok(path.endsWith("utility-scores.json"));
  });
});
