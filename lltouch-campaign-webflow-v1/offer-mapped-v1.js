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
let qaAuthorized=false,qaProfile=null,qaMode='';
async function qaAuthorize(c){
if(qaAuthorized)return c;
if(!c?.enabled||!qaToken||!c?.campaignKey)return c;
try{
const response=await fetch(API+'/lltouch/campaigns/pilot/03c10/context',{
    method:'POST',headers:{'Content-Type':'application/json','X-LL-CM-QA':qaToken},
    cache:'no-store',body:JSON.stringify({campaignKey:c.campaignKey})});
const x=await response.json();
if(!response.ok||x.ok!==true||x.authorized!==true||x.campaignKey!==c.campaignKey||
     x.campaignVersion!==c.campaignVersion)return c;
qaAuthorized=true;qaProfile=x.profile;
return {...c,contactIntakeReady:true,contactOnlyPilot:true};
 }catch{return c}
}
function markQaForm(){
if(!qaAuthorized||!qaProfile)return;
const f=document.getElementById('ll-offer-lead');if(!f)return;
 f.elements.name.value=qaProfile.name;f.elements.email.value=qaProfile.email;
 f.elements.phone.value=qaProfile.phone;
 f.elements.sms_marketing_consent.checked=false;
 f.elements.sms_marketing_consent.disabled=true;
 f.elements.name.readOnly=true;f.elements.email.readOnly=true;f.elements.phone.readOnly=true;
const note=document.createElement('p');note.className='notice';note.setAttribute('role','status');
 note.textContent='PRIVATE ADMIN TEST — fictional data only. No real lead, booking, payment or staff notification.';
 f.prepend(note);
const btn=document.getElementById('ll-start');if(btn)btn.textContent='Test contact on /offer';
}
const preview=/^\/offer-universal-preview\/?$/.test(location.pathname);
const $=id=>document.getElementById(id);
const set=(id,value)=>{const x=$(id);if(x)x.textContent=String(value??'');};
const money=n=>'$'+(Number(n||0)/100).toFixed(2);
const safeUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:''}catch{return ''}};
const fmtDate=s=>{try{return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'America/New_York'}).format(new Date(s))}catch{return ''}};
const fallback={ok:true,enabled:true,bookingReady:false,campaignKey:'preview-only',campaignVersion:0,
 offer:{title:'Laser Hair Removal — 3 Sessions for One Eligible Area',offerLabel:'CAMPAIGN PREVIEW',priceCents:16900,originalCents:42000,depositCents:2500,holdMinutes:10,
 startsAt:'2026-11-12T05:00:00Z',endsAt:'2026-11-17T05:00:00Z',hero:{desktop:'',mobile:''},
 marketing:{headline:'Laser Hair Removal',headlineEm:'Three sessions. One eligible area.',description:'A three-session package for one eligible area, subject to professional assessment.',sectionTitle:'A focused package',featureIntro:'Designed around a single treatment area.',features:[{title:'Three sessions',description:'A package of three laser hair removal treatments.'},{title:'One selected area',description:'All three sessions cover the same eligible area.'},{title:'Personal assessment',description:'Eligibility and suitability are confirmed by LL Touch.'}],faq:[{question:'What does the package include?',answer:'Three sessions for the same eligible area.'}]},serviceTerms:{sessions:3,singleAreaForAllSessions:true},treatmentAreas:[]}};
let cfg=null;
function showNotice(message){set('ll-page-notice',message);$('ll-page-notice')?.classList.remove('hidden');}
function noCampaign(kind){
const root=$('ll-offer');root.classList.add('ll-empty');$('ll-empty-state')?.classList.remove('hidden');
set('ll-empty-title',kind==='error'?'Our offers are temporarily unavailable.':'Our next offer is on its way.');
set('ll-empty-description',kind==='error'?'We could not verify the latest promotion right now. Please check again shortly.':'Our next promotion will appear here when available.');
}
async function load(){
if(preview){$('ll-preview-label')?.classList.remove('hidden');return fallback}
if(qaToken){try{
const r=await fetch(API+'/lltouch/campaigns/pilot/03c11g/context',{
   method:'POST',headers:{'Content-Type':'application/json','X-LL-CM-QA':qaToken},
   cache:'no-store',body:JSON.stringify({campaignKey:(JSON.parse(atob(qaToken.split('.')[0].replace(/-/g,'+').replace(/_/g,'/')))).campaignKey})});
const x=await r.json();if(r.ok&&x.ok&&x.privateQa&&x.qaOnly&&x.profile&&x.offer){
qaAuthorized=true;qaMode='03C11G';qaProfile=x.profile;return x;
  }
 }catch{}}
const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
try{const resp=await fetch(API+'/lltouch/campaigns/active-page',{cache:'no-store',signal:controller.signal});
if(!resp.ok)throw new Error('unavailable');const c=await resp.json();
if(c?.ok&&c.enabled===false)return null;
if(!c?.ok||!c.enabled||!c.offer)throw new Error('unavailable');return c;
 }finally{clearTimeout(timeout)}
}
function renderFeatures(items){const target=$('ll-features');if(!target)return;target.replaceChildren();
 for(let i=0;i<Math.min(items.length,6);i++){
const f=items[i],wrap=document.createElement('div'),n=document.createElement('div'),h=document.createElement('h3'),p=document.createElement('p');
  wrap.className='feature';n.className='number';n.textContent=String(i+1).padStart(2,'0');
  h.textContent=String(f.title||'');p.textContent=String(f.description||'');wrap.append(n,h,p);target.append(wrap);
 }
}
function renderFaq(items){const target=$('ll-faqs');if(!target)return;target.replaceChildren();
 for(const f of items.slice(0,6)){
if(!f?.question||!f?.answer)continue;
const details=document.createElement('details'),summary=document.createElement('summary'),p=document.createElement('p');
  summary.textContent=String(f.question);p.textContent=String(f.answer);details.append(summary,p);target.append(details);
 }
}
function apply(c){cfg=c;const o=c.offer,m=o.marketing||{},terms=o.serviceTerms||{},pending=!c.contactIntakeReady;
set('ll-offer-label',o.offerLabel||'LL Touch exclusive offer');set('ll-headline',m.headline||o.title);
set('ll-headline-em',m.headlineEm||'An exclusive experience.');
const headlineSize=Math.max((m.headline||o.title||'').length,(m.headlineEm||'').length);
$('ll-hero-title')?.classList.toggle('long-title',headlineSize>25);
$('ll-offer')?.classList.toggle('ll-multipack-hero',Number(terms.sessions)>1||Number(o.priceCents)>=10000);
set('ll-hero-description',m.description||'Professional treatment at LL Touch Advanced Aesthetics.');
set('ll-hero-price',money(o.priceCents));set('ll-hero-original','Regularly '+money(o.originalCents));
set('ll-hero-price-unit',Number(terms.sessions)>1?'for the package':'per session');
const end=new Date(Date.parse(o.endsAt)-1000);
set('ll-hero-window',fmtDate(o.startsAt)+' – '+fmtDate(end));
set('ll-deal-price',money(o.priceCents));set('ll-deal-service',o.title);
set('ll-deal-deposit',money(o.depositCents));set('ll-deal-balance',money(o.priceCents-o.depositCents));
set('ll-deal-copy',terms.singleAreaForAllSessions?
  'Your package includes '+(terms.sessions||3)+' sessions for one eligible treatment area, which will be confirmed by LL Touch.':
  'Your offer details and treatment eligibility will be confirmed by LL Touch.');
set('ll-deal-note',pending?'Booking and online payment are not yet available. No deposit is collected on this page.':
  'Send us your request. No appointment is reserved and no deposit is charged.');
set('ll-feature-heading',m.sectionTitle||'A considered treatment');
set('ll-feature-intro',m.featureIntro||m.sectionBody||'Personalized treatment at LL Touch.');
 renderFeatures(Array.isArray(m.features)?m.features:[]);renderFaq(Array.isArray(m.faq)?m.faq:[]);
const img=$('ll-hero-image'),source=$('ll-hero-mobile'),desktop=safeUrl(o.hero?.desktop),mobile=safeUrl(o.hero?.mobile);
if(img&&desktop){img.src=desktop;img.alt=o.hero?.alt||o.title;img.classList.remove('hidden');
if(source){if(mobile)source.srcset=mobile;else source.removeAttribute('srcset')}
  img.addEventListener('load',()=>{$('ll-offer')?.classList.add('ll-photo-ready')},{once:true});
if(img.complete&&img.naturalWidth>0)$('ll-offer')?.classList.add('ll-photo-ready');
 }
set('ll-claim-heading',pending?'Your next step.':qaAuthorized?'Contact verification pilot.':'Request your offer.');
set('ll-claim-step',qaAuthorized?'Private QA · Contact test':'Your details · Contact request');
set('ll-claim-description',pending?'Online reservations are not available yet.':
qaAuthorized?'Synthetic test only; no client messages.':'Share your details to register your interest. This is not an appointment booking.');
$('ll-offer-lead')?.classList.toggle('hidden',pending);
$('ll-coming-soon')?.classList.toggle('hidden',!pending);
const cta=$('ll-start');if(cta){cta.disabled=pending;cta.textContent=pending?'Booking not yet available':
qaAuthorized?'Test contact on /offer':'Send my request'}
set('ll-hold-explainer',pending?'Online reservations are not enabled yet.':
 'Submitting an inquiry does not hold an appointment or collect payment.');
set('ll-primary-action',pending?'View the offer':'Claim the offer');
set('ll-nav-action',pending?'View the offer':'Claim offer');
if(!preview&&!qaAuthorized&&!qaToken&&mappedReady(c)){
 set('ll-claim-description','Share your details to continue to verified appointment times.');set('ll-start','Continue to available dates');set('ll-deal-note','No deposit is collected on this page.');
}
const consentText=$('ll-sms-offer-name');if(consentText)consentText.textContent='LL Touch services';
}
async function submit(ev){ev.preventDefault();const feedback=$('ll-lead-error');feedback.textContent='';
if(!cfg?.contactIntakeReady||preview){feedback.textContent='Contact intake is not enabled.';return}
const form=$('ll-offer-lead'),name=form.elements.name.value.trim(),email=form.elements.email.value.trim(),phone=form.elements.phone.value.trim(),
 agreed=form.elements.consent.checked;
if(name.length<3||!/^\S+@\S+\.\S+$/.test(email)||phone.replace(/\D/g,'').length<10||!agreed){
feedback.textContent='Please complete your name, email, phone, and required consent.';return;
 }
if(qaAuthorized){
if(qaMode==='03C11G'){
const btn=$('ll-start');btn.disabled=true;btn.textContent='Verifying private lead…';
try{
if(name!==qaProfile.name||email!==qaProfile.email||phone!==qaProfile.phone||
form.elements.sms_marketing_consent.checked)throw Error('QA data must stay synthetic.');
const h={'Content-Type':'application/json','X-LL-CM-QA':qaToken};
const p={campaignKey:cfg.campaignKey,campaignVersion:cfg.campaignVersion,
       name,email,phone,consent:true,sms_marketing_consent:false,client_nonce:qaProfile.nonce};
const a=await fetch(API+'/lltouch/campaigns/pilot/03c11g/submit',{
       method:'POST',headers:h,cache:'no-store',body:JSON.stringify(p)});
const x=await a.json();if(!a.ok||!x.ok||!x.qaOnly||!x.persisted||!x.leadId)throw Error(x.error||'QA write failed.');
const v=await fetch(API+'/lltouch/campaigns/pilot/03c11g/verify-and-clean',{
       method:'POST',headers:h,cache:'no-store',body:JSON.stringify({campaignKey:cfg.campaignKey,leadId:x.leadId})});
const z=await v.json();if(!v.ok||!z.ok||!z.committedPersistenceVerified||
       !z.syntheticLeadRemoved||!z.syntheticQueueRemoved)throw Error(z.error||'QA cleanup not verified.');
form.classList.add('hidden');const el=$('ll-lead-success');
      el.textContent='PRIVATE QA PASSED: Webflow → Render → Supabase. Synthetic lead persisted in a separate request and was deleted with its disabled GHL queue. No payment, booking or message.';
      el.classList.remove('hidden');
    }catch(err){feedback.textContent='Private QA incomplete: '+(err.message||'Check audit SQL 52.');
btn.disabled=false;btn.textContent='Retry private contact test'}
return;
   }
if(name!==qaProfile.name||email!==qaProfile.email||phone!==qaProfile.phone||
      Boolean(form.elements.sms_marketing_consent.checked)){
feedback.textContent='Only the fictional prefilled data may be used for this private pilot.';return;
   }
const btn=$('ll-start');btn.disabled=true;btn.textContent='Validating Webflow contact…';
try{
const resp=await fetch(API+'/lltouch/campaigns/pilot/03c10/contact',{
       method:'POST',headers:{'Content-Type':'application/json','X-LL-CM-QA':qaToken},
       cache:'no-store',body:JSON.stringify({campaignKey:cfg.campaignKey,
         campaignVersion:cfg.campaignVersion,name,email,phone,consent:true,
         sms_marketing_consent:false,client_nonce:qaProfile.nonce})});
const x=await resp.json();
if(!resp.ok||x.ok!==true||x.qaOnly!==true||x.slotHeld!==false||!x.hold_id)
throw Error(x.error||'Could not validate test contact.');
     sessionStorage.setItem(STORE,JSON.stringify({claimId:x.hold_id,nonce:qaProfile.nonce,
       deadline:x.deadline,campaignKey:cfg.campaignKey,version:cfg.campaignVersion,
       contactOnly:true,qaPilot:true}));
location.assign('/offer-reserve#cmPilot='+encodeURIComponent(qaToken));
   }catch(err){feedback.textContent=err.message||'Private test failed.';btn.disabled=false;btn.textContent='Test contact on /offer'}
return;
 }
if(cfg.leadCaptureMode!=='contact-only'){
feedback.textContent='Contact intake is not available.';return;
 }
if(mappedReady(cfg)&&!qaAuthorized&&!qaToken&&mappedRead(cfg)?.selection){location.assign('/offer-reserve');return;}
const btn=$('ll-start');btn.disabled=true;btn.textContent='Sending your request…';
const key='lltouch_cm_lead_pending_v1';
try{
const fields=[cfg.campaignKey,cfg.campaignVersion,name,email.toLowerCase(),phone,
    Boolean(form.elements.sms_marketing_consent.checked)].join('|');
const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fields));
const fp=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
let pending=null;try{pending=JSON.parse(sessionStorage.getItem(key)||'null')}catch{}
const nonce=pending?.fingerprint===fp&&/^[0-9a-f-]{36}$/i.test(pending.nonce||'')?
    pending.nonce:crypto.randomUUID();
  sessionStorage.setItem(key,JSON.stringify({fingerprint:fp,nonce}));
const response=await fetch(API+'/lltouch/campaigns/leads',{
    method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
    body:JSON.stringify({campaignKey:cfg.campaignKey,campaignVersion:cfg.campaignVersion,
      name,email,phone,consent:true,website:form.elements.website.value||'',
      sms_marketing_consent:Boolean(form.elements.sms_marketing_consent.checked),client_nonce:nonce})});
const x=await response.json();
if(!response.ok||x.ok!==true||x.contactOnly!==true||x.bookingReady!==false||x.checkoutReady!==false)
throw Error(x.error||'Your request could not be saved. Please try again.');
  if(!qaAuthorized&&!qaToken&&mappedReady(cfg)){
    if(!mappedUuid(x.lead_id)||x.campaignKey!==cfg.campaignKey||x.campaignVersion!==cfg.campaignVersion)throw Error('Lead identity not verified');
    const previous=mappedRead(cfg);
    // Never discard an existing uncertain reservation on resubmission.
    if(previous?.selection){location.assign('/offer-reserve');return;}
    mappedSave({campaignKey:cfg.campaignKey,campaignVersion:cfg.campaignVersion,leadId:x.lead_id,clientNonce:nonce});
    sessionStorage.removeItem(key);location.assign('/offer-reserve');return;
  }
  sessionStorage.removeItem(key);
form.classList.add('hidden');
const success=$('ll-lead-success');
  success.textContent='Thank you. Your request has been received. No appointment is booked and no payment has been taken.';
  success.classList.remove('hidden');
 }catch(err){feedback.textContent='We could not save your request. Please try again later.';
btn.disabled=false;btn.textContent='Send my request';}
}
$('ll-offer-lead')?.addEventListener('submit',submit);
load().then(c=>c?qaAuthorize(c):null).then(c=>{if(!c){noCampaign('none');return}apply(c);markQaForm()}).catch(()=>noCampaign('error'));
})();
