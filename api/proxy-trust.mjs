// Which peers may tell us the client's address (Express "trust proxy"), read from TRUST_PROXY.
// req.ip feeds the admin IP allow-list, the rate limits, the login lockouts, the reseller IP allow-list and the
// security-event log, so a wrong value either lets clients forge their address or makes every visitor look the same.
//  - default 'loopback': a reverse proxy in the same network namespace (bare-metal Nginx -> Node);
//  - compose.yaml uses 'loopback,uniquelocal': behind a Docker-published port the host's reverse proxy reaches the
//    container from the bridge gateway (a private address), never from loopback.
// Accepted: the keywords loopback, linklocal, uniquelocal and explicit addresses or CIDR ranges, comma separated.
// Refused (the server does not start): booleans, hop counts, wildcards and very broad ranges, because they would let
// any client that can reach the port choose its own IP.
const KEYWORDS=new Set(['loopback','linklocal','uniquelocal']);
const IPV4=/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/(\d{1,2}))?$/;
const IPV6=/^(?=.*:)[0-9a-f:]{2,39}(?:\/(\d{1,3}))?$/i;
const PRIVATE_PEER=/^(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)|^::1$|^f[cd][0-9a-f]{2}:|^fe80:/i;

export function resolveTrustProxy(raw){
 const value=String(raw??'').trim();
 if(!value)return ['loopback'];
 const entries=value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 if(!entries.length)throw Error('TRUST_PROXY has no entries');
 for(const entry of entries){
  if(KEYWORDS.has(entry))continue;
  const v4=IPV4.exec(entry),v6=v4?null:IPV6.exec(entry);
  if(!v4&&!v6)throw Error('TRUST_PROXY: unsupported entry "'+entry.slice(0,40)+'" (use loopback, linklocal, uniquelocal, an IP address or a CIDR range)');
  const prefix=(v4||v6)[1];
  if(prefix!==undefined&&(v4?Number(prefix)<8||Number(prefix)>32:Number(prefix)<7||Number(prefix)>128))throw Error('TRUST_PROXY: range "'+entry+'" is invalid or too broad');
 }
 return entries;
}

// Logs once when a private peer (most likely our own reverse proxy) sends X-Forwarded-For that the current
// TRUST_PROXY ignores: in that state every visitor shares the peer's address for rate limits and allow-lists.
// Public peers are never logged, so no visitor address is written because of this check.
export function forwardedIgnoredWarning(log=console.warn){
 let warned=false;
 return (req,res,next)=>{
  if(!warned&&req.headers['x-forwarded-for']){
   const peer=String(req.socket?.remoteAddress||'');
   if(req.ip===peer&&PRIVATE_PEER.test(peer)){
    warned=true;
    log('TRUST_PROXY: X-Forwarded-For sent by '+peer+' is being ignored, so client-IP controls see that address for every visitor. If it is your reverse proxy, set TRUST_PROXY (docs/client-ip-and-proxy.md).');
   }
  }
  next();
 };
}
