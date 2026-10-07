# lore.md — Daily Markdown Per Domain (AI Gateway + xAI)

Last updated: 2026-07-02 (pinned Grok 4.20 non-reasoning model, DO-coordinated daily generation with streaming)

Goal: Serve one markdown essay per domain per UTC day. First request generates and caches; all later requests reuse it. Style is minimal, monospace, with automatic light/dark.

Architecture

- Cloudflare Worker handles HTTP; edge cache (`caches.default`) 24h.
- Durable Object `DomainDO` per hostname enforces single generation per day; stores `{text, generatedAt}` in one overwritten slot per cache version.
- AI generation via Cloudflare AI Gateway (OpenAI-compatible) pointing to the pinned xAI `grok-4.20-0309-non-reasoning` model.
- Rendering: raw markdown inside `<pre>` within minimal HTML; footer shows date and project link.
- Streaming: optional `/stream` path streams the first uncached generation from the Durable Object; concurrent `/` or `/stream` misses wait on the same in-flight record.

Data keys

- DO storage key: `{version}-daily` per host (host is implied by DO instance id); the record date decides whether it is current. Today's legacy `{version}-{YYYY-MM-DD}` record is migrated on first read.
- Edge cache key: `https://{host}/{version}/__md/{YYYY-MM-DD}`.
- `ETag`: `{host}:{version}:{date}`; header `X-Generated-On` echoes date.
- Model changes advance the cache version. The new version generates a fresh daily record without deleting the previous version's slot, keeping rollback reversible.

Request flow

1. Worker tries edge cache.
2. On miss:
   - If path is `/stream`, call the DO streaming endpoint. If no record exists, the DO streams AI output live, stores the completed text, and shares that in-flight generation with concurrent daily requests. The live response is not edge-cached because it is not canonical until both generation and DO storage finish.
   - Otherwise, call the DO daily endpoint with the original host and cache version.
   - DO checks storage, then awaits any in-flight generation promise for the same version/date.
   - If nothing exists or is pending, DO calls AI Gateway → xAI, saves generated or deterministic fallback text, returns JSON.
   - Worker renders and edge-caches completed `/daily` records. A normal request after a live stream populates that data center's edge cache.

Prompt (summary)

- Host-aware, philosophical, 220–400 words, Markdown only.
- H1 title; 2–3 H2 sections; at most one bullet list; italic one-line closing.
- Temperature ~0.6, `max_tokens` ~500, English only, no images/HTML/links.

Failure mode

- On AI error, empty output, malformed/truncated SSE, or timeout, deterministic fallback markdown is stored as the daily record. A partially delivered live stream is marked interrupted and never edge-cached. Worker-local fallback for a failed DO request is `no-store`, avoiding divergence from a generation that may still finish inside the DO.

Styling

- Monospace stack: IBM Plex Mono / JetBrains Mono / ui-monospace fallback.
- `:root { color-scheme: light dark; }` neutral palettes.
- Layout: max-width ~72ch, generous margins; `<pre>` preserves markdown.
- Footer: left “Generated on … UTC”, right link `a @steipete project` → https://steipete.me; flex layout collapses vertically on small screens.

Config (wrangler.toml)

- Durable Object binding `DOMAIN_DO` with migration tag `v1`.
- `main = "src/worker.ts"`, `compatibility_date = "2025-12-04"`.
- Secrets: `XAI_API_KEY`; optional `GATEWAY_TOKEN` for an authenticated Gateway; optional `GATEWAY_BASE` (default placeholder `https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/compat`). The provider key stays in `Authorization`; the Gateway token is sent separately in `cf-aig-authorization`. For Cloudflare `/compat` URLs, the Worker adds the required `grok/` provider namespace to the public xAI model identifier.

Deployment steps

- `wrangler secret put XAI_API_KEY`
- (optional) `wrangler secret put GATEWAY_TOKEN`
- Set env var `GATEWAY_BASE` (or edit default in code) with your real Account/Gateway IDs.
- `wrangler deploy`; map domains/routes in Cloudflare.
- First hit per domain per UTC day triggers generation; edge cache serves the rest.
- Streaming: hit `/stream` on a cache miss to watch generation; final page still stores in the DO and caches for subsequent requests.

CI

- `.github/workflows/ci.yml` runs `pnpm check`, `pnpm audit --audit-level=high`, and `pnpm exec wrangler deploy --dry-run` on Node 22.13 and the latest Node 22 release. Bundle validation is local and requires no deployment or AI credentials.

Extensions (optional)

- Add KV read-through if traffic is heavy multi-region.
- Add scheduled cron prefill for known hostnames to eliminate cold start.
- Swap to other Gateway-provided models by changing `model` in `callXai`.

Testing notes

- `wrangler dev` locally; curl twice within same UTC day to confirm stable `X-Generated-On` and `ETag`.
- Check AI Gateway analytics to verify only one upstream call per domain per day.
