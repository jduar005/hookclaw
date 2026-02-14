/**
 * before_agent_start hook handler — orchestrates memory search
 * and context injection into prompts.
 */

import { searchMemories } from "./memory-client.js";
import { formatContext } from "./context-formatter.js";

let _callCount = 0;

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
  } = config;

  const logger = api.logger;
  const openClawConfig = api.config;

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

    // Skip short prompts (greetings, single words, etc.)
    if (prompt.trim().length < skipShortPrompts) {
      if (logInjections) {
        logger.info(`hookclaw: #${callNum} skip — prompt too short (${prompt.trim().length} chars)`);
      }
      return;
    }

    const startTime = Date.now();

    const results = await searchMemories(prompt, {
      maxResults,
      minScore,
      timeoutMs,
      config: openClawConfig,
      agentId: ctx?.agentId || "hookclaw",
      sessionKey: ctx?.sessionKey,
      logger,
    });

    if (!results || results.length === 0) {
      if (logInjections) {
        logger.info(`hookclaw: #${callNum} no relevant memories found (${Date.now() - startTime}ms)`);
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
