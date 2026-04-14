/**
 * Memory search client — wraps OpenClaw's memory search APIs.
 *
 * v2.4: Uses MemorySearchManager from openclaw/plugin-sdk/memory-core (v2026.3.28+)
 * with automatic fallback to legacy runtime.tools.createMemorySearchTool() API.
 */

// ---------------------------------------------------------------------------
// New API (v2026.3.28+) — openclaw/plugin-sdk/memory-core
// ---------------------------------------------------------------------------

/** @type {object | null | undefined} null = not tried, undefined = import failed (cached) */
let _sdk = null;
let _manager = null;
let _managerInitFailed = false;

/**
 * Lazy-load the new memory-core SDK module.
 * Caches the result (null on failure) to avoid repeated import attempts.
 * @returns {Promise<object | null>}
 */
async function loadSdk() {
  if (_sdk === undefined) return null; // previous failure cached
  if (_sdk) return _sdk;
  try {
    _sdk = await import("openclaw/plugin-sdk/memory-core");
    return _sdk;
  } catch {
    _sdk = undefined; // cache failure
    return null;
  }
}

/**
 * Resolve the agent ID for scoped memory search.
 * Tries SDK helpers first, falls back to "main".
 *
 * @param {object} sdk - The loaded SDK module
 * @param {object} params
 * @param {string} [params.sessionKey]
 * @param {object} [params.config]
 * @returns {string}
 */
function resolveAgentId(sdk, { sessionKey, config }) {
  try {
    if (sdk.resolveSessionAgentId && sessionKey) {
      return sdk.resolveSessionAgentId({ sessionKey, config });
    }
    if (sdk.resolveDefaultAgentId) {
      return sdk.resolveDefaultAgentId({ config });
    }
  } catch { /* fallback */ }
  return "main";
}

/**
 * Get or initialize the MemorySearchManager (new API).
 *
 * @param {object} params
 * @param {object} params.config - OpenClaw config
 * @param {string} [params.sessionKey] - Agent session key
 * @param {object} params.logger - Plugin logger
 * @returns {Promise<object | null>}
 */
async function getManager({ config, sessionKey, logger }) {
  if (_managerInitFailed) return null;
  if (_manager) return _manager;

  const sdk = await loadSdk();
  if (!sdk?.getMemorySearchManager) {
    _managerInitFailed = true;
    logger.warn("hookclaw: openclaw/plugin-sdk/memory-core not available");
    return null;
  }

  try {
    const agentId = resolveAgentId(sdk, { sessionKey, config });
    const { manager, error } = await sdk.getMemorySearchManager({ cfg: config, agentId });

    if (!manager) {
      logger.warn(`hookclaw: memory manager unavailable — ${error || "unknown"}`);
      _managerInitFailed = true;
      return null;
    }

    _manager = manager;
    logger.info("hookclaw: memory search manager initialized (v2026.3.28+ API)");
    return _manager;
  } catch (err) {
    _managerInitFailed = true;
    logger.error(`hookclaw: failed to init memory manager — ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy API (pre-v2026.3.28) — runtime.tools.createMemorySearchTool()
// ---------------------------------------------------------------------------

/** @type {object | null} */
let _legacyTool = null;
let _legacyFailed = false;

/**
 * Get or initialize the legacy memory search tool.
 *
 * @param {object} params
 * @param {object} params.runtime - OpenClaw PluginRuntime
 * @param {object} params.config - OpenClaw config
 * @param {string} params.sessionKey - Agent session key
 * @param {object} params.logger - Plugin logger
 * @returns {object | null}
 */
function getLegacyTool({ runtime, config, sessionKey, logger }) {
  if (_legacyFailed) return null;
  if (_legacyTool) return _legacyTool;
  try {
    const tool = runtime?.tools?.createMemorySearchTool?.({
      config,
      agentSessionKey: sessionKey,
    });
    if (!tool) {
      _legacyFailed = true;
      return null;
    }
    _legacyTool = tool;
    logger.info("hookclaw: memory search tool initialized (legacy API)");
    return _legacyTool;
  } catch {
    _legacyFailed = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search memory index for chunks relevant to the query.
 * Tries new MemorySearchManager API first, then legacy tool.execute() fallback.
 *
 * @param {string} query - The user's prompt text
 * @param {object} options
 * @param {number} options.maxResults - Maximum results to return
 * @param {number} options.minScore - Minimum similarity score (0-1)
 * @param {number} options.timeoutMs - Timeout in milliseconds
 * @param {object} options.runtime - OpenClaw PluginRuntime
 * @param {object} options.config - OpenClaw config
 * @param {string} [options.sessionKey] - Session key for scoped search
 * @param {object} options.logger - Plugin logger
 * @returns {Promise<Array<{text: string, source: string, path: string, lines: string, score: number}>>}
 */
export async function searchMemories(query, { maxResults = 5, minScore = 0.3, timeoutMs = 2000, runtime, config, sessionKey, logger } = {}) {
  // --- New API (v2026.3.28+) ---
  const manager = await getManager({ config, sessionKey, logger });
  if (manager) {
    try {
      const results = await Promise.race([
        manager.search(query, { maxResults, minScore, sessionKey }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Memory search timeout")), timeoutMs)
        ),
      ]);

      return (results || []).map((r) => ({
        text: r.snippet || "",
        source: r.source || "memory",
        path: r.path || "",
        lines: r.startLine && r.endLine ? `${r.startLine}-${r.endLine}` : "",
        startLine: r.startLine,
        endLine: r.endLine,
        score: typeof r.score === "number" ? r.score : 0,
      }));
    } catch (err) {
      logger.warn(`hookclaw: memory search failed — ${err.message}, trying legacy fallback`);
      // Fall through to legacy path instead of returning empty
    }
  }

  // --- Legacy fallback (pre-v2026.3.28) ---
  const tool = getLegacyTool({ runtime, config, sessionKey, logger });
  if (!tool) return [];

  try {
    const rawResult = await Promise.race([
      tool.execute("hookclaw-search", { query, maxResults, minScore }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Memory search timeout")), timeoutMs)
      ),
    ]);

    // The tool returns { content: [{ type: "text", text: "..." }], details: { results, count } }
    const details = rawResult?.details;
    if (details?.results && Array.isArray(details.results)) {
      return details.results.map((r) => ({
        text: r.snippet || r.text || "",
        source: r.source || "memory",
        path: r.path || "",
        lines: r.startLine && r.endLine ? `${r.startLine}-${r.endLine}` : (r.lines || ""),
        score: typeof r.score === "number" ? r.score : 0,
      }));
    }

    // Fallback: try to extract from details.memories (memory-lancedb format)
    if (details?.memories && Array.isArray(details.memories)) {
      return details.memories.map((r) => ({
        text: r.text || "",
        source: "memory",
        path: "",
        lines: "",
        score: typeof r.score === "number" ? r.score : 0,
      }));
    }

    return [];
  } catch (err) {
    logger.warn(`hookclaw: memory search failed — ${err.message}`);
    return [];
  }
}

/**
 * Reset cached state (useful for testing).
 */
export function resetManager() {
  _sdk = null;
  _manager = null;
  _managerInitFailed = false;
  _legacyTool = null;
  _legacyFailed = false;
}
