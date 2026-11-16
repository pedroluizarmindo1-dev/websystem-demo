#!/usr/bin/env bash
# Client-IP regression with the real image and the compose topology: bridge network, port published on 127.0.0.1,
# requests relayed by a reverse proxy on the host (emulated by curl sending X-Forwarded-For).
# Usage: scripts/qa-proxy-trust-docker.sh [image]   (default websystem:release; needs Docker and curl)
# Fictitious addresses only (TEST-NET ranges); no production data, supplier or payment contact.
set -euo pipefail
image="${1:-websystem:release}"
port="${PROXY_TRUST_PORT:-3197}"
name="websystem-proxy-trust"
admin_ip="203.0.113.7"
other_ip="198.51.100.9"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

start(){ # $1 = TRUST_PROXY value
  cleanup
  docker run -d --name "$name" -e HOST=0.0.0.0 -e PORT=3100 -e DEMO_MODE=false -e WALLET_REQUESTS_ENABLED=false \
    -e ADMIN_ALLOWED_IPS="$admin_ip" -e TRUST_PROXY="$1" -p "127.0.0.1:${port}:3100" "$image" >/dev/null
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  docker logs "$name" || true
  echo "PROXY_TRUST_DOCKER_FAIL: container did not become healthy (TRUST_PROXY=$1)"; exit 1
}
gate(){ # prints the status of an admin-gated route: 401 = IP gate passed, 404 = refused
  curl -s -m 5 -o /dev/null -w '%{http_code}' "$@" "http://127.0.0.1:${port}/api/auth/me"
}
expect(){ # description, expected, actual
  if [ "$2" != "$3" ]; then echo "PROXY_TRUST_DOCKER_FAIL: $1: expected $2, got $3"; docker logs "$name" 2>&1 | tail -20 || true; exit 1; fi
  echo "ok: $1 -> $3"
}

echo "== TRUST_PROXY=loopback (previous hard-coded behaviour) behind a published port"
start "loopback"
echo "bridge gateway seen by the container: $(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' "$name")"
expect "allowed admin IP forwarded by the host proxy is ignored" 404 "$(gate -H "X-Forwarded-For: ${admin_ip}")"
if ! docker logs "$name" 2>&1 | grep -q "TRUST_PROXY: X-Forwarded-For sent by"; then
  echo "PROXY_TRUST_DOCKER_FAIL: the ignored-header warning was not logged"; exit 1
fi
echo "ok: the application logged that X-Forwarded-For is being ignored"

echo "== TRUST_PROXY=loopback,uniquelocal (compose.yaml default)"
start "loopback,uniquelocal"
expect "allowed admin IP forwarded by the host proxy" 401 "$(gate -H "X-Forwarded-For: ${admin_ip}")"
expect "another forwarded IP" 404 "$(gate -H "X-Forwarded-For: ${other_ip}")"
expect "no forwarded IP (gateway address is not allow-listed)" 404 "$(gate)"
expect "client-supplied prefix cannot override the proxy-appended address" 404 "$(gate -H "X-Forwarded-For: ${admin_ip}, ${other_ip}")"
expect "proxy-appended address is the one used" 401 "$(gate -H "X-Forwarded-For: ${other_ip}, ${admin_ip}")"

echo "== unsafe value must stop the container"
cleanup
set +e
timeout 40 docker run --rm --name "$name" -e HOST=0.0.0.0 -e PORT=3100 -e TRUST_PROXY=true "$image" >/tmp/proxy-trust-unsafe.log 2>&1
status=$?
set -e
if [ "$status" = 0 ] || [ "$status" = 124 ] || ! grep -q "TRUST_PROXY" /tmp/proxy-trust-unsafe.log; then
  echo "PROXY_TRUST_DOCKER_FAIL: TRUST_PROXY=true should stop the server at startup (exit $status)"; tail -5 /tmp/proxy-trust-unsafe.log; exit 1
fi
echo "ok: TRUST_PROXY=true refused at startup (exit $status)"
echo "PROXY_TRUST_DOCKER_PASS: published-port topology, forged header ignored, compose default resolves real client IPs, unsafe value refused"
