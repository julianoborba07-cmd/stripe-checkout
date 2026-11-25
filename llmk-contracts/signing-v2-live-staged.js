/** D1C staged. No production operations are reachable until a separately reviewed release. */
import crypto from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const fail=(message,http=409)=>Object.assign(new Error(message),{http});
const RELEASED=false; // D2 + legal and security review required. Never override via env alone.
export function liveGate(env){return RELEASED && env.LLMK_LIVE_ISSUANCE_ENABLED==='1' && env.LLMK_SIGNATURE_FLOW_APPROVED==='1' && env.LLMK_LEGAL_EN_PT_APPROVED==='1' && env.LLMK_UNIQUE_PENDING_INDEX_VERIFIED==='1' && ['CREATE','VIEW','BIND','REVIEW','COMPLETION'].every(k=>env[`LLMK_SIGNING_V2_QA_${k}_ENABLED`]==='0');}
export function recentAuth(token,userId,now=Date.now()){
  // Only call after Supabase auth.getUser verified this same access token.
  let claims;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));}catch{return null;}
  if(claims.sub!==userId || !Array.isArray(claims.amr))return null;
  const allowed=new Set(['password','otp','mfa/totp','mfa/phone','mfa/webauthn']);
  const valid=claims.amr.filter(a=>allowed.has(a?.method)&&Number.isSafeInteger(a.timestamp)&&a.timestamp*1000<=now&&a.timestamp*1000>=now-600000).sort((a,b)=>b.timestamp-a.timestamp);
  return valid.length?{method:valid[0].method,at:new Date(valid[0].timestamp*1000).toISOString()}:null;
}
export function validSignature(b){return b && typeof b==='object' && !Array.isArray(b) && typeof b.presentation_id==='string' && /^[1-9][0-9]{0,18}$/.test(b.presentation_id) && BigInt(b.presentation_id)<=9223372036854775807n && HASH.test(b.document_sha256||'') && HASH.test(b.consent_sha256||'') && typeof b.consent_version==='string' && /^[A-Za-z0-9_.-]{1,64}$/.test(b.consent_version) && typeof b.typed_name==='string' && b.typed_name.length>=2 && b.typed_name.length<=145 && b.typed_name===b.typed_name.trim() && b.read_and_accept===true && b.electronic_records_consent===true && b.intent_to_sign===true;}
async function rpc(db,name,args){const {data,error}=await db.rpc(name,args);if(error){if(error.code==='P0001'&&error.message==='LLMK_D1C_NOT_ALLOWED')throw fail('LLMK_LIVE_ACTION_NOT_ALLOWED',404);throw fail('LLMK_LIVE_SERVICE_UNAVAILABLE',503);}if(!data||typeof data!=='object')throw fail('LLMK_LIVE_SERVICE_UNAVAILABLE',503);return data;}
async function authenticate(req,clientFor){
  if(!UUID.test(req.params.envelopeId||''))throw fail('LLMK_LIVE_ACTION_NOT_ALLOWED',404);
  const token=/^Bearer\s+([^\s]+)$/.exec(req.headers.authorization||'')?.[1];
  if(!token)throw fail('LLMK_SESSION_REQUIRED',401);
  const url=process.env.LLMK_SUPABASE_URL||'',serviceKey=process.env.LLMK_SUPABASE_SERVICE_ROLE_KEY||'';
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)||!serviceKey)throw fail('LLMK_LIVE_SERVICE_UNAVAILABLE',503);
  const db=clientFor({url,serviceKey});const {data,error}=await db.auth.getUser(token);
  if(error||!UUID.test(data?.user?.id||''))throw fail('LLMK_INVALID_SESSION',401);
  return {db,token,userId:data.user.id,params:{p_envelope:req.params.envelopeId,p_actor:data.user.id}};
}
async function source(ctx){
  const x=await rpc(ctx.db,'llmk_v2_live_signing_context',ctx.params);
  if(!HASH.test(x.document_sha256||'')||!HASH.test(x.consent_sha256||'')||typeof x.consent_text!=='string'||sha(Buffer.from(x.consent_text,'utf8'))!==x.consent_sha256||!['en','pt'].includes(x.language)||typeof x.storage_path!=='string'||!/^[-a-f0-9]{36}\/live-signing-v2\/[-a-f0-9]{36}\.pdf$/i.test(x.storage_path))throw fail('LLMK_LIVE_SERVICE_UNAVAILABLE',503);
  return x;
}
async function verifiedPdf(db,x){const {data,error}=await db.storage.from('llmk-contracts').download(x.storage_path);if(error||!data)throw fail('LLMK_LIVE_SERVICE_UNAVAILABLE',503);const bytes=Buffer.from(await data.arrayBuffer());if(!bytes.length||bytes.length>10*1024*1024||sha(bytes)!==x.document_sha256)throw fail('LLMK_LIVE_SERVICE_UNAVAILABLE',503);return bytes;}
export function registerSigningV2LiveStagedRoutes(router,{clientFor}){
  const guarded=fn=>async(req,res)=>{
    if(!liveGate(process.env))return res.status(409).json({error:'LLMK_D1C_STAGED_NOT_RELEASED'});
    try{return await fn(req,res,await authenticate(req,clientFor));}catch(e){const http=[401,404,409,422,503].includes(e?.http)?e.http:503;return res.status(http).json({error:http===503?'LLMK_LIVE_SERVICE_UNAVAILABLE':e.message});}
  };
  router.get('/signing-v2/live-consent/:envelopeId',guarded(async(req,res,ctx)=>{
    const x=await source(ctx);return res.json({language:x.language,signerName:x.name,slot:x.slot,documentSha256:x.document_sha256,consentText:x.consent_text,consentVersion:x.consent_version,consentSha256:x.consent_sha256});
  }));
  router.post('/signing-v2/live-document/:envelopeId',guarded(async(req,res,ctx)=>{
    const x=await source(ctx),bytes=await verifiedPdf(ctx.db,x);
    const result=await rpc(ctx.db,'llmk_v2_live_present_document',{...ctx.params,p_hash:x.document_sha256,p_consent_hash:x.consent_sha256,p_version:x.consent_version});
    if(typeof result.presentation_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(result.presentation_id))throw fail('LLMK_LIVE_SERVICE_UNAVAILABLE',503);
    return res.status(200).set('Content-Type','application/pdf').set('Content-Disposition','attachment; filename="LLMK_CONTRACT.pdf"').set('Content-Security-Policy','sandbox').set('Access-Control-Expose-Headers','X-LLMK-Presentation-Id,X-LLMK-Document-SHA256,X-LLMK-Consent-SHA256,X-LLMK-Consent-Version').set('X-LLMK-Presentation-Id',result.presentation_id).set('X-LLMK-Document-SHA256',x.document_sha256).set('X-LLMK-Consent-SHA256',x.consent_sha256).set('X-LLMK-Consent-Version',x.consent_version).send(bytes);
  }));
  router.post('/signing-v2/live-sign/:envelopeId',guarded(async(req,res,ctx)=>{
    if(!validSignature(req.body))throw fail('LLMK_LIVE_EXPLICIT_CONFIRMATION_REQUIRED',422);
    const auth=recentAuth(ctx.token,ctx.userId);if(!auth)throw fail('LLMK_LIVE_RECENT_AUTH_REQUIRED',409);
    const x=await source(ctx),b=req.body;
    if(b.typed_name!==x.name||b.document_sha256!==x.document_sha256||b.consent_sha256!==x.consent_sha256||b.consent_version!==x.consent_version)throw fail('LLMK_LIVE_ACTION_NOT_ALLOWED',409);
    await verifiedPdf(ctx.db,x);
    const result=await rpc(ctx.db,'llmk_v2_live_record_signature',{...ctx.params,p_presentation:b.presentation_id,p_hash:b.document_sha256,p_consent_hash:b.consent_sha256,p_version:b.consent_version,p_name:b.typed_name,p_read:true,p_electronic:true,p_auth_at:auth.at,p_auth_method:auth.method});
    return res.status(201).json(result);
  }));
}
