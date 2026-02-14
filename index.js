/**
 * HookClaw — OpenClaw Memory RAG Plugin
 *
 * Automatically injects relevant memories into every prompt
 * via the before_agent_start hook. Uses the built-in memory-core
 * search index (SQLite + Gemini embeddings).
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
  description: "Automatically injects relevant memories into every prompt via before_agent_start hook",
  version: "1.1.0",

  /**
   * Called by OpenClaw plugin loader on startup.
   * @param {import('openclaw/plugin-sdk').OpenClawPluginApi} api
   */
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const handler = createHandler(config, api);

    api.on("before_agent_start", handler, { priority: 10 });

    api.logger.info(
      `hookclaw: registered before_agent_start hook (maxResults=${config.maxResults}, ` +
        `minScore=${config.minScore}, timeout=${config.timeoutMs}ms, format=${config.formatTemplate})`
    );
  },
};
