# 📜 lore.md

One Markdown page per domain per day.

Minimal Cloudflare Worker that serves a single AI-generated markdown essay per hostname per UTC day. First request triggers generation; the result is cached at the edge and in a Durable Object so you pay for one model call per day per domain. Output is plaintext markdown displayed inside a monospace HTML shell with automatic light/dark.

What it uses

- Cloudflare Worker + Durable Object
- Cloudflare AI Gateway (OpenAI-compatible) pointing to the pinned xAI `grok-4.20-0309-non-reasoning` model
- Edge cache 24h
- Durable Object request coalescing so cold misses share one daily generation
- Optional streaming path `/stream` to show the first generation live on cache miss

Quick start

1. `wrangler login` (or export a CF_API_TOKEN with Workers/DO/AI Gateway edit perms).
2. Create an AI Gateway in the dashboard, add the xAI provider, copy the compat base `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/compat`.
3. From repo root:
   - `wrangler secret put XAI_API_KEY`
   - optional: `wrangler secret put GATEWAY_TOKEN` if your Gateway uses a separate token
   - set env `GATEWAY_BASE` to your compat URL (or edit the default placeholder in `src/worker.ts`); the Worker adds Cloudflare's required `grok/` model namespace for `/compat` URLs.
4. `wrangler deploy`
5. Map your domains in Cloudflare Routes/DNS to this worker. Host header drives per-domain text.

Behavior

- One generation per host per UTC day; DO overwrites one `{text, generatedAt}` slot per cache version.
- Edge cache keyed per host/version/day; headers: `ETag` = `host:version:date`, `X-Generated-On` = date.
- Prompt: philosophical, host-aware, ~220–400 words, H1 + H2 sections, optional single bullet list, italic closing line.
- Fallback text is deterministic if the AI call fails, and is stored for that host/day.
- Footer shows generation date and a right-aligned link “a @steipete project” → https://steipete.me.
- Streaming: request `/stream` to stream the first uncached generation live through the Durable Object. Concurrent `/` or `/stream` misses wait on the same in-flight generation, so streaming cannot bypass the one-generation-per-day guard. Live responses are not edge-cached; the next normal request caches the completed DO record. Interrupted streams store deterministic fallback text, never partial output, as the daily record.

Testing

- Use Node 22.13 or newer and install the pnpm version pinned in `package.json` with `npm install --global pnpm@11.28.4`. Then run `pnpm install --frozen-lockfile` and `pnpm check` for formatting, types, lint, and unit tests. Installing pnpm directly avoids the outdated Corepack signing keys bundled with older Node releases.
- Run `pnpm audit --audit-level=high` to check dependency advisories and `pnpm exec wrangler deploy --dry-run` to validate the Worker bundle without credentials or a deployment.
- `wrangler dev` then curl twice: `curl -H "Host: yourdomain.test" http://127.0.0.1:8787` and confirm `X-Generated-On` stays fixed.
- Check AI Gateway analytics to verify only one upstream call per domain per day.
- Stream path test: `curl -N http://127.0.0.1:8787/stream` on a fresh day to observe live output.

Config references

- `src/worker.ts`: worker logic, DO class, Gateway call.
- `wrangler.toml`: DO binding `DOMAIN_DO`, entrypoint, migration tag.
- `docs/spec.md`: deeper architecture and ops notes.
- CI: `.github/workflows/ci.yml` checks the minimum Node 22.13 runtime and the latest Node 22 release, audits dependencies, and validates the bundle with `wrangler deploy --dry-run`. CI does not require deployment or AI credentials.
