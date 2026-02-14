/**
 * Formats memory search results into context blocks
 * for injection into prompts.
 */

/**
 * Format memory results as XML context block.
 *
 * @param {Array<{text: string, source: string, path: string, lines: string, score: number}>} results
 * @param {number} maxChars - Maximum total characters
 * @returns {string} XML-formatted context block
 */
export function formatAsXml(results, maxChars = 4000) {
  if (!results || results.length === 0) return "";

  const lines = ["<relevant_memories>"];
  let charCount = 0;

  for (const r of results) {
    const text = r.text.trim();
    if (!text) continue;

    // Check if adding this chunk would exceed the limit
    // Account for the XML tags overhead (~120 chars per entry)
    const entryOverhead = 120 + (r.path?.length || 0);
    if (charCount + text.length + entryOverhead > maxChars) {
      // Try to fit a truncated version
      const remaining = maxChars - charCount - entryOverhead - 3; // 3 for "..."
      if (remaining > 50) {
        const truncated = text.slice(0, remaining) + "...";
        lines.push(formatXmlEntry(r, truncated));
      }
      break;
    }

    lines.push(formatXmlEntry(r, text));
    charCount += text.length + entryOverhead;
  }

  // If we only have the opening tag, nothing fit
  if (lines.length === 1) return "";

  lines.push("</relevant_memories>");
  return lines.join("\n");
}

/**
 * Format a single memory entry as an XML element.
 */
function formatXmlEntry(result, text) {
  const attrs = [`source="${escapeXmlAttr(result.source || "memory")}"`];

  if (result.path) {
    attrs.push(`path="${escapeXmlAttr(result.path)}"`);
  }
  if (result.lines) {
    attrs.push(`lines="${escapeXmlAttr(result.lines)}"`);
  }
  attrs.push(`score="${result.score.toFixed(3)}"`);

  return `  <memory ${attrs.join(" ")}>\n    ${escapeXmlText(text)}\n  </memory>`;
}

/**
 * Format memory results as markdown context block.
 *
 * @param {Array<{text: string, source: string, path: string, lines: string, score: number}>} results
 * @param {number} maxChars - Maximum total characters
 * @returns {string} Markdown-formatted context block
 */
export function formatAsMarkdown(results, maxChars = 4000) {
  if (!results || results.length === 0) return "";

  const lines = ["---", "**Relevant Memories:**", ""];
  let charCount = 0;

  for (const r of results) {
    const text = r.text.trim();
    if (!text) continue;

    const header = buildMarkdownHeader(r);
    const entryOverhead = header.length + 10; // newlines + separator

    if (charCount + text.length + entryOverhead > maxChars) {
      const remaining = maxChars - charCount - entryOverhead - 3;
      if (remaining > 50) {
        lines.push(header);
        lines.push(text.slice(0, remaining) + "...");
        lines.push("");
      }
      break;
    }

    lines.push(header);
    lines.push(text);
    lines.push("");
    charCount += text.length + entryOverhead;
  }

  // If we only have the header lines, nothing fit
  if (lines.length === 3) return "";

  lines.push("---");
  return lines.join("\n");
}

/**
 * Build a markdown header line for a memory entry.
 */
function buildMarkdownHeader(result) {
  const parts = [`> *${result.source || "memory"}*`];
  if (result.path) parts.push(`\`${result.path}\``);
  if (result.lines) parts.push(`lines ${result.lines}`);
  parts.push(`(score: ${result.score.toFixed(3)})`);
  return parts.join(" | ");
}

/**
 * Format results using the specified template.
 *
 * @param {Array} results - Memory search results
 * @param {object} options
 * @param {string} options.formatTemplate - "xml" or "markdown"
 * @param {number} options.maxContextChars - Maximum context characters
 * @returns {string} Formatted context block
 */
export function formatContext(results, { formatTemplate = "xml", maxContextChars = 4000 } = {}) {
  if (!results || results.length === 0) return "";

  if (formatTemplate === "markdown") {
    return formatAsMarkdown(results, maxContextChars);
  }
  return formatAsXml(results, maxContextChars);
}

/**
 * Escape special characters for XML attribute values.
 */
function escapeXmlAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape special characters for XML text content.
 */
function escapeXmlText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
