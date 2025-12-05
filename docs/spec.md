# Daily Markdown Per Domain – Spec (AI Gateway + xAI)

Last updated: 2025-12-05

Goal: Serve one markdown essay per domain per UTC day. First request generates and caches; all later requests reuse it. Style is minimal, monospace, with automatic light/dark.

Architecture
- Cloudflare Worker handles HTTP; edge cache (`caches.default`) 24h + `stale-while-revalidate=3600`.
- Durable Object `DomainDO` per hostname enforces single generation per day; stores `{text, generatedAt}` with ~27h TTL.
- AI generation via Cloudflare AI Gateway (OpenAI-compatible) pointing to xAI Grok 4.1 fast non-reasoning.
- Rendering: raw markdown inside `<pre>` within minimal HTML; footer shows date.

Data keys
- DO storage key: `YYYY-MM-DD` per host (host is implied by DO instance id).
- Edge cache key: `https://{host}/__md/{YYYY-MM-DD}`.
- `ETag`: `{host}:{date}`; header `X-Generated-On` echoes date.

Request flow
1) Worker tries edge cache.
2) On miss, call DO stub (per host). DO uses `blockConcurrencyWhile`.
3) If missing, DO calls AI Gateway → xAI, saves text with 27h TTL.
4) Worker renders HTML and asynchronously seeds edge cache.

Prompt (summary)
- Host-aware, philosophical, 450–750 words, Markdown only.
- H1 title; 2–3 H2 sections; at most one bullet list; italic one-line closing.
- Temperature 0.65, `max_tokens` 900, English only, no images/HTML/links.

Failure mode
- On AI error/empty response, deterministic fallback markdown is returned and cached for the day.

Styling
- Monospace stack: IBM Plex Mono / JetBrains Mono / ui-monospace fallback.
- `:root { color-scheme: light dark; }` neutral palettes.
- Layout: max-width ~72ch, generous margins; `<pre>` preserves markdown.
- Footer: left “Generated on … UTC”, right link `a @steipete project` → https://steipete.me; flex layout collapses vertically on small screens.

Config (wrangler.toml)
- Durable Object binding `DOMAIN_DO` with migration tag `v1`.
- `main = "src/worker.js"`, `compatibility_date = "2025-12-04"`.
- Secrets: `XAI_API_KEY`; optional `GATEWAY_TOKEN`; optional `GATEWAY_BASE` (default placeholder `https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/compat`).

Deployment steps
- `wrangler secret put XAI_API_KEY`
- (optional) `wrangler secret put GATEWAY_TOKEN`
- Set env var `GATEWAY_BASE` (or edit default in code) with your real Account/Gateway IDs.
- `wrangler deploy`; map domains/routes in Cloudflare.
- First hit per domain per UTC day triggers generation; edge cache serves the rest.

CI
- `.github/workflows/ci.yml` runs `wrangler deploy --dry-run`; requires GitHub secrets `CLOUDFLARE_API_TOKEN`, `XAI_API_KEY`, optional `GATEWAY_TOKEN`, and `GATEWAY_BASE`.

Extensions (optional)
- Add KV read-through if traffic is heavy multi-region.
- Add scheduled cron prefill for known hostnames to eliminate cold start.
- Swap to other Gateway-provided models by changing `model` in `callXai`.

Testing notes
- `wrangler dev` locally; curl twice within same UTC day to confirm stable `X-Generated-On` and `ETag`.
- Check AI Gateway analytics to verify only one upstream call per domain per day.
