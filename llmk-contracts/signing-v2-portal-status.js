/** D3B/C read-only status. No release, no identity approval, no file access or mutation. */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(http,code)=>Object.assign(new Error(code),{http});
const active=(x,field='verified_at',now=Date.now())=>Boolean(x&&x.revoked_at===null&&Number.isFinite(Date.parse(x[field]))&&Date.parse(x[field])<=now);
async function query(q){const {data,error}=await q;if(error)throw fail(503,'LLMK_PORTAL_STATUS_UNAVAILABLE');return data;}
export async function portalStatus(db,userId,requestedId,now=Date.now(),released=false){
 if(!UUID.test(userId||''))throw fail(401,'LLMK_INVALID_SESSION');
 const admin=Boolean(await query(db.from('llmk_admins').select('user_id').eq('user_id',userId).maybeSingle()));
 // Never trust the browser role or selected tenant. Non-admins cannot request another ID.
 if(requestedId!==undefined&&(!admin||typeof requestedId!=='string'||!UUID.test(requestedId)))throw fail(404,'LLMK_PORTAL_STATUS_NOT_FOUND');
 if(admin&&!requestedId)throw fail(422,'LLMK_PORTAL_CLIENT_REQUIRED');
 const client=await query(db.from('llmk_clients').select('id,owner_id,preferred_contract_language').eq(admin?'id':'owner_id',admin?requestedId:userId).maybeSingle());
 if(!client||(!admin&&client.owner_id!==userId))throw fail(404,'LLMK_PORTAL_STATUS_NOT_FOUND');
 const language=['en','pt','es'].includes(client.preferred_contract_language)?client.preferred_contract_language:null;
 // Only explicitly live contracts; QA and legacy records are never surfaced here.
 const contracts=await query(db.from('llmk_contracts').select('id,contract_version,contract_language,status,created_at').eq('client_id',client.id).eq('generation_source','live_signing_v2_node').in('status',['sent','signed']).order('created_at',{ascending:false}).limit(30));
 const records=[];
 for(const c of contracts||[]){
  const envelope=await query(db.from('llmk_signing_envelopes_v2').select('id,status,required_party_count').eq('contract_id',c.id).eq('environment','production').maybeSingle());
  if(!envelope||!['live_sent','live_in_progress','live_all_signed','live_complete'].includes(envelope.status))continue;
  const parties=await query(db.from('llmk_signing_parties_v2').select('signer_slot,signer_user_id,status,signed_at').eq('envelope_id',envelope.id).order('signer_slot'));
  if(!Array.isArray(parties)||parties.length!==3||new Set(parties.map(x=>x.signer_slot)).size!==3||!parties.every(x=>[1,2,3].includes(x.signer_slot)&&UUID.test(x.signer_user_id||''))||new Set(parties.map(x=>x.signer_user_id)).size!==3)throw fail(503,'LLMK_PORTAL_STATUS_UNAVAILABLE');
  // An owner must also be the actual bound client signer to see this production record.
  if(!admin&&!parties.some(p=>p.signer_slot===1&&p.signer_user_id===userId))continue;
  const archived=envelope.status==='live_complete'&&Boolean(await query(db.from('llmk_live_archives_v2').select('envelope_id').eq('envelope_id',envelope.id).eq('contract_id',c.id).maybeSingle()));
  const own=parties.find(p=>p.signer_user_id===userId);
  if(!UUID.test(envelope.id||''))throw fail(503,'LLMK_PORTAL_STATUS_UNAVAILABLE');
  records.push({envelopeId:envelope.id,canDownload:archived&&Boolean(own),canSign:released===true&&Boolean(own&&own.status==='pending')&&['live_sent','live_in_progress'].includes(envelope.status),canFinalize:released===true&&admin&&envelope.status==='live_all_signed',version:c.contract_version,language:c.contract_language,status:envelope.status,archiveRegistered:archived,parties:parties.map(p=>({slot:p.signer_slot,signed:p.status==='signed'&&Boolean(p.signed_at),isYourSlot:p.signer_user_id===userId}))});
 }
 const output={ok:true,readOnly:true,productionReleased:released===true,language,records};
 if(!admin)return output;
 const [identity,excluded,agency,templates,consents]=await Promise.all([
  query(db.from('llmk_live_client_identity_v2').select('signer_user_id,verified_at,revoked_at').eq('client_id',client.id).maybeSingle()),
  query(db.from('llmk_live_excluded_clients_v2').select('client_id').eq('client_id',client.id).maybeSingle()),
  query(db.from('llmk_live_agency_identity_v2').select('signer_slot,signer_user_id,verified_at,revoked_at')),
  language?query(db.from('llmk_live_template_approval_v2').select('contract_version,template_sha256,approved_at,revoked_at').eq('contract_language',language)):[],
  language?query(db.from('llmk_live_consent_versions_v2').select('contract_version,template_sha256,approved_at,revoked_at').eq('contract_language',language)):[]
 ]);
 const a2=(agency||[]).find(x=>x.signer_slot===2),a3=(agency||[]).find(x=>x.signer_slot===3);
 const approved=(templates||[]).filter(x=>active(x,'approved_at',now));
 output.preflight={excludedFromLive:Boolean(excluded),clientIdentityRegistered:active(identity,'verified_at',now)&&identity.signer_user_id===client.owner_id,agencySlot2Registered:active(a2,'verified_at',now),agencySlot3Registered:active(a3,'verified_at',now),distinctAccounts:Boolean(identity&&a2&&a3&&new Set([identity.signer_user_id,a2.signer_user_id,a3.signer_user_id]).size===3),templateApprovalRecorded:approved.length>0,matchingConsentApprovalRecorded:approved.some(t=>(consents||[]).some(c=>active(c,'approved_at',now)&&c.contract_version===t.contract_version&&c.template_sha256===t.template_sha256)),spanishBlocked:language==='es'};
 return output;
}
export function registerSigningV2PortalStatus(router,{clientFor,config,validConfig,isReleased=()=>false}){
 router.get('/signing-v2/portal-status',async(req,res)=>{
  try{
   const c=config();if(!validConfig(c))throw fail(503,'LLMK_PORTAL_STATUS_UNAVAILABLE');
   const token=/^Bearer\s+([^\s]+)$/.exec(req.headers.authorization||'')?.[1];if(!token)throw fail(401,'LLMK_SESSION_REQUIRED');
   const db=clientFor(c);const {data,error}=await db.auth.getUser(token);
   if(error||!data?.user?.id)throw fail(401,'LLMK_INVALID_SESSION');
   return res.json(await portalStatus(db,data.user.id,req.query.client_id,Date.now(),isReleased()===true));
  }catch(e){const http=[401,404,422,503].includes(e?.http)?e.http:503;return res.status(http).json({error:http===503?'LLMK_PORTAL_STATUS_UNAVAILABLE':e.message});}
 });
}
