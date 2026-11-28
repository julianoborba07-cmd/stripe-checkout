(function(){
'use strict';
const API='https://stripe-checkout-1.onrender.com';
const STORE='lltouch_universal_hold_v1';
const QA_STORE='lltouch_cm_03c10_signed_qa';

// Candidate contract. Never infer transaction readiness from a locally matched service.
const MAPPED_STORE='lltouch_cm_mapped_lead_v1';
const mappedUuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
function mappedReady(c){const p=c?.mappedOperationalPlan,o=c?.offer;
 return c?.enabled===true&&c.contactIntakeReady===true&&typeof c.campaignKey==='string'&&Number.isSafeInteger(c.campaignVersion)&&c.campaignVersion>0&&
 p?.schemaVersion===1&&p.mappingValidatedLocally===true&&p.reservationReady===true&&p.checkoutReady===true&&
 p.providerKeys?.length===2&&p.providerKeys[0]==='ludimilla'&&p.providerKeys[1]==='carol'&&
 Number.isSafeInteger(p.durationMinutes)&&p.durationMinutes>=10&&p.durationMinutes<=240&&
 Number.isSafeInteger(p.priceCents)&&Number.isSafeInteger(p.depositCents)&&p.depositCents>0&&p.priceCents>=p.depositCents&&
 p.priceCents===o?.priceCents&&p.depositCents===o?.depositCents&&p.balanceCents===p.priceCents-p.depositCents&&o.holdMinutes===10;
}
function mappedRead(c){try{const a=JSON.parse(sessionStorage.getItem(MAPPED_STORE)||'null');
 return a?.campaignKey===c?.campaignKey&&a.campaignVersion===c.campaignVersion&&mappedUuid(a.leadId)&&mappedUuid(a.clientNonce)?a:null;
}catch{return null}}
function mappedSave(a){sessionStorage.setItem(MAPPED_STORE,JSON.stringify(a));}

(function captureQaFragment(){
 const t=new URLSearchParams(location.hash.slice(1)).get('cmPilot');
 if(t){sessionStorage.setItem(QA_STORE,t);history.replaceState(null,'',location.pathname+location.search)}
})();
const qaToken=sessionStorage.getItem(QA_STORE)||'';
let qaAuthorized=false;
async function qaAuthorize(c){
 if(!c?.enabled||!qaToken)return c;
 try{
  const response=await fetch(API+'/lltouch/campaigns/pilot/03c10/context',{
    method:'POST',headers:{'Content-Type':'application/json','X-LL-CM-QA':qaToken},
    cache:'no-store',body:JSON.stringify({campaignKey:c.campaignKey})});
  const x=await response.json();
  if(!response.ok||x.ok!==true||x.authorized!==true||
     x.campaignKey!==c.campaignKey||x.campaignVersion!==c.campaignVersion)return c;
  qaAuthorized=true;return {...c,contactIntakeReady:true,contactOnlyPilot:true};
 }catch{return c}
}
const preview=/^\/offer-reserve-universal-preview\/?$/.test(location.pathname);
const $=id=>document.getElementById(id),money=n=>'$'+(Number(n||0)/100).toFixed(2);
const set=(id,v)=>{const el=$(id);if(el)el.textContent=String(v??'')};
const validDay=d=>/^\d{4}-\d{2}-\d{2}$/.test(String(d||''));
let cfg=null,claim=null,provider='',date='',time='',mode='suggested',dates=[],countdown=null;
const query=new URLSearchParams(location.search);
const demo={ok:true,enabled:true,bookingReady:false,campaignKey:'preview-only',campaignVersion:0,
 offer:{title:'Laser Hair Removal — 3 Sessions for One Eligible Area',priceCents:16900,originalCents:42000,depositCents:2500,holdMinutes:10,
 marketing:{headline:'Laser Hair Removal',headlineEm:'Three sessions. One eligible area.'},serviceTerms:{sessions:3,singleAreaForAllSessions:true},treatmentAreas:[]}};
function message(t){set('ll-reserve-error',t)}
function empty(kind){$('ll-offer')?.classList.add('ll-empty');$('ll-empty-state')?.classList.remove('hidden');
 set('ll-empty-title',kind==='error'?'Our offers are temporarily unavailable.':'Our next offer is on its way.');
 set('ll-empty-description',kind==='error'?'We could not verify the latest promotion. Please check again later.':'Please check back for the next LL Touch offer.');
}
async function load(){if(preview){$('ll-preview-label')?.classList.remove('hidden');return demo}
 const ctrl=new AbortController(),tid=setTimeout(()=>ctrl.abort(),10000);
 try{const r=await fetch(API+'/lltouch/campaigns/active-page',{cache:'no-store',signal:ctrl.signal});
  if(!r.ok)throw new Error('unavailable');const c=await r.json();
  if(c?.ok&&c.enabled===false)return null;if(!c?.ok||!c.enabled||!c.offer)throw new Error('unavailable');return c;
 }finally{clearTimeout(tid)}
}
function apply(c){cfg=c;const o=c.offer,terms=o.serviceTerms||{},pending=!c.bookingReady;
 set('ll-book-service',o.title);set('ll-book-original',money(o.originalCents));set('ll-book-price',money(o.priceCents));
 set('ll-book-deposit',money(o.depositCents));set('ll-book-balance',money(o.priceCents-o.depositCents));set('ll-book-today',money(o.depositCents));
 set('ll-mobile-service',o.title);set('ll-mobile-price',money(o.priceCents));
 set('ll-mobile-deposit',money(o.depositCents));set('ll-mobile-balance',money(o.priceCents-o.depositCents));
 set('ll-book-explanation',terms.singleAreaForAllSessions?
 'Deposit toward a '+(terms.sessions||3)+'-session package for the same selected eligible area. The balance is due at the visit under LL Touch booking terms.':
 'Your deposit will count toward the promotional treatment price.');
 set('ll-book-terms','I understand that '+money(o.depositCents)+' is charged toward the '+money(o.priceCents)+' package, with '+money(o.priceCents-o.depositCents)+' remaining, subject to LL Touch booking terms.');
 set('ll-pay','Secure my time — pay '+money(o.depositCents));
 set('ll-reserve-lead',pending?'This campaign is available to view. Verified online booking and deposits will be enabled when our booking integration is ready.':
 'Choose Carol or Ludimilla, select a verified available time, then complete your secure deposit.');
 set('ll-count-title',(o.holdMinutes||10)+'-minute reservation window');
 set('ll-count-sub','Your hold is verified by our booking system. Payment confirmation is separate.');
 set('ll-reservation-label',pending?'Reservation status':'Live calendar');
 set('ll-booking-explainer',pending?'No appointment or payment can be confirmed through this page yet.':
 'Only verified available times are displayed. Final confirmation depends on payment verification and calendar synchronization.');
 $('ll-availability-pending')?.classList.toggle('hidden',!pending);
 $('ll-reserve-controls')?.classList.toggle('hidden',pending);
 $('ll-timerstrip')?.classList.toggle('hidden',true);
 if(!pending)$('ll-reserve-controls')?.classList.add('hidden');
 const items=Array.isArray(c.providers)?c.providers:[];
 const L=items.find(x=>x.key==='ludimilla'),C=items.find(x=>x.key==='carol');
 if(L)set('ll-provider-ludimilla',L.name);if(C)set('ll-provider-carol',C.name);
}
function showReceiptTitle(title,note){$('ll-receipt')?.classList.remove('hidden');set('ll-result-title',title);set('ll-result-message',note)}
async function verifyReceipt(){const sessionId=query.get('session_id');if(!sessionId||!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId))return;
 showReceiptTitle('Verifying your payment…','Please do not pay again while your payment is being checked.');
 try{const r=await fetch(API+'/lltouch/campaigns/receipt?session_id='+encodeURIComponent(sessionId),{cache:'no-store'});
  const x=await r.json();if(!r.ok||!x.ok)throw new Error(x.error||'Receipt not available');
  showReceiptTitle(x.paid?'Payment received':'Awaiting payment verification',x.message||'Please contact LL Touch if you need help.');
 }catch{showReceiptTitle('We cannot verify this payment here','Please do not pay again. Contact LL Touch with your Stripe receipt.');}
}
function getClaim(){try{return JSON.parse(sessionStorage.getItem(STORE)||'null')}catch{return null}}
async function post(endpoint,payload,qa){const headers={'Content-Type':'application/json'};if(qa)headers['X-LL-CM-QA']=qa;const r=await fetch(API+endpoint,{method:'POST',headers,cache:'no-store',body:JSON.stringify(payload)});
 const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Unable to verify availability.');return d;}
function mmss(){if(!claim?.deadline)return;const n=Math.max(0,Math.floor((Date.parse(claim.deadline)-Date.now())/1000));
 set('ll-mm',String(Math.floor(n/60)).padStart(2,'0'));set('ll-ss',String(n%60).padStart(2,'0'));
 if(n===0){clearInterval(countdown);$('ll-pay').disabled=true;message('Your reservation window has expired. Return to the offer to begin again.');}}
function selected(){if(mappedLead){mappedUpdate();return;}const allowed=cfg?.bookingReady&&claim&&!preview&&Date.parse(claim.deadline)>Date.now()&&$('ll-agreement').checked;
 const complete=mode==='suggested'?Boolean(provider&&date&&time):Boolean($('ll-preferred-date').value&&$('ll-preferred-time').value);
 $('ll-pay').disabled=!(allowed&&complete);}
function chooseMode(next){if(next==='preferred'&&cfg?.bookingModes?.preferred!==true)return;
 mode=next;$('ll-mode-suggested').setAttribute('aria-pressed',String(next==='suggested'));
 $('ll-mode-preferred').setAttribute('aria-pressed',String(next==='preferred'));
 $('ll-suggested-calendar').classList.toggle('hidden',next!=='suggested');
 $('ll-preferred-calendar').classList.toggle('hidden',next!=='preferred');message('');selected();}
function displayDates(){const el=$('ll-dates');el.replaceChildren();if(!dates.length){const p=document.createElement('p');p.className='fine';p.textContent='No verified times are available in this window.';el.append(p);return;}
 for(const x of dates){const b=document.createElement('button');b.type='button';b.textContent=new Date(x.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
  b.setAttribute('aria-pressed',String(x.date===date));b.addEventListener('click',()=>{date=x.date;time='';displayDates();displayTimes(x.slots||[]);selected()});el.append(b)} }
function displayTimes(list){const el=$('ll-times');el.replaceChildren();if(!list.length){const p=document.createElement('p');p.className='fine';p.textContent='No verified time slots on this date.';el.append(p);return;}
 for(const slot of list){const value=typeof slot==='string'?slot:String(slot?.time||'');if(!value)continue;
  const b=document.createElement('button');b.type='button';b.textContent=value;b.setAttribute('aria-pressed',String(time===value));
  b.addEventListener('click',()=>{time=value;for(const item of el.querySelectorAll('button'))item.setAttribute('aria-pressed',String(item===b));
   set('ll-selection','Selected '+date+' · '+time+' · '+(provider==='ludimilla'?'Ludimilla Leite':'Carol'));selected()});el.append(b)} }
async function selectProvider(next){provider=next;date='';time='';selected();
 for(const b of [ $('ll-provider-ludimilla'),$('ll-provider-carol') ])b.setAttribute('aria-pressed',String(b.dataset.provider===next));
 set('ll-dates','Checking verified available dates…');set('ll-times','Choose a date first.');
 try{const response=await post('/lltouch/campaigns/dates',{campaignKey:cfg.campaignKey,hold_id:claim.claimId,professional_key:provider});
 dates=(Array.isArray(response.dates)?response.dates:[]).filter(x=>validDay(x.date));displayDates();}
 catch(e){message(e.message||'Availability is temporarily unavailable.');$('ll-dates').replaceChildren();}
}
function initPreferred(){const s=$('ll-preferred-time');for(let h=9;h<=18;h++)for(const min of [0,30]){
 if(h===18&&min)continue;const v=String(h).padStart(2,'0')+':'+String(min).padStart(2,'0');const o=document.createElement('option');o.value=v;o.textContent=v+' Eastern';s.append(o)}
 const now=new Date(),min=new Date(now.getTime()+86400000);$('ll-preferred-date').min=min.toISOString().slice(0,10);
 for(const key of ['ludimilla','carol']){const p=cfg?.providers?.find(x=>x.key===key);if(!p)continue;const opt=document.createElement('option');opt.value=key;opt.textContent=p.name;$('ll-preferred-provider').append(opt)}
}
async function initializeBooking(c){
 // 03C-5 does NOT have dates/checkout/receipt activation. Fail closed.
 if(!c.bookingReady||!c.checkoutReady||preview)return;
 const saved=getClaim();if(!saved?.claimId||saved.campaignKey!==c.campaignKey||saved.version!==c.campaignVersion){
  message('No active reservation found. Return to the offer page to begin.');return;}
 claim=saved;
 if(claim.selectedArea){const area=(c.offer.treatmentAreas||[]).find(x=>x.key===claim.selectedArea);
  if(!area){message('The selected treatment area is no longer offered. Please restart.');return}
  set('ll-selected-area','Selected treatment area: '+area.title);$('ll-selected-area').classList.remove('hidden')}
 try{const response=await post('/lltouch/campaigns/hold/status',{campaignKey:c.campaignKey,hold_id:claim.claimId});
  if(response.state!=='held')throw new Error('This reservation window is no longer active.');
  claim.deadline=response.deadline||claim.deadline;
 }catch(e){message(e.message||'Unable to verify your reservation.');return}
 const customer=claim.customer||{};
 const person=$('ll-person');person.replaceChildren();
 for(const [label,value] of [['Name',customer.name],['Email',customer.email],['Phone',customer.phone]]){
  if(!value)continue;const p=document.createElement('div'),strong=document.createElement('b');strong.textContent=label+': ';
  p.append(strong,document.createTextNode(String(value)));person.append(p)}
 $('ll-availability-pending').classList.add('hidden');$('ll-reserve-controls').classList.remove('hidden');
 $('ll-timerstrip').classList.remove('hidden');
 $('ll-booking-mode').classList.remove('hidden');
 const canSuggested=c.bookingModes?.suggested===true,canPreferred=c.bookingModes?.preferred===true;
 $('ll-mode-suggested').disabled=!canSuggested;$('ll-mode-preferred').disabled=!canPreferred;
 if(!canSuggested&&!canPreferred){message('Booking modes are not enabled for this campaign.');return}
 if(!canSuggested&&canPreferred)chooseMode('preferred');else chooseMode('suggested');
 initPreferred();mmss();countdown=setInterval(mmss,1000);
}
// Stage 03C-5: contact-only pilot, no booking/charge or selected slots.
async function initializeContactPilot(c){
 if(!c.contactIntakeReady||preview||c.bookingReady)return;
 const saved=getClaim();
 if(!saved?.contactOnly||!saved?.claimId||!saved?.nonce||saved.campaignKey!==c.campaignKey||
    saved.version!==c.campaignVersion)return;
 if(qaAuthorized&&saved.qaPilot){
  try{
   const response=await post('/lltouch/campaigns/pilot/03c10/verify-and-clean',{
     campaignKey:c.campaignKey,hold_id:saved.claimId},qaToken);
   if(response.ok!==true||response.cleanupVerified!==true||response.noAreaAccepted!==true)
     throw Error('QA contact was not verified and cleaned');
   const pending=$('ll-availability-pending');
   if(pending){pending.replaceChildren();
     const t=document.createElement('strong');t.textContent='PRIVATE WEBFLOW TEST PASSED';
     const p=document.createElement('p');p.textContent='Contact was accepted without selecting an area, recovered and deleted from Supabase. No slot, charge or booking was created.';
     pending.append(t,p);}
   set('ll-reserve-lead','Test completed: /offer → Render → Supabase → /offer-reserve. Synthetic record deleted.');
   set('ll-reservation-label','Contact-only test passed');
   sessionStorage.removeItem(STORE);sessionStorage.removeItem(QA_STORE);
  }catch(e){message('The private test could not confirm cleanup. Do not repeat until the QA record has been checked.');}
  return;
 }
 try{
  const response=await post('/lltouch/campaigns/hold/status',{
    campaignKey:c.campaignKey,hold_id:saved.claimId,client_nonce:saved.nonce});
  if(response.state!=='held' || Date.parse(response.deadline)<=Date.now()){
    set('ll-reserve-lead','Your contact verification window has expired. No time was booked and no payment was made.');
    return;
  }
  // No area is selected during the initial contact step. No default area.
  set('ll-reserve-lead','Contact saved. Your treatment area will be discussed with LL Touch before any booking.');
  set('ll-reserve-lead','Contact saved in the Campaign Studio test. The area remains undecided; no appointment or payment was made.');
  set('ll-reservation-label','Contact received — test only');
  const pending=$('ll-availability-pending');
  if(pending){pending.replaceChildren();
    const title=document.createElement('strong');title.textContent='Contact recorded for testing.';
    const detail=document.createElement('p');detail.textContent='No appointment was reserved, no Stripe payment occurred, and no automatic staff notification was sent.';
    const link=document.createElement('a');link.className='btn alt small';link.href='/offer';link.textContent='Back to the offer';
    pending.append(title,detail,link);}
 }catch(e){message('Contact verification unavailable. No booking or payment has been made.');}
}
async function goCheckout(){if(mappedLead){return mappedCheckout();}if(cfg?.mappedOperationalPlan)return;selected();if($('ll-pay').disabled)return;
 let payload={campaignKey:cfg.campaignKey,campaignVersion:cfg.campaignVersion,hold_id:claim.claimId,booking_mode:mode,requested_area:claim.selectedArea||null};
 if(mode==='suggested'){if(!provider||!validDay(date)||!time){message('Select a professional, date and time.');return}
  Object.assign(payload,{professional_key:provider,date,time});}
 else{const d=$('ll-preferred-date').value,t=$('ll-preferred-time').value;
  if(!validDay(d)||!t){message('Select a preferred date and time.');return}
  Object.assign(payload,{date:d,time:t,professional_key:$('ll-preferred-provider').value||'either'});}
 $('ll-pay').disabled=true;message('');
 try{const result=await post('/lltouch/campaigns/checkout',payload);const url=new URL(result.url);
  if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com')throw new Error('Unexpected checkout destination.');location.assign(url.href)}
 catch(e){message(e.message||'Unable to open secure checkout.');selected()}
}
$('ll-provider-ludimilla')?.addEventListener('click',()=>mappedLead?mappedProvider('ludimilla'):selectProvider('ludimilla'));
$('ll-provider-carol')?.addEventListener('click',()=>mappedLead?mappedProvider('carol'):selectProvider('carol'));
$('ll-mode-suggested')?.addEventListener('click',()=>chooseMode('suggested'));
$('ll-mode-preferred')?.addEventListener('click',()=>chooseMode('preferred'));
$('ll-agreement')?.addEventListener('change',selected);
$('ll-preferred-date')?.addEventListener('change',selected);
$('ll-preferred-time')?.addEventListener('change',selected);
$('ll-pay')?.addEventListener('click',goCheckout);

// Mapped flow: no hold until a verified appointment is chosen, no new nonce on retry.
let mappedLead=null,mappedBusy=false,mappedSeq=0,mappedSlots=[];
const mappedDay=(offset=0)=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
 const get=k=>parts.find(p=>p.type===k).value;const d=new Date(get('year')+'-'+get('month')+'-'+get('day')+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
function mappedTimeValid(t){return typeof t==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)}
function mappedSelectionValid(s){return !!s&&['ludimilla','carol'].includes(s.providerKey)&&validDay(s.date)&&mappedTimeValid(s.time)}
function mappedHoldValid(h){return mappedUuid(h?.holdId)&&mappedUuid(h?.snapshotId)&&Number.isFinite(Date.parse(h.expiresAt));}
function mappedUpdate(){if(!mappedLead)return;const h=mappedLead.hold,s=mappedLead.selection;
 const retry=mappedSelectionValid(s)&&(!h||mappedHoldValid(h)&&Date.parse(h.expiresAt)>Date.now());
 $('ll-pay').disabled=!(mappedReady(cfg)&&!mappedBusy&&$('ll-agreement').checked&&(s?retry:provider&&date&&mappedSlots.includes(time)));
 for(const id of ['ll-provider-ludimilla','ll-provider-carol','ll-mapped-date','ll-mapped-check']){const el=$(id);if(el)el.disabled=!!s||mappedBusy;}
}
async function mappedAvailability(){if(mappedBusy||mappedLead?.selection)return;
 const token=++mappedSeq,p=provider,d=$('ll-mapped-date').value;date=d;time='';mappedSlots=[];$('ll-times').replaceChildren();mappedUpdate();
 if(!validDay(d)||d<mappedDay()||d>mappedDay(27)||new Date(d+'T12:00:00Z').getUTCDay()===0){message('Choose a date Monday through Saturday within the next 27 days.');return;}
 message('Checking verified times…');
 try{const qs=new URLSearchParams({campaignKey:cfg.campaignKey,campaignVersion:String(cfg.campaignVersion),providerKey:p,date:d});
 const r=await fetch(API+'/lltouch/campaigns/mapped-availability?'+qs,{cache:'no-store'});const x=await r.json();if(token!==mappedSeq)return;
 if(!r.ok||x?.ok!==true||x.readOnly!==true||x.noHold!==true||x.noBooking!==true||x.noPayment!==true||x.campaignKey!==cfg.campaignKey||x.campaignVersion!==cfg.campaignVersion||x.providerKey!==p||x.date!==d||x.timezone!=='America/New_York'||x.durationMinutes!==cfg.mappedOperationalPlan.durationMinutes||!Array.isArray(x.slots)||!x.slots.every(mappedTimeValid))throw Error('Availability unavailable');
 mappedSlots=[...new Set(x.slots)];message(mappedSlots.length?'':'No verified times on this date. Choose another day.');
 for(const t of mappedSlots){const b=document.createElement('button');b.type='button';b.textContent=t;b.setAttribute('aria-pressed','false');b.onclick=()=>{if(mappedLead.selection||mappedBusy)return;time=t;for(const el of $('ll-times').querySelectorAll('button'))el.setAttribute('aria-pressed',String(el===b));set('ll-selection','Selected '+d+' · '+t+' Eastern');mappedUpdate()};$('ll-times').append(b);}
 }catch{if(token===mappedSeq)message('Unable to verify times. Please try again later.');}finally{if(token===mappedSeq)mappedUpdate();}
}
function mappedProvider(p){if(!mappedLead||mappedLead.selection||mappedBusy)return;provider=p;date='';time='';mappedSlots=[];for(const id of ['ll-provider-ludimilla','ll-provider-carol'])$(id).setAttribute('aria-pressed',String($(id).dataset.provider===p));void mappedAvailability();}
async function mappedInit(c){if(preview||qaAuthorized||!mappedReady(c))return;
 mappedLead=mappedRead(c);if(!mappedLead){message('Please start with your contact details on the offer page.');return;}
 if(mappedLead.selection&&!mappedSelectionValid(mappedLead.selection)||mappedLead.hold&&!mappedHoldValid(mappedLead.hold)){mappedLead=null;message('We cannot verify your previous request. Please contact LL Touch before paying.');return;}
 $('ll-availability-pending').classList.add('hidden');$('ll-reserve-controls').classList.remove('hidden');$('ll-suggested-calendar').classList.remove('hidden');$('ll-booking-mode').classList.add('hidden');$('ll-preferred-calendar').classList.add('hidden');
 set('ll-person','Your contact information is securely linked to this request.');set('ll-reserve-lead','Choose a verified available time. Your deposit will count toward your treatment.');set('ll-reservation-label','Live calendar');set('ll-booking-explainer','A reservation window starts only after a verified time is selected. Appointment confirmation follows payment and calendar verification.');
 const wrap=$('ll-dates');wrap.replaceChildren();const input=document.createElement('input');input.type='date';input.id='ll-mapped-date';input.className='field';input.min=mappedDay();input.max=mappedDay(27);input.value=mappedDay();const b=document.createElement('button');b.id='ll-mapped-check';b.className='btn alt small';b.type='button';b.textContent='Check times';wrap.append(input,b);b.onclick=()=>void mappedAvailability();input.onchange=()=>void mappedAvailability();
 provider='ludimilla';if(mappedLead.selection){const s=mappedLead.selection;provider=s.providerKey;date=s.date;time=s.time;input.value=s.date;set('ll-selection','Previous request: '+s.date+' · '+s.time+' Eastern. Resume the same request or contact LL Touch.');if(mappedLead.hold)mappedStartTimer();}
 for(const id of ['ll-provider-ludimilla','ll-provider-carol'])$(id).setAttribute('aria-pressed',String($(id).dataset.provider===provider));mappedUpdate();
 if(!mappedLead.selection)void mappedAvailability();
}
function mappedStartTimer(){if(!mappedHoldValid(mappedLead?.hold))return;clearInterval(countdown);$('ll-timerstrip').classList.remove('hidden');const tick=()=>{const n=Math.max(0,Math.floor((Date.parse(mappedLead.hold.expiresAt)-Date.now())/1000));set('ll-mm',String(Math.floor(n/60)).padStart(2,'0'));set('ll-ss',String(n%60).padStart(2,'0'));if(!n){clearInterval(countdown);message('The reservation window ended. Do not make another payment. Contact LL Touch if payment was attempted.');}mappedUpdate();};tick();countdown=setInterval(tick,1000);}
async function mappedCheckout(){mappedUpdate();if(!mappedLead||$('ll-pay').disabled)return;mappedBusy=true;mappedUpdate();message('Securing your selected time…');
 try{const a=mappedLead;if(!a.selection){a.selection={providerKey:provider,date,time};mappedSave(a);}const identity={campaignKey:a.campaignKey,campaignVersion:a.campaignVersion,leadId:a.leadId,clientNonce:a.clientNonce};
 if(!a.hold){const h=await post('/lltouch/campaigns/mapped-reservation',{...identity,...a.selection});if(!mappedHoldValid(h)||h.bookingReady!==false||h.checkoutReady!==false)throw Error('Reservation response not verified');a.hold={holdId:h.holdId,snapshotId:h.snapshotId,expiresAt:h.expiresAt};mappedSave(a);mappedStartTimer();}
 if(Date.parse(a.hold.expiresAt)<=Date.now())throw Error('Reservation expired');
 const x=await post('/lltouch/campaigns/mapped-checkout',{...identity,holdId:a.hold.holdId,snapshotId:a.hold.snapshotId});const url=new URL(x.url);if(x.bookingReady!==false||url.protocol!=='https:'||url.hostname!=='checkout.stripe.com'||url.username||url.password||url.port)throw Error('Checkout response not verified');
 // Save identifiers before navigation. A later receipt must be verified by the server.
 a.checkoutOpened=true;mappedSave(a);location.assign(url.href);return;
 }catch{message('We could not verify this request. Retry the same request only, or contact LL Touch before paying again.');}finally{mappedBusy=false;mappedUpdate();}
}

async function main(){try{const raw=await load();const c=raw?await qaAuthorize(raw):null;if(!c){empty('none');if(query.has('session_id')||query.has('cancelled'))showReceiptTitle('Verification pending','Please do not make another payment. Contact LL Touch with your Stripe receipt.');return}apply(c);
 if(query.has('session_id')||query.has('cancelled')){
   $('ll-reserve-controls').classList.add('hidden');$('ll-timerstrip').classList.add('hidden');
   showReceiptTitle('Payment or reservation verification pending','Please do not make another payment. Contact LL Touch with your Stripe receipt if payment was attempted.');return;
 }
 if(!preview&&!qaAuthorized&&!qaToken&&mappedReady(c)){await mappedInit(c);return;}
 await initializeContactPilot(c);if(!c.mappedOperationalPlan)await initializeBooking(c);
 }catch(e){if(!cfg)empty('error');else message(e.message||'Could not verify booking at this time.')}}
main();
})();
