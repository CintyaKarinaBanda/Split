import test from 'node:test';import assert from 'node:assert/strict';
import {allocateEqualShares,calculateBalances,suggestPayments} from './logic.js';
test('divide centavos sin perder dinero',()=>assert.deepEqual(allocateEqualShares(100,[1,2,3]).map(x=>x.share_cents),[34,33,33]));
test('calcula balances y pagos sugeridos',()=>{
 const members=[{id:1,name:'Ana'},{id:2,name:'Luis'},{id:3,name:'Sofía'}];
 const expenses=[{paid_by:1,amount_cents:90000,shares:allocateEqualShares(90000,[1,2,3])},{paid_by:2,amount_cents:60000,shares:allocateEqualShares(60000,[1,2,3])},{paid_by:3,amount_cents:30000,shares:allocateEqualShares(30000,[1,2,3])}];
 const b=calculateBalances(members,expenses,[]);
 assert.deepEqual(b.map(x=>x.balance_cents),[30000,0,-30000]);
 assert.deepEqual(suggestPayments(b).map(x=>x.amount_cents),[30000]);
});
test('el pago registrado actualiza el balance',()=>{
 const members=[{id:1,name:'Ana'},{id:2,name:'Luis'}];
 const expenses=[{paid_by:1,amount_cents:1000,shares:allocateEqualShares(1000,[1,2])}];
 const b=calculateBalances(members,expenses,[{from_member:2,to_member:1,amount_cents:500}]);
 assert.deepEqual(b.map(x=>x.balance_cents),[0,0]);
});
