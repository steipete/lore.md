# Changelog

## 0.2.1 — Unreleased

- Update Wrangler's pinned Miniflare dependencies to fix vulnerable sharp and undici versions that blocked Dependabot security updates; refresh development tooling and check dependencies and Node 22.13 compatibility in credential-free CI.
- Refresh Wrangler, Workers types, formatting/lint tooling, and pnpm while retaining the Node 22.13 minimum.
- Pin daily essay generation to xAI `grok-4.20-0309-non-reasoning` and refresh the cache namespace so the new model produces a distinct daily record.

## 0.2.0 — 2026-07-02

### Highlights

- Generate one canonical daily page per host by coalescing concurrent `/daily` and `/stream` misses inside the Durable Object. Thanks @vincent-peng for [PR #4](https://github.com/steipete/lore.md/pull/4).
- Support authenticated Cloudflare AI Gateway credentials and route the public xAI model identifier correctly through `/compat`.
- Keep streaming clients, stored records, and later daily responses consistent across disconnects, malformed upstream streams, timeouts, and fallback generation.
- Bound Durable Object storage to one active daily slot per cache version, migrate same-day legacy records safely, and refresh the cache namespace after credential repair.
