# Zenix POS — source repair and repository split (2026-10-08)

## Outcome
- Two **standalone** repositories: `backend/` (Render/Node/PostgreSQL) and `frontend/` (Vercel/React/Vite).
- Canonical backend starts from **Codex's phase1 worktree**, not the stale original `backend/` tree.
- Frontend starts from **Codex's frontend worktree's inner `frontend/`**, not the stale root tree.
- No `frontend/frontend`, `frontend/backend`, `.worktrees/`, `node_modules/`, `.git/`, compiled `dist/`, or `.env` secrets are distributed in the source ZIPs.
- Source SCSS/CSS compared against the supplied Codex worktree: **21/21 exact matches, zero style changes**.
- This package was not deployed, no production Neon queries/mutations were performed.

## Fixes included
1. Removed nested repo structure while preserving UI code/assets, API proxy, migrations, backend routes, and bots in the right repo.
2. Made standalone frontend tests, readiness, Vercel docs and gitignore independent of an embedded backend; retained combined cross-repo tests.
3. POS sales now lock their open shift row with `FOR UPDATE` to serialize against shift close.
4. Refunds lock customer row, include actual settled credit repayments by payment method, check prior refunds/captured funds, and respect validated explicit payment breakdowns. Previously a fully paid nasiya could fail original refund with `REFUND_MISMATCH`.
5. Inventory count: use SAVEPOINT rollback for partial stock movements; commit a persistent `conflict` count before returning HTTP 409.
6. Receiving API now requires positive cost price, and quick receive rejects blank/zero costs.
7. Document text rows with `1L` size and trailing `24 8500 204000` quantities are conservatively parsed (review required); thousands separators are handled; ambiguous rows never get automatic high confidence.
8. CSV multiline quoted records stay intact; XLSX prefers the data worksheet rather than the first cover sheet.
9. Imported quick receipt requires an explicit confirmation. Displays document total vs computed total if they differ; no automatic silent write.
10. Super Admin: tab-specific filters, plan values, stale asynchronous receipt/audit response protection, and payment intent from billing drafts.
11. Shutdown begins closing HTTP before waiting for notification workers and database pool teardown.
12. Added regression checks for high-risk stock, money and import cases.

## Tests run in this sandbox
- Backend: **155 PASS, 0 FAIL, 3 SKIP** (`npm test`), backend syntax check PASS.
- Frontend combined source tests: **238 PASS, 2 FAIL, 3 SKIP**. Both FAIL results are due to unavailable Linux-native Rolldown binding in dependencies unpacked from a Windows ZIP; npm registry DNS request was unavailable. Do not call them application PASS.
- Frontend `npm run audit`: PASS, missing imports 0, forbidden refs 0.
- Frontend `npm run verify:production`: PASS (static standalone checks).
- Focused import safety tests: **5/5 PASS**, file preview, monetary parsing and CSV tests.
- Frontend production **Vite build NOT VERIFIED** in this sandbox because the Linux Rolldown native optional package cannot be downloaded; re-run fresh `npm ci && npm run build` with internet.
- Real PostgreSQL integration/concurrency tests **NOT VERIFIED in this pass** (3 backend tests skipped without `TEST_DATABASE_URL`). Previous Codex Phase1 report documents disposable PostgreSQL tests on its original environment.
- No real printer/scanner, payment gateway, Telegram, Neon, Render, Vercel or browser/device E2E verified.

## Required before paid production launch
1. In each repository run `npm ci`, `npm test`, `npm run build` (frontend) and `npm run check` (backend).
2. Stage on disposable PostgreSQL with controlled migrations and run `npm run test:db`; never target live production credentials.
3. Verify real sale/shift race, paid-credit refund and inventory conflict API flow end-to-end.
4. Check Neon restore, backups, tenant isolation, Vercel same-origin proxy and Render health checks.
5. Verify all payment/billing and Telegram integrations with test credentials; only then pilot.

## Deploy layout
- **Backend repo**: `src/`, `migrations/`, `render.yaml` at repository root. Deploy with Render root `.`.
- **Frontend repo**: `src/`, `api/`, `public/`, `vercel.json`, `vite.config.js` at repository root. Deploy with Vercel root `.` (update old `frontend` root-directory setting).
- Use `DATABASE_URL` (pooled) at backend runtime, a distinct direct `MIGRATION_DATABASE_URL` for controlled migrations; `ZENIX_BACKEND_URL` server-only at Vercel. Production must not run migrations automatically.
- **No production deploy was executed**.

## Remaining scope / caveats
- Comprehensive Super Admin actions for controlling businesses, subscription limits and audit pagination still need P1 work.
- Real scanned PDFs/images still require OCR if automatic import is in MVP scope.
- Import cannot guarantee correctness for every arbitrary document layout; human confirmation is mandatory.
- Large catalog pagination, printer/scanner E2E, billing expiry/renewal lifecycle, backup/restore and actual production monitoring still need verification.
- This is a repaired source package, **not a certified GO-LIVE build**.
