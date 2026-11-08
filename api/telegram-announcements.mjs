// Read-only public Telegram announcement feed. No Telegram login or production API credentials.
const CHANNEL = 'PriceNotification';
let cache = { updatedAt: 0, posts: [] };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, x => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&nbsp;':' '}[x]||x)).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
const clean = (s) => decode(s.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/[ \t]+/g,' ').trim());
export async function getAnnouncements(){
  if(Date.now()-cache.updatedAt<5*60*1000 && cache.posts.length) return {channel:CHANNEL,...cache};
  const response=await fetch('https://t.me/s/'+CHANNEL,{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0 (compatible; WebSystemDemo/1.0)'}});
  if(!response.ok) throw Error('Telegram public feed unavailable: HTTP '+response.status);
  const html=(await response.text()).slice(0,1500000);
  const blocks=html.split(/(?=<div class="tgme_widget_message_wrap)/);
  const posts=[];
  for(const block of blocks){
    const id=block.match(/data-post="PriceNotification\/(\d+)"/)?.[1];
    const body=block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if(!id||!body)continue;
    const text=clean(body);
    const date=block.match(/<time[^>]*datetime="([^"]+)"/)?.[1]||null;
    const changes=[...text.matchAll(/(\d+(?:\.\d+)?)\s*USD\s*→\s*(\d+(?:\.\d+)?)\s*USD/g)].map(m=>({previousUSD:Number(m[1]),currentUSD:Number(m[2])}));
    posts.push({id:Number(id),url:'https://t.me/'+CHANNEL+'/'+id,date,text:text.slice(0,4000),priceChanges:changes,source:'HeartUnlocks Telegram announcement'});
  }
  if(!posts.length)throw Error('No public announcement posts parsed');
  cache={updatedAt:Date.now(),posts:posts.sort((a,b)=>b.id-a.id).slice(0,30)};
  return {channel:CHANNEL,...cache};
}
