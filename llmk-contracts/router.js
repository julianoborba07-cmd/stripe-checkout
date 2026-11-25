/**
 * LL Brows Media Kit contract API / secured Node.js Express router / v2 QA.
 * Mount ONLY after app.use(express.json(...)) in the shared index.js.
 * No modification to Stripe webhook, Academy, LL Touch or Campaign Studio routes.
 */
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import { createContractPdf, ContractInputError } from './generator.js';
import { registerSigningV2QaRoutes } from './signing-v2-qa.js';
import { registerSigningV2QaViewRoute } from './signing-v2-qa-view.js';
import { registerSigningV2QaOperatorRoutes } from './signing-v2-qa-operators.js';
import { registerSigningV2QaReviewRoutes } from './signing-v2-qa-review.js';
import { registerSigningV2QaCompletionRoutes } from './signing-v2-qa-completion.js';

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ORIGINS=new Set(['https://www.llbrows.com','https://llbrows.com']);
const ALLOWED_PLANS=new Set(['full','foundation','growth','performance']);
const ALLOWED_TZ=new Set(['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Sao_Paulo']);
const s=(v,max=145)=>typeof v==='string'?v.trim().slice(0,max+1):'';

function checkInput(b) {
  if (!b || typeof b!=='object' || Array.isArray(b)) throw new ContractInputError('Invalid contract request');
  if (Object.keys(b).some(k=>/ssn|social.?security|tax.?id|\bein\b/i.test(k))) throw new ContractInputError('Sensitive identifiers are not accepted');
  if (typeof b.client_id!=='string' || !UUID_RE.test(b.client_id)) throw new ContractInputError('Invalid client id');
  if (!ALLOWED_PLANS.has(b.plan)) throw new ContractInputError('Invalid service plan');
  const role=s(b.client_title,70), place=s(b.service_location), date=s(b.effective_date,10), tz=s(b.timezone,45);
  if (role.length<2||role.length>70||place.length<3||place.length>145) throw new ContractInputError('Invalid signer title or service location');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date!==b.effective_date) throw new ContractInputError('Invalid effective date');
  if (!ALLOWED_TZ.has(tz)) throw new ContractInputError('Invalid service timezone');
  if (typeof b.deposit_enabled!=='boolean') throw new ContractInputError('Invalid deposit setting');
  return {clientId:b.client_id, plan:b.plan, role, place, date, tz, depositEnabled:b.deposit_enabled,
    confirmed:b.confirmed_contracting_party===true,
    previewFingerprint:s(b.confirmed_preview_fingerprint,64)};
}

function config() {
  return {
    url:s(process.env.LLMK_SUPABASE_URL,250),
    serviceKey:s(process.env.LLMK_SUPABASE_SERVICE_ROLE_KEY,2000),
    agencyLegal:s(process.env.LLMK_AGENCY_LEGAL_NAME),
    agencyAddress:s(process.env.LLMK_AGENCY_ADDRESS),
    agencyEmail:s(process.env.LLMK_AGENCY_EMAIL),
    governingState:s(process.env.LLMK_GOVERNING_STATE,50),
    venue:s(process.env.LLMK_VENUE),
    previewEnabled:process.env.LLMK_PREVIEW_ENABLED==='1',
    liveEnabled:process.env.LLMK_LIVE_ISSUANCE_ENABLED==='1',
    signingApproved:process.env.LLMK_SIGNATURE_FLOW_APPROVED==='1',
    legalApproved:process.env.LLMK_LEGAL_EN_PT_APPROVED==='1',
    uniquePendingIndexVerified:process.env.LLMK_UNIQUE_PENDING_INDEX_VERIFIED==='1'
  };
}
function validConfig(c) {
  return c.url.startsWith('https://') && Boolean(c.serviceKey) &&
    Boolean(c.agencyLegal&&c.agencyAddress&&c.agencyEmail&&c.governingState&&c.venue);
}
function clientFor(c) {
  return createClient(c.url,c.serviceKey,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{headers:{'X-Client-Info':'llmk-node-contracts-qa-v2'}}
  });
}

async function requireAdmin(req,res,next) {
  const c=config();
  if(!validConfig(c)) return res.status(503).json({error:'LLMK_BACKEND_CONFIGURATION_INCOMPLETE'});
  const authorization=req.headers.authorization||'';
  const m=/^Bearer\s+([^\s]+)$/.exec(authorization);
  if(!m) return res.status(401).json({error:'LLMK_SESSION_REQUIRED'});
  try{
    const db=clientFor(c);
    const {data:userData,error:userErr}=await db.auth.getUser(m[1]);
    if(userErr||!userData?.user?.id) return res.status(401).json({error:'LLMK_INVALID_SESSION'});
    const {data:admin,error:adminErr}=await db.from('llmk_admins')
      .select('user_id').eq('user_id',userData.user.id).maybeSingle();
    if(adminErr) return res.status(503).json({error:'LLMK_ADMIN_VALIDATION_UNAVAILABLE'});
    if(!admin) return res.status(403).json({error:'LLMK_ADMIN_REQUIRED'});
    req.llmk={db,adminId:userData.user.id,config:c};
    next();
  }catch(_e){
    console.error('LLMK admin authentication unavailable');
    return res.status(503).json({error:'LLMK_AUTH_UNAVAILABLE'});
  }
}

async function gatherContract(req,params){
  const {db,config:c}=req.llmk;
  const {data:row,error}=await db.from('llmk_clients')
    .select('id,company_name,contact_full_name,business_address,contact_email,preferred_contract_language')
    .eq('id',params.clientId).maybeSingle();
  if(error) throw Object.assign(new Error('LLMK_CLIENT_READ_UNAVAILABLE'),{http:503});
  if(!row) throw Object.assign(new Error('LLMK_CLIENT_NOT_FOUND'),{http:404});
  const language=s(row.preferred_contract_language||'en',5).toLowerCase();
  if(!['en','pt','es'].includes(language)) throw Object.assign(new Error('LLMK_CLIENT_LOCALE_INVALID'),{http:409});
  // The client identity and locale ALWAYS come from Supabase, never browser payload.
  const data={
    agency_legal_name:c.agencyLegal, agency_address:c.agencyAddress, agency_email:c.agencyEmail,
    client_legal_name:s(row.contact_full_name), client_business_name:s(row.company_name),
    client_address:s(row.business_address), client_email:s(row.contact_email,100),
    client_signer:s(row.contact_full_name),client_title:params.role,
    effective_date:params.date,service_location:params.place,timezone:params.tz,
    governing_state:c.governingState, venue:c.venue,plan:params.plan,deposit_enabled:params.depositEnabled
  };
  return {language,data};
}

function respondError(res,error){
  if(error instanceof ContractInputError) return res.status(422).json({error:'LLMK_INVALID_CONTRACT_DATA',detail:error.message});
  const code=error?.http||503;
  const message=/^LLMK_[A-Z_]+$/.test(error?.message||'')?error.message:'LLMK_CONTRACT_SERVICE_UNAVAILABLE';
  console.error('LLMK contract request failed:',message);
  return res.status(code).json({error:message});
}

export function createLLMKContractsRouter(){
  const router=express.Router();
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store, private');
    res.set('X-Content-Type-Options','nosniff');
    const origin=req.get('origin');
    if(origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({error:'LLMK_ORIGIN_NOT_ALLOWED'});
    next();
  });
  router.use(rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false,
    message:{error:'LLMK_RATE_LIMIT_EXCEEDED'}}));
  // Phase C: scoped QA PDF viewing by the authenticated test-company owner
  // or Media Kit admin. No signatures or user-identity bindings.
  registerSigningV2QaViewRoute(router,{clientFor});
  // C3: QA-only PDF presentation and simulated acknowledgement. No legal signature.
  registerSigningV2QaReviewRoutes(router,{clientFor});
  router.use(requireAdmin);

  router.get('/readiness', (_req,res)=>{
    const c=config();
    return res.json({ok:true,stage:'llmk-contracts-node-v2',
      previewEnabled:c.previewEnabled,
      issueEnabled:false,legacyIssueRetired:true,
      spanishLegalApproved:false,
      noPayments:true,noBooking:true,noSms:true,studentPortalUnchanged:true,
      note:'Read-only readiness. Does not render or issue a contract.'});
  });

  // SIGNATURE V2 / QA: admin-only read-only schema connectivity check.
  // Inherits no-store, origin filter, rate limit and requireAdmin above.
  // Does not create contracts, signatures, envelopes or events.
  router.get('/signing-v2/qa-readiness',async(req,res)=>{
    const {db,config:c}=req.llmk;
    if(c.liveEnabled || c.signingApproved) {
      return res.status(409).json({error:'LLMK_SIGNING_V2_QA_GUARD_NOT_CLOSED'});
    }
    const tables=[
      'llmk_signing_envelopes_v2',
      'llmk_signing_parties_v2',
      'llmk_signing_events_v2'
    ];
    const checked=[];
    for(const table of tables){
      const {error}=await db.from(table).select('id',{head:true,count:'exact'});
      if(error){
        console.error('LLMK_SIGNING_V2_QA_TABLE_UNAVAILABLE',table,error.code);
        return res.status(503).json({error:'LLMK_SIGNING_V2_QA_TABLE_UNAVAILABLE'});
      }
      checked.push(table);
    }
    return res.status(200).json({
      ok:true,
      stage:'llmk-signing-v2-qa-schema',
      tablesAccessible:checked,
      signingEnabled:false,
      liveIssuanceEnabled:false,
      readOnly:true
    });
  });

  // QA-only, admin-protected; disabled by default and restricted to one test company.
  registerSigningV2QaRoutes(router,{checkInput,gatherContract,createContractPdf,respondError});

  // Phase C2: QA test-operator assignment, never legal signer binding or consent.
  registerSigningV2QaOperatorRoutes(router);

  // C4: admin-only read-only QA evidence export.
  registerSigningV2QaCompletionRoutes(router);

  router.post('/preview',async(req,res)=>{
    const c=req.llmk.config;
    if(!c.previewEnabled) return res.status(409).json({error:'LLMK_PREVIEW_DISABLED'});
    try{
      const p=checkInput(req.body);
      const {language,data}=await gatherContract(req,p);
      const pdf=await createContractPdf(data,language,{preview:true});
      return res.status(200)
        .set('Content-Type','application/pdf')
        .set('Content-Disposition','inline; filename="LLMK_QA_preview.pdf"')
        .set('Access-Control-Expose-Headers','X-Document-SHA256,X-Contract-Language,X-Contract-Fingerprint')
        .set('X-Document-SHA256',pdf.sha256)
        .set('X-Contract-Language',pdf.language.toUpperCase())
        .set('X-Contract-Fingerprint',pdf.fingerprint)
        .send(pdf.bytes);
    }catch(e){return respondError(res,e)}
  });

  // D1A: legacy issuance never creates a multi-party envelope.
  // Retire it until the new production-only issuance route is implemented.
  router.post('/issue',(_req,res)=>{
    return res.status(409).json({error:'LLMK_LIVE_ISSUANCE_DISABLED'});
  });
  return router;
}
