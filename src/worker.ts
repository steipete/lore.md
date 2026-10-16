// Daily AI-generated markdown per domain, cached per UTC day.
// Uses xAI Grok 4.7 with low reasoning via Cloudflare AI Gateway (OpenAI-compatible).

export interface Env {
  DOMAIN_DO: DurableObjectNamespace;
  XAI_API_KEY: string;
  GATEWAY_BASE?: string;
  GATEWAY_TOKEN?: string;
}

type DomainRecord = {
  text: string;
  generatedAt: string;
};

type XaiChatCompletion = {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
  }>;
  output_text?: string;
  response?: string;
};

const XAI_MODEL = "grok-4.7";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host") || url.host || "localhost";
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const version = "v18";

    const cacheKey = new Request(`https://${host}/${version}/__md/${today}`, {
      method: "GET",
    });

    // 1) Edge cache first.
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    // 1b) Ask DO for today's text; /stream preserves live output on the first miss.
    const stub = env.DOMAIN_DO.get(env.DOMAIN_DO.idFromName(host));
    try {
      const doPath = url.pathname === "/stream" ? "/stream" : "/daily";
      const doRes = await stub.fetch(`https://domain-do${doPath}`, {
        headers: { "x-md-host": host, "x-md-version": version },
      });
      if (!doRes.ok) {
        throw new Error(`DO daily request failed with ${doRes.status}`);
      }

      // A live stream is not cacheable because its canonical record is unknown
      // until generation and Durable Object storage both complete.
      if (doPath === "/stream") return doRes;

      const record = await doRes.json();
      if (!isDomainRecord(record, today)) {
        throw new Error("DO daily response was malformed or stale");
      }
      const response = renderDailyResponse(host, record, version);
      ctx.waitUntil(
        caches.default
          .put(cacheKey, response.clone())
          .catch((err) => console.error("edge cache write error", err)),
      );
      return response;
    } catch (err) {
      console.error("DO daily request error", err);
    }

    // Do not cache a Worker-local fallback: the DO request may have failed after
    // successfully starting generation, and its stored record remains canonical.
    return renderUncachedFallback(host, today, version);
  },
};

// Export helpers for testing.
export {
  buildGatewayHeaders,
  buildPrompt,
  fallbackText,
  generateDailyText,
  renderPage,
  resolveXaiModel,
};

export class DomainDO {
  state: DurableObjectState;
  env: Env;
  inflight: Map<string, Promise<DomainRecord>>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.inflight = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const version = request.headers.get("x-md-version") || "v1";
    const host = request.headers.get("x-md-host") || request.headers.get("host") || "localhost";
    const inflightKey = `${version}-${today}`;
    const storageKey = `${version}-daily`;
    const legacyKey = `${version}-${today}`;

    if (url.pathname === "/daily") {
      const record = await this.getOrCreateDailyRecord(
        inflightKey,
        storageKey,
        legacyKey,
        host,
        today,
      );
      return json(record);
    }

    if (url.pathname === "/stream") {
      return this.streamDailyRecord(inflightKey, storageKey, legacyKey, host, today, version);
    }

    return new Response("not found", { status: 404 });
  }

  private async getOrCreateDailyRecord(
    inflightKey: string,
    storageKey: string,
    legacyKey: string,
    host: string,
    today: string,
  ): Promise<DomainRecord> {
    const existing = await this.getStoredDailyRecord(storageKey, legacyKey, today);
    if (existing) return existing;

    const pending = this.inflight.get(inflightKey);
    if (pending) return pending;

    const promise = (async () => {
      const text = await generateDailyText(this.env, host, today);
      const record = { text, generatedAt: today };
      await this.storeDailyRecord(storageKey, record);
      return record;
    })();

    this.inflight.set(inflightKey, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(inflightKey);
    }
  }

  private async streamDailyRecord(
    inflightKey: string,
    storageKey: string,
    legacyKey: string,
    host: string,
    today: string,
    version: string,
  ): Promise<Response> {
    const existing = await this.getStoredDailyRecord(storageKey, legacyKey, today);
    if (existing) return renderHtmlResponse(host, existing.text, existing.generatedAt, version);

    const pending = this.inflight.get(inflightKey);
    if (pending) {
      const record = await pending;
      return renderHtmlResponse(host, record.text, record.generatedAt, version);
    }

    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    // Pending I/O keeps a Durable Object alive without waitUntil. Keep canonical
    // generation detached from response backpressure so peers can await it.
    const promise = this.generateStreamedRecord(storageKey, host, today, writer, encoder);
    this.inflight.set(inflightKey, promise);
    void promise.then(
      () => this.inflight.delete(inflightKey),
      (err) => {
        this.inflight.delete(inflightKey);
        console.error("streamed daily generation failed", err);
      },
    );

    return new Response(stream.readable, {
      headers: streamHeaders(version, today),
    });
  }

  private async getStoredDailyRecord(
    storageKey: string,
    legacyKey: string,
    today: string,
  ): Promise<DomainRecord | undefined> {
    const current = await this.state.storage.get<DomainRecord>(storageKey);
    if (isDomainRecord(current, today)) return current;

    // Main previously stored records under version/date keys. Migrate today's
    // observed production state once, then overwrite one bounded daily slot.
    const legacy = await this.state.storage.get<DomainRecord>(legacyKey);
    if (!isDomainRecord(legacy, today)) return undefined;

    await this.storeDailyRecord(storageKey, legacy);
    await this.state.storage.delete(legacyKey);
    return legacy;
  }

  private async storeDailyRecord(storageKey: string, record: DomainRecord): Promise<void> {
    const current = await this.state.storage.get<DomainRecord>(storageKey);
    if (isStoredDomainRecord(current) && current.generatedAt > record.generatedAt) return;
    await this.state.storage.put(storageKey, record);
  }

  private async generateStreamedRecord(
    storageKey: string,
    host: string,
    today: string,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    encoder: TextEncoder,
  ): Promise<DomainRecord> {
    let collected = "";
    let streamOpen = true;
    let writeChain = Promise.resolve();
    const write = (html: string) => {
      if (!streamOpen) return;
      writeChain = writeChain.then(async () => {
        if (!streamOpen) return;
        try {
          await writer.write(encoder.encode(html));
        } catch (err) {
          streamOpen = false;
          console.error("stream write error", err);
        }
      });
    };
    const closeStream = async () => {
      if (!streamOpen) return;
      streamOpen = false;
      try {
        await writer.close();
      } catch (err) {
        console.error("stream close error", err);
      }
    };
    const abortStream = async (reason: unknown) => {
      if (!streamOpen) return;
      streamOpen = false;
      try {
        await writer.abort(reason);
      } catch (err) {
        console.error("stream abort error", err);
      }
    };

    write(renderShellStart(host));
    let record: DomainRecord;
    try {
      await callXaiStream(this.env, buildPrompt(host, today), (chunk) => {
        collected += chunk;
        write(renderMarkdownChunk(chunk));
      });

      const text = collected.trim();
      if (!text) throw new Error("xAI stream response missing content");
      record = { text, generatedAt: today };
    } catch (err) {
      console.error("AI stream generation error", err);
      const fallback = fallbackText(host, today);
      record = { text: fallback, generatedAt: today };
      if (!collected.trim()) {
        write(renderMarkdownChunk(fallback));
      } else {
        write(
          renderMarkdownChunk(
            "\n\n_Generation interrupted; the saved daily page uses fallback text._",
          ),
        );
      }
    }

    try {
      await this.storeDailyRecord(storageKey, record);
    } catch (err) {
      await abortStream(err);
      throw err;
    }

    write(renderShellEnd(today));
    void writeChain.then(closeStream);
    return record;
  }
}

async function generateDailyText(env: Env, host: string, today: string): Promise<string> {
  const prompt = buildPrompt(host, today);

  try {
    const text = await callXai(env, prompt);
    const trimmed = text.trim();
    if (!trimmed) throw new Error("xAI response missing content");
    return trimmed;
  } catch (err) {
    console.error("AI generation error", err);
    return fallbackText(host, today);
  }
}

async function callXai(env: Env, prompt: string): Promise<string> {
  if (!env.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is not set");
  }
  const apiBase =
    env.GATEWAY_BASE || "https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/compat";
  const body = {
    model: resolveXaiModel(apiBase),
    messages: [
      {
        role: "system",
        content:
          "You write concise, thoughtful Markdown essays. Do not mention Markdown or formatting itself. No HTML. No images. Do not mention the prompt. Never use an em-dash (—); use commas or colons instead.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.6,
    top_p: 0.9,
    reasoning_effort: "low",
    max_tokens: 500,
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: buildGatewayHeaders(env),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const msg = await safeText(res);
      throw new Error(`xAI error ${res.status}: ${msg}`);
    }

    const data = (await res.json()) as XaiChatCompletion;
    const text = data?.choices?.[0]?.message?.content || data?.output_text || data?.response;
    if (!text) throw new Error("xAI response missing content");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function callXaiStream(
  env: Env,
  prompt: string,
  onChunk: (chunk: string) => Promise<void> | void,
): Promise<void> {
  if (!env.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is not set");
  }
  const apiBase =
    env.GATEWAY_BASE || "https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/compat";
  const body = {
    model: resolveXaiModel(apiBase),
    messages: [
      {
        role: "system",
        content:
          "You write concise, thoughtful Markdown essays. No HTML. No images. Do not mention the prompt itself.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.6,
    top_p: 0.9,
    reasoning_effort: "low",
    max_tokens: 500,
    stream: true,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: buildGatewayHeaders(env),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const msg = await safeText(res);
      throw new Error(`xAI stream error ${res.status}: ${msg}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const processEvent = async (event: string): Promise<boolean> => {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data) return false;
      if (data === "[DONE]") return true;

      try {
        const json = JSON.parse(data) as XaiChatCompletion;
        const delta =
          json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.message?.content || "";
        if (delta) await onChunk(delta);
      } catch (e) {
        throw new Error("xAI stream contained malformed JSON", { cause: e });
      }
      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n?/g, "\n");
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        if (await processEvent(part)) return;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim() && (await processEvent(buffer))) return;
    throw new Error("xAI stream ended before [DONE]");
  } finally {
    clearTimeout(timeout);
  }
}

function buildGatewayHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.XAI_API_KEY}`,
  };

  if (env.GATEWAY_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${env.GATEWAY_TOKEN}`;
  }

  return headers;
}

function resolveXaiModel(apiBase: string): string {
  // Cloudflare's unified API routes by provider prefix; native Grok/xAI endpoints do not.
  const path = new URL(apiBase).pathname.replace(/\/+$/, "");
  return path.endsWith("/compat") ? `grok/${XAI_MODEL}` : XAI_MODEL;
}

function buildPrompt(host: string, today: string): string {
  return `Write a reflective Markdown piece (220-400 words) for the site "${host}".
Theme: find a simple, thoughtful meaning, metaphor, or philosophy inspired by the domain name.
Tone: calm, sincere, meaningful; avoid jargon and clichés; use clear, everyday language.
If no strong philosophical angle emerges, tell a small, heartwarming story instead.
Structure:
- Start with a single H1 title.
- 2-3 short sections with H2 headings.
- At most one bullet list.
- No images, links, HTML, or code fences.
Constraints: keep it under ~400 words, English only.
Add a one-line italicized closing thought. Date context: ${today} UTC.`;
}

function fallbackText(host: string, today: string): string {
  return `# ${host}

We meant to hand you something thoughtful today, but the generator blinked.

Until it wakes, take this small reminder: meaning often shows up after the first attempt, not before it.

_Generated on ${today} UTC; cached until the next sunrise._`;
}

function renderPage({
  host,
  text,
  generatedAt,
}: {
  host: string;
  text: string;
  generatedAt: string;
}) {
  const rendered = renderMarkdown(text);
  return wrapShell(host, rendered, generatedAt);
}

function renderHtmlResponse(
  host: string,
  text: string,
  generatedAt: string,
  version: string,
): Response {
  return new Response(renderPage({ host, text, generatedAt }), {
    headers: htmlHeaders(host, version, generatedAt),
  });
}

function renderDailyResponse(host: string, record: DomainRecord, version: string): Response {
  return renderHtmlResponse(host, record.text, record.generatedAt, version);
}

function htmlHeaders(host: string, version: string, generatedAt: string): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=86400",
    etag: `${host}:${version}:${generatedAt}`,
    "x-generated-on": generatedAt,
    "x-md-version": version,
  };
}

function streamHeaders(version: string, generatedAt: string): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-generated-on": generatedAt,
    "x-md-version": version,
  };
}

function renderUncachedFallback(host: string, today: string, version: string): Response {
  const text = fallbackText(host, today);
  const headers = new Headers(htmlHeaders(host, version, today));
  headers.set("cache-control", "no-store");
  return new Response(renderPage({ host, text, generatedAt: today }), { headers });
}

function isDomainRecord(value: unknown, expectedDate: string): value is DomainRecord {
  return isStoredDomainRecord(value) && value.generatedAt === expectedDate;
}

function isStoredDomainRecord(value: unknown): value is DomainRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<DomainRecord>;
  return (
    typeof record.text === "string" &&
    record.text.trim().length > 0 &&
    typeof record.generatedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.generatedAt)
  );
}

function wrapShell(host: string, renderedHtml: string, generatedAt: string) {
  return `${renderShellStart(host)}${renderedHtml}${renderShellEnd(generatedAt)}`;
}

function renderShellStart(host: string) {
  const css = `
:root { color-scheme: light dark; }
body {
  font: 16px/1.6 "IBM Plex Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-width: 72ch;
  margin: 4vh auto 5vh;
  padding: 0 1.5rem;
  background: var(--bg, #f8f8f5);
  color: var(--fg, #111);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0c0c0c; --fg: #e6e6e6; }
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f8f8f5; --fg: #111; }
}
pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
}
footer {
  margin-top: 2.5rem;
  font-size: 12px;
  letter-spacing: 0.02em;
  opacity: 0.7;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
footer a {
  color: inherit;
  text-decoration: none;
}
.strong-italic {
  font-style: italic;
  font-weight: 600;
}
em { font-style: italic; }
strong { font-weight: 700; }
footer span, footer a { white-space: nowrap; }
@media (max-width: 340px) {
  footer { flex-direction: column; align-items: flex-start; }
}
}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(host)}" />
  <meta property="og:description" content="One daily markdown page: ${escapeHtml(host)}" />
  <meta property="og:url" content="https://${escapeHtml(host)}" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%23000'%3E%3C/rect%3E%3Ctext x='50%25' y='58%25' text-anchor='middle' font-size='36' font-family='monospace' fill='%23fff'%3Emd%3C/text%3E%3C/svg%3E" />
  <title>${escapeHtml(host)}</title>
  <style>${css}</style>
</head>
<body>
  <pre>`;
}

function renderShellEnd(generatedAt: string) {
  return `</pre>
  <footer>
    <span>Generated on ${generatedAt}</span>
    <a href="https://steipete.me">a @steipete project</a>
  </footer>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json" },
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no-body>";
  }
}

function renderMarkdown(markdown: string): string {
  // render inline tags but keep decorators visible
  let escaped = escapeHtml(markdown);
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>*$1*</strong>");
  escaped = escaped.replace(/\*(.+?)\*/g, "<em>*$1*</em>");
  escaped = escaped.replace(/~~(.+?)~~/g, "<del>~~$1~~</del>");
  return escaped;
}

function renderMarkdownChunk(markdown: string): string {
  return escapeHtml(markdown);
}
