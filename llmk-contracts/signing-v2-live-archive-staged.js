/** D2 staged, admin-only issuance and archive. No operation is reachable while D1C liveGate is false. */
import crypto from 'node:crypto';
import {liveGate,recentAuth} from './signing-v2-live-staged.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const failure=(message,http=409)=>Object.assign(new Error(message),{http});
const requireOk=(v)=>{if(!v)throw failure('LLMK_D2_NOT_ALLOWED');};
async function one(db,table,fields,filters){let q=db.from(table).select(fields);for(const [k,v] of Object.entries(filters))q=q.eq(k,v);const {data,error}=await q.maybeSingle();if(error)throw failure('LLMK_D2_UNAVAILABLE',503);return data;}
async function call(db,name,args){const {data,error}=await db.rpc(name,args);if(error){if(error.code==='23505')throw failure('LLMK_D2_CONFLICT');if(error.code==='P0001')throw failure('LLMK_D2_NOT_ALLOWED');throw failure('LLMK_D2_UNAVAILABLE',503);}if(!data||typeof data!=='object')throw failure('LLMK_D2_UNAVAILABLE',503);return data;}
async function readPdfOrEvidence(bucket,path,hash,max=10*1024*1024){const {data,error}=await bucket.download(path);if(error||!data)throw failure('LLMK_D2_STORAGE_UNAVAILABLE',503);const bytes=Buffer.from(await data.arrayBuffer());if(!bytes.length||bytes.length>max||sha(bytes)!==hash)throw failure('LLMK_D2_INTEGRITY_FAILURE',503);return bytes;}
async function store(bucket,path,bytes,type,uploaded){const {error}=await bucket.upload(path,bytes,{contentType:type,upsert:false,cacheControl:'0'});if(error)throw failure('LLMK_D2_STORAGE_UNAVAILABLE',503);uploaded.push(path);await readPdfOrEvidence(bucket,path,sha(bytes));}
// Never delete objects on an ambiguous RPC result. Reconcile privately before retry.
async function cleanupBeforeRpc(bucket,paths){if(!paths.length)return;try{const {error}=await bucket.remove(paths);if(error)console.error('LLMK_D2_ORPHAN_RECONCILIATION_REQUIRED');}catch{console.error('LLMK_D2_ORPHAN_RECONCILIATION_REQUIRED');}}
function requireRecent(req){const token=/^Bearer\s+([^\s]+)$/.exec(req.headers.authorization||'')?.[1];if(!token||!recentAuth(token,req.llmk.adminId))throw failure('LLMK_D2_RECENT_AUTH_REQUIRED');}
async function prepareIssue(req,{checkInput,createContractPdf},preview){
 const {db,config:c}=req.llmk,b=req.body;
 requireOk(b&&typeof b==='object'&&!Array.isArray(b)&&UUID.test(b.client_id||''));
 const cp=await one(db,'llmk_clients','id,owner_id,company_name,preferred_contract_language',{id:b.client_id});
 const ci=await one(db,'llmk_live_client_identity_v2','client_id,signer_user_id,legal_entity_name,signer_name,signer_title,legal_address,notice_email,verified_at,revoked_at',{client_id:b.client_id});
 const excluded=await one(db,'llmk_live_excluded_clients_v2','client_id',{client_id:b.client_id});
 requireOk(cp&&ci&&!excluded&&ci.revoked_at===null&&Date.parse(ci.verified_at)<=Date.now()&&ci.signer_user_id===cp.owner_id);
 // Never take legal identity, title or language from browser input.
 const p=checkInput({...b,client_title:ci.signer_title});
 const language=cp.preferred_contract_language;
 requireOk(['en','pt'].includes(language));
 const data={agency_legal_name:c.agencyLegal,agency_address:c.agencyAddress,agency_email:c.agencyEmail,governing_state:c.governingState,venue:c.venue,client_legal_name:ci.legal_entity_name,client_business_name:cp.company_name,client_address:ci.legal_address,client_email:ci.notice_email,client_signer:ci.signer_name,client_title:ci.signer_title,effective_date:p.date,service_location:p.place,timezone:p.tz,plan:p.plan,deposit_enabled:p.depositEnabled};
 const pdf=await createContractPdf(data,language,{preview});
 requireOk(pdf.language===language&&HASH.test(pdf.sha256)&&sha(pdf.bytes)===pdf.sha256&&HASH.test(pdf.fingerprint));
 const ap=await one(db,'llmk_live_template_approval_v2','agency_legal_name,agency_address,agency_email,governing_state,venue,approved_at,revoked_at',{contract_language:language,contract_version:pdf.templateVersion,template_sha256:pdf.snapshot.template_sha256});
 requireOk(ap&&ap.revoked_at===null&&Date.parse(ap.approved_at)<=Date.now()&&['agency_legal_name','agency_address','agency_email','governing_state','venue'].every(k=>ap[k]===pdf.snapshot[k]));
 const {data:consents,error}=await db.from('llmk_live_consent_versions_v2').select('consent_text,consent_sha256,approved_at').eq('contract_language',language).eq('contract_version',pdf.templateVersion).eq('template_sha256',pdf.snapshot.template_sha256).is('revoked_at',null);
 if(error)throw failure('LLMK_D2_UNAVAILABLE',503);
 requireOk(consents?.length===1&&Date.parse(consents[0].approved_at)<=Date.now()&&typeof consents[0].consent_text==='string'&&sha(Buffer.from(consents[0].consent_text,'utf8'))===consents[0].consent_sha256);
 return {p,pdf,language};
}
export function parseArchiveContext(x,envelopeId){
 requireOk(x&&UUID.test(x.client_id||'')&&UUID.test(x.contract_id||'')&&HASH.test(x.source_sha256||'')&&typeof x.source_path==='string'&&x.source_path.startsWith(`${x.client_id}/live-signing-v2/`)&&UUID.test(x.source_path.split('/').at(-1).replace(/\.pdf$/,''))&&x.source_path.split('/').length===3&&x.source_path.endsWith('.pdf')&&typeof x.evidence_text==='string'&&x.evidence_text.length<100000);
 const evidence=JSON.parse(x.evidence_text);
 requireOk(evidence.schema==='LLMK_LIVE_ARCHIVE_V1'&&evidence.environment==='production'&&evidence.envelopeId===envelopeId&&evidence.contractId===x.contract_id&&evidence.sourceSha256===x.source_sha256&&['en','pt'].includes(evidence.language)&&Array.isArray(evidence.entries)&&evidence.entries.length===3);
 requireOk(new Set(evidence.entries.map(a=>a.signerUserId)).size===3&&evidence.entries.every((a,i)=>a.slot===i+1&&a.role===(i===0?'client':'agency')&&UUID.test(a.signerUserId||'')&&UUID.test(a.partyId||'')&&typeof a.typedName==='string'&&a.typedName.length>=2&&a.typedName.length<=145&&Number.isFinite(Date.parse(a.signedAt))&&a.readAndAccept===true&&a.electronicRecordsConsent===true&&typeof a.consentText==='string'&&sha(Buffer.from(a.consentText,'utf8'))===a.consentSha256));
 return {evidence,manifest:Buffer.from(x.evidence_text,'utf8')};
}
export async function renderArchive(source,evidence,manifestHash){
 const {PDFDocument,StandardFonts,rgb}=await import('pdf-lib');
 const src=await PDFDocument.load(source,{updateMetadata:false});
 requireOk(src.getPageCount()===8&&sha(source)===evidence.sourceSha256);
 const out=await PDFDocument.create();for(const p of await out.copyPages(src,src.getPageIndices()))out.addPage(p);
 const font=await out.embedFont(StandardFonts.Helvetica),bold=await out.embedFont(StandardFonts.HelveticaBold);
 const pt=evidence.language==='pt',page=out.addPage([612,792]);let y=748;
 const draw=(s,size=10,strong=false)=>{const f=strong?bold:font; if(f.widthOfTextAtSize(s,size)>516||y<46)throw failure('LLMK_D2_ARCHIVE_LAYOUT_FAILURE',503);page.drawText(s,{x:48,y,size,font:f,color:rgb(.094,.137,.231)});y-=size+6;};
 const wrapped=(s,size=10)=>{let line='';for(const word of s.split(/\s+/)){const v=line?line+' '+word:word;if(font.widthOfTextAtSize(v,size)>516){if(!line)throw failure('LLMK_D2_ARCHIVE_LAYOUT_FAILURE',503);draw(line,size);line=word;}else line=v;}if(line)draw(line,size);};
 draw('LL BROWS MEDIA KIT',11,true);y-=6;
 draw(pt?'REGISTRO DE ASSINATURAS ELETRÔNICAS':'ELECTRONIC SIGNATURE RECORD',18,true);
 wrapped(pt?'Anexo de evidências. As páginas originais são preservadas; as assinaturas digitadas registradas constam neste anexo.':'Evidence appendix. Original pages are preserved; recorded typed signatures appear in this appendix.');y-=5;
 draw('Envelope: '+evidence.envelopeId);draw((pt?'Contrato: ':'Contract: ')+evidence.contractId);draw('SHA-256 '+(pt?'original:':'source:'),10,true);draw(evidence.sourceSha256,9);draw('SHA-256 JSON:',10,true);draw(manifestHash,9);y-=9;
 for(const a of evidence.entries){draw((pt?'Signatário ':'Signer ')+a.slot+' / '+(a.role==='client'?(pt?'Cliente':'Client'):(pt?'Agência':'Agency')),11,true);wrapped(a.typedName,12);draw((pt?'Assinado (UTC): ':'Signed (UTC): ')+new Date(a.signedAt).toISOString(),9);draw((pt?'Evento: ':'Event: ')+a.signatureEventId,9);y-=8;}
 wrapped(pt?'O arquivo JSON registra as evidências individuais e os textos de consentimento. Este anexo não é um certificado criptográfico de assinatura digital.':'The JSON file records individual evidence and consent texts. This appendix is not a cryptographic digital-signature certificate.',9);
 out.setTitle(pt?'LLMK - Registro de assinaturas':'LLMK - Signature record');return Buffer.from(await out.save());
}
export function registerSigningV2LiveArchiveStagedRoutes(router,deps){
 const guarded=fn=>async(req,res)=>{if(!liveGate(process.env))return res.status(409).json({error:'LLMK_D2_STAGED_NOT_RELEASED'});try{return await fn(req,res);}catch(e){const http=[409,422,503].includes(e?.http)?e.http:503;return res.status(http).json({error:http===503?'LLMK_D2_UNAVAILABLE':e.message});}};
 router.post('/signing-v2/live-issue-preview',guarded(async(req,res)=>{const {pdf}=await prepareIssue(req,deps,true);return res.status(200).set('Content-Type','application/pdf').set('Content-Disposition','attachment; filename="LLMK_REVIEW.pdf"').set('Access-Control-Expose-Headers','X-Contract-Fingerprint').set('X-Contract-Fingerprint',pdf.fingerprint).send(pdf.bytes);}));
 router.post('/signing-v2/live-issue',guarded(async(req,res)=>{
  requireRecent(req);const {db,adminId}=req.llmk;const {p,pdf,language}=await prepareIssue(req,deps,false);requireOk(p.confirmed&&p.previewFingerprint===pdf.fingerprint);
  const path=`${p.clientId}/live-signing-v2/${crypto.randomUUID()}.pdf`,bucket=db.storage.from('llmk-contracts');let attempted=false;const uploaded=[];
  try{await store(bucket,path,pdf.bytes,'application/pdf',uploaded);attempted=true;const r=await call(db,'llmk_v2_live_register_document',{p_client_id:p.clientId,p_actor_user_id:adminId,p_contract_language:language,p_contract_version:pdf.templateVersion,p_storage_path:path,p_document_sha256:pdf.sha256,p_contract_snapshot:{...pdf.snapshot,preview_fingerprint:pdf.fingerprint}});requireOk(UUID.test(r.contract_id||'')&&UUID.test(r.envelope_id||'')&&r.status==='live_sent');return res.status(201).json(r);}catch(e){if(!attempted)await cleanupBeforeRpc(bucket,uploaded);else console.error('LLMK_D2_ISSUE_RECONCILIATION_REQUIRED');throw e;}
 }));
 router.post('/signing-v2/live-finalize/:envelopeId',guarded(async(req,res)=>{
  requireRecent(req);const {db,adminId}=req.llmk,id=req.params.envelopeId;requireOk(UUID.test(id||'')&&req.body?.confirm_finalize===true);
  const args={p_envelope:id,p_actor:adminId},x=await call(db,'llmk_v2_live_archive_context',args),{evidence,manifest}=parseArchiveContext(x,id),bucket=db.storage.from('llmk-contracts');
  const original=await readPdfOrEvidence(bucket,x.source_path,x.source_sha256),jsonHash=sha(manifest),final=await renderArchive(original,evidence,jsonHash);requireOk(final.length>0&&final.length<=10*1024*1024);
  const prefix=`${x.client_id}/live-signing-v2/final/${id}/${crypto.randomUUID()}`,pdfPath=prefix+'.pdf',jsonPath=prefix+'.json';let attempted=false;const uploaded=[];
  try{await store(bucket,pdfPath,final,'application/pdf',uploaded);await store(bucket,jsonPath,manifest,'application/json',uploaded);attempted=true;const r=await call(db,'llmk_v2_live_commit_archive',{...args,p_pdf_path:pdfPath,p_pdf_hash:sha(final),p_evidence_path:jsonPath,p_evidence_hash:jsonHash});requireOk(r.ok===true&&r.status==='live_complete'&&r.final_pdf_sha256===sha(final)&&r.evidence_sha256===jsonHash);return res.status(201).json(r);}catch(e){if(!attempted)await cleanupBeforeRpc(bucket,uploaded);else console.error('LLMK_D2_ARCHIVE_RECONCILIATION_REQUIRED');throw e;}
 }));
}
