// src/lib/proxy.js
// Smart fetch — tries direct first, falls back to CORS proxy if blocked.
// This way it works both locally (direct) and on GitHub Pages (via proxy).

import { isTauri, getTauriFetch } from './platform.js';
import { logger } from './logger.js';

const PROXY_URL = import.meta.env.VITE_PROXY_URL || 'https://audiobook-tagger-proxy.workers.dev';

/**
 * Fetch with an AbortController timeout.
 * @param {string} url
 * @param {object} options - standard fetch options
 * @param {number} timeoutMs - timeout in milliseconds
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

/**
 * Fetch a URL, trying direct first, then falling back to the CORS proxy.
 * @param {string} targetUrl - The actual API URL to call
 * @param {object} options - { method, headers, body }
 * @param {number} timeoutMs - timeout in milliseconds (default 30000)
 * @returns {Promise<Response>} - The response
 */
export async function proxyFetch(targetUrl, options = {}, timeoutMs = 30000) {
  const { method = 'GET', headers = {}, body = null } = options;

  // In Tauri, always use direct fetch (HTTP plugin bypasses CORS)
  if (isTauri()) {
    const tauriFetch = await getTauriFetch();
    const directOpts = { method, headers: { ...headers } };
    if (body && method !== 'GET' && method !== 'HEAD') {
      directOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return tauriFetch(targetUrl, directOpts);
  }

  // Browser: try direct fetch first, fall back to CORS proxy
  // Try direct fetch first (works same-origin or if server allows CORS)
  try {
    const directOpts = { method, headers: { ...headers }, credentials: 'omit' };
    if (body && method !== 'GET' && method !== 'HEAD') {
      directOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetchWithTimeout(targetUrl, directOpts, timeoutMs);
    return res;
  } catch (directError) {
    // Direct failed (likely CORS) — try proxy
  }

  // Fall back to CORS proxy
  const res = await fetchWithTimeout(`${PROXY_URL}/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      method,
      headers,
      body,
    }),
  }, timeoutMs);

  return res;
}

/**
 * Call an ABS API endpoint through the proxy.
 * @param {string} absBaseUrl - e.g., 'https://my-abs.com'
 * @param {string} absToken - ABS API token
 * @param {string} path - e.g., '/api/libraries'
 * @param {object} options - { method, body }
 */
export async function absApi(absBaseUrl, absToken, path, options = {}) {
  const { method = 'GET', body = null } = options;
  // Trim whitespace from URL and token — copy-paste from browsers/ABS UI
  // commonly adds leading/trailing spaces that silently break the request.
  const url = `${(absBaseUrl || '').trim().replace(/\/$/, '')}${path}`;
  const token = (absToken || '').trim();

  const res = await proxyFetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ABS API error ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Call OpenAI API through the proxy.
 * @param {string} apiKey - OpenAI API key
 * @param {string} model - e.g., 'gpt-5.4-nano'
 * @param {string} systemPrompt - System message
 * @param {string} userPrompt - User message
 * @param {number} maxTokens - Max output tokens
 * @param {string} baseUrl - API base URL (default: https://api.openai.com)
 */
export async function callOpenAI(apiKey, model, systemPrompt, userPrompt, maxTokens = 2000, baseUrl = 'https://api.openai.com') {
  const isGpt5 = model.startsWith('gpt-5');
  const useResponsesApi = isGpt5;

  // Route through Caddy proxy if on same origin, otherwise use proxyFetch
  const useLocalProxy = !isTauri() && typeof window !== 'undefined' && baseUrl === 'https://api.openai.com';
  const apiBase = useLocalProxy ? '/api/openai' : baseUrl;

  let endpoint, body;

  if (useResponsesApi) {
    endpoint = `${apiBase}/v1/responses`;
    body = {
      model,
      input: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_output_tokens: maxTokens,
      text: { format: { type: 'json_object' } },
      reasoning: { effort: 'minimal' },
    };
  } else {
    endpoint = `${apiBase}/v1/chat/completions`;
    body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    };
  }

  const fetchFn = isTauri() ? await getTauriFetch() : (useLocalProxy ? fetchWithTimeout : proxyFetch);
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, 90000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Parse response based on API type
  if (useResponsesApi) {
    if (data.output_text) return data.output_text.trim();
    const text = data.output
      ?.find(item => item.type === 'message')
      ?.content?.find(c => c.type === 'output_text' || c.type === 'text')
      ?.text;
    if (text) return text.trim();
    throw new Error('No text in OpenAI Responses API response');
  } else {
    const content = data.choices?.[0]?.message?.content;
    if (content) return content.trim();
    throw new Error('No content in OpenAI Chat response');
  }
}

/**
 * Call Anthropic Claude API through the proxy.
 * @param {string} apiKey - Anthropic API key
 * @param {string} model - e.g., 'claude-haiku-4-5-20251001'
 * @param {string} systemPrompt - System message
 * @param {string} userPrompt - User message
 * @param {number} maxTokens - Max output tokens
 */
export async function callAnthropic(apiKey, model, systemPrompt, userPrompt, maxTokens = 2000) {
  // Route through Caddy proxy to avoid CORS
  const useLocalProxy = !isTauri() && typeof window !== 'undefined';
  const endpoint = useLocalProxy ? '/api/anthropic/v1/messages' : 'https://api.anthropic.com/v1/messages';
  const fetchFn = isTauri() ? await getTauriFetch() : (useLocalProxy ? fetchWithTimeout : proxyFetch);

  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  }, 90000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const text = data.content?.find(c => c.type === 'text')?.text;
  if (text) return text.trim();
  throw new Error('No text in Anthropic response');
}

// Module-level streaming callback.
// api.js installs this before an Ollama batch call to receive per-token progress.
// Cleared after each call so it doesn't leak to unrelated calls.
let _ollamaStreamCb = null;
export function setOllamaStreamCallback(fn) { _ollamaStreamCb = fn; }

/**
 * Call local Ollama server for chat completions.
 * Uses Ollama's native /api/chat endpoint with streaming for real-time UI feedback.
 * Streams NDJSON from /api/chat, accumulating content and calling _ollamaStreamCb
 * with {tokens, elapsed} after every chunk so the progress bar can tick.
 */
export async function callOllama(systemPrompt, userPrompt, { model = 'qwen3:4b', maxTokens = 1000 } = {}) {
  const url = 'http://127.0.0.1:11434/api/chat';
  const t0 = performance.now();

  const promptChars = systemPrompt.length + userPrompt.length;
  console.log(`[Ollama] Starting request — model=${model}, prompt=${(promptChars/1024).toFixed(1)}KB, maxTokens=${maxTokens}`);

  const fetchFn = isTauri() ? await getTauriFetch() : globalThis.fetch.bind(globalThis);

  const isQwen = model.startsWith('qwen');
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: true,   // ← streaming enabled for real-time token feedback
    format: 'json',
    options: {
      num_predict: maxTokens,
      temperature: 0.3,
    },
  };
  if (isQwen) body.think = false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 min timeout

  let resp;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    if (err.name === 'AbortError') {
      console.error(`[Ollama] TIMEOUT after ${elapsed}s — model=${model}`);
      throw new Error(`Ollama timed out after 3 minutes. The model "${model}" may be too large for your hardware, or still loading into memory. Try a smaller model.`);
    }
    console.error(`[Ollama] FETCH ERROR after ${elapsed}s — ${err.message}`);
    throw err;
  }
  clearTimeout(timeoutId);

  if (!resp.ok) {
    const text = await resp.text();
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.error(`[Ollama] HTTP ${resp.status} after ${elapsed}s — ${text.substring(0, 200)}`);
    throw new Error(`Ollama error ${resp.status}: ${text}`);
  }

  // ── Stream reading ──────────────────────────────────────────────────────
  // Ollama streams NDJSON: one JSON object per line.
  // Each chunk: {"message":{"content":"token"},"done":false}
  // Final chunk: {"done":true,"eval_count":N,"eval_duration":N,...}
  let content = '';
  let tokenCount = 0;
  let finalStats = null;

  // Tauri's plugin-http and browser both expose response.body as a ReadableStream
  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // last entry may be incomplete — carry it forward

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const chunk = JSON.parse(trimmed);
            if (chunk.message?.content) {
              content += chunk.message.content;
              tokenCount++;
              // Notify at most every 10 tokens to avoid flooding the event loop
              if (tokenCount % 10 === 0 && _ollamaStreamCb) {
                _ollamaStreamCb({ tokens: tokenCount, elapsed: ((performance.now() - t0) / 1000).toFixed(1) });
              }
            }
            if (chunk.done) {
              finalStats = chunk;
            }
          } catch {
            // Malformed chunk — skip
          }
        }
      }
      // Flush any remaining buffer content
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer.trim());
          if (chunk.message?.content) content += chunk.message.content;
          if (chunk.done) finalStats = chunk;
        } catch {}
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    // Fallback: body not streamable (shouldn't happen, but be safe)
    const data = await resp.json();
    content = data?.message?.content || '';
    finalStats = data;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const loadTime = finalStats?.load_duration ? (finalStats.load_duration / 1e9).toFixed(1) : '?';
  const evalTime = finalStats?.eval_duration ? (finalStats.eval_duration / 1e9).toFixed(1) : '?';
  const promptEvalTime = finalStats?.prompt_eval_duration ? (finalStats.prompt_eval_duration / 1e9).toFixed(1) : '?';
  const tokens = finalStats?.eval_count || tokenCount || '?';
  const promptTokens = finalStats?.prompt_eval_count || '?';
  const speed = (finalStats?.eval_count && finalStats?.eval_duration)
    ? (finalStats.eval_count / (finalStats.eval_duration / 1e9)).toFixed(0)
    : '?';

  console.log(`[Ollama] DONE in ${elapsed}s — load=${loadTime}s, prompt_eval=${promptEvalTime}s (${promptTokens} tokens), gen=${evalTime}s (${tokens} tokens, ${speed} tok/s)`);

  if (!content) throw new Error('Empty response from Ollama');
  return content.trim();
}

/**
 * Call Claude CLI (claude --print) as an AI provider.
 * Only works in the Tauri desktop app — requires `claude` on PATH and authenticated.
 * Install: https://claude.ai/code  Then: claude auth login
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string} model - e.g. 'sonnet', 'opus', 'haiku' or a full model ID
 */
export async function callClaudeCli(systemPrompt, userPrompt, model = 'sonnet') {
  if (!isTauri()) {
    throw new Error('Claude CLI is only available in the desktop app. Use an API key provider in the browser.');
  }

  const promptKB = (userPrompt.length / 1024).toFixed(1);
  const sysKB    = (systemPrompt.length / 1024).toFixed(1);
  logger.info('ClaudeCLI', `→ model=${model}  user=${promptKB}KB  sys=${sysKB}KB`, {
    model,
    user_prompt_preview: userPrompt.substring(0, 300),
    system_prompt_preview: systemPrompt.substring(0, 200),
  });

  const t0 = performance.now();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke('call_claude_cli', { systemPrompt, userPrompt, model });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    logger.info('ClaudeCLI', `← ${elapsed}s  response=${result.length} chars`, {
      response_preview: result.substring(0, 500),
    });
    return result;
  } catch (err) {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    logger.error('ClaudeCLI', `✗ FAILED after ${elapsed}s: ${err}`, {
      error: String(err),
      user_prompt_preview: userPrompt.substring(0, 300),
    });
    throw err;
  }
}

/**
 * Call the configured AI provider (OpenAI, Anthropic, Claude CLI, or Ollama).
 * @param {object} config - App config with api keys and model settings
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 */
export async function callAI(config, systemPrompt, userPrompt, maxTokens = 2000) {
  // Claude CLI (Enterprise subscription — no API key needed)
  if (config.use_claude_cli) {
    return callClaudeCli(systemPrompt, userPrompt, config.claude_cli_model || 'sonnet');
  }

  // Log non-CLI providers too (less verbose — just the routing decision)
  if (config.use_local_ai && config.ollama_model) {
    logger.debug('AI', `→ Ollama  model=${config.ollama_model}  maxTokens=${maxTokens}`);
  } else {
    const model = config.ai_model || 'gpt-4o-mini';
    logger.debug('AI', `→ Cloud  model=${model}  maxTokens=${maxTokens}`);
  }

  // Local AI (Ollama)
  if (config.use_local_ai && config.ollama_model) {
    return callOllama(systemPrompt, userPrompt, {
      model: config.ollama_model,
      maxTokens,
    });
  }

  const model = config.ai_model || 'gpt-5-nano';
  const isAnthropic = model.startsWith('claude');

  if (isAnthropic) {
    const key = config.anthropic_api_key;
    if (!key) throw new Error('No Anthropic API key configured. Add one in Settings.');
    return callAnthropic(key, model, systemPrompt, userPrompt, maxTokens);
  } else {
    const key = config.openai_api_key;
    if (!key) throw new Error('No OpenAI API key configured. Add one in Settings.');
    const baseUrl = config.ai_base_url || 'https://api.openai.com';
    return callOpenAI(key, model, systemPrompt, userPrompt, maxTokens, baseUrl);
  }
}

/**
 * Parse a JSON response from AI, handling markdown code blocks and preamble text.
 * Claude CLI (and some models) may prefix the JSON with prose like "Here is the JSON:".
 */
export function parseAIJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    // Fallback: find the first JSON object or array in the text.
    // Handles cases where the AI includes preamble prose before the JSON.
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (objMatch) {
      try {
        const parsed = JSON.parse(objMatch[0]);
        logger.warn('ParseAIJson', 'Direct parse failed; extracted JSON object from preamble text', {
          raw_preview: cleaned.substring(0, 200),
        });
        return parsed;
      } catch (_) { /* try array next */ }
    }
    if (arrMatch) {
      try {
        const parsed = JSON.parse(arrMatch[0]);
        logger.warn('ParseAIJson', 'Direct parse failed; extracted JSON array from preamble text', {
          raw_preview: cleaned.substring(0, 200),
        });
        return parsed;
      } catch (_) { /* fall through */ }
    }
    logger.error('ParseAIJson', `Failed to parse AI response as JSON: ${firstErr.message}`, {
      raw_response: cleaned.substring(0, 500),
    });
    throw new Error(
      `Failed to parse AI response as JSON: ${firstErr.message}\nResponse was: ${cleaned.substring(0, 200)}`
    );
  }
}
