import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetricsCollector } from "../src/metrics.js";

describe("MetricsCollector", () => {
  it("starts with zero counts", () => {
    const m = new MetricsCollector();
    const snap = m.getSnapshot();
    assert.equal(snap.totalCalls, 0);
    assert.equal(snap.injections, 0);
    assert.equal(snap.cacheHits, 0);
    assert.equal(snap.errors, 0);
  });

  it("records injection events", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "injection", latencyMs: 150, topScore: 0.85 });
    m.record({ outcome: "injection", latencyMs: 200, topScore: 0.72 });

    const snap = m.getSnapshot();
    assert.equal(snap.totalCalls, 2);
    assert.equal(snap.injections, 2);
    assert.equal(snap.injectionRate, 1.0);
  });

  it("records cache hit events", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "cache_hit" });
    m.record({ outcome: "cache_hit" });
    m.record({ outcome: "injection", latencyMs: 100 });

    const snap = m.getSnapshot();
    assert.equal(snap.cacheHits, 2);
    assert.ok(snap.cacheHitRate > 0.6);
  });

  it("records skip pattern events", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "skip_pattern" });

    const snap = m.getSnapshot();
    assert.equal(snap.skipPatternHits, 1);
  });

  it("records short prompt events", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "short_prompt" });

    const snap = m.getSnapshot();
    assert.equal(snap.shortPromptSkips, 1);
  });

  it("records no_results events", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "no_results" });

    const snap = m.getSnapshot();
    assert.equal(snap.noResults, 1);
  });

  it("records error events", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "error" });

    const snap = m.getSnapshot();
    assert.equal(snap.errors, 1);
  });

  it("computes latency percentiles", () => {
    const m = new MetricsCollector();
    // Add 100 latency values
    for (let i = 1; i <= 100; i++) {
      m.record({ outcome: "injection", latencyMs: i * 2 });
    }

    const snap = m.getSnapshot();
    assert.ok(snap.latency.p50 > 0);
    assert.ok(snap.latency.p95 > snap.latency.p50);
    assert.ok(snap.latency.p99 >= snap.latency.p95);
    assert.equal(snap.latency.min, 2);
    assert.equal(snap.latency.max, 200);
  });

  it("computes average top score", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "injection", topScore: 0.8 });
    m.record({ outcome: "injection", topScore: 0.6 });

    const snap = m.getSnapshot();
    assert.ok(Math.abs(snap.topScoreAvg - 0.7) < 0.01);
  });

  it("tracks FTS5 usage", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "injection", ftsUsed: true });
    m.record({ outcome: "injection", ftsUsed: true });
    m.record({ outcome: "injection" });

    const snap = m.getSnapshot();
    assert.equal(snap.ftsUsed, 2);
  });

  it("handles empty latency stats", () => {
    const m = new MetricsCollector();
    const snap = m.getSnapshot();
    assert.equal(snap.latency.p50, 0);
    assert.equal(snap.latency.avg, 0);
  });

  it("resets all metrics", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "injection", latencyMs: 100, topScore: 0.8 });
    m.record({ outcome: "cache_hit" });
    m.record({ outcome: "error" });

    m.reset();
    const snap = m.getSnapshot();
    assert.equal(snap.totalCalls, 0);
    assert.equal(snap.injections, 0);
    assert.equal(snap.cacheHits, 0);
    assert.equal(snap.errors, 0);
    assert.equal(snap.latency.p50, 0);
  });

  it("logs periodic summary", () => {
    const logged = [];
    const logger = { info: (msg) => logged.push(msg) };
    const m = new MetricsCollector(logger, 5); // Summary every 5 calls

    for (let i = 0; i < 5; i++) {
      m.record({ outcome: "injection", latencyMs: 100, topScore: 0.8 });
    }

    assert.ok(logged.some((msg) => msg.includes("hookclaw metrics")));
    assert.ok(logged.some((msg) => msg.includes("inject")));
  });

  it("does not log when summaryInterval is 0", () => {
    const logged = [];
    const logger = { info: (msg) => logged.push(msg) };
    const m = new MetricsCollector(logger, 0);

    for (let i = 0; i < 100; i++) {
      m.record({ outcome: "injection" });
    }

    assert.equal(logged.length, 0);
  });

  it("tracks uptime", () => {
    const m = new MetricsCollector();
    const snap = m.getSnapshot();
    assert.ok(snap.uptimeMs >= 0);
  });

  it("computes injection rate correctly for mixed events", () => {
    const m = new MetricsCollector();
    m.record({ outcome: "injection" });
    m.record({ outcome: "no_results" });
    m.record({ outcome: "cache_hit" });
    m.record({ outcome: "skip_pattern" });

    const snap = m.getSnapshot();
    assert.equal(snap.totalCalls, 4);
    assert.equal(snap.injectionRate, 0.25);
  });
});
