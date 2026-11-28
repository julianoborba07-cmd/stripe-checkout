import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const container = process.env.LL_CM_TEST_PG_CONTAINER || 'lltouch-master-qa-pg';
const key = `authorization-race-${randomUUID().slice(0, 8)}`;
const listener = `ll-cm-authorization-race-${key}`;
const localGuard = `DO $$ BEGIN
  IF current_database() <> 'lltouch_authorization_qa' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Use the isolated authorization test database over its Unix socket';
  END IF;
END $$;`;

function session(sql, keepOpen = false) {
  const process = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-qtA', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'lltouch_authorization_qa']);
  let stdout = '';
  let stderr = '';
  process.stdout.on('data', data => { stdout += data; });
  process.stderr.on('data', data => { stderr += data; });
  const result = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => resolve({ code, stdout, stderr }));
  });
  process.stdin.write(`${localGuard}\n${sql}\n`);
  if (!keepOpen) process.stdin.end();
  return { process, result, output: () => stdout };
}

async function run(sql) {
  const result = await session(sql).result;
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function waitUntil(ready) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await ready()) return;
    await delay(100);
  }
  throw Error('Did not observe the expected open transaction or blocking lock');
}

const review = `jsonb_build_object('reviewToken',public.lltouch_cm_commercial_status_v1('${key}')->>'reviewToken',
  'pricingVerified',true,'clinicalCopyReviewed',true,'imagesReviewed',true,
  'publicVisibilityAccepted',true,'availability',jsonb_build_object('date',current_date + 2,
    'checkedAt',clock_timestamp(),'providers','["ludimilla","carol"]'::jsonb,
    'sources','["Vagaro","Google Calendar","Supabase"]'::jsonb,'slots',3))`;

await run(`
INSERT INTO public.lltouch_campaigns(campaign_key,version,status,site_item,service_title,marketing,
  regular_price_cents,price_cents,deposit_cents,offer_starts_at,offer_ends_at)
VALUES ('${key}',2,'draft','{"type":"manual","requiresVagaroMapping":true}','HydraFacial',
  '{"headline":"Seasonal offer","description":"Synthetic commercial approval record.","campaignMeta":{"automationPlan":
  {"schemaVersion":1,"mappingStatus":"local-catalog-match","serviceKey":"hydrafacial","siteItem":
  {"type":"med-spa","service":"hydrafacial","package":"single","addon":"none","quantity":1},"durationMinutes":60,
  "providerKeys":["ludimilla","carol"],"holdMinutes":10,"priceCents":14900,"depositCents":2500,"balanceCents":12400}}}',
  34900,14900,2500,now() - interval '1 hour',now() + interval '7 days');
INSERT INTO public.lltouch_campaign_assets(campaign_id,asset_type,device,position,image_url)
SELECT id,'hero',device,0,'https://example.invalid/hero.jpg' FROM public.lltouch_campaigns
CROSS JOIN (VALUES ('desktop'),('mobile')) d(device) WHERE campaign_key='${key}';
`);

let first;
let second;
try {
  first = session(`BEGIN; SET LOCAL ROLE service_role; SET statement_timeout='10s';
    SELECT public.lltouch_cm_commercial_lifecycle_v1('${key}',2,0,'approve','qa-admin-one',${review});
    \\echo APPROVAL_LOCK_HELD`, true);
  await waitUntil(() => first.output().includes('APPROVAL_LOCK_HELD'));

  second = session(`SET application_name='${listener}'; SET ROLE service_role; SET statement_timeout='10s';
    SELECT public.lltouch_cm_commercial_lifecycle_v1('${key}',2,0,'revoke','qa-admin-two');`);
  await waitUntil(async () => await run(`SELECT EXISTS (SELECT FROM pg_stat_activity WHERE
    application_name='${listener}' AND cardinality(pg_blocking_pids(pid)) > 0);`) === 't');
  first.process.stdin.end('COMMIT;\n');

  const [approval, revocation] = await Promise.all([first.result, second.result]);
  assert.equal(approval.code, 0, approval.stderr);
  assert.equal(revocation.code, 3, revocation.stderr);
  assert.match(revocation.stderr, /CM_COMMERCIAL_REVISION_CONFLICT/);
  const authorization = JSON.parse(await run(`SELECT public.lltouch_cm_commercial_status_v1('${key}')->'authorization';`));
  assert.equal(authorization.state, 'approved');
  assert.equal(authorization.revision, 1);
  assert.equal(authorization.approvedBy, 'qa-admin-one');
  assert.equal(await run(`SELECT count(*) FROM public.lltouch_cm_commercial_audit_v1 a
    JOIN public.lltouch_campaigns c ON c.id=a.campaign_id WHERE c.campaign_key='${key}';`), '1');
  console.log('Commercial approval/revocation verified with two competing PostgreSQL connections');

  await run(`SELECT public.lltouch_cm_commercial_lifecycle_v1('${key}',2,1,'publish','qa-admin-one');`);
  first = session(`BEGIN; SET LOCAL ROLE service_role; SET statement_timeout='10s';
    SELECT campaign_key FROM public.lltouch_cm_lead_capture_settings WHERE campaign_key='${key}' FOR UPDATE;
    \\echo SETTING_LOCK_HELD`, true);
  await waitUntil(() => first.output().includes('SETTING_LOCK_HELD'));
  second = session(`SET application_name='${listener}'; SET ROLE service_role; SET statement_timeout='10s';
    SELECT public.lltouch_cm_commercial_lifecycle_v1('${key}',3,2,'revoke','qa-admin-two');`);
  await waitUntil(async () => await run(`SELECT EXISTS (SELECT FROM pg_stat_activity WHERE
    application_name='${listener}' AND cardinality(pg_blocking_pids(pid)) > 0);`) === 't');
  first.process.stdin.end(`UPDATE public.lltouch_cm_lead_capture_settings SET enabled=true WHERE campaign_key='${key}';\nCOMMIT;\n`);
  const [captureWrite, laterRevocation] = await Promise.all([first.result, second.result]);
  assert.equal(captureWrite.code, 0, captureWrite.stderr);
  assert.equal(laterRevocation.code, 0, laterRevocation.stderr);
  assert.equal(await run(`SELECT enabled FROM public.lltouch_cm_lead_capture_settings WHERE campaign_key='${key}';`), 'f');
  console.log('Commercial revocation disabled capture after a competing legacy setting update');
} finally {
  first?.process.stdin.end();
  await Promise.allSettled([first?.result, second?.result]);
  await run(`BEGIN;
    DELETE FROM public.lltouch_cm_commercial_audit_v1 WHERE campaign_id=(SELECT id FROM public.lltouch_campaigns WHERE campaign_key='${key}');
    DELETE FROM public.lltouch_cm_commercial_authorization_v1 WHERE campaign_id=(SELECT id FROM public.lltouch_campaigns WHERE campaign_key='${key}');
    DELETE FROM public.lltouch_cm_lead_capture_settings WHERE campaign_key='${key}';
    DELETE FROM public.lltouch_campaign_assets WHERE campaign_id=(SELECT id FROM public.lltouch_campaigns WHERE campaign_key='${key}');
    DELETE FROM public.lltouch_campaigns WHERE campaign_key='${key}'; COMMIT;`);
}
