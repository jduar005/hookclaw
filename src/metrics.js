/**
 * Metrics collection for HookClaw performance monitoring.
 *
 * Tracks injection rates, cache behavior, latency distribution,
 * and retrieval quality over time. Outputs periodic log summaries.
 */

/**
 * Metrics collector with rolling window statistics.
 */
export class MetricsCollector {
  /**
   * @param {object} [logger] - Logger instance
   * @param {number} [summaryInterval=100] - Log summary every N calls
   */
  constructor(logger = null, summaryInterval = 100) {
    this._logger = logger;
    this._summaryInterval = summaryInterval;

    // Counters
    this._totalCalls = 0;
    this._injections = 0;
    this._cacheHits = 0;
    this._skipPatternHits = 0;
    this._shortPromptSkips = 0;
    this._noResults = 0;
    this._errors = 0;

    // Latency tracking (rolling window)
    /** @type {number[]} */
    this._latencies = [];
    this._maxLatencyWindow = 1000;

    // Score distribution
    /** @type {number[]} */
    this._topScores = [];

    // Signal usage
    this._ftsUsed = 0;

    // Start time
    this._startTime = Date.now();
  }

  /**
   * Record a hook call.
   *
   * @param {object} event
   * @param {"injection"|"cache_hit"|"skip_pattern"|"short_prompt"|"no_results"|"error"} event.outcome
   * @param {number} [event.latencyMs] - Call latency
   * @param {number} [event.topScore] - Top result score
   * @param {number} [event.resultCount] - Number of results
   * @param {boolean} [event.ftsUsed] - FTS5 keyword boost used
   */
  record(event) {
    this._totalCalls++;

    switch (event.outcome) {
      case "injection":
        this._injections++;
        break;
      case "cache_hit":
        this._cacheHits++;
        break;
      case "skip_pattern":
        this._skipPatternHits++;
        break;
      case "short_prompt":
        this._shortPromptSkips++;
        break;
      case "no_results":
        this._noResults++;
        break;
      case "error":
        this._errors++;
        break;
    }

    if (typeof event.latencyMs === "number") {
      this._latencies.push(event.latencyMs);
      if (this._latencies.length > this._maxLatencyWindow) {
        this._latencies.shift();
      }
    }

    if (typeof event.topScore === "number") {
      this._topScores.push(event.topScore);
      if (this._topScores.length > this._maxLatencyWindow) {
        this._topScores.shift();
      }
    }

    if (event.ftsUsed) this._ftsUsed++;

    // Periodic summary
    if (this._summaryInterval > 0 && this._totalCalls % this._summaryInterval === 0) {
      this.logSummary();
    }
  }

  /**
   * Get current metrics snapshot.
   */
  getSnapshot() {
    const uptimeMs = Date.now() - this._startTime;
    return {
      totalCalls: this._totalCalls,
      injections: this._injections,
      injectionRate: this._totalCalls > 0 ? this._injections / this._totalCalls : 0,
      cacheHits: this._cacheHits,
      cacheHitRate: this._totalCalls > 0 ? this._cacheHits / this._totalCalls : 0,
      skipPatternHits: this._skipPatternHits,
      shortPromptSkips: this._shortPromptSkips,
      noResults: this._noResults,
      errors: this._errors,
      latency: this._computeLatencyStats(),
      topScoreAvg: this._computeAverage(this._topScores),
      ftsUsed: this._ftsUsed,
      uptimeMs,
    };
  }

  /**
   * Log a summary to the logger.
   */
  logSummary() {
    if (!this._logger) return;

    const snap = this.getSnapshot();
    const latency = snap.latency;

    this._logger.info(
      `hookclaw metrics: ${snap.totalCalls} calls | ` +
      `${(snap.injectionRate * 100).toFixed(0)}% inject | ` +
      `${(snap.cacheHitRate * 100).toFixed(0)}% cache | ` +
      `p50=${latency.p50}ms p95=${latency.p95}ms | ` +
      `avg_score=${snap.topScoreAvg.toFixed(3)} | ` +
      `fts=${snap.ftsUsed}`
    );
  }

  /**
   * Compute latency percentiles.
   */
  _computeLatencyStats() {
    if (this._latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 };
    }

    const sorted = [...this._latencies].sort((a, b) => a - b);
    return {
      p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      p99: sorted[Math.floor(sorted.length * 0.99)] || 0,
      avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }

  /**
   * Compute average of an array.
   * @param {number[]} arr
   * @returns {number}
   */
  _computeAverage(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  /**
   * Reset all metrics.
   */
  reset() {
    this._totalCalls = 0;
    this._injections = 0;
    this._cacheHits = 0;
    this._skipPatternHits = 0;
    this._shortPromptSkips = 0;
    this._noResults = 0;
    this._errors = 0;
    this._latencies = [];
    this._topScores = [];
    this._ftsUsed = 0;
    this._startTime = Date.now();
  }
}
