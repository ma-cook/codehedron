// Reasoning-budget A/B: replay the EXACT failing request payload against all
// three egress paths and report whether the model answers or reason-loops.
//
// Usage:
//   1. Reproduce the failing task in the app; DevTools console prints a line:
//        [sendToProvider][DEBUG] payload: {...}
//      Copy everything after "payload: " into a file (default: payload.json
//      in the repo root, or pass the path as the first argument).
//   2. node scripts/llm-ab-test.mjs [payloadPath] [timeoutSecPerLeg]
//
// The API key is read from opencode's local auth store and re-injected — the
// debug payload only carries a redacted hint.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const payloadPath = process.argv[2] || join(rootDir, 'payload.json');
const timeoutSec = Number(process.argv[3]) || 420;

if (!existsSync(payloadPath)) {
  console.error(`payload file not found: ${payloadPath}`);
  console.error('Reproduce the failing task in the app, then copy the');
  console.error('[sendToProvider][DEBUG] payload: {...} line into payload.json');
  process.exit(1);
}

const raw = readFileSync(payloadPath, 'utf8');
const jsonStart = raw.indexOf('{');
const payload = JSON.parse(raw.slice(jsonStart));

const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
const key = JSON.parse(readFileSync(authPath, 'utf8'))?.nvidia?.key;
if (!key || !key.startsWith('nvapi-')) {
  console.error('nvidia key not found in', authPath);
  process.exit(1);
}

const LEGS = [
  { name: 'direct    ', url: payload.url, envelope: null },
  {
    name: 'cf-worker ',
    url: 'https://codehedron-llm-proxy.mitchell-cook.workers.dev/api/llm/chat',
    envelope: true,
  },
  {
    name: 'cloud-run ',
    url: 'https://hoverchart-api-52303258436.us-central1.run.app/api/llm/chat',
    envelope: true,
  },
];

function parseSseChunk(text, acc) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') { acc.done = true; continue; }
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta || {};
      if (typeof delta.reasoning_content === 'string') acc.reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === 'string') acc.reasoning += delta.reasoning;
      if (Array.isArray(delta.content)) {
        for (const part of delta.content) acc.content += typeof part === 'string' ? part : (part?.text || '');
      } else if (typeof delta.content === 'string') {
        acc.content += delta.content;
      }
      const fr = parsed.choices?.[0]?.finish_reason;
      if (fr) acc.finishReason = fr;
    } catch { /* keep-alive or partial line */ }
  }
}

async function runLeg(leg) {
  const headers = { ...payload.headers, Authorization: `Bearer ${key}` };
  const body = leg.envelope
    ? JSON.stringify({ url: payload.url, headers: { ...payload.headers, Authorization: `Bearer ${key}` }, body: payload.body })
    : JSON.stringify(payload.body);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const res = await fetch(leg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    });
    const ttfb = ((Date.now() - started) / 1000).toFixed(1);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      clearTimeout(timer);
      return `HTTP ${res.status} after ${ttfb}s — ${text.slice(0, 160)}`;
    }

    const acc = { reasoning: '', content: '', finishReason: null, done: false };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      parseSseChunk(lines.join('\n'), acc);
    }
    clearTimeout(timer);
    const total = ((Date.now() - started) / 1000).toFixed(1);
    const verdict = acc.content.trim().length > 0
      ? 'ANSWERED'
      : (acc.reasoning.length > 0 ? 'REASONING-ONLY (budget death)' : 'EMPTY');
    return `HTTP 200 | TTFB ${ttfb}s | total ${total}s | reasoning ${acc.reasoning.length} chars | answer ${acc.content.length} chars | finish=${acc.finishReason} → ${verdict}`;
  } catch (e) {
    clearTimeout(timer);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    return `FAILED after ${secs}s — ${e.name === 'AbortError' ? `timeout (${timeoutSec}s)` : e.message}`;
  }
}

console.log(`payload: ${payload.body?.messages?.length ?? '?'} messages, ${payload.body?.tools?.length ?? 0} tools, max_tokens=${payload.body?.max_tokens}, model=${payload.body?.model}`);
console.log(`timeout per leg: ${timeoutSec}s\n`);
for (const leg of LEGS) {
  process.stdout.write(`${leg.name} ... `);
  const result = await runLeg(leg);
  console.log(`\r${leg.name} ${result}\n`);
}
