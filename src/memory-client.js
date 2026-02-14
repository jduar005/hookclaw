/**
 * Memory search client — wraps OpenClaw's getMemorySearchManager
 * with caching, timeout, and graceful fallback.
 *
 * Uses the built-in memory-core search index (SQLite + embeddings).
 */

/** @type {import('openclaw/plugin-sdk').MemorySearchManager | null} */
let _manager = null;
let _initFailed = false;
let _initPromise = null;

/**
 * Initialize the memory search manager from OpenClaw internals.
 * Caches the instance across calls for SQLite connection reuse.
 *
 * @param {object} params
 * @param {object} params.config - OpenClaw config object
 * @param {string} params.agentId - Agent identifier
 * @param {object} params.logger - Plugin logger
 * @returns {Promise<import('openclaw/plugin-sdk').MemorySearchManager | null>}
 */
async function getManager({ config, agentId, logger }) {
  if (_initFailed) return null;
  if (_manager) return _manager;

  // Deduplicate concurrent init calls
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const { getMemorySearchManager } = await import("openclaw/plugin-sdk");
      const result = await getMemorySearchManager({ cfg: config, agentId: agentId || "hookclaw" });

      if (!result.manager) {
        logger.warn(`hookclaw: memory manager unavailable — ${result.error || "unknown reason"}`);
        _initFailed = true;
        return null;
      }

      _manager = result.manager;
      logger.info("hookclaw: memory search manager initialized");
      return _manager;
    } catch (err) {
      _initFailed = true;
      logger.error(`hookclaw: failed to initialize memory search manager — ${err.message}`);
      return null;
    } finally {
      _initPromise = null;
    }
  })();

  return _initPromise;
}

/**
 * Search memory index for chunks relevant to the query.
 *
 * @param {string} query - The user's prompt text
 * @param {object} options
 * @param {number} options.maxResults - Maximum results to return
 * @param {number} options.minScore - Minimum similarity score (0-1)
 * @param {number} options.timeoutMs - Timeout in milliseconds
 * @param {object} options.config - OpenClaw config
 * @param {string} options.agentId - Agent ID
 * @param {string} [options.sessionKey] - Session key for scoped search
 * @param {object} options.logger - Plugin logger
 * @returns {Promise<Array<{text: string, source: string, path: string, lines: string, score: number}>>}
 */
export async function searchMemories(query, { maxResults = 5, minScore = 0.3, timeoutMs = 2000, config, agentId, sessionKey, logger } = {}) {
  const manager = await getManager({ config, agentId, logger });
  if (!manager) return [];

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
      score: typeof r.score === "number" ? r.score : 0,
    }));
  } catch (err) {
    logger.warn(`hookclaw: memory search failed — ${err.message}`);
    return [];
  }
}

/**
 * Reset the cached manager (useful for testing).
 */
export function resetManager() {
  _manager = null;
  _initFailed = false;
  _initPromise = null;
}
