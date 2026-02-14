import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAsXml, formatAsMarkdown, formatContext } from "../src/context-formatter.js";

const SAMPLE_RESULTS = [
  {
    text: "The team prefers structured logging for all services across the platform.",
    source: "memory",
    path: "memory/2026-02-10.md",
    lines: "14-16",
    score: 0.85,
  },
  {
    text: "The gateway service runs behind a reverse proxy with TLS termination.",
    source: "memory",
    path: "memory/2026-02-08.md",
    lines: "42-44",
    score: 0.72,
  },
  {
    text: "Database connections use TLS and authentication in all environments.",
    source: "memory",
    path: "memory/2026-01-30.md",
    lines: "100-102",
    score: 0.55,
  },
];

describe("formatAsXml", () => {
  it("formats results into XML with correct structure", () => {
    const output = formatAsXml(SAMPLE_RESULTS);
    assert.ok(output.startsWith("<relevant_memories>"));
    assert.ok(output.endsWith("</relevant_memories>"));
    assert.ok(output.includes('<memory source="memory"'));
    assert.ok(output.includes('path="memory/2026-02-10.md"'));
    assert.ok(output.includes('lines="14-16"'));
    assert.ok(output.includes('score="0.850"'));
    assert.ok(output.includes("structured logging"));
  });

  it("returns empty string for empty results", () => {
    assert.equal(formatAsXml([]), "");
    assert.equal(formatAsXml(null), "");
    assert.equal(formatAsXml(undefined), "");
  });

  it("respects maxChars limit", () => {
    const output = formatAsXml(SAMPLE_RESULTS, 300);
    // Should include at least the first result but not all three
    assert.ok(output.includes("structured logging"));
    // The full output with all 3 results would be much longer
    assert.ok(output.length <= 500); // generous bound accounting for XML tags
  });

  it("skips entries with empty text", () => {
    const results = [
      { text: "", source: "memory", path: "a.md", lines: "", score: 0.9 },
      { text: "Real content here", source: "memory", path: "b.md", lines: "1-2", score: 0.8 },
    ];
    const output = formatAsXml(results);
    assert.ok(!output.includes('path="a.md"'));
    assert.ok(output.includes("Real content here"));
  });

  it("escapes XML special characters in text", () => {
    const results = [
      { text: "Use <bold> & \"quotes\" for <effect>", source: "memory", path: "x.md", lines: "", score: 0.7 },
    ];
    const output = formatAsXml(results);
    assert.ok(output.includes("&lt;bold&gt;"));
    assert.ok(output.includes("&amp;"));
    assert.ok(!output.includes("<bold>"));
  });

  it("escapes XML special characters in attributes", () => {
    const results = [
      { text: "Content", source: 'a "source"', path: "path<with>&chars.md", lines: "", score: 0.7 },
    ];
    const output = formatAsXml(results);
    assert.ok(output.includes("&quot;source&quot;"));
    assert.ok(output.includes("&lt;with&gt;&amp;chars.md"));
  });

  it("truncates last entry to fit within maxChars", () => {
    const longText = "A".repeat(3000);
    const results = [
      { text: "Short first entry", source: "memory", path: "a.md", lines: "", score: 0.9 },
      { text: longText, source: "memory", path: "b.md", lines: "", score: 0.8 },
    ];
    const output = formatAsXml(results, 500);
    assert.ok(output.includes("Short first entry"));
    // The long text should be truncated if included at all
    if (output.includes("AAAA")) {
      assert.ok(output.includes("..."));
    }
  });
});

describe("formatAsMarkdown", () => {
  it("formats results with markdown structure", () => {
    const output = formatAsMarkdown(SAMPLE_RESULTS);
    assert.ok(output.startsWith("---"));
    assert.ok(output.includes("**Relevant Memories:**"));
    assert.ok(output.includes("> *memory*"));
    assert.ok(output.includes("`memory/2026-02-10.md`"));
    assert.ok(output.includes("lines 14-16"));
    assert.ok(output.includes("(score: 0.850)"));
    assert.ok(output.includes("structured logging"));
    assert.ok(output.endsWith("---"));
  });

  it("returns empty string for empty results", () => {
    assert.equal(formatAsMarkdown([]), "");
    assert.equal(formatAsMarkdown(null), "");
  });

  it("respects maxChars limit", () => {
    const output = formatAsMarkdown(SAMPLE_RESULTS, 250);
    assert.ok(output.length <= 500);
    assert.ok(output.includes("structured logging"));
  });

  it("skips entries with empty text", () => {
    const results = [
      { text: "  ", source: "memory", path: "a.md", lines: "", score: 0.9 },
      { text: "Valid content", source: "memory", path: "b.md", lines: "", score: 0.8 },
    ];
    const output = formatAsMarkdown(results);
    assert.ok(output.includes("Valid content"));
    // First entry should be skipped since text is whitespace-only
    const memoryCount = (output.match(/> \*memory\*/g) || []).length;
    assert.equal(memoryCount, 1);
  });
});

describe("formatContext", () => {
  it("uses xml format by default", () => {
    const output = formatContext(SAMPLE_RESULTS);
    assert.ok(output.startsWith("<relevant_memories>"));
  });

  it("uses markdown format when specified", () => {
    const output = formatContext(SAMPLE_RESULTS, { formatTemplate: "markdown" });
    assert.ok(output.includes("**Relevant Memories:**"));
  });

  it("passes maxContextChars through", () => {
    const output = formatContext(SAMPLE_RESULTS, { maxContextChars: 200 });
    assert.ok(output.length <= 500);
  });

  it("returns empty string for empty results", () => {
    assert.equal(formatContext([]), "");
    assert.equal(formatContext(null), "");
  });
});
