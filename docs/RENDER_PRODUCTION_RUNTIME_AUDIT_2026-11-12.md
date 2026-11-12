# Render production runtime audit — 2026-11-12

Status: READ-ONLY INSPECTION + PR CANDIDATE. Live Render service settings and customer records unchanged.

## Current Render My Workspace findings

- My Workspace: tea-d2sr84be5dus73f1mf9g.
- Production service: Zenix-Pos-Backend (srv-darqr0l9fdbs73amtig0), Frankfurt, one instance.
- Last live deploy: dep-dbp0r0uk1f9s73ffpaqg (backend SHA 982ce109b9bc476909cfbd7ac14cb615cbecf315).
- Manual deployment: autoDeploy=no (retain).
- Live build command: npm install; desired repository render.yaml build command: npm ci.
- Live healthCheckPath: empty (TCP only); desired repository render.yaml uses /ready (database-aware HTTP check).
- Render build used Node 26.13.0 because package.json engine >=20 had no upper bound; GitHub CI uses Node 22.
- Build emitted npm audit warnings: 1 moderate and 2 high. Identify dependency chains before patching.
- Production startup emitted PostgreSQL SSL mode future-semantics warning. Do not weaken TLS as a workaround.
- Separate zenix-pos-worker is NOT listed in this workspace's service inventory, although render.yaml declares one.
- src/server.js starts embedded notification/payment/outbox workers unless RUN_NOTIFICATION_WORKERS=false. Current runtime env value is NOT AVAILABLE via the read-only connector. DO NOT change worker ownership blindly.

## Observed read-only telemetry

- Render metrics for 2026-11-11 12:00Z–2026-11-12 12:00Z: 3,748 HTTP 200, one 201, six 401; no 5xx series returned. Metrics are not proof of zero customer errors.
- Sampled last-24h app logs empty; 7-day warning filter shows SSL mode warning. Absence of logs does not establish worker health.
- Neon: zero active long-running queries and zero locks at inspection. pg_stat_statements is not installed, so slow SQL rankings cannot be verified. No extension was installed.
- Independent HTTPS /ready probe was not accessible to the audit browser; do not equate a TCP pass with database readiness.

## Staged candidate — no deployment

1. .node-version=22, package.json/lockfile engines >=22 <23 match existing GitHub CI; service-level NODE_VERSION overrides repository pin and must be reviewed.
2. scripts/checkRenderProductionReadback.mjs is a local JSON readback-only drift validator; no Render API access or write capability. Run: node scripts/checkRenderProductionReadback.mjs /path/to/service.json
3. src/server.js adds a non-sensitive startup marker for effective embedded notification-worker enabled/disabled state. It changes no worker behavior.
4. tests/renderProductionReadback.test.mjs enforces correct service identity, manual deploy, desired readiness path and runtime policy.

## Operator acceptance before any production change

1. Independently GET /health and /ready via HTTPS; record exact status code and DB-ready response.
2. Under a reviewed rollback plan, configure EXISTING Render web service Settings > Health Checks > HTTP path=/ready. render.yaml does not automatically fix an existing manually configured service.
3. Changing HTTP health checks can stop routing or restart on database failures; confirm expected effects before setting them.
4. Review NODE_VERSION environment override and build command before a reviewed manual deployment. Existing repo service is on Node26, candidate would use Node22. Do not deploy merely to silence this audit.
5. Confirm real API RUN_NOTIFICATION_WORKERS and any other active consumers first; plan one-owner worker takeover. No extra worker should be created or enabled without signoff.
6. Triage the 2 high dependency advisories with exact package paths; do not use blind npm audit fix.
7. Investigate SSL warning in staging while retaining certificate verification.
8. After authorized change, read back Render config, independently verify /ready, compare deployment SHA and monitor alerts, outbox, error logs and 5xx.

NO production database SQL writes, schema changes, snapshot restores, Render service setting changes, notification activation or payment/Telegram callbacks were performed in this audit.
