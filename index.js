/**
 * HookClaw v2.0 — OpenClaw Memory RAG Plugin
 *
 * Multi-signal memory retrieval with:
 * - Vector search + BM25 hybrid retrieval
 * - RRF rank fusion
 * - Temporal decay scoring
 * - MMR diversity filtering
 * - Intent-gating skip patterns
 * - Fuzzy semantic cache
 * - Feedback loop via agent_end hook
 */

import { createHandler } from "./src/hook-handler.js";

/** Default configuration values */
const DEFAULTS = {
  maxResults: 3,
  minScore: 0.5,
  maxContextChars: 2000,
  timeoutMs: 2000,
  logInjections: true,
  formatTemplate: "xml",
  skipShortPrompts: 20,
  // v2.0 defaults
  halfLifeHours: 24,
  skipPatterns: null,
  enableSkipPatterns: true,
  enableBm25: false,
  enableRrf: false,
  rrfWeights: { vector: 0.4, bm25: 0.3, recency: 0.2, entity: 0.1 },
  rrfK: 60,
  enableTemporalParsing: false,
  enableFeedbackLoop: false,
  mmrLambda: 0.7,
  enableMmr: true,
  fuzzyCacheThreshold: 0.85,
};

/**
 * Merge user config with defaults.
 * @param {Record<string, unknown>} [userConfig]
 * @returns {object} Resolved config
 */
function resolveConfig(userConfig) {
  return { ...DEFAULTS, ...userConfig };
}

/** @type {import('openclaw/plugin-sdk').OpenClawPluginDefinition} */
export default {
  id: "hookclaw",
  name: "HookClaw Memory RAG",
  description: "Multi-signal memory retrieval — injects relevant memories into prompts via hybrid search, RRF fusion, and self-improving feedback",
  version: "2.0.0",

  /**
   * Called by OpenClaw plugin loader on startup.
   * @param {import('openclaw/plugin-sdk').OpenClawPluginApi} api
   */
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const handler = createHandler(config, api);

    // Register primary hook: before_agent_start
    api.on("before_agent_start", handler, { priority: 10 });

    api.logger.info(
      `hookclaw: registered before_agent_start hook (v2.0, maxResults=${config.maxResults}, ` +
        `minScore=${config.minScore}, timeout=${config.timeoutMs}ms, format=${config.formatTemplate}, ` +
        `bm25=${config.enableBm25}, rrf=${config.enableRrf}, mmr=${config.enableMmr})`
    );

    // Register feedback hook: agent_end (Phase 3)
    if (config.enableFeedbackLoop) {
      registerFeedbackHook(api, config);
    }
  },
};

/**
 * Register the agent_end feedback hook for utility tracking.
 *
 * @param {import('openclaw/plugin-sdk').OpenClawPluginApi} api
 * @param {object} config
 */
async function registerFeedbackHook(api, config) {
  try {
    const { UtilityTracker, defaultStoragePath } = await import("./src/utility-tracker.js");
    const { MetricsCollector } = await import("./src/metrics.js");

    const storagePath = defaultStoragePath();
    const tracker = new UtilityTracker(storagePath, api.logger);
    const metrics = new MetricsCollector(api.logger, 100);

    await tracker.load();

    api.on("agent_end", async (event, ctx) => {
      try {
        const sessionKey = ctx?.sessionKey || "unknown";
        const responseText = event?.response || event?.output || "";

        if (responseText) {
          tracker.recordResponse(sessionKey, responseText);
        }

        // Record metrics
        metrics.record({
          outcome: responseText ? "injection" : "no_results",
        });
      } catch {
        // Non-fatal
      }
    }, { priority: 90 });

    api.logger.info("hookclaw: registered agent_end feedback hook");
  } catch (err) {
    api.logger.warn(`hookclaw: feedback hook registration failed — ${err.message}`);
  }
}
