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

    const cacheKey = new Request(`https://${host}/__md/${today}`, {
      method: "GET",
    });

    // 1) Edge cache first.
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    // 2) Ask Durable Object for today's text (generates on first hit).
    const stub = env.DOMAIN_DO.get(env.DOMAIN_DO.idFromName(host));
    const doRes = await stub.fetch("https://domain-do/internal", {
      headers: { host },
    });
    if (!doRes.ok) {
      return new Response("Upstream generation failed", { status: 502 });
    }
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
        etag: `${host}:${payload.generatedAt}`,
        "x-generated-on": payload.generatedAt,
      },
    });

    // 3) Populate edge cache asynchronously.
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
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

    // Serialize concurrent requests for same DO instance.
    return await this.state.blockConcurrencyWhile(async () => {
      const existing = await this.state.storage.get(today);
      if (existing) {
        return json(existing);
      }

      const text = await generateDailyText(this.env, host, today);
      const record = { text, generatedAt: today };

      await this.state.storage.put(today, record, {
        expirationTtl: 60 * 60 * 27, // ~27h to cover clock skew.
      });

      return json(record);
    });
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
    model: "xai/grok-4.1-fast-non-reasoning",
    messages: [
      {
        role: "system",
        content:
          "You write concise, thoughtful Markdown essays. No HTML. No images. Do not mention the prompt itself.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.65,
    top_p: 0.9,
    max_tokens: 900,
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

function buildPrompt(host, today) {
  return `Write a reflective Markdown piece (450-750 words) for the site "${host}".
Theme: derive meaning, metaphor, or philosophy from the domain name itself.
Tone: contemplative, clear, modern; avoid clichés.
Structure:
- Start with a single H1 title.
- 2-3 short sections with H2 headings.
- At most one bullet list.
- No images, links, HTML, or code fences.
Constraints: keep it under ~750 words, English only.
Add a one-line italicized closing thought. Date context: ${today} UTC.`;
}

function fallbackText(host, today) {
  return `# ${host}

We meant to hand you something thoughtful today, but the generator blinked.

Until it wakes, take this small reminder: meaning often shows up after the first attempt, not before it.

_Generated on ${today} UTC; cached until the next sunrise._`;
}

function renderPage({ host, text, generatedAt }) {
  const escapedText = escapeHtml(text);
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
  text-decoration: underline;
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
  <pre>${escapedText}</pre>
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
