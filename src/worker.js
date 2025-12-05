// Daily AI-generated markdown per domain, cached per UTC day.
// Uses xAI Grok 4.1 fast non-reasoning via Cloudflare AI Gateway (OpenAI-compatible).

export default {
  /**
   * @param {Request} request
   * @param {{ DOMAIN_DO: DurableObjectNamespace, XAI_API_KEY: string, GATEWAY_BASE?: string, GATEWAY_TOKEN?: string }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = request.headers.get("host") || url.host || "localhost";
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const version = "v10";

  const cacheKey = new Request(`https://${host}/${version}/__md/${today}`, {
      method: "GET",
    });

    // 1) Edge cache first.
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    // 1b) Ask DO for today's text; if present, render and cache.
    const stub = env.DOMAIN_DO.get(env.DOMAIN_DO.idFromName(host));
    const doRes = await stub.fetch("https://domain-do/internal", {
      headers: { host, "x-md-version": version },
    });
    if (doRes.ok) {
      /** @type {{ text: string, generatedAt: string }} */
      const payload = await doRes.json();
    const html = renderPage({
      host,
      text: payload.text,
      generatedAt: payload.generatedAt,
    });
      const response = new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=86400, stale-while-revalidate=3600",
          etag: `${host}:${version}:${payload.generatedAt}`,
          "x-generated-on": payload.generatedAt,
          "x-md-version": version,
        },
      });
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    }

    // 2) Stream generation (default on cache miss); caches after completion.
    return streamGenerate(host, today, version, env, stub, ctx);
  },
};

// Export helpers for testing.
export { buildPrompt, fallbackText, renderPage };

export class DomainDO {
  /**
   * @param {DurableObjectState} state
   * @param {{ XAI_API_KEY: string, GATEWAY_BASE?: string, GATEWAY_TOKEN?: string }} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const host = request.headers.get("host") || url.host || "localhost";
    const today = new Date().toISOString().slice(0, 10);
    const version = request.headers.get("x-md-version") || "v1";
    const key = `${version}-${today}`;

    if (request.method === "POST" && url.pathname === "/store") {
      const body = await request.json();
      const record = {
        text: body.text,
        generatedAt: body.generatedAt || today,
      };
      await this.state.blockConcurrencyWhile(async () => {
        await this.state.storage.put(key, record, {
          expirationTtl: 60 * 60 * 27,
        });
      });
      return json({ stored: true });
    }

    // GET internal: return if exists, else 404
    const existing = await this.state.storage.get(key);
    if (existing) return json(existing);
    return new Response("not found", { status: 404 });
  }
}

async function generateDailyText(env, host, today) {
  const prompt = buildPrompt(host, today);

  try {
    const text = await callXai(env, prompt);
    return text.trim();
  } catch (err) {
    console.error("AI generation error", err);
    return fallbackText(host, today);
  }
}

async function callXai(env, prompt) {
  if (!env.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is not set");
  }
  const apiBase =
    env.GATEWAY_BASE ||
    "https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/compat";
  const body = {
    model: "grok-4-1-fast-reasoning",
    messages: [
      {
        role: "system",
        content:
          "You write concise, thoughtful Markdown essays. Do not mention Markdown or formatting itself. No HTML. No images. Do not mention the prompt.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.6,
    top_p: 0.9,
    max_tokens: 500,
    stream: false,
  };

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.GATEWAY_TOKEN || env.XAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await safeText(res);
    throw new Error(`xAI error ${res.status}: ${msg}`);
  }

  const data = await res.json();
  const text =
    data?.choices?.[0]?.message?.content ||
    data?.output_text ||
    data?.response;
  if (!text) throw new Error("xAI response missing content");
  return text;
}

async function callXaiStream(env, prompt, onChunk) {
  if (!env.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is not set");
  }
  const apiBase =
    env.GATEWAY_BASE ||
    "https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/compat";
  const body = {
    model: "grok-4-1-fast-reasoning",
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
    max_tokens: 500,
    stream: true,
  };

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.GATEWAY_TOKEN || env.XAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const msg = await safeText(res);
    throw new Error(`xAI stream error ${res.status}: ${msg}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      if (!part.startsWith("data:")) continue;
      const data = part.slice(5).trim();
      if (data === "[DONE]") {
        return;
      }
      try {
        const json = JSON.parse(data);
        const delta =
          json?.choices?.[0]?.delta?.content ||
          json?.choices?.[0]?.message?.content ||
          "";
        if (delta) await onChunk(delta);
      } catch (e) {
        console.error("stream parse error", e);
      }
    }
  }
}

function buildPrompt(host, today) {
  return `Write a reflective Markdown piece (220-400 words) for the site "${host}".
Theme: find a simple, thoughtful meaning, metaphor, or philosophy inspired by the domain name.
Tone: calm, sincere, meaningful; avoid jargon and clichés; use clear, everyday language.
Structure:
- Start with a single H1 title.
- 2-3 short sections with H2 headings.
- At most one bullet list.
- No images, links, HTML, or code fences.
Constraints: keep it under ~400 words, English only.
Add a one-line italicized closing thought. Date context: ${today} UTC.`;
}

function fallbackText(host, today) {
  return `# ${host}

We meant to hand you something thoughtful today, but the generator blinked.

Until it wakes, take this small reminder: meaning often shows up after the first attempt, not before it.

_Generated on ${today} UTC; cached until the next sunrise._`;
}

async function streamGenerate(host, today, version, env, stub, ctx) {
  const prompt = buildPrompt(host, today);
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  const encoder = new TextEncoder();
  const header = renderHead(host);
  const footer = renderFooter(today);

  const response = new Response(ts.readable, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "transfer-encoding": "chunked",
      "x-md-version": version,
    },
  });

  ctx.waitUntil(
    (async () => {
      let collected = "";
      const write = async (chunk) => {
        collected += chunk;
        await writer.write(encoder.encode(chunk));
      };

      try {
        await writer.write(encoder.encode(header));
        await callXaiStream(env, prompt, write);
        await writer.write(encoder.encode(footer));

        if (collected.trim().length && stub) {
          await stub.fetch("https://domain-do/store", {
            method: "POST",
            headers: {
              host,
              "content-type": "application/json",
              "x-md-version": version,
            },
            body: JSON.stringify({ text: collected, generatedAt: today }),
          });
        }

        if (collected.trim().length) {
          const html = wrapShell(host, collected, today);
          const cacheKey = new Request(`https://${host}/${version}/__md/${today}`);
          const cachedResponse = new Response(html, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "public, max-age=86400, stale-while-revalidate=3600",
              etag: `${host}:${version}:${today}`,
              "x-generated-on": today,
              "x-md-version": version,
            },
          });
          await caches.default.put(cacheKey, cachedResponse);
        }
      } catch (err) {
        console.error("stream error", err);
        await writer.write(encoder.encode("\n\n<p><em>generation failed</em></p>"));
      } finally {
        await writer.close();
      }
    })()
  );

  return response;
}

function renderPage({ host, text, generatedAt }) {
  const rendered = renderMarkdown(text);
  return wrapShell(host, rendered, generatedAt);
}

function wrapShell(host, renderedHtml, generatedAt) {
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
  gap: 1rem;
}
footer a {
  color: inherit;
  text-decoration: none;
}
.strong-italic {
  font-style: italic;
  font-weight: 600;
}
@media (max-width: 520px) {
  footer { flex-direction: column; align-items: flex-start; }
}
}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(host)}</title>
  <style>${css}</style>
</head>
<body>
  <pre>${renderedHtml}</pre>
  <footer>
    <span>Generated on ${generatedAt} UTC</span>
    <a href="https://steipete.me" target="_blank" rel="noopener">a @steipete project</a>
  </footer>
</body>
</html>`;
}

function escapeHtml(input) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json" },
  });
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "<no-body>";
  }
}

function renderHead(host) {
  const css = `
:root { color-scheme: light dark; }
body {
  font: 16px/1.6 "IBM Plex Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-width: 72ch;
  margin: 8vh auto 10vh;
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
  gap: 1rem;
}
footer a {
  color: inherit;
  text-decoration: none;
}
.strong-italic {
  font-style: italic;
  font-weight: 600;
}
p { margin: 0.3rem 0 0.6rem; }
@media (max-width: 520px) {
  footer { flex-direction: column; align-items: flex-start; }
}
`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(host)}</title>
  <style>${css}</style>
</head>
<body>
  <pre>`;
}

function renderFooter(generatedAt) {
  return `</pre>
  <footer>
    <span>Generated on ${generatedAt} UTC</span>
    <a href="https://steipete.me" target="_blank" rel="noopener">a @steipete project</a>
  </footer>
</body>
</html>`;
}

function renderMarkdown(markdown) {
  let escaped = escapeHtml(markdown);
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
  escaped = escaped.replace(/~~(.+?)~~/g, '<del>$1</del>');
  return escaped;
}
