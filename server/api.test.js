import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import test from 'node:test';

async function startApi(dbPath, t) {
  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: '0', DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const stopped = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    child.kill();
    await stopped;
  });
  const lines = createInterface({ input: child.stdout });
  let timer;
  const base = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('La API no arrancó a tiempo')), 5000);
    stopped.then(() => reject(new Error('La API se cerró antes de arrancar')));
    lines.on('line', line => {
      const url = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) resolve(url);
    });
  }).finally(() => {
    clearTimeout(timer);
    lines.close();
  });

  return async (path, status = 200, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
}

test('crea un grupo, registra un gasto exacto y salda las deudas en SQLite', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'split-test-'));
  const dbPath = join(directory, 'split.sqlite');
  let groupPath;
  try {
    await t.test('flujo REST completo', async flow => {
      const api = await startApi(dbPath, flow);
      await api('/groups', 400, '{');
      const group = await api('/groups', 201, { name: 'Viaje de prueba' });
      groupPath = '/groups/' + group.id;
      await api(groupPath + '/expenses', 400, { description: 'Sin integrantes', amount_cents: 100 });
      for (const name of ['Ana', 'Luis', 'Sofía']) {
        await api(groupPath + '/members', 201, { name });
      }
      const { members } = await api(groupPath);
      const participantIds = members.map(member => member.id);
      const expense = {
        description: 'Gasto de un peso', amount_cents: 100,
        paid_by: participantIds[0], participant_ids: participantIds,
      };
      await api(groupPath + '/expenses', 400, { ...expense, amount_cents: 100.5 });
      await api(groupPath + '/expenses', 400, { ...expense, participant_ids: [1] });
      let state = await api(groupPath + '/expenses', 201, expense);
      const shares = state.expenses[0].shares.sort((a, b) => a.member_id - b.member_id);
      assert.deepEqual(shares.map(share => share.share_cents), [34, 33, 33]);
      assert.deepEqual(state.balances.map(member => member.balance_cents), [66, -33, -33]);

      const luisPath = groupPath + '/members/' + participantIds[1];
      const sofiaPath = groupPath + '/members/' + participantIds[2];
      await api(sofiaPath, 400, { name: ' ' }, 'PATCH');
      await api(groupPath + '/members/1', 404, { name: 'Otro grupo' }, 'PATCH');
      state = await api(sofiaPath, 200, { name: ' Sofi ' }, 'PATCH');
      assert.equal(state.suggested_payments[1].from_name, 'Sofi');

      state = await api(luisPath, 200, undefined, 'DELETE');
      assert.equal(state.members.find(member => member.id === participantIds[1]).active, 0);
      assert.deepEqual(state.balances.map(member => member.balance_cents), [66, -33, -33]);
      assert.equal(state.suggested_payments[0].from_name, 'Luis');
      await api(groupPath + '/expenses', 400, { ...expense, paid_by: participantIds[1], participant_ids: [participantIds[0]] });
      await api(groupPath + '/expenses', 400, expense);
      state = await api(groupPath + '/expenses', 201, {
        description: 'Gasto nuevo entre integrantes activos', amount_cents: 2, paid_by: participantIds[0],
      });
      assert.deepEqual(state.expenses[0].shares.map(share => share.member_id).sort(), [participantIds[0], participantIds[2]].sort());
      assert.deepEqual(state.suggested_payments.map(payment => payment.amount_cents), [33, 34]);
      state = await api(groupPath + '/expenses/' + state.expenses[0].id, 200, undefined, 'DELETE');

      const [first, second] = state.suggested_payments;
      await api(groupPath + '/settlements', 400, { ...first, amount_cents: 34 });
      await api(groupPath + '/settlements', 201, first);
      await api(groupPath + '/settlements', 400, first);
      state = await api(groupPath + '/settlements', 201, second);
      assert.deepEqual(state.suggested_payments, []);
      assert.deepEqual(state.balances.map(member => member.balance_cents), [0, 0, 0]);
    });
    await t.test('los datos sobreviven al reinicio', async restart => {
      assert.ok(groupPath);
      const api = await startApi(dbPath, restart);
      const state = await api(groupPath);
      assert.equal(state.expenses[0].amount_cents, 100);
      assert.equal(state.settlements.length, 2);
      assert.equal(state.members.find(member => member.name === 'Luis').active, 0);
      assert.ok(state.members.some(member => member.name === 'Sofi'));
      assert.deepEqual(state.suggested_payments, []);
      const [payment,remaining] = state.settlements;
      await api('/groups/1/settlements/' + payment.id, 404, undefined, 'DELETE');
      const paymentPath = groupPath + '/settlements/' + payment.id;
      const reopened = await api(paymentPath, 200, undefined, 'DELETE');
      assert.deepEqual(reopened.settlements, [remaining]);
      assert.equal(reopened.balances.find(member=>member.id===payment.from_member).balance_cents, -payment.amount_cents);
      assert.equal(reopened.balances.find(member=>member.id===payment.to_member).balance_cents, payment.amount_cents);
      assert.deepEqual(reopened.suggested_payments.map(({from_member,to_member,amount_cents})=>({from_member,to_member,amount_cents})), [{
        from_member:payment.from_member,to_member:payment.to_member,amount_cents:payment.amount_cents,
      }]);
      await api(paymentPath, 404, undefined, 'DELETE');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('comparte personas entre planes y ajusta solo los gastos seleccionados', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'split-plans-'));
  const dbPath = join(directory, 'split.sqlite');
  try {
    await t.test('reparto retroactivo y eliminación de planes', async flow => {
      const api = await startApi(dbPath, flow);
      const source = '/groups/' + (await api('/groups', 201, { name: 'Concierto' })).id;
      const target = '/groups/' + (await api('/groups', 201, { name: 'Cena' })).id;
      const { members: [guest] } = await api(source + '/members', 201, { name: 'Marta' });
      await api(target + '/members', 201, { name: 'Ana' });
      const { members: [payer, friend] } = await api(target + '/members', 201, { name: 'Luis' });
      let state = await api(target + '/expenses', 201, {
        description: 'Cena', amount_cents: 100, paid_by: payer.id,
      });
      const sharedExpense = state.expenses[0].id;
      await api(target + '/expenses', 201, {
        description: 'Aparte', amount_cents: 25, paid_by: payer.id, participant_ids: [payer.id],
      });
      await api(target + '/settlements', 201, { from_member: friend.id, to_member: payer.id, amount_cents: 20 });
      assert.ok((await api(target + '/people')).some(person=>person.person_key===guest.person_key));
      await api(target + '/members', 400, { person_key: guest.person_key, expense_ids: [9999] });
      assert.equal((await api(target)).members.length, 2);

      state = await api(target + '/members', 201, { person_key: guest.person_key, expense_ids: [sharedExpense] });
      const member = state.members.find(person=>person.id===state.added_member_id);
      assert.equal(member.person_key, guest.person_key);
      assert.notEqual(member.id, guest.id);
      assert.deepEqual(state.expenses[0].shares.map(share=>share.share_cents), [25]);
      assert.deepEqual(state.balances.map(person=>person.balance_cents), [46,-13,-33]);
      assert.deepEqual(state.suggested_payments.map(payment=>payment.amount_cents), [13,33]);
      await api(target + '/members', 409, { person_key: member.person_key });
      await api(target + '/members/' + member.id, 200, { name: 'Martina' }, 'PATCH');
      assert.equal((await api(source)).members[0].name, 'Martina');
      await api(target + '/members/' + member.id, 200, undefined, 'DELETE');
      state = await api(target + '/members', 201, { person_key: member.person_key, expense_ids: [sharedExpense] });
      assert.equal(state.added_member_id, member.id);
      assert.deepEqual(state.balances.map(person=>person.balance_cents), [46,-13,-33]);

      const expensePath = target + '/expenses/' + sharedExpense;
      await api(source + '/expenses/' + sharedExpense, 404, { description: 'Otro plan' }, 'PATCH');
      await api(expensePath, 400, { participant_ids: [] }, 'PATCH');
      state = await api(expensePath, 200, {
        description: 'Cena ajustada', amount_cents: 101, participant_ids: [payer.id,member.id],
      }, 'PATCH');
      assert.deepEqual(state.balances.map(person=>person.balance_cents), [30,20,-50]);
      assert.equal(state.settlements.length, 1);
      const edited = state.expenses.find(expense=>expense.id===sharedExpense);
      assert.equal(edited.description, 'Cena ajustada');
      assert.deepEqual(edited.shares.map(share=>share.share_cents).sort((a,b)=>a-b), [50,51]);
      state = await api(expensePath, 200, { participant_ids: [member.id,payer.id] }, 'PATCH');
      assert.deepEqual(state.balances.map(person=>person.balance_cents), [30,20,-50]);
      state = await api(expensePath, 200, undefined, 'DELETE');
      assert.deepEqual(state.balances.map(person=>person.balance_cents), [-20,20,0]);
      assert.equal(state.settlements.length, 1);

      const { groups } = await api(target, 200, undefined, 'DELETE');
      assert.ok(groups.every(group=>'/groups/' + group.id!==target));
      await api(target, 404);
      assert.equal((await api(source)).members[0].name, 'Martina');
      for(const group of groups)await api('/groups/' + group.id, 200, undefined, 'DELETE');
    });
    await t.test('borrar todos los planes no restaura el plan de demostración', async restart => {
      const api = await startApi(dbPath, restart);
      assert.deepEqual(await api('/groups'), []);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recalcula repartos al quitar integrantes y corrige repartos anteriores', async t => {
  const api = await startApi(':memory:', t);
  const path = '/groups/' + (await api('/groups', 201, { name: 'Salida' })).id;
  for(const name of ['Ana','Luis','Sofía'])await api(path + '/members', 201, { name });
  const {members:[ana,luis,sofia]} = await api(path);
  let state = await api(path + '/expenses', 201, {
    description:'Comida',amount_cents:100,paid_by:ana.id,
  });
  const mealId = state.expenses[0].id;
  state = await api(path + '/expenses', 201, {
    description:'Bebidas',amount_cents:40,paid_by:sofia.id,
  });
  const drinksId = state.expenses[0].id;
  await api(path + '/settlements', 201, {from_member:luis.id,to_member:ana.id,amount_cents:10});
  state = await api(path + '/members/' + sofia.id, 200, {expense_ids:[mealId]}, 'DELETE');
  assert.deepEqual(state.balances.map(member=>member.balance_cents), [26,-53,27]);
  assert.deepEqual(state.suggested_payments.map(payment=>payment.amount_cents), [26,27]);
  await api(path + '/recalculate-shares', 400, {expense_ids:[mealId,drinksId]});
  state = await api(path + '/recalculate-shares', 200, {expense_ids:[drinksId]});
  assert.deepEqual(state.balances.map(member=>member.balance_cents), [20,-60,40]);
  assert.deepEqual(state.suggested_payments.map(payment=>payment.amount_cents), [20,40]);
  assert.equal(state.settlements[0].amount_cents, 10);
});
