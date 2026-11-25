/** C4: read-only QA export. Never signs, issues, updates or archives a contract. */
import crypto from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const VERSION='LLMK_QA_REVIEW_2026_11_v1';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=(code,http=409)=>Object.assign(new Error(code),{http});
const requireOk=(condition,code='LLMK_C4_QA_EVIDENCE_INVALID')=>{if(!condition)throw fail(code);};
const validDate=x=>typeof x==='string' && Number.isFinite(Date.parse(x));
export function qaCompletionEnabled(env){
  return env.LLMK_SIGNING_V2_QA_COMPLETION_ENABLED==='1' &&
    ['CREATE','VIEW','BIND','REVIEW'].every(k=>env[`LLMK_SIGNING_V2_QA_${k}_ENABLED`]==='0') &&
    env.LLMK_LIVE_ISSUANCE_ENABLED==='0' && env.LLMK_SIGNATURE_FLOW_APPROVED==='0';
}
// All source IDs and timestamps are read from protected server tables, never browser input.
export function buildEvidence({e,c,parties,operators,acks,presentations,clientId}){
  requireOk(e?.environment==='qa' && e.status==='qa_draft' && e.required_party_count===3 &&
    e.completed_at===null && e.final_pdf_storage_path===null && e.final_pdf_sha256===null &&
    UUID.test(e.id||'') && UUID.test(c?.id||'') && e.contract_id===c.id && c.client_id===clientId &&
    c.status==='draft' && c.signed_at===null && c.generation_source==='qa_signing_v2_node' &&
    c.contract_snapshot?.qa_not_for_signature===true && c.contract_snapshot?.llmk_signing_v2_qa===true &&
    HASH.test(c.document_sha256||'') && e.source_document_sha256===c.document_sha256 &&
    ['en','pt'].includes(c.contract_language) && typeof c.contract_version==='string' &&
    /^[A-Za-z0-9_. -]{1,64}$/.test(c.contract_version) && validDate(c.created_at), 'LLMK_C4_QA_SOURCE_INVALID');
  requireOk(Array.isArray(parties)&&Array.isArray(operators)&&Array.isArray(acks)&&Array.isArray(presentations)&&
    parties.length===3 && operators.length===3 && acks.length===3,'LLMK_C4_QA_NOT_COMPLETE');
  requireOk(new Set(operators.map(x=>x.operator_user_id)).size===3 && new Set(acks.map(x=>x.id)).size===3 &&
    new Set(acks.map(x=>x.presentation_id)).size===3);
  const entries=[1,2,3].map(slot=>{
    const p=parties.find(x=>x.signer_slot===slot), o=operators.find(x=>x.signer_slot===slot), a=acks.find(x=>x.signer_slot===slot);
    const r=presentations.find(x=>x.id===a?.presentation_id);
    requireOk(p && o && a && r && [p,o,a,r].every(x=>x.envelope_id===e.id) &&
      [p.id,o.operator_user_id,a.id,r.id].every(x=>UUID.test(x||'')) &&
      p.status==='pending' && p.signer_user_id===null && p.signed_at===null &&
      p.read_and_accept_confirmed===false && p.electronic_records_consent===false &&
      o.assignment_kind==='qa_simulator' && o.not_for_signature===true && o.party_id===p.id &&
      a.party_id===p.id && r.party_id===p.id && r.signer_slot===slot &&
      a.operator_user_id===o.operator_user_id && r.operator_user_id===o.operator_user_id &&
      a.document_sha256===c.document_sha256 && r.document_sha256===c.document_sha256 &&
      a.acknowledgement_version===VERSION && a.qa_test_confirmation===true &&
      a.not_a_signature===true && a.not_legal_consent===true && r.not_for_signature===true &&
      r.context==='qa_pdf_delivered' && validDate(r.presented_at) && validDate(a.confirmed_at) &&
      Date.parse(a.confirmed_at)>=Date.parse(r.presented_at) &&
      Date.parse(a.confirmed_at)-Date.parse(r.presented_at)<=3600000);
    return {slot,partyId:p.id,qaOperatorUserId:o.operator_user_id,presentationId:r.id,
      presentedAt:new Date(r.presented_at).toISOString(),acknowledgementId:a.id,
      confirmedAt:new Date(a.confirmed_at).toISOString(),acknowledgementVersion:VERSION,
      notASignature:true,notLegalConsent:true};
  });
  return {schema:'LLMK_QA_COMPLETION_V1',environment:'qa',notForSignature:true,
    legalSignature:false,legalConsent:false,originalPartiesUnchanged:true,
    envelopeId:e.id,contractId:c.id,contractLanguage:c.contract_language,contractVersion:c.contract_version,
    originalDocumentSha256:c.document_sha256,originalContractCreatedAt:new Date(c.created_at).toISOString(),
    latestQaConfirmationAt:entries.map(x=>x.confirmedAt).sort().at(-1),entries};
}
async function query(db,table,fields,key,value,many=false){
  let q=db.from(table).select(fields).eq(key,value);
  const {data,error}=await (many?q:q.maybeSingle());
  if(error)throw fail('LLMK_C4_QA_READ_UNAVAILABLE',503);
  return data;
}
async function load(db,envId,clientId){
  const e=await query(db,'llmk_signing_envelopes_v2','id,contract_id,environment,status,required_party_count,source_document_sha256,completed_at,final_pdf_storage_path,final_pdf_sha256','id',envId);
  if(!e || e.environment!=='qa'||e.status!=='qa_draft')throw fail('LLMK_C4_QA_NOT_FOUND',404);
  const c=await query(db,'llmk_contracts','id,client_id,status,signed_at,generation_source,contract_snapshot,document_sha256,contract_language,contract_version,created_at,storage_path','id',e.contract_id);
  if(!c || c.client_id!==clientId || !new RegExp('^'+clientId+'/qa-signing-v2/[0-9a-f-]{36}\\.pdf$','i').test(c.storage_path||''))throw fail('LLMK_C4_QA_NOT_FOUND',404);
  const [parties,operators,acks]=await Promise.all([
    query(db,'llmk_signing_parties_v2','id,envelope_id,signer_slot,status,signer_user_id,signed_at,read_and_accept_confirmed,electronic_records_consent','envelope_id',envId,true),
    query(db,'llmk_signing_qa_operators_v2','envelope_id,party_id,signer_slot,operator_user_id,assignment_kind,not_for_signature','envelope_id',envId,true),
    query(db,'llmk_signing_qa_acknowledgements_v2','id,envelope_id,party_id,signer_slot,operator_user_id,presentation_id,document_sha256,acknowledgement_version,qa_test_confirmation,not_a_signature,not_legal_consent,confirmed_at','envelope_id',envId,true)
  ]);
  requireOk(Array.isArray(acks)&&acks.length===3,'LLMK_C4_QA_NOT_COMPLETE');
  // Only the three linked presentation receipts, not all attempts.
  const presentations=await Promise.all(acks.map(a=>query(db,'llmk_signing_qa_presentations_v2','id,envelope_id,party_id,signer_slot,operator_user_id,document_sha256,presented_at,context,not_for_signature','id',a.presentation_id)));
  const evidence=buildEvidence({e,c,parties,operators,acks,presentations:presentations.filter(Boolean),clientId});
  const {data:blob,error}=await db.storage.from('llmk-contracts').download(c.storage_path);
  if(error||!blob)throw fail('LLMK_C4_QA_STORAGE_UNAVAILABLE',503);
  const source=Buffer.from(await blob.arrayBuffer());
  if(!source.length||source.length>10*1024*1024||sha(source)!==evidence.originalDocumentSha256)throw fail('LLMK_C4_QA_INTEGRITY_FAILURE',503);
  const manifest=Buffer.from(JSON.stringify(evidence),'utf8');
  return {source,evidence,manifest,manifestSha:sha(manifest)};
}
// Make a NEW PDF with the source pages and a clearly marked evidence appendix.
// Never upload it over the original or populate production final-PDF columns.
export async function renderQaCompletion({source,evidence,manifestSha}){
  const {PDFDocument,StandardFonts,rgb}=await import('pdf-lib');
  const original=await PDFDocument.load(source);
  if(original.getPageCount()!==8)throw fail('LLMK_C4_QA_PAGE_COUNT_UNEXPECTED',503);
  const out=await PDFDocument.create();
  for(const page of await out.copyPages(original,original.getPageIndices()))out.addPage(page);
  const font=await out.embedFont(StandardFonts.Helvetica), bold=await out.embedFont(StandardFonts.HelveticaBold);
  const ink=rgb(.094,.137,.231), copper=rgb(.59,.34,.19), muted=rgb(.32,.35,.4);
  const page=out.addPage([612,792]);
  let y=754;
  const line=(s,size=10,strong=false,color=ink)=>{
    const f=strong?bold:font;
    if(f.widthOfTextAtSize(s,size)>516 || y<46)throw fail('LLMK_C4_QA_REPORT_LAYOUT_FAILURE',503);
    page.drawText(s,{x:48,y,size,font:f,color});y-=size+5;
  };
  line('LL BROWS MEDIA KIT',11,true,copper); y-=5;
  line('QA COMPLETION / CONCLUSAO DE TESTE',18,true);
  line('NOT A SIGNATURE / NAO E UMA ASSINATURA',12,true,copper);
  line('Simulation only. No legal consent or signature recorded.',10,true);
  line('Original PDF is preserved separately. This is a derived copy.',10,false,muted); y-=9;
  line('Envelope: '+evidence.envelopeId,10);
  line('Contract: '+evidence.contractId,10);
  line('Version: '+evidence.contractVersion+' | Language: '+evidence.contractLanguage.toUpperCase(),10);
  line('Original PDF SHA-256:',10,true);line(evidence.originalDocumentSha256,9);
  line('Evidence JSON SHA-256:',10,true);line(manifestSha,9); y-=8;
  for(const a of evidence.entries){
    line('QA OPERATOR SLOT '+a.slot+' / SIMULATED ACKNOWLEDGEMENT',11,true,copper);
    line('Operator UID: '+a.qaOperatorUserId,9);
    line('Presentation: '+a.presentationId,9);
    line('Delivered (UTC): '+a.presentedAt,9);
    line('Acknowledgement: '+a.acknowledgementId,9);
    line('Confirmed (UTC): '+a.confirmedAt,9); y-=7;
  }
  line('Delivery receipt is not proof that every page was read.',9,false,muted);
  line('QA PREVIEW - NOT FOR SIGNATURE',11,true,copper);
  out.setTitle('LLMK QA completion - not for signature');
  out.setSubject('Simulated acknowledgement evidence only');
  return Buffer.from(await out.save());
}
export function registerSigningV2QaCompletionRoutes(router,{render=renderQaCompletion}={}){
  const handler=format=>async(req,res)=>{
    if(!qaCompletionEnabled(process.env))return res.status(409).json({error:'LLMK_C4_QA_COMPLETION_DISABLED'});
    const allowed=(process.env.LLMK_SIGNING_V2_QA_CLIENT_ID||'').trim(), id=req.params.envelopeId;
    if(!UUID.test(allowed)||!UUID.test(id))return res.status(404).json({error:'LLMK_C4_QA_NOT_FOUND'});
    try{
      const bundle=await load(req.llmk.db,id,allowed); // requireAdmin already ran
      if(format==='json')return res.status(200).set('Content-Type','application/json; charset=utf-8')
        .set('Content-Disposition','attachment; filename="LLMK_QA_EVIDENCE.json"')
        .set('Access-Control-Expose-Headers','X-LLMK-Evidence-SHA256')
        .set('X-LLMK-Evidence-SHA256',bundle.manifestSha).send(bundle.manifest);
      const bytes=await render(bundle);
      return res.status(200).set('Content-Type','application/pdf')
        .set('Content-Disposition','attachment; filename="LLMK_QA_COMPLETION_NOT_FOR_SIGNATURE.pdf"')
        .set('Content-Security-Policy','sandbox')
        .set('Access-Control-Expose-Headers','X-LLMK-Evidence-SHA256,X-LLMK-Export-SHA256')
        .set('X-LLMK-Evidence-SHA256',bundle.manifestSha)
        .set('X-LLMK-Export-SHA256',sha(bytes)).send(bytes);
    }catch(error){
      const http=[404,409].includes(error?.http)?error.http:503;
      if(http===503)console.error('LLMK_C4_QA_EXPORT_FAILED',/^LLMK_[A-Z0-9_]+$/.test(error?.message||'')?error.message:'internal');
      return res.status(http).json({error:http===503?'LLMK_C4_QA_EXPORT_UNAVAILABLE':error.message});
    }
  };
  router.get('/signing-v2/qa-completion/:envelopeId',handler('pdf'));
  router.get('/signing-v2/qa-completion-evidence/:envelopeId',handler('json'));
}
