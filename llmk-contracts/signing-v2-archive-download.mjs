import {createHash} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const fail=(http,message)=>Object.assign(new Error(message),{http});
const missing=()=>fail(404,'LLMK_ARCHIVE_NOT_FOUND');
const unavailable=()=>fail(503,'LLMK_ARCHIVE_UNAVAILABLE');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function query(p){const {data,error}=await p;if(error)throw unavailable();return data;}
export async function getArchive(db,userId,id,kind){
 if(!UUID.test(userId||''))throw fail(401,'LLMK_INVALID_SESSION');
 if(!UUID.test(id||'')||!['pdf','evidence'].includes(kind))throw missing();
 const e=await query(db.from('llmk_signing_envelopes_v2').select('id,contract_id,environment,status,required_party_count,source_document_sha256,final_pdf_storage_path,final_pdf_sha256,completed_at').eq('id',id).eq('environment','production').eq('status','live_complete').maybeSingle());
 if(!e||!e.completed_at||e.required_party_count!==3)throw missing();
 const parties=await query(db.from('llmk_signing_parties_v2').select('signer_slot,signer_user_id,status,signed_at,accepted_document_sha256').eq('envelope_id',id));
 const slot=parties?.find(p=>p.signer_user_id===userId);
 if(!slot)throw missing();
 if(parties.length!==3||new Set(parties.map(p=>p.signer_slot)).size!==3||new Set(parties.map(p=>p.signer_user_id)).size!==3||!parties.every(p=>[1,2,3].includes(p.signer_slot)&&UUID.test(p.signer_user_id||'')&&p.status==='signed'&&p.signed_at&&p.accepted_document_sha256===e.source_document_sha256))throw unavailable();
 const c=await query(db.from('llmk_contracts').select('id,client_id,generation_source,status,signed_at,document_sha256,contract_snapshot').eq('id',e.contract_id).maybeSingle());
 if(!c||c.generation_source!=='live_signing_v2_node'||c.status!=='signed'||!c.signed_at||c.document_sha256!==e.source_document_sha256||c.contract_snapshot?.qa_not_for_signature||c.contract_snapshot?.llmk_signing_v2_qa)throw missing();
 // A bound client must still own the company; a bound agency signer must still be an admin.
 if(slot.signer_slot===1){const owner=await query(db.from('llmk_clients').select('owner_id').eq('id',c.client_id).maybeSingle());if(owner?.owner_id!==userId)throw missing();}
 else {const admin=await query(db.from('llmk_admins').select('user_id').eq('user_id',userId).maybeSingle());if(!admin)throw missing();}
 const a=await query(db.from('llmk_live_archives_v2').select('envelope_id,contract_id,source_document_sha256,final_pdf_storage_path,final_pdf_sha256,evidence_storage_path,evidence_sha256').eq('envelope_id',id).eq('contract_id',c.id).maybeSingle());
 if(!a||!UUID.test(c.client_id||'')||a.source_document_sha256!==c.document_sha256||!HASH.test(a.source_document_sha256)||a.final_pdf_storage_path!==e.final_pdf_storage_path||a.final_pdf_sha256!==e.final_pdf_sha256||!HASH.test(a.final_pdf_sha256)||!HASH.test(a.evidence_sha256))throw unavailable();
 const prefix=`${c.client_id}/live-signing-v2/final/${id}/`;
 const suffix=a.final_pdf_storage_path?.slice(prefix.length);
 if(!a.final_pdf_storage_path?.startsWith(prefix)||!suffix?.endsWith('.pdf')||!UUID.test(suffix.slice(0,-4))||a.evidence_storage_path!==a.final_pdf_storage_path.slice(0,-4)+'.json')throw unavailable();
 const pdf=kind==='pdf',path=pdf?a.final_pdf_storage_path:a.evidence_storage_path,hash=pdf?a.final_pdf_sha256:a.evidence_sha256;
 const {data,error}=await db.storage.from('llmk-contracts').download(path);
 if(error||!data||data.size<1||data.size>(pdf?20*1024*1024:1024*1024))throw unavailable();
 const bytes=Buffer.from(await data.arrayBuffer());if(sha(bytes)!==hash)throw unavailable();
 if(pdf){if(bytes.subarray(0,5).toString()!=='%PDF-')throw unavailable();}
 else {let evidence;try{evidence=JSON.parse(bytes.toString('utf8'));}catch{throw unavailable();}if(evidence.envelopeId!==id||evidence.sourceSha256!==a.source_document_sha256||evidence.entries?.length!==3)throw unavailable();}
 return {bytes,hash,type:pdf?'application/pdf':'application/json',filename:pdf?'LLMK_CONTRACT.pdf':'LLMK_EVIDENCE.json'};
}
export function registerArchiveDownload(router,{getDb}){
 router.get('/signing-v2/archive/:id/:kind',async(req,res)=>{
  res.set('Cache-Control','no-store, private');res.set('X-Content-Type-Options','nosniff');
  try{
   const token=/^Bearer\s+([^\s]+)$/.exec(req.headers.authorization||'')?.[1];if(!token)throw fail(401,'LLMK_SESSION_REQUIRED');
   const db=getDb();const {data,error}=await db.auth.getUser(token);if(error||!data?.user?.id)throw fail(401,'LLMK_INVALID_SESSION');
   const f=await getArchive(db,data.user.id,req.params.id,req.params.kind);
   return res.status(200).set('Content-Type',f.type).set('Content-Disposition',`attachment; filename="${f.filename}"`).set('Access-Control-Expose-Headers','X-LLMK-Archive-SHA256').set('X-LLMK-Archive-SHA256',f.hash).send(f.bytes);
  }catch(e){const status=[401,404,503].includes(e?.http)?e.http:503;return res.status(status).json({error:status===503?'LLMK_ARCHIVE_UNAVAILABLE':e.message});}
 });
}
