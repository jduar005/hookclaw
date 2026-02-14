/**
 * Memory search client — wraps OpenClaw's createMemorySearchTool
 * to execute memory searches programmatically.
 *
 * Uses the built-in memory-core search index (SQLite + embeddings).
 */

/** @type {object | null} */
let _tool = null;
let _initFailed = false;

/**
 * Initialize the memory search tool from OpenClaw runtime.
 * Caches the tool instance across calls.
 *
 * @param {object} params
 * @param {object} params.runtime - OpenClaw PluginRuntime
 * @param {object} params.config - OpenClaw config object
 * @param {string} params.sessionKey - Agent session key
 * @param {object} params.logger - Plugin logger
 * @returns {object | null}
 */
function getTool({ runtime, config, sessionKey, logger }) {
  if (_initFailed) return null;
  if (_tool) return _tool;

  try {
    const tool = runtime.tools.createMemorySearchTool({
      config,
      agentSessionKey: sessionKey,
    });

    if (!tool) {
      logger.warn("hookclaw: memory search tool unavailable (createMemorySearchTool returned null)");
      _initFailed = true;
      return null;
    }

    _tool = tool;
    logger.info("hookclaw: memory search tool initialized");
    return _tool;
  } catch (err) {
    _initFailed = true;
    logger.error(`hookclaw: failed to create memory search tool — ${err.message}`);
    return null;
  }
}

/**
 * Search memory index for chunks relevant to the query.
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
  const tool = getTool({ runtime, config, sessionKey, logger });
  if (!tool) return [];

  try {
    const rawResult = await Promise.race([
      tool.execute("hookclaw-search", { query, maxResults, minScore }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Memory search timeout")), timeoutMs)
      ),
    ]);

    // The tool returns { content: [{ type: "text", text: "..." }], details: { results, count } }
    // Parse the results from the details or from the text content
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
 * Reset the cached tool (useful for testing).
 */
export function resetManager() {
  _tool = null;
  _initFailed = false;
}
