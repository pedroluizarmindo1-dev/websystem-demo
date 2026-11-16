# Client IP behind the reverse proxy (`TRUST_PROXY`)

`req.ip` drives every IP-based control in the application:

- the admin IP allow-list (`ADMIN_ALLOWED_IPS`) for `/admin/`, `/api/auth/*` and `/api/admin/*`;
- the global `/api` rate limit, the admin and customer login lockouts and the customer flow limits;
- the public order-lookup throttle;
- the reseller API IP allow-list (`reseller_keys.allowed_ip`, `/api/dhru`);
- the address stored in `security_events` and `client_security_events`.

Express only believes `X-Forwarded-For` when the TCP peer is a trusted proxy. Which peers are trusted is now read from `TRUST_PROXY` (`api/proxy-trust.mjs`).

## Why it matters with Docker Compose
`compose.yaml` publishes the container port on `127.0.0.1:3100` of the host and the host reverse proxy forwards to it. Inside the container that connection does **not** come from loopback: it comes from the Docker bridge gateway, a private address such as `172.18.0.1`. With the previous hard-coded `trust proxy = loopback` the header sent by the proxy was ignored, so:

- every visitor had the same address (the gateway): one client could exhaust the shared rate limit or lock everybody's login, and nobody could be throttled individually;
- `ADMIN_ALLOWED_IPS` could only ever match the gateway, i.e. either nobody or everybody;
- reseller keys compared `allowed_ip` with the gateway as well.

This is reproduced by `scripts/qa-proxy-trust-docker.sh` (real image, published port) and `scripts/qa-proxy-trust-isolated.mjs` (no Docker).

## Values
| `TRUST_PROXY` | Use |
| --- | --- |
| unset or `loopback` | Reverse proxy in the same network namespace (bare-metal Nginx and Node on the same host). Default of the application. |
| `loopback,uniquelocal` | Default in `compose.yaml`: also trusts private peers (10/8, 172.16/12, 192.168/16, fc00::/7), which covers the Docker bridge gateway. |
| explicit addresses or CIDR ranges, e.g. `loopback,172.18.0.1` | Narrowest option when the gateway address is fixed. |

Booleans, hop counts, wildcards and very broad ranges (`true`, `1`, `*`, `0.0.0.0/0`, IPv4 ranges wider than `/8`, IPv6 wider than `/7`) are refused and the server does not start: they would let any client that reaches the port choose its own IP.

The container port must stay bound to `127.0.0.1` (as in `compose.yaml`). Trusting private peers is only safe while the only way to reach the port is through the host reverse proxy.

## Reverse proxy requirements
The proxy must **append** the real client address, for example in Nginx:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

The application uses the right-most address that is not a trusted proxy, so anything a client puts in the header before the proxy appends its own entry is ignored.

## Deployment checklist (required when this change first reaches production)
1. Confirm the host reverse proxy sends `X-Forwarded-For` as above.
2. Set `ADMIN_ALLOWED_IPS` to the **real public IP addresses of the administrators**. If it currently contains a Docker gateway address (`172.x.x.1`), the admin panel answers `404` for everyone after the deploy until this is corrected.
3. Review `allowed_ip` of active reseller keys: they must hold the resellers' public addresses.
4. After the deploy, check the container log: the line `TRUST_PROXY: X-Forwarded-For sent by ... is being ignored` means the proxy is still not trusted. Recent rows of `security_events` should show visitor addresses, not a private gateway address.

Rollback: set `TRUST_PROXY=loopback` in the environment to restore the previous behaviour without changing code.
