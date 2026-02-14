/**
 * Utility score tracker — learns which memories are actually useful
 * by comparing injected memories against agent responses.
 *
 * Uses the agent_end hook to detect whether injected memories were
 * referenced in the response. Over time, builds utility scores that
 * can be fed back into RRF as an additional signal.
 *
 * Storage: Lightweight JSON file persisted to disk.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BAYESIAN_PRIOR = 2; // pseudo-count for Bayesian smoothing
const BAYESIAN_PRIOR_CITATIONS = 1;
const MIN_RETRIEVALS_FOR_SCORE = 3; // Don't use utility score until N retrievals
const SAVE_DEBOUNCE_MS = 5000;

/**
 * Utility tracker — tracks how often memories are retrieved vs cited.
 */
export class UtilityTracker {
  /**
   * @param {string} storagePath - Path to the JSON storage file
   * @param {object} [logger] - Logger instance
   */
  constructor(storagePath, logger = null) {
    this._storagePath = storagePath;
    this._logger = logger;
    /** @type {Map<string, { retrievals: number, citations: number }>} */
    this._scores = new Map();
    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;
    /** @type {Map<string, string[]>} sessionKey -> injected chunk paths */
    this._pendingInjections = new Map();
  }

  /**
   * Load scores from disk.
   */
  async load() {
    try {
      const data = await readFile(this._storagePath, "utf-8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") {
        for (const [key, val] of Object.entries(parsed)) {
          if (val && typeof val.retrievals === "number") {
            this._scores.set(key, {
              retrievals: val.retrievals || 0,
              citations: val.citations || 0,
            });
          }
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        this._logger?.warn(`hookclaw: utility tracker load failed — ${err.message}`);
      }
    }
    this._loaded = true;
  }

  /**
   * Save scores to disk (debounced).
   */
  async save() {
    if (!this._dirty) return;

    try {
      await mkdir(dirname(this._storagePath), { recursive: true });
      const obj = Object.fromEntries(this._scores);
      await writeFile(this._storagePath, JSON.stringify(obj, null, 2), "utf-8");
      this._dirty = false;
    } catch (err) {
      this._logger?.warn(`hookclaw: utility tracker save failed — ${err.message}`);
    }
  }

  /**
   * Schedule a debounced save.
   */
  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      await this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Record that memories were retrieved and injected for a session.
   *
   * @param {string} sessionKey
   * @param {Array<{path?: string, text?: string}>} injectedMemories
   */
  recordInjection(sessionKey, injectedMemories) {
    if (!injectedMemories || injectedMemories.length === 0) return;

    const entries = injectedMemories
      .map((m) => ({
        key: m.path || (m.text || "").slice(0, 100),
        text: m.text || "",
      }))
      .filter((e) => e.key);

    // Store for later citation checking (includes text for matching)
    this._pendingInjections.set(sessionKey, entries);

    // Increment retrieval count
    for (const { key } of entries) {
      const entry = this._scores.get(key) || { retrievals: 0, citations: 0 };
      entry.retrievals++;
      this._scores.set(key, entry);
    }

    this._scheduleSave();
  }

  /**
   * Process agent response to detect which injected memories were cited.
   *
   * @param {string} sessionKey
   * @param {string} responseText
   */
  recordResponse(sessionKey, responseText) {
    const pendingEntries = this._pendingInjections.get(sessionKey);
    if (!pendingEntries || !responseText) {
      this._pendingInjections.delete(sessionKey);
      return;
    }

    const lowerResponse = responseText.toLowerCase();

    for (const { key, text } of pendingEntries) {
      // Check if the memory content was referenced in the response
      // Use a heuristic: extract significant words from the chunk TEXT and check overlap
      const sourceText = text || key;
      const contentWords = sourceText.toLowerCase().split(/[\s\/\-_.,:;!?()]+/).filter((w) => w.length > 3);
      const matchCount = contentWords.filter((w) => lowerResponse.includes(w)).length;
      const matchRatio = contentWords.length > 0 ? matchCount / contentWords.length : 0;

      if (matchRatio >= 0.3) {
        const entry = this._scores.get(key);
        if (entry) {
          entry.citations++;
          this._scores.set(key, entry);
        }
      }
    }

    this._pendingInjections.delete(sessionKey);
    this._scheduleSave();
  }

  /**
   * Get the utility score for a memory chunk.
   * Uses Bayesian smoothing to avoid extreme scores with few observations.
   *
   * @param {string} chunkKey - Chunk path or text prefix
   * @returns {number} 0-1 utility score (higher = more useful)
   */
  getUtilityScore(chunkKey) {
    const entry = this._scores.get(chunkKey);
    if (!entry || entry.retrievals < MIN_RETRIEVALS_FOR_SCORE) {
      return 0.5; // Neutral default
    }

    // Bayesian smoothed estimate: (citations + 1) / (retrievals + 2)
    return (entry.citations + BAYESIAN_PRIOR_CITATIONS) /
           (entry.retrievals + BAYESIAN_PRIOR);
  }

  /**
   * Get utility scores for multiple chunks.
   *
   * @param {Array<{path?: string, text?: string}>} chunks
   * @returns {Map<string, number>} chunkKey -> utility score
   */
  getUtilityScores(chunks) {
    const scores = new Map();
    for (const chunk of chunks) {
      const key = chunk.path || (chunk.text || "").slice(0, 100);
      if (key) {
        scores.set(key, this.getUtilityScore(key));
      }
    }
    return scores;
  }

  /**
   * Get all tracked entries.
   * @returns {Array<{key: string, retrievals: number, citations: number, utilityScore: number}>}
   */
  getAllEntries() {
    return Array.from(this._scores.entries()).map(([key, entry]) => ({
      key,
      ...entry,
      utilityScore: this.getUtilityScore(key),
    }));
  }

  /**
   * Get summary statistics.
   */
  getSummary() {
    const entries = this.getAllEntries();
    const totalRetrievals = entries.reduce((s, e) => s + e.retrievals, 0);
    const totalCitations = entries.reduce((s, e) => s + e.citations, 0);
    return {
      trackedChunks: entries.length,
      totalRetrievals,
      totalCitations,
      overallCitationRate: totalRetrievals > 0 ? totalCitations / totalRetrievals : 0,
      avgUtilityScore: entries.length > 0
        ? entries.reduce((s, e) => s + e.utilityScore, 0) / entries.length
        : 0.5,
    };
  }

  /**
   * Clear all tracked data.
   */
  clear() {
    this._scores.clear();
    this._pendingInjections.clear();
    this._dirty = true;
    this._scheduleSave();
  }

  /**
   * Cancel any pending save timer.
   */
  destroy() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }
}

/**
 * Default storage path for utility scores.
 * @param {string} [pluginDir] - Plugin directory override
 * @returns {string}
 */
export function defaultStoragePath(pluginDir) {
  if (pluginDir) return join(pluginDir, "utility-scores.json");
  // Fallback to user's home directory
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, ".openclaw", "plugins", "hookclaw", "utility-scores.json");
}
