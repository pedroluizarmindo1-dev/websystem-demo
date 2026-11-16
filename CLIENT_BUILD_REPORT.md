# WebSystem UNLOCKER Tools — Client Build (2026-11-10)

Source commit: `94f8fe5c9037030e73519e925eb6aa46fbf3e9db`.

## Verified
- `npm run build` successful with Node 24.
- `node --check` successful for `api/server.mjs`, `api/client-area.mjs`, `api/wallet.mjs`.
- Local HTTP 200: `/`, `/services`, `/client/`, `/client/wallet`, `/admin/`, `/api/health`.
- Local unauthenticated HTTP 401: `/api/client/wallet`, `/api/admin/wallet/deposits`.
- Chrome 390x844 viewport: no horizontal overflow on five pages.

## Release gates — not yet verified
- Full authenticated role/permission tests and wallet transaction tests.
- Backup/restore drill on production SQLite.
- Security review for session cookies, CSP/HSTS, CSRF and all API routes.
- USDT BEP20 chain/contract verification, conversion rules, payment reconciliation.
- Production deployment and HTTPS smoke tests.

## Deployment safety
This is a **client build candidate**, not a confirmed production release. Keep `WALLET_REQUESTS_ENABLED` unset or `false`. Do not enable real funds. Before deployment back up the SQLite volume and preserve local `compose.override.yaml`. Deploy only after gates are approved and a rollback path is available.
