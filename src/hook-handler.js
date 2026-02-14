/**
 * before_agent_start hook handler — orchestrates memory search
 * and context injection into prompts.
 *
 * v2.1: Hybrid search — runs direct FTS5 keyword queries via node:sqlite
 * against OpenClaw's chunks_fts table, boosts vector results additively.
 * Retains temporal decay, skip patterns, fuzzy cache, MMR diversity.
 */

import { searchMemories } from "./memory-client.js";
import { formatContext } from "./context-formatter.js";

let _callCount = 0;

// ---------------------------------------------------------------------------
// Default skip patterns — prompts that never benefit from memory injection
// ---------------------------------------------------------------------------
const DEFAULT_SKIP_PATTERNS = [
  /^(write|create|generate|imagine|compose)\b/i,
  /^(format|convert|translate|calculate)\b/i,
  /^(clear|reset|start over|help|thanks|ok|yes|no|sure)\b/i,
];

/**
 * Check if a prompt matches any skip pattern.
 * @param {string} prompt - Trimmed prompt text
 * @param {Array<RegExp|string>} patterns - Skip patterns
 * @returns {boolean}
 */
export function matchesSkipPattern(prompt, patterns = DEFAULT_SKIP_PATTERNS) {
  for (const p of patterns) {
    const re = p instanceof RegExp ? p : new RegExp(p, "i");
    if (re.test(prompt)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Temporal decay — exponential decay based on chunk age
// ---------------------------------------------------------------------------

/**
 * Parse a date from a memory chunk's path field.
 * Expects paths like "memory/2026-02-12.md" or similar date patterns.
 *
 * @param {string} path - Chunk path
 * @returns {Date|null}
 */
export function parseDateFromPath(path) {
  if (!path) return null;
  // Match YYYY-MM-DD pattern anywhere in the path
  const match = path.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const d = new Date(match[1] + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Apply temporal decay to scored results.
 * finalScore = cosineScore * exp(-ageHours / halfLifeHours)
 *
 * @param {Array<{score: number, path?: string}>} results
 * @param {number} halfLifeHours - Decay half-life in hours
 * @param {number} [now] - Current timestamp (ms), defaults to Date.now()
 * @returns {Array} Results with adjusted scores, re-sorted by finalScore
 */
export function applyTemporalDecay(results, halfLifeHours = 168, now = Date.now()) {
  if (!results || results.length === 0) return [];
  if (halfLifeHours <= 0) return results;

  const decayRate = Math.LN2 / halfLifeHours;

  const decayed = results.map((r) => {
    const chunkDate = parseDateFromPath(r.path);
    if (!chunkDate) return { ...r }; // No date → no decay penalty

    const ageHours = Math.max(0, (now - chunkDate.getTime()) / (1000 * 60 * 60));
    const decayFactor = Math.exp(-decayRate * ageHours);
    return {
      ...r,
      _originalScore: r.score,
      score: r.score * decayFactor,
    };
  });

  // Re-sort by decayed score descending
  decayed.sort((a, b) => b.score - a.score);
  return decayed;
}

// ---------------------------------------------------------------------------
// Fuzzy semantic cache — Jaccard similarity on word tokens
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into lowercase word tokens.
 * @param {string} str
 * @returns {Set<string>}
 */
export function tokenize(str) {
  const tokens = str.toLowerCase().match(/\b\w+\b/g);
  return new Set(tokens || []);
}

/**
 * Compute Jaccard similarity between two token sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0-1
 */
export function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// ---------------------------------------------------------------------------
// Prompt dedup LRU cache with fuzzy matching
// ---------------------------------------------------------------------------
const DEFAULT_CACHE_SIZE = 20;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_FUZZY_THRESHOLD = 0.85;

class PromptCache {
  constructor(maxSize = DEFAULT_CACHE_SIZE, ttlMs = DEFAULT_CACHE_TTL_MS, fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._fuzzyThreshold = fuzzyThreshold;
    /** @type {Map<string, { results: Array, ts: number, tokens: Set<string> }>} */
    this._map = new Map();
  }

  get(key) {
    // Exact match first
    const entry = this._map.get(key);
    if (entry) {
      if (Date.now() - entry.ts > this._ttlMs) {
        this._map.delete(key);
      } else {
        // Move to end (most recently used)
        this._map.delete(key);
        this._map.set(key, entry);
        return entry.results;
      }
    }

    // Fuzzy match: compare against cached entries
    if (this._fuzzyThreshold < 1.0) {
      const keyTokens = tokenize(key);
      let bestMatch = null;
      let bestSim = 0;

      for (const [cachedKey, cachedEntry] of this._map) {
        if (Date.now() - cachedEntry.ts > this._ttlMs) {
          this._map.delete(cachedKey);
          continue;
        }
        const sim = jaccardSimilarity(keyTokens, cachedEntry.tokens);
        if (sim >= this._fuzzyThreshold && sim > bestSim) {
          bestSim = sim;
          bestMatch = cachedEntry;
        }
      }

      if (bestMatch) {
        // Refresh LRU position: delete and re-insert to move to end
        const matchKey = [...this._map.entries()]
          .find(([, v]) => v === bestMatch)?.[0];
        if (matchKey) {
          this._map.delete(matchKey);
          this._map.set(matchKey, bestMatch);
        }
        return bestMatch.results;
      }
    }

    return undefined;
  }

  set(key, results) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { results, ts: Date.now(), tokens: tokenize(key) });
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
// MMR — Maximal Marginal Relevance for result diversity
// ---------------------------------------------------------------------------

/**
 * Compute text similarity between two chunks using Jaccard on word tokens.
 * @param {string} textA
 * @param {string} textB
 * @returns {number} 0-1
 */
function textSimilarity(textA, textB) {
  return jaccardSimilarity(tokenize(textA || ""), tokenize(textB || ""));
}

/**
 * Apply MMR diversity filtering to remove redundant memories.
 *
 * MMR = lambda * relevance - (1 - lambda) * max_similarity_to_selected
 *
 * @param {Array<{text: string, score: number}>} results - Score-sorted results
 * @param {number} lambda - Balance between relevance and diversity (0-1, default 0.7)
 * @param {number} [maxResults] - Maximum results to return
 * @returns {Array} Diverse subset
 */
export function mmrFilter(results, lambda = 0.7, maxResults = Infinity) {
  if (!results || results.length <= 1) return results || [];

  const selected = [results[0]];
  const candidates = results.slice(1);

  while (selected.length < maxResults && candidates.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const relevance = candidate.score;

      // Max similarity to any already-selected item
      let maxSim = 0;
      for (const sel of selected) {
        const sim = textSimilarity(candidate.text, sel.text);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    selected.push(candidates[bestIdx]);
    candidates.splice(bestIdx, 1);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Adaptive maxResults — vary top-k based on score distribution
// ---------------------------------------------------------------------------

/**
 * Filter results adaptively based on score quality.
 *   top score > 0.7  -> keep at most 2 (strong match)
 *   top score 0.4-0.7 -> keep at most maxResults (moderate match)
 *   top score < 0.4  -> keep nothing (noise)
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
    // v2.0 config
    halfLifeHours = 24,
    skipPatterns = null,
    enableSkipPatterns = true,
    mmrLambda = 0.7,
    enableMmr = true,
    fuzzyCacheThreshold = DEFAULT_FUZZY_THRESHOLD,
    enableTemporalParsing = false,
    // v2.1 config — direct FTS5 keyword search
    enableFts = true,
    ftsBoostWeight = 0.3,
    ftsDbPath = null,
    ftsAgentId = "main",
    // Debug logging — logs prompt, each result path/score/snippet
    debugLogging = false,
  } = config;

  const logger = api.logger;
  const openClawConfig = api.config;
  const runtime = api.runtime;
  const cache = new PromptCache(cacheSize, cacheTtlMs, fuzzyCacheThreshold);

  // Compile skip patterns once at init (invalid user patterns are warned and skipped)
  const compiledSkipPatterns = skipPatterns
    ? skipPatterns.reduce((acc, p) => {
        if (p instanceof RegExp) { acc.push(p); return acc; }
        try { acc.push(new RegExp(p, "i")); } catch {
          logger.warn(`hookclaw: invalid skip pattern ignored: "${p}"`);
        }
        return acc;
      }, [])
    : DEFAULT_SKIP_PATTERNS;

  // Lazy-load query enricher (temporal parsing, entity extraction)
  let _queryEnricher = null;

  async function getQueryEnricher() {
    if (!enableTemporalParsing) return null;
    if (_queryEnricher === undefined) return null;
    if (_queryEnricher) return _queryEnricher;
    try {
      _queryEnricher = await import("./query-enricher.js");
      return _queryEnricher;
    } catch {
      _queryEnricher = undefined;
      return null;
    }
  }

  // Lazy-load FTS5 search module
  let _ftsModule = null;

  async function getFtsModule() {
    if (!enableFts) return null;
    if (_ftsModule === undefined) return null; // failed previously
    if (_ftsModule) return _ftsModule;
    try {
      _ftsModule = await import("./fts-search.js");
      return _ftsModule;
    } catch {
      _ftsModule = undefined;
      return null;
    }
  }

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

    // Skip pattern matching (intent gating)
    if (enableSkipPatterns && matchesSkipPattern(trimmed, compiledSkipPatterns)) {
      if (logInjections) {
        logger.info(`hookclaw: #${callNum} skip — matches skip pattern`);
      }
      return;
    }

    const startTime = Date.now();

    // Check prompt dedup cache (now with fuzzy matching)
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

    // Query enrichment (temporal parsing, entity extraction for logging)
    const enricherMod = await getQueryEnricher();
    if (enricherMod) {
      try {
        enricherMod.enrichQuery(trimmed);
      } catch {
        // Non-fatal
      }
    }

    // Memory search (vector similarity via OpenClaw)
    const rawResults = await searchMemories(prompt, {
      maxResults,
      minScore,
      timeoutMs,
      runtime,
      config: openClawConfig,
      sessionKey: ctx?.sessionKey,
      logger,
    });

    // FTS5 keyword search (parallel signal — boosts vector results with keyword matches)
    let ftsHits = 0;
    const ftsMod = await getFtsModule();
    if (ftsMod && rawResults && rawResults.length > 0) {
      try {
        const ftsResults = ftsMod.searchFts(trimmed, {
          maxResults: maxResults * 2,
          dbPath: ftsDbPath,
          agentId: ftsAgentId,
          logger,
        });
        if (ftsResults.length > 0) {
          // Build a map of path -> FTS5 score for quick lookup
          const ftsScoreMap = new Map();
          for (const fr of ftsResults) {
            const key = fr.path;
            // Keep highest FTS5 score per path
            if (!ftsScoreMap.has(key) || ftsScoreMap.get(key) < fr.score) {
              ftsScoreMap.set(key, fr.score);
            }
          }

          // Boost vector results that also appear in FTS5 results
          for (const result of rawResults) {
            const ftsScore = ftsScoreMap.get(result.path);
            if (ftsScore !== undefined) {
              const boost = ftsBoostWeight * ftsScore;
              result._ftsScore = ftsScore;
              result._originalScore = result.score;
              result.score = Math.min(1, result.score + boost);
              ftsHits++;
            }
          }

          // Re-sort after boosting
          if (ftsHits > 0) {
            rawResults.sort((a, b) => b.score - a.score);
          }
        }
      } catch {
        // FTS5 is non-fatal — vector results still work
      }
    }

    // Apply temporal decay
    const decayedResults = applyTemporalDecay(rawResults || [], halfLifeHours);

    // Apply adaptive filtering
    const filtered = adaptiveResults
      ? adaptiveFilter(decayedResults, maxResults)
      : decayedResults;

    // Apply MMR diversity filter
    const results = enableMmr
      ? mmrFilter(filtered, mmrLambda, maxResults)
      : filtered;

    // Cache the final results
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
      if (debugLogging) {
        const promptPreview = trimmed.length > 120
          ? trimmed.substring(0, 120) + "..."
          : trimmed;
        logger.info(`hookclaw: [debug] #${callNum} prompt: "${promptPreview}" → no injection`);
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
      const ftsInfo = ftsHits > 0 ? `, fts: ${ftsHits} boosted` : "";
      logger.info(
        `hookclaw: #${callNum} injecting ${results.length} memories (${elapsed}ms, top score: ${topScore}${ftsInfo})`
      );
    }

    if (debugLogging) {
      const promptPreview = trimmed.length > 120
        ? trimmed.substring(0, 120) + "..."
        : trimmed;
      logger.info(`hookclaw: [debug] #${callNum} prompt: "${promptPreview}"`);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const ftsTag = r._ftsScore !== undefined
          ? ` | fts: ${r._ftsScore.toFixed(3)} | pre-boost: ${(r._originalScore ?? r.score).toFixed(3)}`
          : "";
        const snippet = (r.snippet || r.text || "")
          .replace(/\n/g, " ")
          .substring(0, 150);
        logger.info(
          `hookclaw: [debug] #${callNum} result[${i}]: ${r.path}:${r.startLine ?? r.start_line ?? "?"}-${r.endLine ?? r.end_line ?? "?"} | score: ${r.score.toFixed(3)}${ftsTag}`
        );
        if (snippet) {
          logger.info(`hookclaw: [debug] #${callNum} result[${i}]: "${snippet}..."`);
        }
      }
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
