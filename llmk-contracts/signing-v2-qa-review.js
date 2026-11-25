/**
 * LL Brows Media Kit | Signature V2 Phase C3 / QA PDF review and simulated ack.
 * NEVER changes legal parties, signer_user_id, consents, signatures or contract status.
 * Routes mounted BEFORE admin middleware: each authenticates the caller server-side.
 */
import crypto from 'node:crypto';

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE=/^[0-9a-f]{64}$/;
const ACK_VERSION='LLMK_QA_REVIEW_2026_11_v1';
const CONFIRM='QA_SIMULATION_ONLY_NO_LEGAL_SIGNATURE_OR_CONSENT';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const missing=res=>res.status(404).json({error:'LLMK_C3_QA_NOT_FOUND'});
const fail=(code,http=503)=>Object.assign(new Error(code),{http});

export function qaReviewEnabled(env) {
  return env.LLMK_SIGNING_V2_QA_REVIEW_ENABLED==='1' &&
    env.LLMK_SIGNING_V2_QA_CREATE_ENABLED!=='1' &&
    env.LLMK_SIGNING_V2_QA_VIEW_ENABLED!=='1' &&
    env.LLMK_SIGNING_V2_QA_BIND_ENABLED!=='1' &&
    env.LLMK_LIVE_ISSUANCE_ENABLED!=='1' &&
    env.LLMK_SIGNATURE_FLOW_APPROVED!=='1';
}

async function context(req,{clientFor,adminOnly=false}) {
  const clientId=(process.env.LLMK_SIGNING_V2_QA_CLIENT_ID||'').trim();
  const envelopeId=req.params.envelopeId;
  if (!UUID_RE.test(clientId)||!UUID_RE.test(envelopeId)) throw fail('LLMK_C3_QA_NOT_FOUND',404);
  const match=/^Bearer\s+([^\s]+)$/.exec(req.headers.authorization||'');
  if(!match) throw fail('LLMK_SESSION_REQUIRED',401);
  const url=process.env.LLMK_SUPABASE_URL||'';
  const serviceKey=process.env.LLMK_SUPABASE_SERVICE_ROLE_KEY||'';
  if(!/^https:\/\/.+\.supabase\.co\/?$/.test(url) || !serviceKey)
    throw fail('LLMK_C3_QA_BACKEND_UNAVAILABLE');
  const db=clientFor({url,serviceKey});
  const {data:ud,error:ue}=await db.auth.getUser(match[1]);
  if(ue||!ud?.user?.id) throw fail('LLMK_INVALID_SESSION',401);
  const userId=ud.user.id;
  if(adminOnly) {
    const {data:a,error:ae}=await db.from('llmk_admins')
      .select('user_id').eq('user_id',userId).maybeSingle();
    if(ae)throw fail('LLMK_C3_QA_ADMIN_LOOKUP_UNAVAILABLE');
    if(!a)throw fail('LLMK_C3_QA_ADMIN_REQUIRED',403);
  }
  const {data:e,error:ee}=await db.from('llmk_signing_envelopes_v2')
    .select('id,contract_id,environment,status,source_document_sha256,required_party_count')
    .eq('id',envelopeId).maybeSingle();
  if(ee)throw fail('LLMK_C3_QA_ENVELOPE_LOOKUP_UNAVAILABLE');
  if(!e||e.environment!=='qa'||e.status!=='qa_draft'||e.required_party_count!==3)
    throw fail('LLMK_C3_QA_NOT_FOUND',404);
  const {data:c,error:ce}=await db.from('llmk_contracts')
    .select('id,client_id,status,generation_source,document_sha256,storage_path,contract_snapshot')
    .eq('id',e.contract_id).maybeSingle();
  if(ce)throw fail('LLMK_C3_QA_CONTRACT_LOOKUP_UNAVAILABLE');
  if(!c||c.client_id!==clientId||c.status!=='draft'||
    c.generation_source!=='qa_signing_v2_node'||
    c.contract_snapshot?.qa_not_for_signature!==true||
    c.contract_snapshot?.llmk_signing_v2_qa!==true||
    !HASH_RE.test(c.document_sha256||'')||
    c.document_sha256!==e.source_document_sha256||
    !new RegExp('^'+clientId+'/qa-signing-v2/[0-9a-f-]{36}\\.pdf$','i').test(c.storage_path||''))
    throw fail('LLMK_C3_QA_NOT_FOUND',404);
  const {data:parties,error:pe}=await db.from('llmk_signing_parties_v2')
    .select('id,signer_slot,status,signer_user_id,signed_at,read_and_accept_confirmed,electronic_records_consent')
    .eq('envelope_id',envelopeId).order('signer_slot');
  if(pe)throw fail('LLMK_C3_QA_PARTY_LOOKUP_UNAVAILABLE');
  if(parties?.length!==3 || parties.some((p,i)=>
    p.signer_slot!==i+1||p.status!=='pending'||p.signer_user_id!==null||
    p.signed_at!==null||p.read_and_accept_confirmed!==false||
    p.electronic_records_consent!==false))throw fail('LLMK_C3_QA_REAL_PARTIES_CHANGED',409);
  if(!adminOnly) {
    const {data:operator,error:oe}=await db.from('llmk_signing_qa_operators_v2')
      .select('party_id,signer_slot,assignment_kind,not_for_signature')
      .eq('envelope_id',envelopeId).eq('operator_user_id',userId).maybeSingle();
    if(oe)throw fail('LLMK_C3_QA_OPERATOR_LOOKUP_UNAVAILABLE');
    if(!operator||operator.assignment_kind!=='qa_simulator'||
      operator.not_for_signature!==true||
      !parties.some(p=>p.id===operator.party_id&&p.signer_slot===operator.signer_slot))
      throw fail('LLMK_C3_QA_NOT_FOUND',404);
  }
  return {db,userId,envelopeId,c,e};
}

function errorReply(res,e) {
  const http=[401,403,404,409].includes(e?.http)?e.http:503;
  if(http===404)return missing(res);
  if(http===503)console.error('LLMK_C3_QA_REQUEST_FAILED',e?.message||'unknown');
  const code=http===503?'LLMK_C3_QA_SERVICE_UNAVAILABLE':e.message;
  return res.status(http).json({error:code});
}

export function registerSigningV2QaReviewRoutes(router,{clientFor}) {
  // PDF delivery creates a QA presentation receipt only AFTER the backend
  // verifies the exact bytes, user mapping and QA-only envelope.
  router.get('/signing-v2/qa-review-document/:envelopeId',async(req,res)=>{
    if(!qaReviewEnabled(process.env))
      return res.status(409).json({error:'LLMK_C3_QA_REVIEW_DISABLED'});
    try {
      const ctx=await context(req,{clientFor});
      const {data:blob,error:be}=await ctx.db.storage.from('llmk-contracts').download(ctx.c.storage_path);
      if(be||!blob)throw fail('LLMK_C3_QA_STORAGE_UNAVAILABLE');
      const bytes=Buffer.from(await blob.arrayBuffer());
      if(!bytes.length || bytes.length>10*1024*1024 || digest(bytes)!==ctx.c.document_sha256)
        throw fail('LLMK_C3_QA_PDF_INTEGRITY_FAILURE');
      const {data:r,error:re}=await ctx.db.rpc('llmk_v2_qa_record_presentation',{
        p_envelope_id:ctx.envelopeId,p_actor_user_id:ctx.userId,
        p_document_sha256:ctx.c.document_sha256
      });
      if(re || !UUID_RE.test(r?.presentation_id)){
        console.error('LLMK_C3_QA_PRESENTATION_RPC_FAILED',re?.code||'invalid_result');
        throw fail('LLMK_C3_QA_PRESENTATION_UNAVAILABLE');
      }
      return res.status(200)
        .set('Content-Type','application/pdf')
        .set('Content-Disposition','attachment; filename="LLMK_QA_REVIEW_ONLY.pdf"')
        .set('Content-Security-Policy','sandbox')
        .set('Access-Control-Expose-Headers','X-LLMK-QA-Presentation-Id,X-LLMK-QA-Document-SHA256')
        .set('X-LLMK-QA-Presentation-Id',r.presentation_id)
        .set('X-LLMK-QA-Document-SHA256',ctx.c.document_sha256)
        .send(bytes);
    } catch(e){return errorReply(res,e)}
  });

  // Acknowledgement is explicitly QA simulation, NOT legal electronic consent.
  router.post('/signing-v2/qa-acknowledge/:envelopeId',async(req,res)=>{
    if(!qaReviewEnabled(process.env))
      return res.status(409).json({error:'LLMK_C3_QA_REVIEW_DISABLED'});
    const b=req.body;
    if(!b||typeof b!=='object'||Array.isArray(b)||
      !UUID_RE.test(b.presentation_id||'')||!HASH_RE.test(b.document_sha256||'')||
      b.qa_acknowledgement_version!==ACK_VERSION||b.qa_confirmation!==CONFIRM||
      b.qa_test_confirmation!==true)
      return res.status(422).json({error:'LLMK_C3_QA_CONFIRMATION_REQUIRED'});
    try {
      const ctx=await context(req,{clientFor});
      if(b.document_sha256!==ctx.c.document_sha256)
        return res.status(409).json({error:'LLMK_C3_QA_DOCUMENT_CHANGED'});
      const {data:r,error:re}=await ctx.db.rpc('llmk_v2_qa_record_acknowledgement',{
        p_envelope_id:ctx.envelopeId,
        p_actor_user_id:ctx.userId,
        p_presentation_id:b.presentation_id,
        p_document_sha256:b.document_sha256,
        p_acknowledgement_version:ACK_VERSION,
        p_qa_test_confirmation:true
      });
      if(re){
        if(re.code==='23505')return res.status(409).json({error:'LLMK_C3_QA_ALREADY_ACKNOWLEDGED'});
        if(re.code==='P0001')return res.status(409).json({error:'LLMK_C3_QA_ACK_REJECTED'});
        console.error('LLMK_C3_QA_ACK_RPC_FAILED',re.code);
        throw fail('LLMK_C3_QA_ACK_UNAVAILABLE');
      }
      if(!UUID_RE.test(r?.acknowledgement_id)||r?.not_a_signature!==true||
        r?.legal_consent_recorded!==false)
        throw fail('LLMK_C3_QA_ACK_RESULT_INVALID');
      return res.status(201).json({ok:true,qa:true,
        acknowledgementId:r.acknowledgement_id,operatorSlot:r.signer_slot,
        notASignature:true,legalConsentRecorded:false});
    } catch(e){return errorReply(res,e)}
  });

  // Admin-only and read-only. Works after QA flag is switched back to 0.
  router.get('/signing-v2/qa-review-status/:envelopeId',async(req,res)=>{
    if(process.env.LLMK_LIVE_ISSUANCE_ENABLED==='1'||
       process.env.LLMK_SIGNATURE_FLOW_APPROVED==='1')
      return res.status(409).json({error:'LLMK_C3_QA_STATUS_DISABLED'});
    try {
      const ctx=await context(req,{clientFor,adminOnly:true});
      const {data:acks,error:ae}=await ctx.db.from('llmk_signing_qa_acknowledgements_v2')
        .select('signer_slot,not_a_signature,not_legal_consent,qa_test_confirmation')
        .eq('envelope_id',ctx.envelopeId).order('signer_slot');
      if(ae)throw fail('LLMK_C3_QA_STATUS_UNAVAILABLE');
      return res.status(200).json({ok:true,qa:true,envelopeId:ctx.envelopeId,
        simulatedAcknowledgements:acks.length,
        slots:acks.map(x=>x.signer_slot),
        allQaOnly:acks.every(x=>x.not_a_signature===true&&
          x.not_legal_consent===true&&x.qa_test_confirmation===true),
        legalSignaturesCreated:false,legalConsentsRecorded:false,
        originalPartiesUnchanged:true});
    } catch(e){return errorReply(res,e)}
  });
}
