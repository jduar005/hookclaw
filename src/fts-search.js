/**
 * Direct FTS5 keyword search against OpenClaw's SQLite memory index.
 *
 * OpenClaw's native hybrid search has two bugs that prevent it from working:
 *   1. buildFtsQuery joins ALL tokens with AND — natural language queries
 *      with stop words ("do you remember when we...") always return 0 results.
 *   2. bm25RankToScore clips negative FTS5 ranks to 0 via Math.max(0, rank),
 *      mapping all results to score 1.0 regardless of relevance.
 *
 * This module reads the existing chunks_fts FTS5 table (read-only) and uses
 * an OR-based query strategy with stop-word filtering and score normalization.
 *
 * Requires Node 22+ (node:sqlite built-in).
 */

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Stop words — common English words that hurt FTS5 precision
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
  "they", "them", "their", "its", "this", "that", "these", "those",
  "of", "in", "to", "for", "with", "on", "at", "from", "by", "about",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "and", "but", "or", "nor", "not", "so", "if", "then", "than",
  "when", "where", "how", "what", "which", "who", "whom", "why",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "only", "same", "just", "also", "very",
  "up", "out", "over", "any", "here", "there",
  "remember", "tell", "know", "think", "use", "using", "used",
]);

/**
 * Tokenize a query string into meaningful search terms.
 * Strips stop words and short tokens.
 *
 * @param {string} query - Raw user query
 * @returns {string[]} Filtered tokens suitable for FTS5
 */
export function tokenizeQuery(query) {
  const tokens = (query || "").toLowerCase().match(/[a-z0-9_.-]+/g) || [];
  return tokens.filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Build an FTS5 MATCH expression using OR (not AND).
 * Returns null if no meaningful tokens remain after filtering.
 *
 * @param {string} query - Raw user query
 * @returns {string|null} FTS5 query string
 */
export function buildFtsQuery(query) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return null;

  // Quote each token for exact matching in FTS5
  const quoted = tokens.map((t) => `"${t.replace(/"/g, "")}"`);
  return quoted.join(" OR ");
}

/**
 * Normalize FTS5 bm25() rank to a 0-1 score.
 * FTS5 ranks are negative (more negative = better match).
 * We negate and apply a sigmoid-like normalization.
 *
 * @param {number} rank - FTS5 bm25 rank (negative)
 * @returns {number} Normalized score 0-1
 */
export function normalizeRank(rank) {
  if (!Number.isFinite(rank)) return 0;
  // FTS5 ranks are negative; negate to get positive relevance
  const relevance = -rank;
  if (relevance <= 0) return 0;
  // Sigmoid normalization: score = relevance / (relevance + k)
  // k=2 gives good discrimination for typical FTS5 scores (1-10 range)
  return relevance / (relevance + 2);
}

/**
 * Resolve the path to OpenClaw's memory SQLite database.
 *
 * @param {object} [options]
 * @param {string} [options.dbPath] - Explicit override
 * @param {string} [options.agentId] - Agent ID (defaults to "main")
 * @returns {string|null} Resolved path, or null if not found
 */
export function resolveDbPath({ dbPath, agentId = "main" } = {}) {
  if (dbPath && existsSync(dbPath)) return dbPath;

  // Standard OpenClaw memory path
  const standard = resolve(homedir(), ".openclaw", "memory", `${agentId}.sqlite`);
  if (existsSync(standard)) return standard;

  // Legacy path (single main.sqlite)
  const legacy = resolve(homedir(), ".openclaw", "memory", "main.sqlite");
  if (existsSync(legacy)) return legacy;

  return null;
}

/**
 * Search OpenClaw's FTS5 index directly.
 *
 * @param {string} query - User search query
 * @param {object} [options]
 * @param {number} [options.maxResults=5] - Max results to return
 * @param {string} [options.dbPath] - Override database path
 * @param {string} [options.agentId] - Agent ID (default "main")
 * @param {object} [options.logger] - Logger instance
 * @returns {Array<{text: string, path: string, startLine: number, endLine: number, score: number, source: string}>}
 */
export function searchFts(query, options = {}) {
  const { maxResults = 5, dbPath, agentId = "main", logger } = options;

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }

  const resolvedPath = resolveDbPath({ dbPath, agentId });
  if (!resolvedPath) {
    logger?.warn?.("hookclaw-fts: SQLite database not found");
    return [];
  }

  let db;
  try {
    db = new DatabaseSync(resolvedPath, { open: true, readOnly: true });

    const rows = db
      .prepare(
        `SELECT text, path, source, start_line, end_line, bm25(chunks_fts) AS rank
           FROM chunks_fts
          WHERE chunks_fts MATCH ?
          ORDER BY rank ASC
          LIMIT ?`
      )
      .all(ftsQuery, maxResults * 2); // Fetch extra, we'll score and re-rank

    return rows
      .map((row) => ({
        text: row.text,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        source: row.source || "memory",
        score: normalizeRank(row.rank),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  } catch (err) {
    logger?.warn?.(`hookclaw-fts: search failed — ${err.message}`);
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}
