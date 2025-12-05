# daily.md — One Markdown Page Per Domain Per Day

Minimal Cloudflare Worker that serves a single AI-generated markdown essay per hostname per UTC day. First request triggers generation; the result is cached at the edge and in a Durable Object so you pay for one model call per day per domain. Output is plaintext markdown displayed inside a monospace HTML shell with automatic light/dark.

What it uses
- Cloudflare Worker + Durable Object
- Cloudflare AI Gateway (OpenAI-compatible) pointing to xAI Grok 4.1 fast non-reasoning
- Edge cache 24h + stale-while-revalidate 1h

Quick start
1) `wrangler login` (or export a CF_API_TOKEN with Workers/DO/AI Gateway edit perms).
2) Create an AI Gateway in the dashboard, add the xAI provider, copy the compat base `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/compat`.
3) From repo root:  
   - `wrangler secret put XAI_API_KEY`  
   - optional: `wrangler secret put GATEWAY_TOKEN` if your Gateway uses a separate token  
   - set env `GATEWAY_BASE` to your compat URL (or edit the default placeholder in `src/worker.js`).
4) `wrangler deploy`
5) Map your domains in Cloudflare Routes/DNS to this worker. Host header drives per-domain text.

Behavior
- One generation per host per UTC day; DO stores `{text, generatedAt}` with ~27h TTL.
- Edge cache keyed per host/day; headers: `ETag` = `host:date`, `X-Generated-On` = date.
- Prompt: philosophical, host-aware, 450–750 words, H1 + H2 sections, optional single bullet list, italic closing line.
- Fallback text is deterministic if the AI call fails.
- Footer shows generation date and a right-aligned link “a @steipete project” → https://steipete.me.

Testing
- `wrangler dev` then curl twice: `curl -H "Host: yourdomain.test" http://127.0.0.1:8787` and confirm `X-Generated-On` stays fixed.
- Check AI Gateway analytics to verify only one upstream call per domain per day.

Config references
- `src/worker.js`: worker logic, DO class, Gateway call.
- `wrangler.toml`: DO binding `DOMAIN_DO`, entrypoint, migration tag.
- `docs/spec.md`: deeper architecture and ops notes.
- CI: `.github/workflows/ci.yml` runs `wrangler deploy --dry-run` (needs GitHub secrets: `CLOUDFLARE_API_TOKEN`, `XAI_API_KEY`, and `GATEWAY_BASE`; optional `GATEWAY_TOKEN`).
