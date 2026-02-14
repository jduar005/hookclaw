/**
 * before_agent_start hook handler — orchestrates memory search
 * and context injection into prompts.
 */

import { searchMemories } from "./memory-client.js";
import { formatContext } from "./context-formatter.js";

let _callCount = 0;

// ---------------------------------------------------------------------------
// Prompt dedup LRU cache — skips Gemini embedding call on repeated prompts
// ---------------------------------------------------------------------------
const DEFAULT_CACHE_SIZE = 20;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class PromptCache {
  constructor(maxSize = DEFAULT_CACHE_SIZE, ttlMs = DEFAULT_CACHE_TTL_MS) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    /** @type {Map<string, { results: Array, ts: number }>} */
    this._map = new Map();
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this._ttlMs) {
      this._map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.results;
  }

  set(key, results) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { results, ts: Date.now() });
    // Evict oldest if over capacity
    if (this._map.size > this._maxSize) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }
}

// ---------------------------------------------------------------------------
// Adaptive maxResults — vary top-k based on score distribution
// ---------------------------------------------------------------------------

/**
 * Filter results adaptively based on score quality.
 *   top score > 0.7  → keep at most 2 (strong match)
 *   top score 0.4–0.7 → keep at most maxResults (moderate match)
 *   top score < 0.4  → keep nothing (noise)
 *
 * @param {Array<{score: number}>} results
 * @param {number} maxResults - configured upper bound
 * @returns {Array}
 */
export function adaptiveFilter(results, maxResults) {
  if (!results || results.length === 0) return [];

  const topScore = results[0]?.score ?? 0;

  if (topScore < 0.4) return [];
  if (topScore > 0.7) return results.slice(0, Math.min(2, maxResults));
  return results.slice(0, maxResults);
}

/**
 * Create the hook handler with the given plugin config and API.
 *
 * @param {object} config - Resolved plugin configuration
 * @param {object} api - OpenClaw plugin API
 * @returns {Function} Hook handler function matching PluginHookHandlerMap["before_agent_start"]
 */
export function createHandler(config, api) {
  const {
    maxResults = 5,
    minScore = 0.3,
    maxContextChars = 4000,
    timeoutMs = 2000,
    logInjections = true,
    formatTemplate = "xml",
    skipShortPrompts = 10,
    cacheSize = DEFAULT_CACHE_SIZE,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    adaptiveResults = true,
  } = config;

  const logger = api.logger;
  const openClawConfig = api.config;
  const runtime = api.runtime;
  const cache = new PromptCache(cacheSize, cacheTtlMs);

  /**
   * Hook handler called before the agent processes each prompt.
   *
   * @param {import('openclaw/plugin-sdk').PluginHookBeforeAgentStartEvent} event
   * @param {import('openclaw/plugin-sdk').PluginHookAgentContext} ctx
   * @returns {Promise<import('openclaw/plugin-sdk').PluginHookBeforeAgentStartResult | void>}
   */
  return async function handleBeforeAgentStart(event, ctx) {
    _callCount++;
    const callNum = _callCount;

    const prompt = event?.prompt;
    if (!prompt || typeof prompt !== "string") return;

    const trimmed = prompt.trim();

    // Skip short prompts (greetings, single words, etc.)
    if (trimmed.length < skipShortPrompts) {
      if (logInjections) {
        logger.info(`hookclaw: #${callNum} skip — prompt too short (${trimmed.length} chars)`);
      }
      return;
    }

    const startTime = Date.now();

    // Check prompt dedup cache
    const cached = cache.get(trimmed);
    if (cached !== undefined) {
      if (cached.length === 0) {
        if (logInjections) {
          logger.info(`hookclaw: #${callNum} cache hit — no results (0ms)`);
        }
        return;
      }
      const context = formatContext(cached, { formatTemplate, maxContextChars });
      if (context) {
        if (logInjections) {
          const topScore = cached[0]?.score?.toFixed(3) || "?";
          logger.info(
            `hookclaw: #${callNum} cache hit — injecting ${cached.length} memories (0ms, top score: ${topScore})`
          );
        }
        return { prependContext: context };
      }
      return;
    }

    const rawResults = await searchMemories(prompt, {
      maxResults,
      minScore,
      timeoutMs,
      runtime,
      config: openClawConfig,
      sessionKey: ctx?.sessionKey,
      logger,
    });

    // Apply adaptive filtering
    const results = adaptiveResults
      ? adaptiveFilter(rawResults, maxResults)
      : rawResults;

    // Cache the (possibly filtered) results
    cache.set(trimmed, results || []);

    if (!results || results.length === 0) {
      if (logInjections) {
        const rawCount = rawResults?.length || 0;
        const topScore = rawResults?.[0]?.score?.toFixed(3) || "?";
        const reason = rawCount > 0
          ? `${rawCount} results filtered out (top score: ${topScore})`
          : "no relevant memories found";
        logger.info(`hookclaw: #${callNum} ${reason} (${Date.now() - startTime}ms)`);
      }
      return;
    }

    const context = formatContext(results, { formatTemplate, maxContextChars });

    if (!context) {
      if (logInjections) {
        logger.info(`hookclaw: #${callNum} memories found but formatting produced empty context`);
      }
      return;
    }

    if (logInjections) {
      const elapsed = Date.now() - startTime;
      const topScore = results[0]?.score?.toFixed(3) || "?";
      logger.info(
        `hookclaw: #${callNum} injecting ${results.length} memories (${elapsed}ms, top score: ${topScore})`
      );
    }

    return { prependContext: context };
  };
}

/**
 * Get the current call count (useful for testing/diagnostics).
 */
export function getCallCount() {
  return _callCount;
}

/**
 * Reset call count (for testing).
 */
export function resetCallCount() {
  _callCount = 0;
}

// Export for testing
export { PromptCache };
