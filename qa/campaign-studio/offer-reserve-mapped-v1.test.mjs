import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../../lltouch-campaign-webflow-v1/offer-reserve-mapped-v1.js',import.meta.url),'utf8');
const lead={
  campaignKey:'hydrafacial-piloto-qa', campaignVersion:2,
  leadId:'c75e3450-f029-48f9-8b96-eb527d141bc4', clientNonce:'15c335de-119b-4aa5-84e4-e5f28c6bb886',
  hold:{holdId:'e0febe53-8ac1-4d23-84d5-e950bce1565a', snapshotId:'5b656af5-52d3-4c56-8aac-a2d96f30b4ac',
    expiresAt:'2027-01-05T15:10:00.000Z'}
};
const sessionId='cs_live_synthetic_123456789';

async function openReceipt({proof,archivedProof,response,query='?session_id='+sessionId}){
  const elements=new Map();
  const calls=[];
  function element(id){
    if(!elements.has(id)){
      const classes=new Set(id==='ll-receipt'?['hidden']:[]);
      elements.set(id,{textContent:'',addEventListener(){},classList:{
        add:classes.add.bind(classes),remove:classes.delete.bind(classes),contains:classes.has.bind(classes)
      }});
    }
    return elements.get(id);
  }
  runInNewContext(source,{
    location:{pathname:'/offer-reserve',search:query,hash:''},URLSearchParams,
    document:{getElementById:element},
    sessionStorage:{getItem(key){
      if(key==='lltouch_cm_mapped_lead_v1'&&proof)return JSON.stringify(proof);
      if(key==='lltouch_cm_mapped_lead_v1:'+sessionId&&archivedProof)return JSON.stringify(archivedProof);
      return null;
    }},
    fetch:async(url,options)=>{
      calls.push({path:new URL(url).pathname,method:options.method,body:JSON.parse(options.body)});
      return {ok:true,json:async()=>response};
    }
  });
  await setImmediate();
  return {calls,element};
}

test('Stripe return can show ledger-proven calendar block after the public campaign has ended',async()=>{
  const {calls,element}=await openReceipt({proof:lead,
    response:{ok:true,status:'calendar-verified',paid:true,calendarVerified:true,appointmentConfirmed:false}});
  assert.deepEqual(calls,[{path:'/lltouch/campaigns/mapped-receipt',method:'POST',body:{
    campaignKey:lead.campaignKey,campaignVersion:lead.campaignVersion,leadId:lead.leadId,clientNonce:lead.clientNonce,
    holdId:lead.hold.holdId,snapshotId:lead.hold.snapshotId,sessionId
  }}]);
  assert.equal(element('ll-result-title').textContent,'Deposit received. Calendar time blocked.');
  assert.match(element('ll-result-message').textContent,/LL Touch will confirm/);
  assert.equal(element('ll-reserve-controls').classList.contains('hidden'),true);
});

test('a bare Stripe return does not permit status lookup or another payment',async()=>{
  const {calls,element}=await openReceipt({});
  assert.deepEqual(calls,[]);
  assert.equal(element('ll-result-title').textContent,'Payment status unavailable');
  assert.match(element('ll-result-message').textContent,/do not pay again/);
  assert.equal(element('ll-reserve-controls').classList.contains('hidden'),true);
});

test('an older Stripe return uses its archived proof after a new campaign replaced current storage',async()=>{
  const {calls,element}=await openReceipt({
    proof:{...lead,campaignKey:'different-offer',campaignVersion:3},archivedProof:lead,
    response:{ok:true,status:'paid',paid:true,calendarVerified:false,appointmentConfirmed:false}
  });
  assert.equal(calls[0].body.campaignKey,lead.campaignKey);
  assert.equal(calls[0].body.campaignVersion,lead.campaignVersion);
  assert.equal(calls[0].body.sessionId,sessionId);
  assert.equal(element('ll-result-title').textContent,'Deposit received');
});

test('a failed booking after a paid deposit displays the review state and suppresses another checkout',async()=>{
  const {calls,element}=await openReceipt({proof:lead,query:'?cancelled=1',
    response:{ok:true,status:'review',paid:true,calendarVerified:false,appointmentConfirmed:false}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.sessionId,undefined);
  assert.equal(element('ll-result-title').textContent,'Deposit received. Booking needs review.');
  assert.equal(element('ll-reserve-controls').classList.contains('hidden'),true);
});
