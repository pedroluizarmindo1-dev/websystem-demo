// DHRU supplier CREDIT is a unit cost in USD; all markups are in BRL per listed unit.
// Keep category rules independent from upstream catalog updates.
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
export function classifyService(service){
 const value=[service.name,service.category,service.brand].filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 // Higher-risk service classes take priority over generic credit/activation keywords.
 if(/fmi\s*(?:off|remove|removal)|find\s*my\s*iphone|icloud|i\s*cloud|sim\s*lock|simlock|network\s*unlock|carrier\s*unlock|account\s*(?:remove|removal|unlock)|(?:remove|removal|unlock)\s*(?:mi\s*account|samsung\s*account|google\s*account|frp|account)|(?:3|6|12)\s*(?:months?|mes(?:es)?|m\b)|(?:1|one)\s*(?:year|ano)\b/.test(value))return 'premium';
 if(/rental|rent\s*(?:tool|license)|tool\s*rent|aluguel|locacao|locacao\s*de\s*ferramenta/.test(value))return 'rental';
 if(/(?:credit|credito|credits|creditos|cr[eé]dits?)\b/.test(value)&&/(?:server|servidor|activation|ativacao|tool|ferramenta|license|licenca|credit)/.test(value))return 'credit';
 return 'standard';
}
export function creditUnits(service){
 const name=String(service.name||'');
 const match=name.match(/\b(?:add|buy|purchase|activation|ativacao|ativar|pack(?:age)?|pacote)?\s*(\d{1,5})\s*(?:credits?|creditos?|cr[eé]ditos?)\b/i);
 return match?Math.max(1,Number(match[1])):1;
}
export function priceService(service,usdBrl,{creditMarkup=2.5,rentalMarkup=17,standardMarkup=28,premiumMarkup=50}={}){
 const usd=Number(service.price_usd),rate=Number(usdBrl);
 if(!Number.isFinite(usd)||usd<0||!Number.isFinite(rate)||rate<=0)throw Error('Preço ou câmbio inválido');
 const markups={credit:creditMarkup,rental:rentalMarkup,standard:standardMarkup,premium:premiumMarkup};
 const kind=classifyService(service),units=kind==='credit'?creditUnits(service):1,markup=Number(markups[kind])*units;
 if(!Number.isFinite(markup)||markup<0)throw Error('Acréscimo inválido');
 return {category:kind,supplier_usd:usd,rate,base_brl:round(usd*rate),credit_units:units,markup_brl:markup,selling_brl:round(usd*rate+markup)};
}
