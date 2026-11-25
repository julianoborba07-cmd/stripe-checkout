const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId=x=>typeof x==='string'&&UUID.test(x);
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(o,ks)=>obj(o)&&Object.keys(o).length===ks.length&&ks.every(k=>Object.hasOwn(o,k));
const conflict=new Set(['RC1_CLIENT_EXCLUDED_OR_MISSING','RC1_BINDING_REQUIRED','RC1_BINDING_CHANGED','RC1_ACCOUNT_REQUIRED','RC1_DISTINCT_ACCOUNT_REQUIRED','RC1_DRAFT_EXISTS_OR_INVALID','RC1_SELF_REQUEST_REQUIRED','RC1_STALE_REQUEST','RC1_CANCEL_BLOCKED','RC1_REVIEW_BLOCKED','RC1_REFERENCE_REQUIRED','RC1_REVOKE_BLOCKED']);
export function parseIdentityBody(b){
 if(!keys(b,['scope','clientId','slot','action','requestId','data']))return null;
 const {scope,clientId,slot,action,requestId,data}=b;
 if(!(scope==='client'&&validId(clientId)&&slot===null||scope==='agency'&&clientId===null&&[2,3].includes(slot)))return null;
 if(!['read','draft','review','revoke','cancel'].includes(action))return null;
 if(['read','draft'].includes(action)?requestId!==null:!validId(requestId))return null;
 if(action==='read'&&!keys(data,[]))return null;
 if(action==='draft'&&scope==='client'){
   const fields=['legal_entity_name','signer_name','signer_title','legal_address','notice_email'];
   if(!keys(data,fields)||!fields.every(k=>typeof data[k]==='string'&&data[k].length<=254))return null;
 }
 if((action==='draft'&&scope==='agency'||action==='cancel')&&(!keys(data,['confirmed'])||data.confirmed!==true))return null;
 if(['review','revoke'].includes(action)&&(!keys(data,['confirmed','reference'])||data.confirmed!==true||typeof data.reference!=='string'||data.reference.length>160))return null;
 return {p_scope:scope,p_client:clientId,p_slot:slot,p_action:action,p_request:requestId,p_data:data};
}
// Must be registered AFTER existing requireAdmin. No token or actor accepted from JSON.
export function registerIdentityRoutes(router,{recentAuth,enabled=()=>process.env.LLMK_RC1_IDENTITY_ENABLED==='1'}){
 router.post('/signing-v2/identity',async(req,res)=>{
  if(!enabled())return res.status(409).json({error:'RC1_IDENTITY_DISABLED'});
  const {db,adminId,config}=req.llmk||{};
  if(!validId(adminId)||!db)return res.status(403).json({error:'RC1_ADMIN_REQUIRED'});
  // RC1 must remain independent of and mutually exclusive with contract release.
  if(config?.liveEnabled!==false||config?.signingApproved!==false)return res.status(409).json({error:'RC1_RELEASE_GUARD'});
  const input=parseIdentityBody(req.body);
  if(!input)return res.status(422).json({error:'RC1_INVALID_REQUEST'});
  const token=/^Bearer\s+(\S+)$/.exec(req.get('authorization')||'')?.[1];
  if(input.p_action!=='read'&&(!token||!recentAuth(token,adminId)))return res.status(403).json({error:'RC1_RECENT_AUTH_REQUIRED'});
  try{
   const {data,error}=await db.rpc('llmk_rc1_identity_action',{...input,p_actor:adminId});
   if(error){const code=error.message;if(error.code==='P0001'){
     if(['RC1_ADMIN_REQUIRED','RC1_ROLE_REQUIRED'].includes(code))return res.status(403).json({error:code});
     if(['RC1_INVALID_REQUEST','RC1_INVALID_DATA'].includes(code))return res.status(422).json({error:code});
     if(conflict.has(code))return res.status(409).json({error:code});
   }return res.status(503).json({error:'RC1_IDENTITY_UNAVAILABLE'});}
   if(!obj(data)||data.ok!==true)return res.status(503).json({error:'RC1_IDENTITY_UNAVAILABLE'});
   return res.status(input.p_action==='draft'?201:200).json(data);
  }catch{return res.status(503).json({error:'RC1_IDENTITY_UNAVAILABLE'});}
 });
}
