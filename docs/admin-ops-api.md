# Admin operations API (`/api/admin/ops`)

Read-only toolkit for the admin panel: filtered/paginated orders, a summary report, an audited CSV export, audit-log search and a redacted queue of customer order drafts.

- Module: `api/admin-ops.mjs` (mounted in `api/server.mjs` right after the client-area router).
- Regression: `node scripts/qa-admin-ops-isolated.mjs` (hermetic: temp copy of `api/`, own SQLite files, no supplier or payment contact). Wired into `scripts/agents-orchestrator.mjs` and the `Integration quality gate` workflow.
- Existing contracts are unchanged: `GET /api/orders`, `PATCH /api/orders/:id`, `GET /api/orders/:id/status-history` and `GET /api/audit-logs` behave as before (asserted by the QA).
- No schema changes and no new order statuses. Status values come from `Object.keys(ORDER_TRANSITIONS)`; the module refuses to load if a status it relies on disappears from the state machine.

## Access control
- Everything sits under `/api/admin`, so the existing admin IP gate and admin-session guard apply first. The router additionally answers `403` unless `req.user.role === 'admin'` (fail closed) and sends `Cache-Control: no-store`.
- Unauthenticated -> `401`; authenticated non-admin -> `403` (covered for all five endpoints).
- Customer drafts are never exposed to the customer-facing API by this module; the admin only receives a redacted view (below).

## Endpoints (all `GET`)

| Endpoint | Purpose |
| --- | --- |
| `/orders` | Filtered, sorted, paginated order list: `{items,total,limit,offset,sort,filters}`. |
| `/orders.csv` | Same filters, returned as an audited CSV attachment. |
| `/summary` | Counters and totals for a UTC day window. |
| `/client-drafts` | Redacted queue of customer order drafts. |
| `/audit` | Audit-log search with facets. |

### Query parameters

`/orders` and `/orders.csv`

| Parameter | Rules |
| --- | --- |
| `status` | Comma-separated list of valid order statuses (`pendente,em_processamento,concluido,entregue,rejeitado,reembolsado`). |
| `payment_status` | Slug `^[a-z_]+$`. |
| `service_id` | Integer >= 1. |
| `from`, `to` | `YYYY-MM-DD` (strict, real calendar dates), applied to `date(created_at)`, inclusive; `from` <= `to`. |
| `q` | Free text (max 80 chars) over customer name/contact, brand, model, AnyDesk id and service name; a numeric value also matches the order id. `%`, `_` and `\` are literal. |
| `sort` | Whitelist: `id_desc` (default), `id_asc`, `updated_desc`, `price_desc`. |
| `limit`, `offset` | `/orders`, `/client-drafts` and `/audit` (not the CSV export). `limit` 1-200 (default 50), `offset` 0-100000. |
| `sep` | `/orders.csv` only: `comma` (default) or `semicolon` (Excel pt-BR; decimal comma). |

`/summary`: `days` = 1-366 (default 30). Day buckets are UTC and zero-filled.

`/client-drafts`: `kind` (`imei`, `server`, `api`, `legacy`), `q` (client e-mail/name, service, device model, identifier), `from`, `to`, `limit`, `offset`. `by_kind` is always computed without the `kind` filter so a UI can render facet counts.

`/audit`: `entity`, `action` (slugs), `entity_id` (integer >= 1), `from`, `to`, `q` (detail text), `limit`, `offset`. The response includes `facets.entities` and `facets.actions`.

Invalid input returns `400` with a message (unknown status, bad date, out-of-range number, unknown sort, repeated parameters, ...). Queries are fully parameterised; sort columns come from a whitelist.

## CSV export
- UTF-8 with BOM, CRLF line endings, columns `id,criado_em,atualizado_em,cliente,contato,marca,modelo,servico,valor_brl,pagamento,status`.
- Spreadsheet formula injection is neutralised: cells starting with `=`, `+`, `-`, `@`, TAB or CR are prefixed with `'`. Cells containing the separator, quotes or line breaks are quoted.
- Hard cap of 5,000 rows: larger results return `422` (`{total,max}`) and ask for narrower filters.
- Quota: 10 exports per 10 minutes per admin user (in memory, per process) -> `429` with `Retry-After`.
- Every successful export writes one audit row: `entity=export`, `action=orders_csv`, `detail=by=<user>;rows=<n>;filters=<json>`. The free-text search term is **not** stored (only `"q":true`). Rejected requests (400/422/429) are not audited.

## Summary report
`orders` (count, total_brl, completed_total_brl), `by_status` (every state-machine status, in state-machine order), `by_payment_status`, `daily` series, `backlog` (`open_orders`, `open_tickets`) and `client_drafts` (`total`, `last_7_days`). Open = `pendente` + `em_processamento`; completed = `concluido` + `entregue`.

## Customer draft queue (privacy)
Drafts (`client_order_drafts`) are customer-owned and never become orders by themselves. This endpoint lets the operator see demand without touching customer secrets:
- Returned: draft id, timestamp, `status: "draft"`, client `{id,email,display_name}`, service name, device model, identifier (IMEI/serial/user, needed for fulfilment) and a `details_summary`.
- `details_summary` contains only **field names and non-sensitive markers** (`kind`, `mode`, names of the provided fields, names of API fields). Values such as license keys, usernames, remote-connection data, comments or API field values are never returned (asserted by the QA with canary strings). Rows with empty or invalid JSON are tolerated.
- If the client-area tables do not exist yet, the endpoint returns an empty result instead of failing.

## Operational notes
- No migrations; no writes besides the export audit row. Rolling back is removing the router mount and the module.
- All dates and day buckets are UTC (SQLite `CURRENT_TIMESTAMP`); for a UTC-3 operator the "day" rolls over at 21:00 local time.
- The export limiter is per process; with several replicas the effective quota is per replica.
- Out of scope (deferred): converting drafts into orders, PIX/payment gateway flows and supplier-specific dynamic forms.
- Production is **not** changed by this module landing in the repository; releases follow the guarded GitHub Actions workflow only.
