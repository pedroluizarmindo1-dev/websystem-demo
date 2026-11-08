import {getAnnouncements} from './telegram-announcements.mjs';
const PRICE = /(?:([0-9]+(?:\.[0-9]+)?)\s*USD\s*(?:→|->)\s*)?([0-9]+(?:\.[0-9]+)?)\s*USD/i;
const skip = /^(?:date:|www\.|https?:|default prices|\d+ new services|\d+ services|\.\.\.|…)/i;
export function extractServices(posts){
  const result=new Map();
  // Oldest first, so the most recent announcement wins for repeated names.
  for(const post of [...posts].reverse()){
    const lines=post.text.replace(/\s*•\s*/g,'\n').split(/\n+/).map(s=>s.trim()).filter(Boolean);
    for(const line of lines){
      const m=PRICE.exec(line);
      if(!m)continue;
      const name=line.slice(0,m.index).trim().replace(/^[•*\-\s]+/,'').replace(/[\s:–-]+$/,'');
      const price=Number(m[2]);
      if(!name||name.length<5||name.length>240||skip.test(name)||!Number.isFinite(price)||price<0||price>100000)continue;
      // Avoid treating a list summary or ambiguous multi-price text as a product.
      if((line.match(/\bUSD\b/g)||[]).length>2)continue;
      const key=name.toLocaleLowerCase('en');
      result.set(key,{name,price_usd:price,post_id:post.id,post_url:post.url});
    }
  }
  return [...result.values()];
}
export async function syncTelegramServices(db){
  const feed=await getAnnouncements();
  const items=extractServices(feed.posts);
  const upsert=db.prepare(`INSERT INTO services(external_id,source,name,category,brand,model,price_usd,available,eta,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(external_id) DO UPDATE SET name=excluded.name,price_usd=excluded.price_usd,updated_at=CURRENT_TIMESTAMP`);
  let count=0;
  for(const item of items){
    const key='telegram:PriceNotification:'+item.name.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g,'-').slice(0,170);
    upsert.run(key,'telegram-announcement',item.name,'Telegram · preço anunciado','','',item.price_usd,0,'Preço de referência; disponibilidade não confirmada');
    count++;
  }
  return {source:'@PriceNotification',imported:count,announcements:feed.posts.length,updatedAt:new Date().toISOString(),note:'Public announcements are indicative, not authenticated account prices or confirmed availability.'};
}
