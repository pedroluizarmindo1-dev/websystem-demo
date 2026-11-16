# RC1 — Client Area, SQLite and SMTP (staging only)

This branch is a proposed extension of RC1. **Do not deploy directly to public production without review and backup.** The currently running KVM2 container is unchanged.

## Data
- SQLite schema adds `client_users`, `client_sessions`, `client_order_links`, `client_ticket_links`, `mail_outbox` using idempotent `CREATE TABLE IF NOT EXISTS`.
- Existing `orders`, `support_tickets`, `auth.sqlite` and service tables are preserved.
- Order ownership is explicit, not inferred from customer name/email.
- Back up both SQLite files *before* migrating. Use SQLite online backup, not `cp` of a live database.
- Run the backup script from a host with Node 24 and read access to both DBs, with `DATA_DIR` and `BACKUP_DIR` set. Backup destination must be outside the Docker volume and stored off-server, encrypted and access-restricted. Verify restores regularly.
- Script retains latest 14 backups per database. Arrange scheduling separately.

## Customer portal
- `/cliente.html` is a mobile-responsive standalone page.
- `POST /api/client/login`, `POST /api/client/logout`, `GET /api/client/me`, `GET /api/client/orders`, `GET /api/client/tickets`, `POST /api/client/tickets`.
- `POST /api/admin/client-area/users` creates invited clients (admin session required).
- `POST /api/admin/client-area/users/:id/orders` explicitly links an existing order to a client.
- There is deliberately **no public signup**, no password reset, no automatic wallet operations, and no customer visibility into unlinked orders.
- Client session cookies are HttpOnly, Secure when `COOKIE_SECURE=true`, SameSite=Lax, scoped to `/api/client`. Set `APP_ORIGIN=https://unlockertools.tech`; mutation requests without matching Origin are rejected.
- Test role isolation and session expiry, password reset design, and accessibility before release.

## Email
- Admin endpoints: `POST /api/admin/client-area/mail/queue`, `GET /api/admin/client-area/mail/status`, `POST /api/admin/client-area/mail/send-pending`.
- The outbox is persistent and manual-send only; no automatic sends on registration or orders. Do not send real mail during smoke tests.
- Configure **only on the server**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. Set SPF, DKIM, DMARC at DNS provider and verify sending domain.
- A production-ready mail worker needs stronger atomic claiming, retries with idempotency, backoff, bounce handling and delivery observability.

## Safe deployment sequence
1. Review this branch and tests. Freeze writes briefly, create off-server SQLite backups, and test restore.
2. Set `APP_ORIGIN` and `COOKIE_SECURE=true`; provision SMTP secrets separately, never in GitHub.
3. Merge only after review; `git pull --ff-only` on KVM2, then `docker compose build` and `docker compose up -d`.
4. Validate `/api/health`, `/cliente.html`, unauthenticated 401, admin RBAC, order isolation and logs.
5. Rollback image/code if needed, but **do not blindly roll back a migrated database**. Restore only from a verified backup with a documented recovery procedure.

## Outstanding security work
Current RC1 has several broad admin routes guarded by login but not admin role; global CSRF/Origin and rate limiting require a separate hardening pass. Public release remains blocked until these are resolved.
