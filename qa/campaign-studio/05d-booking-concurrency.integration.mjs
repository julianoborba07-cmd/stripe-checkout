import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const container=process.env.LL_CM_TEST_PG_CONTAINER||'lltouch-master-qa-pg';
const suffix=randomUUID().slice(0,12);
const key='synthetic-booking-race-'+suffix;
const provider='synthetic-vagaro-provider-'+suffix;
const service='synthetic-vagaro-service-'+suffix;
const legacyId=randomUUID();
const nonces=[randomUUID(),randomUUID()];
const guard=`DO $$ BEGIN
  IF current_database()<>'lltouch_mapped_qa' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Use the disposable mapped database on a Unix socket';
  END IF;
END $$;`;

function session(sql,keepOpen=false){
  const child=spawn('docker',['exec','-i',container,'psql','-X','-qtA','-v','ON_ERROR_STOP=1',
    '-U','postgres','-d','lltouch_mapped_qa']);
  let stdout='',stderr='';
  child.stdout.on('data',data=>{stdout+=data;});
  child.stderr.on('data',data=>{stderr+=data;});
  const result=new Promise((resolve,reject)=>{
    child.on('error',reject);
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
  child.stdin.write(`${guard}\n${sql}\n`);
  if(!keepOpen)child.stdin.end();
  return {child,result,output:()=>stdout};
}

async function run(sql){
  const result=await session(sql).result;
  assert.equal(result.code,0,result.stderr);
  return result.stdout.trim();
}

async function until(observed){
  for(let attempt=0;attempt<50;attempt++){
    if(await observed())return;
    await delay(100);
  }
  throw Error('Expected PostgreSQL transaction or blocked waiter was not observed');
}

function setting(application){
  return `SET application_name='${application}'; SET statement_timeout='15s'; SET ROLE service_role;`;
}

const day=await run(`SELECT d::date FROM generate_series(
  ((clock_timestamp() AT TIME ZONE 'America/New_York')::date+7)::timestamp,
  ((clock_timestamp() AT TIME ZONE 'America/New_York')::date+9)::timestamp,'1 day') AS d
  WHERE extract(isodow FROM d)<>7 ORDER BY d LIMIT 1;`);
assert.match(day,/^\d{4}-\d{2}-\d{2}$/);
const slot=time=>`('${day} ${time}'::timestamp AT TIME ZONE 'America/New_York')`;
await run(`BEGIN;
  INSERT INTO public.lltouch_campaigns(campaign_key,version,status,site_item,service_title,marketing,
     regular_price_cents,price_cents,deposit_cents,offer_starts_at,offer_ends_at)
  VALUES ('${key}',2,'draft','{"type":"manual","requiresVagaroMapping":true}','HydraFacial',
    '{"headline":"Synthetic HydraFacial","description":"Synthetic hold race used only in local tests.",
      "campaignMeta":{"automationPlan":{"schemaVersion":1,"mappingStatus":"local-catalog-match",
       "serviceKey":"hydrafacial","siteItem":{"type":"med-spa","service":"hydrafacial","package":"single","addon":"none","quantity":1},
       "durationMinutes":60,"providerKeys":["ludimilla","carol"],"holdMinutes":10,
       "priceCents":14900,"depositCents":2500,"balanceCents":12400}}}',
    34900,14900,2500,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '14 days');
  INSERT INTO public.lltouch_campaign_assets
    SELECT id,'hero',device,0,'https://synthetic.invalid/hero.jpg' FROM public.lltouch_campaigns
      CROSS JOIN (VALUES ('desktop'),('mobile')) d(device) WHERE campaign_key='${key}';
  SET LOCAL ROLE service_role;
  SELECT public.lltouch_cm_commercial_lifecycle_v1('${key}',2,0,'approve','qa-booking-race',
    jsonb_build_object('reviewToken',public.lltouch_cm_commercial_status_v1('${key}')->>'reviewToken',
      'pricingVerified',true,'clinicalCopyReviewed',true,'imagesReviewed',true,'publicVisibilityAccepted',true,
      'availability',jsonb_build_object('date','${day}','checkedAt',clock_timestamp(),
        'providers','["ludimilla","carol"]'::jsonb,'sources','["Vagaro","Google Calendar","Supabase"]'::jsonb,'slots',2)));
  SELECT public.lltouch_cm_commercial_lifecycle_v1('${key}',2,1,'publish','qa-booking-race');
  COMMIT;`);

let holder;
let waiter;
async function stopSessions(){
  for(const active of [holder,waiter]){
    if(active&&!active.child.stdin.writableEnded)active.child.stdin.end('ROLLBACK;\n');
  }
  await Promise.allSettled([holder?.result,waiter?.result]);
}

try{
  const leads=[];
  for(const [i,nonce] of nonces.entries()){
    const output=await run(`SET ROLE service_role; SELECT public.lltouch_cm_commercial_submit_v1(
      '${key}',3,'${nonce}','Synthetic Person ${i}','reservation-${i}@synthetic.invalid','+17815550101',
      true,false)->>'leadId';`);
    assert.match(output,/^[a-f0-9-]{36}$/);
    leads.push(output);
  }
  const reserve=(i,time)=>`SELECT public.lltouch_cm_mapped_reserve_v1('${key}',3,'${leads[i]}','${nonces[i]}',
    'ludimilla','${provider}','${service}',${slot(time)})`;
  const blocked=application=>until(async()=>await run(`SELECT EXISTS (
    SELECT FROM pg_stat_activity WHERE application_name='${application}' AND wait_event_type='Lock'
      AND cardinality(pg_blocking_pids(pid))>0);`)==='t');

  const firstWaiter='cm-race-legacy-'+suffix;
  holder=session(`${setting('cm-legacy-fixture-'+suffix)} BEGIN;
    SELECT pg_advisory_xact_lock(5520261105);
    INSERT INTO public.lltouch_offer_claims(id,provider_id,starts_at,ends_at,state,hold_expires_at)
      VALUES ('${legacyId}','${provider}',${slot('10:00')},${slot('11:00')},'held',clock_timestamp()+interval '5 minutes');
    \\echo LEGACY_LOCK_HELD`,true);
  await until(()=>holder.output().includes('LEGACY_LOCK_HELD'));
  waiter=session(`${setting(firstWaiter)} ${reserve(0,'10:00')};`);
  await blocked(firstWaiter);
  holder.child.stdin.end('COMMIT;\n');
  assert.equal((await holder.result).code,0);
  const conflict=await waiter.result;
  assert.equal(conflict.code,3,conflict.stderr);
  assert.match(conflict.stderr,/CM_MAPPED_SLOT_CONFLICT/);
  assert.equal(await run(`SELECT count(*) FROM public.lltouch_cm_universal_holds WHERE campaign_key='${key}';`),'0');

  const secondWaiter='cm-race-mapped-'+suffix;
  holder=session(`${setting('cm-mapped-fixture-'+suffix)} BEGIN; ${reserve(0,'12:00')};
    \\echo MAPPED_LOCK_HELD`,true);
  await until(()=>holder.output().includes('MAPPED_LOCK_HELD'));
  waiter=session(`${setting(secondWaiter)} BEGIN; ${reserve(1,'12:00')}; ROLLBACK;`);
  await blocked(secondWaiter);
  holder.child.stdin.end('ROLLBACK;\n');
  const [first,second]=await Promise.all([holder.result,waiter.result]);
  assert.equal(first.code,0,first.stderr);
  assert.equal(second.code,0,second.stderr);
  assert.match(second.stdout,/"ok": true/);
  assert.equal(await run(`SELECT count(*) FROM public.lltouch_cm_universal_holds WHERE campaign_key='${key}';`),'0');
  console.log('PASS | two mapped calls serialize; legacy fixture using the same lock blocks the competing mapped hold');
}finally{
  await stopSessions();
  await run(`BEGIN;
    DELETE FROM public.lltouch_offer_claims WHERE id='${legacyId}' AND provider_id='${provider}';
    DELETE FROM public.lltouch_cm_lead_capture_settings WHERE campaign_key='${key}';
    DELETE FROM public.lltouch_cm_leads WHERE campaign_key='${key}';
    DELETE FROM public.lltouch_cm_commercial_audit_v1 WHERE campaign_id=(SELECT id FROM public.lltouch_campaigns WHERE campaign_key='${key}');
    DELETE FROM public.lltouch_cm_commercial_authorization_v1 WHERE campaign_id=(SELECT id FROM public.lltouch_campaigns WHERE campaign_key='${key}');
    DELETE FROM public.lltouch_campaign_assets WHERE campaign_id=(SELECT id FROM public.lltouch_campaigns WHERE campaign_key='${key}');
    DELETE FROM public.lltouch_campaigns WHERE campaign_key='${key}';
    COMMIT;`);
}
