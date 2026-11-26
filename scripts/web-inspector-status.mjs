// Public probes run outside ADMIN_ALLOWED_IPS. The IP gate must stop them
// before session auth: 404 hides the route; 503 means the allowlist is absent.
export const isAdminIpGateStatus = status => status === 404 || status === 503;
