const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080';
// Cloudflare Worker egress for NVIDIA. Cloud Run's Google egress IP is
// 504-throttled by NVIDIA's gateway (~300s even for tiny requests, measured
// against a 26s direct response on the same payload), so NVIDIA chat goes
// through the Worker first and falls back to the Cloud Run proxy on
// gateway-class errors. Other providers always use Cloud Run.
const CF_LLM_BASE = import.meta.env.VITE_CF_LLM_URL || '';

async function gzipBytes(str) {
  return new TextEncoder().encode(str);
}

function sanitizeMessages(messages) {
  return messages.map(m => {
    if (m.role === 'assistant' && m.content == null && m.tool_calls) {
      return { ...m, content: '' };
    }
    return m;
  });
}

function isFreeModel(m) {
  if (m?.free === true) return true;
  if (/\bfree\b/i.test(String(m?.id || '')) || /\bfree\b/i.test(String(m?.name || ''))) return true;
  const inputPrice = m?.cost?.text?.input?.price;
  const outputPrice = m?.cost?.text?.output?.price;
  return inputPrice === 0 && outputPrice === 0;
}

function normalizeModel(m) {
  const id = String(m?.id || m?.name || '').replace(/^models\//, '');
  if (!id) return null;
  const free = isFreeModel(m);
  const rawName = String(m?.name || m?.display_name || id).replace(/^models\//, '');
  const baseName = rawName.replace(/\s*-?\s*free\s*$/i, '');
  return {
    id,
    name: free ? `${baseName} - free` : rawName,
    free,
    canonicalId: m?.canonical_id || null,
  };
}

const OPENCODE_FREE_MODEL_FALLBACKS = [
  {
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    canonical_id: 'deepseek/deepseek-v4.1-flash-1017',
    cost: { text: { input: { price: 0 }, output: { price: 0 } } },
  },
];

function parseOpenCodeModels(data) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  const models = rows.map(normalizeModel).filter(Boolean);
  for (const fallback of OPENCODE_FREE_MODEL_FALLBACKS) {
    if (!models.some((m) => m.id === fallback.id)) {
      const model = normalizeModel(fallback);
      if (model) models.push(model);
    }
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

export const REASONING_EFFORTS = ['low', 'high', 'max'];

export function modelSupportsReasoningEffort(model) {
  return /glm[-_]?5(?:\.3)?/i.test(String(model || ''));
}

function applyReasoningModelOptions(body, model, reasoningEffort) {
  if (modelSupportsReasoningEffort(model)) {
    const effort = REASONING_EFFORTS.includes(reasoningEffort) ? reasoningEffort : 'low';
    body.reasoning_effort = effort;
    body.chat_template_kwargs = {
      ...(body.chat_template_kwargs || {}),
      reasoning_effort: effort,
      clear_thinking: true,
    };
  }
  return body;
}

// GLM 5.3 on NVIDIA: thinking cannot be disabled or bounded via API
// parameters (every convention tested is ignored) and its thinking budget
// scales with max_tokens. A tight cap makes the model hit
// finish_reason=length mid-thought — a reasoning-only turn with no answer
// (measured at 8192: ~8k reasoning tokens, then death; the model was planning
// a multi-file implementation and never reached its first tool call). With
// streaming (Accept: text/event-stream in the proxies) there is no ~300s
// gateway-504 pressure on long generations anymore — TTFB is seconds and
// tokens flow continuously — so give it opencode's effective shape: a cap
// large enough that thinking terminates naturally and the answer still fits.
// opencode never exhausts because it doesn't cap tightly.
const NVIDIA_MAX_TOKENS = 32768;

function parseOpenAiStreamLine(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return { done: true };
  try {
    const parsed = JSON.parse(data);
    const choice = parsed.choices?.[0];
    if (!choice) return null;
    const delta = choice.delta || {};
    const results = [];
    if (delta.reasoning_content) {
      results.push({ type: 'reasoning', text: delta.reasoning_content });
    }
    if (delta.reasoning) {
      results.push({ type: 'reasoning', text: delta.reasoning });
    }
    if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        const text = typeof part === 'string' ? part : part?.text;
        if (text) results.push({ type: 'text', text });
      }
    } else if (delta.content) {
      results.push({ type: 'text', text: delta.content });
    }
    if (delta.tool_calls) {
      results.push({ type: 'tool_calls', tool_calls: delta.tool_calls });
    }
    if (choice.finish_reason) {
      results.push({ done: true, finish_reason: choice.finish_reason });
    }
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

export const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    chatEndpoint: 'https://api.anthropic.com/v1/messages',
    modelsEndpoint: 'https://api.anthropic.com/v1/models',
    getHeaders: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }),
    formatBody: (messages, model) => {
      const system = messages.find((m) => m.role === 'system')?.content;
      const msgs = messages.filter((m) => m.role !== 'system');
      return {
        model,
        system,
        messages: msgs.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        max_tokens: 32768,
        stream: true,
      };
    },
    parseModels: (data) =>
      (data.data || [])
        .filter((m) => m.id?.startsWith('claude-'))
        .map(normalizeModel)
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name)),
    parseStreamLine: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6);
      if (data === '[DONE]') return { done: true };
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          return parsed.delta.text;
        }
        if (parsed.type === 'message_stop') return { done: true };
        return null;
      } catch {
        return null;
      }
    },
  },
  {
    id: 'google',
    name: 'Google Gemini',
    chatEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    getHeaders: (_apiKey) => ({
      'Content-Type': 'application/json',
    }),
    formatBody: (messages, _model) => {
      const msgs = messages.filter((m) => m.role !== 'system');
      const system = messages.find((m) => m.role === 'system')?.content;
      return {
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: msgs.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      };
    },
    formatEndpoint: (apiKey, model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
    parseModels: (data) =>
      (data.models || [])
        .filter((m) => m.name?.startsWith('models/gemini-'))
        .map(normalizeModel)
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name)),
    parseStreamLine: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6);
      if (!data || data === '[DONE]') return { done: true };
      try {
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text != null) return text;
        return null;
      } catch {
        return null;
      }
    },
  },
  {
    id: 'opencode-zen',
    name: 'Opencode Zen',
    chatEndpoint: 'https://opencode.ai/zen/v1/chat/completions',
    modelsEndpoint: 'https://opencode.ai/zen/v1/models',
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    formatBody: (messages, model, tools, options) => {
      const body = { model, messages: sanitizeMessages(messages), stream: true, max_tokens: 32768 };
      if (tools && tools.length > 0) body.tools = tools;
      return applyReasoningModelOptions(body, model, options?.reasoningEffort);
    },
    parseModels: parseOpenCodeModels,
    parseStreamLine: parseOpenAiStreamLine,
  },
  {
    id: 'opencode-go',
    name: 'Opencode Go',
    chatEndpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
    modelsEndpoint: 'https://opencode.ai/zen/go/v1/models',
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    formatBody: (messages, model, tools, options) => {
      const body = { model, messages: sanitizeMessages(messages), stream: true, max_tokens: 32768 };
      if (tools && tools.length > 0) body.tools = tools;
      return applyReasoningModelOptions(body, model, options?.reasoningEffort);
    },
    parseModels: parseOpenCodeModels,
    parseStreamLine: parseOpenAiStreamLine,
  },
  {
    id: 'nvidia',
    name: 'Nvidia',
    chatEndpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    modelsEndpoint: 'https://integrate.api.nvidia.com/v1/models',
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    formatBody: (messages, model, tools) => {
      const body = { model, messages: sanitizeMessages(messages), stream: true, max_tokens: NVIDIA_MAX_TOKENS };
      if (tools && tools.length > 0) body.tools = tools;
      return body;
    },
    parseModels: (data) => {
      const rows = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : [];
      return rows
        .map((m) => normalizeModel({ ...m, name: m?.display_name || m?.name || m?.id }))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    parseStreamLine: parseOpenAiStreamLine,
  },
];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}

export function isFreeUsageLimit(err) {
  if (!err) return false;
  if (err.providerErrorType === 'FreeUsageLimitError') return true;
  return /FreeUsageLimitError|free usage (exceeded|limit)|add credits/i.test(err.message || '');
}

export async function fetchModels(providerId, apiKey) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const headers = provider.getHeaders(apiKey);
  const url = provider.modelsEndpoint;
  if (!url) return [];

  try {
    const payload = JSON.stringify({ url, headers });
    const res = await fetch(`${API_BASE}/api/llm/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await gzipBytes(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Failed to fetch models (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
    }
    const data = await res.json();
    return provider.parseModels(data);
  } catch (err) {
    if (err instanceof Error && /Failed to fetch models/.test(err.message)) throw err;
    throw new Error(`Failed to fetch models: ${err?.message || err}`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildNvidiaAbBodies(body) {
  const current = cloneJson(body);

  const noTools = cloneJson(body);
  delete noTools.tools;

  const minimalSystem = cloneJson(body);
  delete minimalSystem.tools;
  minimalSystem.messages = (minimalSystem.messages || []).map((m) => m?.role === 'system'
    ? { ...m, content: 'Complete the user task. Return only the final file contents.' }
    : m);

  const lowTokens = cloneJson(body);
  lowTokens.max_tokens = 4096;

  return [
    { name: 'current', body: current },
    { name: 'no-tools', body: noTools },
    { name: 'minimal-system-no-tools', body: minimalSystem },
    { name: 'max-tokens-4096', body: lowTokens },
  ];
}

async function proxyLlmChat({ url, headers, body, signal, timeoutMs }) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  const startedAt = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await gzipBytes(JSON.stringify({ url, headers, body })),
      signal: combinedSignal,
    });
    return { res, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runNvidiaAb({ url, headers, body, signal, timeoutMs, onChunk }) {
  const variants = buildNvidiaAbBodies(body);
  const results = [];
  let lastError = null;

  for (const variant of variants) {
    const startedAt = Date.now();
    try {
      const { res, elapsedMs } = await proxyLlmChat({
        url,
        headers,
        body: variant.body,
        signal,
        timeoutMs,
      });
      const requestId = res.headers.get('x-upstream-request-id') || 'none';
      const summary = `variant=${variant.name} status=${res.status} timeToHeadersMs=${elapsedMs} requestId=${requestId} tools=${(variant.body.tools || []).length} maxTokens=${variant.body.max_tokens}`;
      console.log(`[NvidiaAB] ${summary}`);
      onChunk?.('', `A/B ${variant.name}: ${res.status} in ${Math.round(elapsedMs / 1000)}s`);
      results.push(summary);
      if (res.ok) {
        console.warn(`[NvidiaAB] success=${variant.name} after ${results.length}/${variants.length} variants`);
        return { res, variant: variant.name };
      }
      const detail = await res.text().catch(() => '');
      if (detail) console.warn(`[NvidiaAB] ${variant.name} body=${detail.slice(0, 200)}`);
      lastError = new Error(`Nvidia A/B variant ${variant.name} failed with ${res.status}`);
      lastError.status = res.status;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      const summary = `variant=${variant.name} error=${err?.message || err} timeMs=${Date.now() - startedAt}`;
      console.warn(`[NvidiaAB] ${summary}`);
      results.push(summary);
      lastError = err;
    }
  }

  console.warn(`[NvidiaAB] all variants failed: ${results.join(' | ')}`);
  throw lastError || new Error('Nvidia A/B failed');
}

export async function sendToProvider({
  providerId,
  apiKey,
  model,
  messages,
  tools,
  onChunk,
  signal,
  reasoningEffort,
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const body = provider.formatBody(messages, model, tools, { reasoningEffort });
  const url = provider.formatEndpoint
    ? provider.formatEndpoint(apiKey, model)
    : provider.chatEndpoint;
  const headers = provider.getHeaders(apiKey);

  const requestStartedAt = Date.now();
  console.log(`[sendToProvider] ${provider.name} request started model=${model} reasoning=${reasoningEffort || 'default'}`);
  onChunk?.('', 'Calling provider…');

  let responseHeadersReceived = false;
  let firstTokenSeen = false;
  let waitingIntervalId = null;
  const clearWaitingTicker = () => {
    if (waitingIntervalId) {
      clearInterval(waitingIntervalId);
      waitingIntervalId = null;
    }
  };
  const startWaitingTicker = () => {
    clearWaitingTicker();
    waitingIntervalId = setInterval(() => {
      if (firstTokenSeen) return;
      const seconds = Math.round((Date.now() - requestStartedAt) / 1000);
      const phase = responseHeadersReceived ? 'Waiting for first token' : 'Waiting for provider';
      onChunk?.('', `${phase}… (${seconds}s)`);
    }, 3000);
  };
  startWaitingTicker();

  try {
  const MAX_RETRIES = 3;
  const timeoutMs = 18 * 60 * 1000;

  // 5xx / gateway-class failures get exactly one retry. Each failed attempt can
  // burn minutes while the proxy waits on a slow reasoning model, and three
  // silent rounds of that read as a dead app instead of an error.
  let gatewayRetried = false;

  // NVIDIA cycles egress across attempts: Cloudflare Worker first, then the
  // Cloud Run proxy. Other providers only ever hit Cloud Run.
  const proxyBases = providerId === 'nvidia' && CF_LLM_BASE
    ? [CF_LLM_BASE, API_BASE]
    : [API_BASE];

  let abResult = null;
  if (providerId === 'nvidia' && typeof localStorage !== 'undefined' && localStorage.getItem('llm:abNvidia') === '1') {
    localStorage.removeItem('llm:abNvidia');
    onChunk?.('', 'Running NVIDIA payload A/B…');
    abResult = await runNvidiaAb({ url, headers, body, signal, timeoutMs, onChunk });
    onChunk?.('', `Using ${abResult.variant} payload…`);
  }

  let res;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let timeoutId = null;

    try {
      if (abResult) {
        res = abResult.res;
        abResult = null;
      } else {
        const timeoutController = new AbortController();
        timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
        const combinedSignal = signal
          ? AbortSignal.any([signal, timeoutController.signal])
          : timeoutController.signal;
      const payload = JSON.stringify({ url, headers, body });
      const proxyBase = proxyBases[Math.min(attempt, proxyBases.length - 1)];
      res = await fetch(`${proxyBase}/api/llm/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: await gzipBytes(payload),
          signal: combinedSignal,
        });
      }
      clearTimeout(timeoutId);
      timeoutId = null;

      if (res.ok) break;

      if (res.status >= 500 && !gatewayRetried) {
        gatewayRetried = true;
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[sendToProvider] ${provider.name} error ${res.status}, retrying once in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      const errText = await res.text().catch(() => '');
      // A 502 from our proxy means the upstream never returned headers within
      // its timeout — for buffered reasoning models the generation may have
      // simply needed more time. Say so instead of surfacing a bare 502.
      const message = res.status === 502
        ? `${provider.name} did not respond before the proxy timed out. The model may still be generating server-side — try a shorter prompt, a different model, or another provider.`
        : `${provider.name} error ${res.status}: ${errText}`;
      const err = new Error(message);
      err.status = res.status;
      err.provider = provider.name;
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
      const typeMatch = errText.match(/"type":\s*"([A-Za-z]+Error)"/);
      if (typeMatch) err.providerErrorType = typeMatch[1];
      if (/hosted outside Europe and the United States|Select Global/i.test(errText)) {
        err.providerErrorType = 'RegionRestrictedError';
        err.regionRestricted = true;
        const settingsUrl = errText.match(/https:\/\/opencode\.ai\/console\/[^\s"]+/)?.[0];
        err.message = `${provider.name}: this model is blocked by your OpenCode organization region setting. ${settingsUrl ? `Open ${settingsUrl} and select Global, then retry.` : 'Select Global in the OpenCode console, then retry.'}`;
      }
      const retryAfterBody = errText.match(/"retryAfter"\s*:\s*(\d+)/);
      if (retryAfterBody && !err.retryAfterMs) err.retryAfterMs = Number(retryAfterBody[1]) * 1000;
      throw err;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') throw err;
      if (err.message?.startsWith(provider.name)) throw err;
      if (/failed to fetch|networkerror|load failed/i.test(err?.message || '')) {
        if (!gatewayRetried) {
          gatewayRetried = true;
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(`[sendToProvider] ${provider.name} request failed (${err.message}), retrying once in ${backoffMs}ms`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        err.message = `${provider.name} proxy request failed twice before response headers (gateway timeout/CORS). Check the backend /api/llm/chat deployment, or switch provider.`;
        err.providerErrorType = 'GatewayTimeoutError';
      }
      throw err;
    }
  }

  responseHeadersReceived = true;
  console.log(`[sendToProvider] ${provider.name} response headers received in ${Date.now() - requestStartedAt}ms`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  let streamDone = false;
  let finishReason = null;
  let reasoningSeen = false;
  let reasoningChunks = 0;
  // The streamed reasoning text is kept (instead of only counted) so a
  // reasoning-only budget death can hand the continuation nudge a digest of
  // what the model was already deliberating - it resumes instead of
  // re-deriving from zero.
  let reasoningChars = 0;
  let reasoningText = '';
  let contentSeen = false;
  let toolStatusEmitted = false;
  const toolCallsMap = new Map();

  let streamWatchdogId = null;
  const resetStreamWatchdog = () => {
    clearTimeout(streamWatchdogId);
    streamWatchdogId = setTimeout(() => reader.cancel(), timeoutMs);
  };
  const emitStatus = (text) => {
    console.log(`[sendToProvider] ${provider.name}: ${text} (${Date.now() - requestStartedAt}ms)`);
    onChunk?.('', contentSeen ? `${fullText}\n\n${text}` : text);
  };
  const markFirstToken = () => {
    firstTokenSeen = true;
    clearWaitingTicker();
  };
  resetStreamWatchdog();

  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      clearTimeout(streamWatchdogId);
      if (done) break;
      resetStreamWatchdog();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = provider.parseStreamLine(trimmed);
        if (parsed === null) continue;
        const results = Array.isArray(parsed) ? parsed : [parsed];
        for (const result of results) {
          if (result.done) {
            streamDone = true;
            finishReason = result.finish_reason || null;
            markFirstToken();
            emitStatus('Finishing…');
            break;
          }
          if (result.type === 'reasoning') {
            reasoningChunks++;
            reasoningText += result.text || '';
            reasoningChars += (result.text || '').length;
            if (!reasoningSeen) {
              reasoningSeen = true;
              markFirstToken();
              emitStatus('Thinking…');
            } else if (reasoningChunks % 12 === 0) {
              // Token estimate (chars / ~3.5) reads better than raw chunk
              // counts: chunks are SSE lines carrying 1-3 tokens each, and the
              // estimate shows the reasoning budget actually being consumed.
              emitStatus(`Thinking… (~${Math.round(reasoningChars / 3.5).toLocaleString('en-US')} tokens)`);
            }
          } else if (result.type === 'text') {
            if (!contentSeen) {
              contentSeen = true;
              markFirstToken();
              console.log(`[sendToProvider] ${provider.name} first content chunk after ${Date.now() - requestStartedAt}ms`);
            }
            fullText += result.text;
            onChunk?.(result.text, fullText);
          } else if (result.type === 'tool_calls') {
            if (!toolStatusEmitted) {
              toolStatusEmitted = true;
              markFirstToken();
              emitStatus('Calling tools…');
            }
            for (const tc of result.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, { id: tc.id || '', name: '', arguments: '' });
              }
              const existing = toolCallsMap.get(idx);
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            }
          } else if (typeof result === 'string') {
            if (!contentSeen) {
              contentSeen = true;
              markFirstToken();
              console.log(`[sendToProvider] ${provider.name} first content chunk after ${Date.now() - requestStartedAt}ms`);
            }
            fullText += result;
            onChunk?.(result, fullText);
          }
        }
        if (streamDone) break;
      }
    }
  } finally {
    clearWaitingTicker();
    clearTimeout(streamWatchdogId);
  }

  // Integrity probe (model-output corruption diagnosis): for file-writing
  // calls, log the streamed argument size plus head/tail. If corruption is
  // visible here, it entered in the model's own streamed output (NVIDIA-side);
  // if this is clean but stored files are not, the corruption happened in the
  // content store (persistFileContent's round-trip check catches that side).
  for (const tc of toolCallsMap.values()) {
    const args = tc.arguments || '';
    if (tc.name === 'write' || tc.name === 'edit' || args.length > 2000) {
      console.log(`[sendToProvider][args] ${tc.name} argsLen=${args.length} head=${JSON.stringify(args.slice(0, 100))} tail=${JSON.stringify(args.slice(-100))}`);
    }
  }

  const toolCalls = finishReason === 'tool_calls' && toolCallsMap.size > 0
    ? [...toolCallsMap.values()].map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.parse(tc.arguments || '{}'),
      }))
    : [];

  const stalledAfterReasoning = reasoningSeen && !fullText.trim() && toolCalls.length === 0
    && (!finishReason || finishReason === 'length' || finishReason === 'stop');
  if (stalledAfterReasoning) {
    const err = new Error(`${provider.name} spent its response budget on reasoning without returning an answer. Try a shorter prompt or a different model.`);
    err.providerErrorType = 'ReasoningBudgetExceeded';
    err.provider = provider.name;
    // Reasoning digest: the orchestrator's continuation nudge embeds this so
    // the next round resumes from where the thinking left off instead of
    // re-deriving everything from zero.
    err.reasoningLength = reasoningText.length;
    err.reasoningDigest = reasoningText.length > 0
      ? `${reasoningText.slice(0, 300)}\n[...]\n${reasoningText.slice(-300)}`
      : '';
    throw err;
  }

  return { text: fullText, toolCalls };
  } finally {
    clearWaitingTicker();
  }
}
