// Todos los importes se calculan en centavos para evitar errores de precisión flotante.
export function calculateBalances(members, expenses, settlements) {
  const balances = new Map(members.map(member => [member.id, 0]));
  for (const expense of expenses) {
    balances.set(expense.paid_by, (balances.get(expense.paid_by) || 0) + expense.amount_cents);
    for (const share of expense.shares) balances.set(share.member_id, (balances.get(share.member_id) || 0) - share.share_cents);
  }
  for (const payment of settlements) {
    balances.set(payment.from_member, (balances.get(payment.from_member) || 0) + payment.amount_cents);
    balances.set(payment.to_member, (balances.get(payment.to_member) || 0) - payment.amount_cents);
  }
  return members.map(member => ({...member, balance_cents: balances.get(member.id) || 0}));
}
export function suggestPayments(balances) {
  const debtors = balances.filter(x => x.balance_cents < 0).map(x => ({...x, left: -x.balance_cents}));
  const creditors = balances.filter(x => x.balance_cents > 0).map(x => ({...x, left: x.balance_cents}));
  let i=0,j=0;const payments=[];
  while(i<debtors.length && j<creditors.length){
    const cents=Math.min(debtors[i].left,creditors[j].left);
    if(cents>0)payments.push({from_member:debtors[i].id,to_member:creditors[j].id,from_name:debtors[i].name,to_name:creditors[j].name,amount_cents:cents});
    debtors[i].left-=cents;creditors[j].left-=cents;
    if(debtors[i].left===0)i++;if(creditors[j].left===0)j++;
  }
  return payments;
}
export function allocateEqualShares(amountCents, ids){
  if(!Number.isSafeInteger(amountCents)||amountCents<=0||ids.length===0)throw new Error('Importe o participantes inválidos');
  const base=Math.floor(amountCents/ids.length),remainder=amountCents%ids.length;
  return ids.map((id,index)=>({member_id:id,share_cents:base+(index<remainder?1:0)}));
}
