const MAX_RETRY_AFTER_MS=24*60*60*1000;
const DEFAULT_RETRY_AFTER_MS=6*60*60*1000;

// RFC 9110 Retry-After: delta-seconds (including zero) or HTTP-date.
export function retryAfterDelayMs(header,now=Date.now()){
 if(typeof header!=='string'||!header.trim())return DEFAULT_RETRY_AFTER_MS;
 const value=header.trim();let delay;
 if(/^\d+$/.test(value)){
  delay=Number(value)*1000;
 }else if(/^[A-Za-z]{3,9}(?:,|\s)/.test(value)){
  const retryAt=Date.parse(value);
  if(!Number.isFinite(retryAt))return DEFAULT_RETRY_AFTER_MS;
  delay=Math.max(0,retryAt-now);
 }else return DEFAULT_RETRY_AFTER_MS;
 if(!Number.isFinite(delay))return MAX_RETRY_AFTER_MS;
 return Math.min(MAX_RETRY_AFTER_MS,Math.max(0,delay));
}
