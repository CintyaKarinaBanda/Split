import { useEffect, useId, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { ArrowRight, ArrowUpRight, Check, Copy, LayoutDashboard, Link2, LogOut, Menu, Pencil, Plus, ReceiptText, Trash2, Undo2, Users, Wallet, X } from 'lucide-react';
import { money, parseExpenseCents } from './money.js';

const initials = name => name.trim().split(/\s+/).slice(0,2).map(word=>Array.from(word)[0]).join('').toUpperCase();
const shades=['#526954','#945033','#345f6d','#845268','#665a36','#606873'];
async function api(path,opts={}){
  let res;
  try{res=await fetch('/api'+path,{headers:{'Content-Type':'application/json'},...opts,body:opts.body?JSON.stringify(opts.body):undefined})}
  catch{throw new Error('No se pudo conectar con el servidor. Comprueba que npm run dev esté funcionando.');}
  const data=await res.json().catch(()=>null);
  if(!res.ok){
   if(res.status===401&&path!=='/session')window.dispatchEvent(new Event('split:session-expired'));
   throw new Error(data?.error||'Ocurrió un error');
  }
  if(!data)throw new Error('El servidor devolvió una respuesta inesperada.');
  return data;
}
function Avatar({name,index=0,size=36}){return <span className="avatar" style={{background:shades[index%shades.length],width:size,height:size,fontSize:size*.34}}>{initials(name)}</span>}
function Modal({title,onClose,children,error,busy}){
 const dialog=useRef(null),titleId=useId(),reducedMotion=useReducedMotion();
 useEffect(()=>{
  const element=dialog.current;
  element.showModal();
  element.querySelector('input')?.focus();
  return ()=>element.close();
 },[]);
 return <dialog ref={dialog} aria-labelledby={titleId} className="modal-overlay"
   onCancel={event=>{event.preventDefault();onClose()}}
   onClick={event=>{if(event.target===event.currentTarget)onClose()}}>
  <motion.div className="modal" initial={reducedMotion?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={reducedMotion?undefined:{opacity:0,y:8}} transition={{duration:.18}}>
   <div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" disabled={busy} onClick={onClose} aria-label="Cerrar"><X size={20}/></button></div>
   {error&&<p className="error-banner" role="alert">{error}</p>}
   {children}
  </motion.div>
 </dialog>
}
const categories=['Comida','Transporte','Hospedaje','Compras','Diversión','Otros'];

function ExpenseForm({members,expense,onSave,busy}){
 const activeMembers=members.filter(member=>member.active);
 const originalParticipants=expense?.shares.map(share=>share.member_id);
 const [description,setDescription]=useState(expense?.description??'');
 const [amount,setAmount]=useState(expense?(expense.amount_cents/100).toFixed(2):'');
 const [paidBy,setPaidBy]=useState(expense?.paid_by??activeMembers[0]?.id??'');
 const [category,setCategory]=useState(expense?.category??'Comida');
 const [participants,setParticipants]=useState(originalParticipants??activeMembers.map(member=>member.id));
 const payers=members.filter(member=>member.active||member.id===expense?.paid_by);
 const eligibleParticipants=members.filter(member=>member.active||originalParticipants?.includes(member.id));
 const availableCategories=categories.includes(category)?categories:[category,...categories];
 const cents=parseExpenseCents(amount);
 const invalidAmount=amount.trim()!==''&&cents===null;
 return <form onSubmit={e=>{
  e.preventDefault();
  if(cents!==null&&participants.length>0)onSave({description,amount_cents:cents,paid_by:Number(paidBy),category,participant_ids:participants});
 }} className="stack">
  <label>¿Qué compraron?<input required maxLength="100" placeholder="Ej. Pizza para todos" value={description} onChange={e=>setDescription(e.target.value)}/></label>
  <label>¿Cuánto costó? (MXN)<input required inputMode="decimal" maxLength={16} placeholder="0.00" value={amount} onChange={e=>setAmount(e.target.value)} aria-invalid={invalidAmount}/>
   {invalidAmount&&<small className="field-error">Ingresa entre $0.01 y $1,000,000.00 con hasta dos decimales y sin separador de miles.</small>}
  </label>
  <div className="form-pair">
   <label>¿Quién pagó?<select value={paidBy} onChange={e=>setPaidBy(e.target.value)}>{payers.map(m=><option key={m.id} value={m.id}>{m.name}{m.active?'':' · Salió del grupo'}</option>)}</select></label>
   <label>Categoría<select value={category} onChange={e=>setCategory(e.target.value)}>{availableCategories.map(value=><option key={value}>{value}</option>)}</select></label>
  </div>
  <fieldset className="expense-participants">
   <legend>Dividir entre</legend>
   <div className="participant-list">{eligibleParticipants.map((member,index)=><label key={member.id} className="check-pill">
    <input type="checkbox" checked={participants.includes(member.id)} onChange={event=>{
     setParticipants(previous=>event.target.checked?[...previous,member.id]:previous.filter(id=>id!==member.id));
    }}/>
    <span aria-hidden="true"><Avatar name={member.name} index={index} size={24}/></span>
    <span>{member.name}{member.active?'':' · Salió del grupo'}</span>
   </label>)}</div>
   {participants.length===0&&<p className="field-error">Selecciona al menos una persona.</p>}
  </fieldset>
  {expense&&<p className="member-action-copy">Los saldos se recalculan al guardar. Los pagos que ya registraste se conservan.</p>}
  <button className="button primary full" disabled={busy||participants.length===0||cents===null||!description.trim()}>{busy?'Guardando…':expense?'Guardar cambios':'Guardar gasto'} <ArrowRight size={17}/></button>
 </form>
}
function AddMemberForm({group,busy,onSave}){
 const personLabel=useId();
 const [people,setPeople]=useState([]);
 const [peopleError,setPeopleError]=useState('');
 const [personKey,setPersonKey]=useState('');
 const [name,setName]=useState('');
 const [expenseIds,setExpenseIds]=useState([]);
 useEffect(()=>{
  let current=true;
  api(`/groups/${group.id}/people`).then(data=>{if(current)setPeople(data)})
   .catch(error=>{if(current)setPeopleError(error.message)});
  return ()=>{current=false};
 },[group.id]);
 const person=people.find(candidate=>candidate.person_key===personKey);
 const existingMember=group.members.find(member=>member.person_key===personKey);
 const expenses=group.expenses.filter(expense=>!expense.shares.some(share=>share.member_id===existingMember?.id));
 return <form className="stack" onSubmit={event=>{
  event.preventDefault();
  if(person||name.trim())onSave({...(person?{person_key:personKey}:{name}),expense_ids:expenseIds});
 }}>
  {people.length>0&&<label><span id={personLabel}>Persona</span><select aria-labelledby={personLabel} value={personKey} onChange={event=>{setPersonKey(event.target.value);setExpenseIds([])}}>
   <option value="">Crear una persona nueva</option>
   {people.map(candidate=><option key={candidate.person_key} value={candidate.person_key}>{candidate.name} · {candidate.plans}</option>)}
  </select></label>}
  {peopleError&&<p className="field-error" role="status">No se pudieron cargar las personas de otros planes.</p>}
  {!person&&<label>Nombre<input required maxLength={100} placeholder="Ej. Mariana" value={name} onChange={event=>setName(event.target.value)}/></label>}
  {expenses.length>0&&<fieldset className="prior-expenses">
   <legend>¿Lo incluimos en gastos anteriores?</legend>
   <p>Selecciona cuáles quieres volver a dividir. Los pagos registrados se conservan y los saldos se recalculan.</p>
   <div className="prior-expense-list">
    {expenses.map(expense=><label key={expense.id}>
     <input type="checkbox" checked={expenseIds.includes(expense.id)} onChange={event=>{
      setExpenseIds(previous=>event.target.checked?[...previous,expense.id]:previous.filter(id=>id!==expense.id));
     }}/>
     <span>{expense.description}</span><strong>{money(expense.amount_cents)}</strong>
    </label>)}
   </div>
  </fieldset>}
  <button className="button primary full" disabled={busy||(!person&&!name.trim())}>{busy?'Guardando…':'Agregar persona'} <ArrowRight size={17}/></button>
 </form>;
}
function expensesToRecalculate(group,removedId=null){
 const active=new Set(group.members.filter(member=>member.active&&member.id!==removedId).map(member=>member.id));
 return group.expenses.filter(expense=>{
  const shares=expense.shares;
  const affected=removedId===null
   ?shares.some(share=>!active.has(share.member_id))
   :shares.some(share=>share.member_id===removedId);
  return affected&&shares.some(share=>active.has(share.member_id));
 });
}
function RecalculationChoices({expenses,selected,onChange}){
 return <fieldset className="prior-expenses">
  <legend>Gastos que se volverán a repartir</legend>
  <p>Se dividirán entre sus participantes activos. Si alguien adelantó dinero o ya registró un pago, ese movimiento se conserva.</p>
  <div className="prior-expense-list">{expenses.map(expense=><label key={expense.id}>
   <input type="checkbox" checked={selected.includes(expense.id)} onChange={event=>{
    onChange(event.target.checked?[...selected,expense.id]:selected.filter(id=>id!==expense.id));
   }}/>
   <span>{expense.description}</span><strong>{money(expense.amount_cents)}</strong>
  </label>)}</div>
 </fieldset>;
}
function RecalculationForm({expenses,busy,onSave}){
 const [selected,setSelected]=useState(()=>expenses.map(expense=>expense.id));
 return <form className="stack" onSubmit={event=>{event.preventDefault();if(selected.length)onSave(selected)}}>
  <RecalculationChoices expenses={expenses} selected={selected} onChange={setSelected}/>
  <button className="button primary full" disabled={busy||selected.length===0}>Actualizar reparto</button>
 </form>;
}
function MemberDirectory({group,members,busy,onUpdate,onAdd,clearError,initialAction}){
 const [action,setAction]=useState(initialAction);
 const [name,setName]=useState(initialAction?.member.name??'');
 const [notice,setNotice]=useState('');
 const [expenseIds,setExpenseIds]=useState(()=>initialAction?.type==='remove'
  ?expensesToRecalculate(group,initialAction.member.id).map(expense=>expense.id)
  :[]);

 function choose(type,member){
  clearError();
  setNotice('');
  setName(member.name);
  setExpenseIds(type==='remove'?expensesToRecalculate(group,member.id).map(expense=>expense.id):[]);
  setAction({type,member});
 }
 function cancel(){
  clearError();
  setAction(null);
 }
 async function submit(event){
  event.preventDefault();
  const {type,member}=action;
  const rename=type==='rename';
  if(rename&&(!name.trim()||name.trim()===member.name))return;
  if(!await onUpdate(member.id,rename?{method:'PATCH',body:{name}}:{method:'DELETE',body:{expense_ids:expenseIds}}))return;
  setNotice(rename?`Nombre actualizado a ${name.trim()}.`:`Se quitó a ${member.name} del grupo.`);
  setAction(null);
 }

 if(action){
  const {type,member}=action;
  const expenses=type==='remove'?expensesToRecalculate(group,member.id):[];
  return <form className="stack" onSubmit={submit}>
   {type==='rename'
    ?<label>Nuevo nombre<input autoFocus required maxLength={100} value={name} onChange={event=>setName(event.target.value)}/><small>El nombre se actualizará en todos sus planes.</small></label>
    :<p className="member-action-copy">¿Quitar a <strong>{member.name}</strong> del grupo? Los gastos seleccionados se actualizarán. Si un gasto queda sin participantes activos, puedes ajustar su reparto desde Movimientos recientes.</p>}
   {expenses.length>0&&<RecalculationChoices expenses={expenses} selected={expenseIds} onChange={setExpenseIds}/>}
   <div className="member-actions">
    <button type="button" className="button secondary" onClick={cancel} disabled={busy}>Cancelar</button>
    {type==='rename'
     ?<button className="button primary" disabled={busy||!name.trim()||name.trim()===member.name}>Guardar nombre</button>
     :<button className="button primary" disabled={busy}>Quitar integrante</button>}
   </div>
  </form>;
 }
 return <>
  <p className="directory-status" role="status">{notice}</p>
  {members.length===0?<p className="member-action-copy">Todavía no hay integrantes activos.</p>:<ul className="member-directory">
   {members.map((member,index)=><li key={member.id}>
    <span aria-hidden="true"><Avatar name={member.name} index={index} size={31}/></span>
    <strong>{member.name}</strong>
    <button className="icon-button" aria-label={`Renombrar a ${member.name}`} title="Renombrar" disabled={busy} onClick={()=>choose('rename',member)}><Pencil size={16}/></button>
    <button className="icon-button remove-member" aria-label={`Quitar a ${member.name}`} title="Quitar integrante" disabled={busy} onClick={()=>choose('remove',member)}><Trash2 size={16}/></button>
   </li>)}
  </ul>}
  <button className="button secondary full" disabled={busy} onClick={onAdd}><Plus size={16}/> Agregar integrante</button>
 </>;
}
function BalanceBreakdown({group,person}){
 const {id,name,balance_cents:balance}=person;
 const names=new Map(group.members.map(member=>[member.id,member.name]));
 const advances=[],shares=[],sent=[],received=[];
 for(const expense of group.expenses){
  if(expense.paid_by===id)advances.push({id:expense.id,label:expense.description,cents:expense.amount_cents});
  const share=expense.shares.find(item=>item.member_id===id);
  if(share)shares.push({id:expense.id,label:expense.description,cents:share.share_cents});
 }
 for(const payment of group.settlements){
  if(payment.from_member===id)sent.push({id:payment.id,label:`A ${names.get(payment.to_member)}`,cents:payment.amount_cents});
  if(payment.to_member===id)received.push({id:payment.id,label:`De ${names.get(payment.from_member)}`,cents:payment.amount_cents});
 }
 const steps=[
  {label:'Dinero que adelantó',sign:'+',items:advances},
  {label:'Su parte de los gastos',sign:'−',items:shares},
  {label:'Pagos que ya envió',sign:'+',items:sent},
  {label:'Pagos que ya recibió',sign:'−',items:received},
 ];
 const suggested=group.suggested_payments.filter(payment=>payment.from_member===id||payment.to_member===id);

 return <div className="balance-breakdown">
  <p>SPLIT suma lo que adelantó {name} y resta su parte de todos los gastos. Después aplica los pagos que ya hizo o recibió.</p>
  <ol className="breakdown-steps">
   {steps.map(step=>{
    const total=step.items.reduce((sum,item)=>sum+item.cents,0);
    const heading=<><span>{step.label}</span><strong>{total?step.sign:''}{money(total)}</strong></>;
    return <li key={step.label}>{step.items.length>0
     ?<details><summary>{heading}</summary><ul className="breakdown-items">{step.items.map(item=><li key={item.id}><span>{item.label}</span><span>{money(item.cents)}</span></li>)}</ul></details>
     :<div className="breakdown-empty-step">{heading}</div>}</li>;
   })}
  </ol>
  <div className="breakdown-total">
   <span>{balance>0?'Le falta recibir':balance<0?'Le falta pagar':'Saldo al día'}</span>
   <strong>{money(Math.abs(balance))}</strong>
  </div>
  {advances.length>0&&balance<0&&<p>Aunque {name} adelantó dinero, después de compensar sus gastos y pagos todavía queda un importe por cubrir.</p>}
  {suggested.length>0&&<div>
   <h3>Cómo se salda</h3>
   <ul className="breakdown-items">{suggested.map(payment=>{
    const outgoing=payment.from_member===id;
    return <li key={`${payment.from_member}-${payment.to_member}`}><span>{outgoing?`Paga a ${payment.to_name}`:`Recibe de ${payment.from_name}`}</span><strong>{money(payment.amount_cents)}</strong></li>;
   })}</ul>
  </div>}
 </div>;
}
function PaymentsPanel({group,busy,onPay,onUndo,onReview,onBreakdown}){
 const [view,setView]=useState('person');
 const [notice,setNotice]=useState(null);
 const [manualCopy,setManualCopy]=useState(false);
 const reducedMotion=useReducedMotion();
 useEffect(()=>{
  if(!notice)return;
  const timer=setTimeout(()=>setNotice(null),5000);
  return ()=>clearTimeout(timer);
 },[notice]);
 const pending=group.suggested_payments;
 const paid=group.settlements;
 const pendingAmount=pending.reduce((sum,payment)=>sum+payment.amount_cents,0);
 const membersById=new Map(group.members.map((member,index)=>[member.id,{...member,index}]));
 const byPayer=new Map();
 for(const payment of [...pending,...paid]){
  if(!byPayer.has(payment.from_member))byPayer.set(payment.from_member,[]);
  byPayer.get(payment.from_member).push(payment);
 }
 const payerIds=group.members.map(member=>member.id).filter(id=>byPayer.has(id));
 const views=[['person','Por persona'],['pending','Pendientes'],['paid','Registrados']];
 const summary=[
  `SPLIT · ${group.name}`,
  ...pending.map(payment=>`• ${payment.from_name} → ${payment.to_name}: ${money(payment.amount_cents)}`),
  `Total por liquidar: ${money(pendingAmount)} MXN`,
 ].join('\n');

 async function copySummary(){
  try{
   await navigator.clipboard.writeText(summary);
   setManualCopy(false);
   setNotice({message:'Resumen copiado.'});
  }catch{
   setNotice(null);
   setManualCopy(true);
  }
 }
 async function undo(payment){
  if(await onUndo(payment))setNotice({message:'Pago deshecho. Se actualizaron los saldos y las transferencias pendientes.'});
 }
 async function pay(payment){
  const saved=await onPay(payment);
  if(!saved)return;
  const payer=saved.balances.find(person=>person.id===payment.from_member);
  const status=payer.balance_cents<0
   ?`A ${payer.name} todavía le faltan ${money(-payer.balance_cents)} por pagar.`
   :`${payer.name} ya no tiene saldo por pagar.`;
  setNotice({message:<span>
   Se registró el pago de <strong>{money(payment.amount_cents)}</strong> de <strong>{payer.name}</strong> a <strong>{payment.to_name}</strong>. {status}
  </span>});
 }

 function personLabel(id){
  const member=membersById.get(id);
  return <button type="button" className="transfer-person transfer-person-link" aria-label={`Ver desglose de ${member.name}`} onClick={()=>onBreakdown(id)}>
   <span aria-hidden="true"><Avatar name={member.name} index={member.index} size={27}/></span>
   <span>{member.name}{!member.active&&<small>Salió del grupo</small>}</span>
  </button>;
 }
 function transferRow(payment,showPayer){
  const recorded=payment.id!==undefined;
  return <li className={`transfer-row ${recorded?'transfer-recorded':''}`} key={recorded?`paid-${payment.id}`:`due-${payment.from_member}-${payment.to_member}`}>
   <div className="transfer-parties">
    {showPayer&&personLabel(payment.from_member)}
    <span className="transfer-direction" aria-label="a"><ArrowRight size={13}/></span>
    {personLabel(payment.to_member)}
   </div>
   <strong className="transfer-amount">{money(payment.amount_cents)}</strong>
   {recorded
    ?<span className="recorded-actions">
     <span className="transfer-paid"><Check size={14} aria-hidden="true"/> Registrado</span>
     {showPayer&&<button className="button outline undo-payment" disabled={busy}
      aria-label={`Deshacer pago de ${membersById.get(payment.from_member).name} a ${membersById.get(payment.to_member).name} por ${money(payment.amount_cents)}`}
      onClick={()=>undo(payment)}><Undo2 size={14} aria-hidden="true"/> Deshacer</button>}
    </span>
    :<button className="button outline" disabled={busy}
      aria-label={`Marcar pagado: ${payment.from_name} a ${payment.to_name} por ${money(payment.amount_cents)}`}
      onClick={()=>pay(payment)}>Marcar pagado</button>}
  </li>;
 }
 return <section className="panel settlement">
  <header className="payments-summary">
   <div><h2>Pagos pendientes</h2><p>{pending.length===0?'Todas las cuentas están al día.':`${pending.length} ${pending.length===1?'transferencia por hacer':'transferencias por hacer'}`}</p></div>
   <div className="payments-total"><span>Total por liquidar</span><strong>{money(pendingAmount)}</strong></div>
  </header>
  <div className="payments-body">
   <div className="payments-toolbar">
    <div className="payment-views" role="group" aria-label="Vista de pagos">
     {views.map(([id,label])=><button key={id} type="button" aria-pressed={view===id} onClick={()=>setView(id)}>{label}</button>)}
    </div>
    {pending.length>0&&<button className="button secondary" type="button" disabled={busy} onClick={copySummary}><Copy size={15} aria-hidden="true"/> Copiar resumen</button>}
   </div>
   <div role="status">
    <AnimatePresence initial={false}>
     {notice&&<motion.p key="payment-notice" className="member-feedback" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
      transition={{duration:reducedMotion?0:.16}}><Check size={16} aria-hidden="true"/>{notice.message}</motion.p>}
    </AnimatePresence>
   </div>
   {manualCopy&&pending.length>0&&<div className="manual-copy">
    <label>Selecciona y copia el resumen<textarea readOnly rows={Math.min(8,pending.length+2)} value={summary} onFocus={event=>event.currentTarget.select()}/></label>
    <button className="text-action" type="button" onClick={()=>setManualCopy(false)}>Cerrar resumen</button>
   </div>}
  {onReview&&<div className="review-shares">
   <p>Algunos gastos todavía incluyen a personas que salieron del grupo.</p>
   <button type="button" className="button secondary" disabled={busy} onClick={onReview}>Revisar repartos</button>
  </div>}
  {view==='person'&&(byPayer.size===0
   ?<p className="all-settled"><Check size={18} aria-hidden="true"/> Todavía no hay transferencias en este plan.</p>
   :<div className="payer-groups">{payerIds.map(payerId=>{
    const payments=byPayer.get(payerId);
    const remaining=payments.reduce((sum,payment)=>sum+(payment.id===undefined?payment.amount_cents:0),0);
    return <section className="payer-group" key={payerId}>
     <div className="payer-heading"><h3>{personLabel(payerId)}</h3>
      {remaining>0?<div className="payer-due"><small>Por pagar</small><strong>{money(remaining)}</strong></div>
       :<span className="payer-current"><Check size={13} aria-hidden="true"/> Al día</span>}
     </div>
     <ul className="transfer-list">{payments.map(payment=>transferRow(payment,false))}</ul>
    </section>;
   })}</div>)}
  {view==='pending'&&(pending.length>0
   ?<ul className="transfer-list flat-transfers">{pending.map(payment=>transferRow(payment,true))}</ul>
   :<p className="all-settled"><Check size={18} aria-hidden="true"/> No hay pagos pendientes.</p>)}
  {view==='paid'&&(paid.length>0
   ?<ul className="transfer-list flat-transfers">{paid.map(payment=>transferRow(payment,true))}</ul>
   :<p className="all-settled">Aún no hay pagos registrados.</p>)}
  </div>
 </section>;
}
function ScrollableRows({label,className,count,children}){
 return <>
  <div className={`scrollable-rows ${className}`} role="region" aria-label={label} tabIndex={count>4?0:undefined}>
   {children}
  </div>
  {count>4&&<p className="scroll-hint">Desplázate para ver los {count} registros.</p>}
 </>;
}
function ActivityPanel({group,busy,canAdd,onAdd,onEdit,onDelete,enter,reducedMotion}){
 const membersById=new Map(group.members.map(member=>[member.id,member]));
 const icons={Comida:'🍜',Transporte:'🚗',Hospedaje:'🏠',Compras:'🛍️',Diversión:'🎉',Otros:'🧾'};
 return <section className="panel">
  <div className="panel-head">
   <h2>Movimientos recientes <span className="movement-count" aria-label={`${group.expenses.length} gastos registrados`}>{group.expenses.length}</span></h2>
   <button className="text-action" disabled={busy||!canAdd} onClick={onAdd}><Plus size={16}/> Agregar</button>
  </div>
  <ScrollableRows label="Lista de movimientos" className="expense-list" count={group.expenses.length}>
   {group.expenses.length===0
    ?<div className="list-empty">{canAdd?'Todavía no hay gastos.':'Agrega un integrante para registrar el primer gasto.'}</div>
    :group.expenses.map((expense,index)=><motion.div layout={!reducedMotion} key={expense.id} className="expense-row"
      initial={enter} animate={{opacity:1,y:0}} transition={{delay:reducedMotion?0:Math.min(index,5)*.035}}>
     <div className="expense-icon" aria-hidden="true">{icons[expense.category]||'🧾'}</div>
     <div className="expense-description">
      <strong>{expense.description}</strong><small>Pagó {membersById.get(expense.paid_by)?.name} · {expense.category}</small>
     </div>
     <div className="expense-right">
      <strong>{money(expense.amount_cents)}</strong>
      <button className="delete-button" disabled={busy} aria-label={`Editar ${expense.description}`} title="Editar gasto" onClick={()=>onEdit(expense)}><Pencil size={15}/></button>
      <button className="delete-button" disabled={busy} aria-label={`Eliminar ${expense.description}`} title="Eliminar gasto" onClick={()=>onDelete(expense)}><Trash2 size={15}/></button>
     </div>
    </motion.div>)}
  </ScrollableRows>
 </section>;
}
function BalancePanel({balances,busy,onAdd,onBreakdown}){
 return <section className="panel balance-panel">
  <div className="panel-head">
   <h2>Balance del grupo</h2>
  </div>
  <ScrollableRows label="Lista de saldos" className="balance-list" count={balances.length}>
   {balances.length===0&&<p className="member-action-copy">Todavía no hay integrantes activos.</p>}
   {balances.map((person,index)=><button key={person.id} type="button" className="balance-row" aria-label={`Ver desglose de ${person.name}`} onClick={()=>onBreakdown(person.id)}>
    <span aria-hidden="true"><Avatar name={person.name} index={index} size={32}/></span>
    <span className="balance-name"><b>{person.name}</b><small>{person.balance_cents>0?'Tiene por recibir':person.balance_cents<0?'Tiene por pagar':'Está al día'}</small></span>
    <span className={'balance-amount '+(person.balance_cents>0?'positive':person.balance_cents<0?'negative':'')}>{person.balance_cents>0?'+':''}{money(person.balance_cents)}</span>
    <ArrowUpRight size={16} className="balance-detail-icon" aria-hidden="true"/>
   </button>)}
  </ScrollableRows>
  {balances.length>0&&<p className="balance-hint">Selecciona a alguien para ver el desglose de su saldo.</p>}
  <button className="button secondary full" disabled={busy} onClick={onAdd}><Plus size={16}/> Agregar integrante</button>
 </section>;
}
function InvitePanel({groupId}){
 const [link,setLink]=useState('');
 const [status,setStatus]=useState('');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 async function update(revoke){
  if(revoke&&!window.confirm('¿Revocar todos los accesos de invitados a este plan?'))return;
  setBusy(true);
  setError('');
  setStatus('');
  try{
   if(revoke){
    await api(`/groups/${groupId}/guest-access`,{method:'DELETE'});
    setLink('');
    setStatus('Accesos revocados.');
   }else{
    const {code}=await api(`/groups/${groupId}/invite`,{method:'POST',body:{}});
    const url=new URL(window.location.href);
    url.hash=`invite=${code}`;
    setLink(url.toString());
   }
  }catch(err){setError(err.message)}
  finally{setBusy(false)}
 }
 return <div className="stack">
  <p className="member-action-copy">Cada enlace da acceso a este plan y puede usarse una vez durante las próximas 24 horas. Generar otro reemplaza la invitación pendiente.</p>
  {error&&<p className="error-banner" role="alert">{error}</p>}
  {link&&<label>Enlace de invitación<input readOnly value={link} onFocus={event=>event.currentTarget.select()}/></label>}
  <p className="directory-status" role="status">{status}</p>
  <div className="member-actions">
   <button className="button secondary" disabled={busy} onClick={()=>update(true)}>Revocar accesos</button>
   <button className="button primary" disabled={busy} onClick={()=>update(false)}>Generar invitación</button>
  </div>
 </div>;
}

const invitationFromUrl=()=>new URLSearchParams(window.location.hash.slice(1)).get('invite');
function clearInvitation(){
 window.history.replaceState(null,'',window.location.pathname+window.location.search);
}

export default function Split(){
 const [access,setAccess]=useState(null);
 const [invite,setInvite]=useState(invitationFromUrl);
 const [key,setKey]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [version,setVersion]=useState(0);
 useEffect(()=>{
  let current=true;
  api('/session').then(data=>{if(current)setAccess(data)})
   .catch(err=>{if(current)setError(err.message)});
  const expired=()=>setAccess(previous=>previous?.private?{...previous,signed_in:false,owner:false}:previous);
  const hashChanged=()=>{setInvite(invitationFromUrl());setError('')};
  window.addEventListener('split:session-expired',expired);
  window.addEventListener('hashchange',hashChanged);
  return ()=>{
   current=false;
   window.removeEventListener('split:session-expired',expired);
   window.removeEventListener('hashchange',hashChanged);
  };
 },[]);
 function cancelInvite(){
  clearInvitation();
  setInvite(null);
  setError('');
 }
 async function updateSession(event,method){
  event?.preventDefault();
  setBusy(true);
  setError('');
  try{
   const session=await api('/session',{method,body:method==='POST'?{code:invite??key.trim()}:undefined});
   setAccess(session);
   setKey('');
   cancelInvite();
   setVersion(previous=>previous+1);
  }catch(err){setError(err.message)}
  finally{setBusy(false)}
 }
 if(access?.signed_in&&(!access.private||!invite)){
  return <>
   {error&&<div className="error-banner" role="alert">{error}</div>}
   <App key={version} access={access} onSignOut={()=>updateSession(null,'DELETE')}/>
  </>;
 }
 return <main className="access-screen">
  <section className="panel access-card">
   <div className="access-brand">split<span>.</span></div>
   <h1>{invite?'Invitación a un plan':'Acceso privado'}</h1>
   {error&&<p className="error-banner" role="alert">{error}</p>}
   {!access
    ?error?<button className="button secondary" onClick={()=>window.location.reload()}>Reintentar</button>:<p role="status">Cargando SPLIT…</p>
    :<form className="stack" onSubmit={event=>updateSession(event,'POST')}>
     {invite?<p className="member-action-copy">Acepta la invitación para ver y actualizar los gastos de este plan.</p>
      :<label>Clave de acceso<input type="password" value={key} onChange={event=>setKey(event.target.value)} required autoComplete="off"/></label>}
     <button className="button primary full" disabled={busy||(invite===null&&!key.trim())}>{invite?'Aceptar invitación':'Entrar'} <ArrowRight size={16}/></button>
     {invite&&<button type="button" className="button secondary full" disabled={busy} onClick={cancelInvite}>Cancelar</button>}
    </form>}
  </section>
 </main>;
}

function App({access,onSignOut}){
 const [groups,setGroups]=useState([]),[activeId,setActiveId]=useState(null),[detail,setDetail]=useState(null),[modal,setModal]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[formError,setFormError]=useState(''),[loading,setLoading]=useState(true),[name,setName]=useState(''),[emoji,setEmoji]=useState('✨'),[mobileMenu,setMobileMenu]=useState(false);
 const [addedMember,setAddedMember]=useState(null);
 const [memberAction,setMemberAction]=useState(null);
 const [editingExpense,setEditingExpense]=useState(null);
 const [breakdownId,setBreakdownId]=useState(null);
 const memberFeedback=useRef(null);
 const group=detail?.id===activeId?detail:null;
 const members=group?.members.filter(member=>member.active)??[];
 const reviewableExpenses=group?expensesToRecalculate(group):[];
 const breakdownPerson=group?.balances.find(person=>person.id===breakdownId);
 const reducedMotion=useReducedMotion();
 const enter=reducedMotion?false:{opacity:0,y:8};
 useEffect(()=>{
  let current=true;
  api('/groups').then(list=>{
   if(!current)return;
   setGroups(list);
   setActiveId(list[0]?.id??null);
  }).catch(e=>{if(current)setError(e.message)}).finally(()=>{if(current)setLoading(false)});
  return ()=>{current=false};
 },[]);
 useEffect(()=>{
  if(!activeId||group)return;
  let current=true;
  api('/groups/'+activeId).then(data=>{if(current)setDetail(data)})
   .catch(e=>{if(current)setError(e.message)});
  return ()=>{current=false};
 },[activeId,group]);
 function openModal(type,initialAction=null){
  setFormError('');
  setAddedMember(null);
  setName('');
  setEmoji('✨');
  setMobileMenu(false);
  setMemberAction(initialAction);
  setEditingExpense(null);
  setBreakdownId(null);
  setModal(type);
 }
 function editExpense(expense){
  openModal('expense');
  setEditingExpense(expense);
 }
 function openBreakdown(id){
  openModal('breakdown');
  setBreakdownId(id);
 }
 function closeModal(){if(!busy)setModal('')}
 async function mutate(request,{keepModal=false}={}){
  if(busy)return false;
  setBusy(true);
  setError('');
  setFormError('');
  try{
   const result=await request();
   if(modal==='group'){
    setGroups(previous=>[result,...previous]);
    setActiveId(result.id);
   }
   if(modal==='delete-group'){
    setGroups(result.groups);
    setActiveId(result.groups[0]?.id??null);
    setDetail(null);
   }else{
    if(modal==='member')setAddedMember(result.members.find(member=>member.id===result.added_member_id));
    setDetail(result);
   }
   if(!keepModal)setModal('');
   return result;
  }catch(e){
   if(modal)setFormError(e.message);
   else setError(e.message);
   return false;
  }finally{setBusy(false)}
 }
 async function recordPayment(payment){
  const {from_member,to_member,amount_cents,from_name,to_name}=payment;
  const payer=group.balances.find(person=>person.id===from_member);
  const remaining=Math.max(0,-payer.balance_cents-amount_cents);
  const status=remaining>0?`Le quedarían ${money(remaining)} por pagar.`:'Con este pago queda al día.';
  if(!window.confirm(`¿Confirmas que ${from_name} pagó ${money(amount_cents)} a ${to_name}?\n\n${status}`))return;
  return mutate(()=>api(`/groups/${activeId}/settlements`,{method:'POST',body:{from_member,to_member,amount_cents}}));
 }
 async function undoPayment(payment){
  const payer=group.members.find(member=>member.id===payment.from_member);
  const recipient=group.members.find(member=>member.id===payment.to_member);
  if(!window.confirm(`¿Deshacer el pago de ${money(payment.amount_cents)} de ${payer.name} a ${recipient.name}? Se recalcularán los saldos del plan.`))return false;
  return mutate(()=>api(`/groups/${activeId}/settlements/${payment.id}`,{method:'DELETE'}));
 }
 const total=group?.expenses.reduce((sum,expense)=>sum+expense.amount_cents,0)??0;
 const currentGroupName=group?.name||'Tus grupos';
 return <div className="app-shell">
 {mobileMenu&&<button className="sidebar-backdrop" onClick={()=>setMobileMenu(false)} aria-label="Cerrar menú"/>}
 <aside id="sidebar" className={'sidebar '+(mobileMenu?'show':'')}>
   <div className="brand"><span className="brand-icon" aria-hidden="true"><span/><span/></span><span>split<span className="brand-dot">.</span></span></div>
   
   <nav><button className="side-link selected" onClick={()=>setMobileMenu(false)}><LayoutDashboard size={19}/> Resumen</button><button className="side-link" onClick={()=>openModal('expense')} disabled={busy||!members.length}><ReceiptText size={19}/> Agregar gasto</button><button className="side-link" onClick={()=>openModal('directory')} disabled={busy||!group}><Users size={19}/> Integrantes</button></nav>
   <div className="sidebar-groups"><div className="sidebar-label between">MIS GRUPOS {access.owner&&<button onClick={()=>openModal('group')} aria-label="Nuevo grupo" disabled={busy||loading}><Plus size={18}/></button>}</div>{groups.map(g=><button key={g.id} className={'group-link '+(g.id===activeId?'active':'')} disabled={busy} aria-current={g.id===activeId?'true':undefined} onClick={()=>{if(g.id!==activeId)setError('');setActiveId(g.id);setMobileMenu(false)}}><span>{g.emoji}</span><span>{g.name}</span>{g.id===activeId&&<span className="active-dot"/>}</button>)}</div>
 </aside>
 <main className="main">
   <header className="topbar"><button className="mobile-toggle icon-button" aria-label="Menú de grupos" aria-expanded={mobileMenu} aria-controls="sidebar" onClick={()=>setMobileMenu(v=>!v)}><Menu size={22}/></button><div className="breadcrumb">Grupos <span>/</span> <b>{currentGroupName}</b></div><div className="topright"><span className="currency-label">MXN</span>{access.private&&<button className="icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={onSignOut} disabled={busy}><LogOut size={16}/></button>}</div></header>
   <section className="content">
   <motion.div className="headline" initial={enter} animate={{opacity:1,y:0}}><div><h1>{group&&<span className="group-emoji" aria-hidden="true">{group.emoji}</span>}{currentGroupName}</h1></div>{group&&<div className="plan-actions">{access.private&&access.owner&&<button className="button secondary" disabled={busy} onClick={()=>openModal('invite')}><Link2 size={16}/> Invitar</button>}{access.owner&&<button className="icon-button remove-member" aria-label="Eliminar plan" title="Eliminar plan" disabled={busy} onClick={()=>openModal('delete-group')}><Trash2 size={18}/></button>}<button className="button primary add-main" disabled={busy||!members.length} onClick={()=>openModal('expense')}><Plus size={18}/> Nuevo gasto</button></div>}</motion.div>
   {error&&<div className="error-banner" role="alert"><span>{error}</span>{group&&<button onClick={()=>setError('')} aria-label="Cerrar aviso"><X size={16}/></button>}</div>}
   <div role="status">
    {addedMember&&addedMember.group_id===group?.id&&<p ref={memberFeedback} className="member-feedback"><Check size={18} aria-hidden="true"/><span>Se agregó a <strong>{addedMember.name}</strong> al grupo.</span></p>}
   </div>
   {!group&&error?<div className="empty"><button className="button secondary" onClick={()=>window.location.reload()}>Reintentar</button></div>:loading||(!group&&activeId)?<div className="loading" role="status">Cargando SPLIT…</div>:!group?<div className="empty">{access.owner?<><h2>¡Tu primer grupo te espera!</h2><p>Organiza un viaje, salida o reunión.</p><button className="button primary" onClick={()=>openModal('group')}>Crear grupo</button></>:<><h2>Aún no tienes planes disponibles</h2><p>Abre el enlace de invitación del plan.</p></>}</div>:<>
    <div className="summary-grid"><motion.div className="total-card" initial={enter} animate={{opacity:1,y:0}}><div className="card-top"><span>GASTOS TOTALES</span><span className="card-icon"><Wallet size={19}/></span></div><div className="big-amount">{money(total)}</div><div className="ticket-stub"><span>Pesos mexicanos</span><span className="ticket-stripes" aria-hidden="true"/></div></motion.div>
      <motion.div className="metric-card member-card" initial={enter} animate={{opacity:1,y:0}} transition={{delay:.08}}>
       <div className="card-top"><span>INTEGRANTES</span><button className="text-action" disabled={busy} onClick={()=>openModal('member')}><Plus size={15}/> Agregar</button></div>
       <div className="metric-number">{members.length}</div>
       {members.length>0&&<ul className="member-roster" aria-label="Lista de integrantes">
        {members.map((member,index)=>({member,index})).reverse().map(({member,index})=><li key={member.id} className={member.id===addedMember?.id?'member-added':undefined}>
         <span aria-hidden="true"><Avatar name={member.name} index={index} size={26}/></span>
         <span className="roster-name">{member.name}</span>
         <div className="roster-actions">
          <button className="icon-button" aria-label={`Renombrar a ${member.name}`} disabled={busy} onClick={()=>openModal('directory',{type:'rename',member})}><Pencil size={14}/></button>
          <button className="icon-button remove-member" aria-label={`Quitar a ${member.name}`} disabled={busy} onClick={()=>openModal('directory',{type:'remove',member})}><Trash2 size={14}/></button>
         </div>
        </li>)}
       </ul>}
      </motion.div>
    </div>
    <div className="section-grid">
     <ActivityPanel group={group} busy={busy} canAdd={members.length>0} enter={enter} reducedMotion={reducedMotion}
      onAdd={()=>openModal('expense')} onEdit={editExpense} onDelete={expense=>{
       if(window.confirm('¿Eliminar este gasto? Se recalcularán los saldos y se conservarán los pagos registrados.')){
        mutate(()=>api(`/groups/${activeId}/expenses/${expense.id}`,{method:'DELETE'}));
       }
      }}/>
     <BalancePanel balances={group.balances.filter(person=>person.active)} busy={busy} onAdd={()=>openModal('member')} onBreakdown={openBreakdown}/>
    </div>
    <PaymentsPanel key={group.id} group={group} busy={busy}
     onBreakdown={openBreakdown} onReview={reviewableExpenses.length?()=>openModal('review-shares'):undefined} onPay={recordPayment} onUndo={undoPayment}/>
   </>}
   </section>
 </main>
 <AnimatePresence onExitComplete={()=>memberFeedback.current?.scrollIntoView({block:'nearest',behavior:reducedMotion?'instant':'smooth'})}>
 {modal==='breakdown'&&group&&breakdownPerson&&<Modal key={modal} title={`Desglose de ${breakdownPerson.name}`} onClose={closeModal}>
  <BalanceBreakdown group={group} person={breakdownPerson}/>
 </Modal>}
 {modal==='expense'&&group&&<Modal key={modal} title={editingExpense?'Editar gasto':'Agregar un gasto'} onClose={closeModal} error={formError} busy={busy}>
  <ExpenseForm members={group.members} expense={editingExpense} busy={busy} onSave={body=>{
   const path=`/groups/${activeId}/expenses`;
   mutate(()=>api(editingExpense?`${path}/${editingExpense.id}`:path,{method:editingExpense?'PATCH':'POST',body}));
  }}/>
 </Modal>}
 {modal==='member'&&group&&<Modal key={modal} title="Nuevo integrante" onClose={closeModal} error={formError} busy={busy}>
  <AddMemberForm group={group} busy={busy} onSave={body=>mutate(()=>api(`/groups/${activeId}/members`,{method:'POST',body}))}/>
 </Modal>}
 {modal==='review-shares'&&group&&<Modal key={modal} title="Revisar repartos" onClose={closeModal} error={formError} busy={busy}>
  <RecalculationForm expenses={reviewableExpenses} busy={busy} onSave={expenseIds=>mutate(()=>api(`/groups/${activeId}/recalculate-shares`,{method:'POST',body:{expense_ids:expenseIds}}))}/>
 </Modal>}
 {modal==='invite'&&group&&access.owner&&<Modal key={modal} title="Invitar al plan" onClose={closeModal}><InvitePanel groupId={group.id}/></Modal>}
 {modal==='delete-group'&&group&&<Modal key={modal} title="Eliminar plan" onClose={closeModal} error={formError} busy={busy}>
  <p className="member-action-copy">Se eliminará <strong>{group.name}</strong> con sus gastos, pagos e integrantes de este plan. Las personas que estén en otros planes seguirán allí. Esta acción es definitiva.</p>
  <div className="member-actions delete-plan-actions">
   <button className="button secondary" disabled={busy} onClick={closeModal}>Cancelar</button>
   <button className="button primary" disabled={busy} onClick={()=>mutate(()=>api(`/groups/${activeId}`,{method:'DELETE'}))}>Eliminar definitivamente</button>
  </div>
 </Modal>}
 {modal==='directory'&&group&&<Modal key={modal} title="Integrantes del grupo" onClose={closeModal} error={formError} busy={busy}>
  <MemberDirectory group={group} members={members} initialAction={memberAction} busy={busy} onAdd={()=>openModal('member')} clearError={()=>setFormError('')}
   onUpdate={(id,options)=>mutate(()=>api(`/groups/${activeId}/members/${id}`,options),{keepModal:true})}/>
 </Modal>}
 {modal==='group'&&<Modal key={modal} title="Crear nuevo grupo" onClose={closeModal} error={formError} busy={busy}><form className="stack" onSubmit={e=>{e.preventDefault();mutate(()=>api('/groups',{method:'POST',body:{name,emoji}}))}}><label>Nombre del grupo<input required maxLength="100" placeholder="Ej. Viaje a Oaxaca" value={name} onChange={e=>setName(e.target.value)}/></label><label>Elige un emoji<select value={emoji} onChange={e=>setEmoji(e.target.value)}>{['✨','🏖️','🍕','🏠','🎉','✈️','⛺'].map(x=><option key={x} value={x}>{x}</option>)}</select></label><button className="button primary full" disabled={busy}>Crear grupo <ArrowRight size={17}/></button></form></Modal>}</AnimatePresence>
 </div>
}
