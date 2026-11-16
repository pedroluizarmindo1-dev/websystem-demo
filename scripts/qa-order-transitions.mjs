import assert from 'node:assert/strict';
import {ORDER_TRANSITIONS,canTransitionOrder} from '../api/order-transitions.mjs';
assert.deepEqual(Object.keys(ORDER_TRANSITIONS),['pendente','em_processamento','concluido','entregue','rejeitado','reembolsado']);
for(const [from,targets] of Object.entries(ORDER_TRANSITIONS)){
 assert.equal(canTransitionOrder(from,from),false);
 for(const to of targets)assert.equal(canTransitionOrder(from,to),true);
 for(const other of Object.keys(ORDER_TRANSITIONS).filter(x=>x!==from&&!targets.includes(x)))assert.equal(canTransitionOrder(from,other),false);
}
assert.equal(canTransitionOrder('__proto__','pendente'),false);
console.log('ORDER_TRANSITIONS_PASS');
