// Explicit state transitions prevent terminal orders from being silently reopened.
// Financial settlement is intentionally outside this module.
export const ORDER_TRANSITIONS=Object.freeze({
 pendente:['em_processamento','rejeitado'],
 em_processamento:['concluido','rejeitado'],
 concluido:['entregue','reembolsado'],
 entregue:['reembolsado'],
 rejeitado:[],
 reembolsado:[]
});
export function canTransitionOrder(from,to){
 return Object.hasOwn(ORDER_TRANSITIONS,from)&&ORDER_TRANSITIONS[from].includes(to);
}
