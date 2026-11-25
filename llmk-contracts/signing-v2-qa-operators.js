/**
 * LL Brows Media Kit | Signature V2 Phase C2 — QA operator mapping.
 * It NEVER writes to signer_user_id, captures consent or signs a contract.
 * Both routes inherit the LL Media Kit requireAdmin middleware.
 */
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIRM='MAP_QA_OPERATORS_NO_LEGAL_SIGNATURE';
const reply404=res=>res.status(404).json({error:'LLMK_C2_QA_ENVELOPE_NOT_FOUND'});

async function qaEnvelope(db,envelopeId,clientId) {
  const {data:e,error:ee}=await db.from('llmk_signing_envelopes_v2')
    .select('id,contract_id,environment,status,source_document_sha256')
    .eq('id',envelopeId).maybeSingle();
  if(ee) throw new Error('envelope_read_unavailable');
  if(!e || e.environment!=='qa' || e.status!=='qa_draft') return false;
  const {data:c,error:ce}=await db.from('llmk_contracts')
    .select('id,client_id,status,generation_source,document_sha256,contract_snapshot')
    .eq('id',e.contract_id).maybeSingle();
  if(ce) throw new Error('contract_read_unavailable');
  return Boolean(c && c.client_id===clientId && c.status==='draft' &&
    c.generation_source==='qa_signing_v2_node' &&
    c.contract_snapshot?.qa_not_for_signature===true &&
    c.contract_snapshot?.llmk_signing_v2_qa===true &&
    c.document_sha256===e.source_document_sha256);
}

export function registerSigningV2QaOperatorRoutes(router) {
  router.post('/signing-v2/qa-bind-operators/:envelopeId',async(req,res)=>{
    const {db,config:c,adminId}=req.llmk;
    if(process.env.LLMK_SIGNING_V2_QA_BIND_ENABLED!=='1' ||
       process.env.LLMK_SIGNING_V2_QA_CREATE_ENABLED==='1' ||
       process.env.LLMK_SIGNING_V2_QA_VIEW_ENABLED==='1' ||
       c.liveEnabled || c.signingApproved) {
      return res.status(409).json({error:'LLMK_C2_QA_BIND_DISABLED'});
    }
    if(req.body?.qa_confirmation!==CONFIRM) {
      return res.status(422).json({error:'LLMK_C2_EXPLICIT_QA_CONFIRMATION_REQUIRED'});
    }
    const allowed=(process.env.LLMK_SIGNING_V2_QA_CLIENT_ID||'').trim();
    const slot2=(process.env.LLMK_SIGNING_V2_QA_OPERATOR_SLOT2_ID||'').trim();
    const slot3=(process.env.LLMK_SIGNING_V2_QA_OPERATOR_SLOT3_ID||'').trim();
    const envelopeId=req.params.envelopeId;
    if(!UUID_RE.test(allowed)||!UUID_RE.test(slot2)||!UUID_RE.test(slot3)||
       slot2===slot3) {
      return res.status(503).json({error:'LLMK_C2_QA_ALLOWLIST_NOT_CONFIGURED'});
    }
    if(!UUID_RE.test(envelopeId)) return reply404(res);
    try{
      if(!await qaEnvelope(db,envelopeId,allowed)) return reply404(res);
      const {data,error}=await db.rpc('llmk_v2_qa_register_operators',{
        p_envelope_id:envelopeId,
        p_actor_user_id:adminId,
        p_slot2_operator_user_id:slot2,
        p_slot3_operator_user_id:slot3
      });
      if(error){
        // Do not expose raw database errors or personal identifiers to browsers.
        console.error('LLMK_C2_QA_BIND_FAILED',error.code);
        const alreadyBound=error.code==='23505' ||
          (error.code==='P0001' &&
           String(error.message||'').includes('LLMK_C2_QA_OPERATORS_ALREADY_REGISTERED'));
        return res.status(alreadyBound?409:503)
          .json({error:alreadyBound?'LLMK_C2_QA_ALREADY_BOUND':'LLMK_C2_QA_BIND_UNAVAILABLE'});
      }
      if(data?.assigned_count!==3 || data?.signatures_created!==false ||
         data?.real_signers_bound!==false || data?.not_for_signature!==true) {
        console.error('LLMK_C2_QA_BIND_UNEXPECTED_RESULT');
        return res.status(503).json({error:'LLMK_C2_QA_BIND_RESULT_UNVERIFIED'});
      }
      return res.status(201).json({ok:true,qa:true,envelopeId,
        operatorAssignments:3,realSignersBound:false,
        signaturesCreated:false,consentsRecorded:false});
    }catch(err){
      console.error('LLMK_C2_QA_BIND_READ_FAILED',err.message);
      return res.status(503).json({error:'LLMK_C2_QA_UNAVAILABLE'});
    }
  });

  // Read-only admin verification, available even after disabling the QA bind flag.
  router.get('/signing-v2/qa-operators/:envelopeId',async(req,res)=>{
    const {db,config:c}=req.llmk;
    if(c.liveEnabled || c.signingApproved) {
      return res.status(409).json({error:'LLMK_C2_QA_GUARD_NOT_CLOSED'});
    }
    const allowed=(process.env.LLMK_SIGNING_V2_QA_CLIENT_ID||'').trim();
    const envelopeId=req.params.envelopeId;
    if(!UUID_RE.test(allowed)||!UUID_RE.test(envelopeId)) return reply404(res);
    try{
      if(!await qaEnvelope(db,envelopeId,allowed)) return reply404(res);
      const {data:rows,error}=await db.from('llmk_signing_qa_operators_v2')
        .select('signer_slot,assignment_kind,not_for_signature')
        .eq('envelope_id',envelopeId).order('signer_slot');
      if(error) throw new Error('mapping_read_unavailable');
      const {data:parties,error:partyErr}=await db.from('llmk_signing_parties_v2')
        .select('signer_slot,status,signer_user_id,signed_at,read_and_accept_confirmed,electronic_records_consent')
        .eq('envelope_id',envelopeId).order('signer_slot');
      if(partyErr) throw new Error('parties_read_unavailable');
      const partiesUntouched=parties?.length===3 && parties.every((x,i)=>
        x.signer_slot===i+1 && x.status==='pending' &&
        x.signer_user_id===null && x.signed_at===null &&
        x.read_and_accept_confirmed===false &&
        x.electronic_records_consent===false);
      if(!partiesUntouched) return res.status(409).json({error:'LLMK_C2_QA_PARTY_STATE_CHANGED'});
      const valid=rows?.length===3 &&
        rows.every((x,i)=>x.signer_slot===i+1 &&
          x.assignment_kind==='qa_simulator' && x.not_for_signature===true);
      return res.status(200).json({ok:true,qa:true,envelopeId,
        operatorAssignments:rows?.length||0,slots:(rows||[]).map(x=>x.signer_slot),
        assignmentsValid:Boolean(valid),realSignersBound:false,
        signaturesCreated:false,consentsRecorded:false});
    }catch(err){
      console.error('LLMK_C2_QA_STATUS_FAILED',err.message);
      return res.status(503).json({error:'LLMK_C2_QA_STATUS_UNAVAILABLE'});
    }
  });
}
