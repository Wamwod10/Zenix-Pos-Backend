# Zenix POS — Backend (separate repository)

This is the canonical **Express/PostgreSQL** repository for Render, Neon, business logic, migrations, and Telegram bots. There is no frontend subtree.

```bash
npm ci
npm run check
npm test
npm run migrate:status
npm run db:verify
```

Production requires a pooled Neon `DATABASE_URL` and separate direct Neon `MIGRATION_DATABASE_URL` for manually controlled migration sessions. Do not run `npm run migrate` against production without a verified backup and maintenance approval. The `render.yaml` root is this repository root.

The separate Vercel frontend repository must use its own repo root for builds and server-side `ZENIX_BACKEND_URL` API proxy. See `PHASE-1-BACKEND-FOUNDATION-REPORT.md` for the prior foundation audit.

## Phase 7 billing safety

Payment draft submission now checks the **current** tariff, expiry, and active branch count against the draft quote. A 409 `BILLING_DRAFT_STALE` response means the client should create a new quote. Only one pending payment review (LICENSE **or** EXTRA) is allowed per organization so an approved license cannot erase an additional paid branch limit. No DB migration is required for this application-layer guard. More detail in `../PHASE7_PROGRESS.md`.
