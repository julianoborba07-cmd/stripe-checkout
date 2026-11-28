// Candidate only. A successful claim is not a confirmed SMS delivery.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const contact=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{6,120}$/.test(v);
const secret=v=>typeof v==='string'&&/^[0-9a-f]{64}$/i.test(v);
const digest=v=>createHash('sha256').update(v).digest();
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(digest(a),digest(b));
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const exact=(o,keys)=>plain(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const denied=(reason,mapping_only=false)=>({authorized:false,mapping_only,reason,recovery_message:mapping_only?'QA MAPPING ONLY - DO NOT SEND':''});
const claimsKeys=['lead_id','campaign_id','campaign_version','message_version_id','contact_id','iat','exp'];
function validClaims(c,now){return exact(c,claimsKeys)&&uuid(c.lead_id)&&uuid(c.campaign_id)&&uuid(c.message_version_id)&&contact(c.contact_id)&&Number.isSafeInteger(c.campaign_version)&&c.campaign_version>0&&Number.isSafeInteger(c.iat)&&Number.isSafeInteger(c.exp)&&c.iat<=now&&c.exp>now&&c.exp>c.iat&&c.exp-c.iat<=60000;}
function mac(encoded,key){return createHmac('sha256',key).update('lltouch-cm-recovery-v1.'+encoded).digest('base64url');}
export function createRecoveryTicket(claims,key,now=Date.now()){
  if(!secret(key)||!validClaims(claims,now))throw Error('INVALID_TICKET_INPUT');
  const encoded=Buffer.from(JSON.stringify(claims),'utf8').toString('base64url');
  return encoded+'.'+mac(encoded,key);
}
export function verifyRecoveryTicket(ticket,key,now=Date.now()){
  if(!secret(key)||typeof ticket!=='string'||ticket.length>2048||!(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)))return null;
  const [encoded,signature]=ticket.split('.');
  if(!same(signature,mac(encoded,key)))return null;
  try{const c=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));return validClaims(c,now)?c:null;}catch{return null;}
}
export function recoveryCallbackAuthenticated(header,key){return secret(key)&&same(header,'Bearer '+key);}
export function renderApprovedRecoveryText(template,name){
  if(typeof template!=='string'||template.trim()!==template||template.length<25||template.length>700||/[\x00-\x1f\x7f]/.test(template)||!(/\bSTOP\b/i.test(template)))return null;
  const first=String(name||'').trim().split(/\s+/)[0]||'';
  if(template.includes('{{first_name}}')&&(!first||first.length>60||!(/^[\p{L}\p{M}'’.-]+$/u.test(first))))return null;
  const rendered=template.replaceAll('{{first_name}}',()=>first);
  return /[{}<>]/.test(rendered)||rendered.length>700?null:rendered;
}
// The dependencies must be supplied by the server, never by an HTTP body.
// liveEnabled MUST remain false until the authoritative eligibility and GHL execution contracts are homologated.
export async function authorizeRecoveryCallback({body,authorization,callbackKey,ticketKey,qaEnabled,liveEnabled,loadContext,audit,reserve,now=Date.now}){
  if(!recoveryCallbackAuthenticated(authorization,callbackKey))return {http:401,body:denied('AUTH_REQUIRED')};
  if(exact(body,['mode'])&&body.mode==='mapping_test')return qaEnabled()===true?{http:200,body:denied('MAPPING_ONLY',true)}:{http:200,body:denied('QA_DISABLED')};
  if(!exact(body,['mode','ticket','contact_id'])||body.mode!=='authorize'||!contact(body.contact_id))return {http:422,body:denied('INVALID_INPUT')};
  if(liveEnabled()!==true)return {http:200,body:denied('RELEASE_LOCKED')};
  const c=verifyRecoveryTicket(body.ticket,ticketKey,now());
  if(!c||c.contact_id!==body.contact_id)return {http:200,body:denied('TICKET_INVALID_OR_EXPIRED')};
  try{
    const context=await loadContext(c);
    if(!context||context.campaign?.id!==c.campaign_id||context.campaign.version!==c.campaign_version||context.lead?.id!==c.lead_id||context.lead.campaign_id!==c.campaign_id||context.lead.campaign_version!==c.campaign_version||context.lead.contact_consent!==true||context.lead.sms_marketing_consent!==true||context.outbox?.ghl_contact_id!==c.contact_id||context.approval?.message_version_id!==c.message_version_id||context.approval.campaign_version!==c.campaign_version||context.message?.id!==c.message_version_id||context.message.campaign_id!==c.campaign_id||context.message.campaign_version!==c.campaign_version)return {http:200,body:denied('CONTEXT_MISMATCH')};
    const message=renderApprovedRecoveryText(context.message.template_en,context.lead.customer_name);
    if(!message)return {http:200,body:denied('APPROVED_TEXT_INVALID')};
    const proof=await audit(context.campaign,c.lead_id);
    // The current audit deliberately NEVER returns this positive verdict.
    // Absence of external records is not sufficient to produce it.
    if(proof?.recoveryAuthorized!==true||proof.status!=='eligible'||proof.reason!=='ALL_RECOVERY_CHECKS_PASSED')return {http:200,body:denied('ELIGIBILITY_NOT_ESTABLISHED')};
    if(liveEnabled()!==true||!verifyRecoveryTicket(body.ticket,ticketKey,now()))return {http:200,body:denied('RELEASE_OR_TICKET_CHANGED')};
    const result=await reserve(c);
    if(result?.status!=='reserved'||!uuid(result.idempotencyKey))return {http:200,body:denied('RESERVATION_NOT_GRANTED')};
    // Never reuse a reservation even if the response is lost. Never mark it sent here.
    if(liveEnabled()!==true||!verifyRecoveryTicket(body.ticket,ticketKey,now()))return {http:200,body:denied('RESERVED_BUT_AUTHORIZATION_EXPIRED')};
    return {http:200,body:{authorized:true,mapping_only:false,reason:'ONE_TIME_RESERVATION_GRANTED',recovery_message:message}};
  }catch{return {http:200,body:denied('AUTHORIZATION_UNAVAILABLE')};}
}
