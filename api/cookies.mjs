// Ignore malformed cookie pairs without failing authentication for the entire request.
export function parseCookies(req) {
  const result = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try {
      const key = decodeURIComponent(part.slice(0, separator).trim());
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      if (Object.hasOwn(result, key)) { result[key] = ''; continue; }
      result[key] = value;
    } catch { /* Invalid encoding is not a valid cookie. */ }
  }
  return result;
}
