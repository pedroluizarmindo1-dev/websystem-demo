/* Technical-service terminology: translate descriptions, never alter brands, models or identifiers. */
(()=>{'use strict';
const rules=[
 [/\bFMI\s*[- ]?OFF\b/gi,'Remoção do Buscar iPhone (iCloud)'],
 [/\bFind My iPhone\s*(?:OFF|Removal|Remove)\b/gi,'Remoção do Buscar iPhone (iCloud)'],
 [/\biCloud\s*(?:Removal|Remove|Unlock)\b/gi,'Remoção de bloqueio iCloud'],
 [/\b(?:FRP|Factory Reset Protection)\s*(?:Removal|Remove|Unlock|Reset|Bypass)\b/gi,'Remoção de FRP (Conta Google)'],
 [/\b(?:Remove|Removal|Bypass)\s*FRP\b/gi,'Remoção de FRP (Conta Google)'],
 [/\b(?:Mi|Xiaomi)\s*Account\s*(?:Removal|Remove|Unlock)\b/gi,'Remoção de Conta Xiaomi'],
 [/\bSamsung\s*Account\s*(?:Removal|Remove|Unlock)\b/gi,'Remoção de Conta Samsung'],
 [/\bGoogle\s*Account\s*(?:Removal|Remove|Unlock)\b/gi,'Remoção de Conta Google'],
 [/\bSIM\s*Lock\s*(?:Removal|Unlock)\b/gi,'Desbloqueio de operadora (SIM Lock)'],
 [/\bNetwork\s*Unlock(?:ing)?\b/gi,'Desbloqueio de operadora'],
 [/\bUnlock Code\b/gi,'Código de desbloqueio'],
 [/\b(?:IMEI|Serial)\s*Check\b/gi,'Consulta de IMEI/Série'],
 [/\b(?:Clean|Lost)\s*Status\b/gi,'Status limpo/perdido'],
 [/\b(?:Activation|Activate)\b/gi,'Ativação'],
 [/\b(?:Renewal|Renew)\b/gi,'Renovação'],
 [/\b(?:Add|Buy)\s*(\d+\s*)?Credits?\b/gi,(_m,n)=>'Adicionar '+(n||'')+'créditos'],
 [/\bCreate New User\b/gi,'Criar novo usuário'],
 [/\bExisting User\b/gi,'Usuário existente'],
 [/\b(?:Tool\s*Rent|Rent(?:al)?\s*Tool|Tool\s*Rental)\b/gi,'Aluguel de ferramenta'],
 [/\bRent\s*\((?=\d+\s*Hours?)/gi,'Aluguel ('],
 [/\b(\d+)\s*Hours?\b/gi,'$1 horas'],
 [/\b(\d+)\s*Months?\b/gi,'$1 meses'],
 [/\b(\d+)\s*Years?\b/gi,'$1 anos'],
 [/\b(?:Worldwide|Global)\b/gi,'Mundial'],
 [/\b(?:All Models|All Supported)\b/gi,'Todos os modelos compatíveis']
];
function locale(){try{return localStorage.getItem('ut_locale')||document.documentElement.lang||navigator.language}catch{return document.documentElement.lang||navigator.language}}
function translate(value){if(!/^pt/i.test(locale()))return String(value||'');let result=String(value||'');for(const [re,to] of rules)result=result.replace(re,to);return result.replace(/\b1 créditos\b/g,'1 crédito').replace(/\b1 meses\b/g,'1 mês').replace(/\b1 anos\b/g,'1 ano')}
window.utServiceTranslate=translate;
})();
