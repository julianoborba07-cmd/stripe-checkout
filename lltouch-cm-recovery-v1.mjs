// Candidate: no messaging, network, or database writes in this module.
const blocked=reason=>({status:'blocked',reason,recoveryAuthorized:false});
const date=value=>typeof value==='string'?Date.parse(value):NaN;
export function recoveryBase({campaign:c,lead:l,setting:s,job:j,outbox:o,approval:a,message:m,attempt,now=Date.now()}){
  if(!c||!l||!s||l.campaign_id!==c.id||l.campaign_key!==c.campaign_key||l.campaign_version!==c.version||s.campaign_id!==c.id||s.campaign_key!==c.campaign_key||s.campaign_version!==c.version||s.enabled!==true) return blocked('CAMPAIGN_OR_CAPTURE_MISMATCH');
  if(c.status!=='published'||!(date(c.offer_starts_at)<=now&&now<date(c.offer_ends_at)))return blocked('CAMPAIGN_NOT_ACTIVE');
  if(l.contact_consent!==true||l.sms_marketing_consent!==true)return blocked('NO_SMS_CONSENT');
  if(!(date(l.created_at)+600000<=now))return blocked('WAIT_10_MINUTES');
  if(!j||j.lead_id!==l.id||j.campaign_id!==c.id||j.campaign_key!==c.campaign_key||j.campaign_version!==c.version||!['blocked','ready'].includes(j.state)||!(date(j.due_at)>=date(l.created_at)+600000&&date(j.due_at)<=now))return blocked('JOB_MISSING_OR_NOT_DUE');
  if(attempt)return blocked('DELIVERY_ALREADY_RESERVED');
  if(o?.lead_id!==l.id||o.campaign_key!==c.campaign_key||o.state!=='sent'||o.external_step!=='completed'||o.reconciliation_required!==false||!o.ghl_contact_id)return blocked('CONTACT_SYNC_NOT_CONFIRMED');
  if(!a||!m||a.campaign_id!==c.id||m.campaign_id!==c.id||m.campaign_key!==c.campaign_key||a.campaign_version!==c.version||m.campaign_version!==c.version||a.message_version_id!==m.id||typeof m.template_en!=='string'||m.template_en.length<25||m.template_en.length>700)return blocked('MESSAGE_NOT_APPROVED');
  return {status:'inspect',reason:'BASE_CHECKS_PASSED',recoveryAuthorized:false};
}
export function classifyMappedEvidence({holds,legacyBindings,verdicts}){
  if(!Array.isArray(holds)||!Array.isArray(legacyBindings)||!Array.isArray(verdicts))return blocked('EVIDENCE_UNAVAILABLE');
  if(holds.some(h=>['paid','processing','confirmed','refunded','review'].includes(h.state)))return blocked('PAYMENT_OR_BOOKING_REQUIRES_SUPPRESSION');
  if(legacyBindings.length)return blocked('LEGACY_PAYMENT_BINDING_REQUIRES_REVIEW');
  if(!holds.length)return blocked('NO_PAYMENT_BINDING_NOT_PROOF_OF_NONPAYMENT');
  if(holds.length!==verdicts.length||holds.some((h,i)=>h.state!=='expired'||!h.stripe_session_id||verdicts[i]?.action!=='expiry_candidate'||verdicts[i]?.reason!=='STRIPE_CLOSED_UNPAID'))return blocked('PAYMENT_UNKNOWN_OR_IN_PROGRESS');
  return {status:'mapped_closed_unpaid_only',reason:'MAPPED_SESSIONS_VERIFIED_EXPIRED',recoveryAuthorized:false};
}
export function recoveryFinal({payment,dnd}){
  if(payment?.status!=='mapped_closed_unpaid_only')return blocked(payment?.reason||'PAYMENT_UNKNOWN');
  if(dnd?.known!==true||dnd?.clear!==true)return blocked('GHL_SMS_OPTOUT_OR_UNKNOWN');
  // Other sales channels, identity-level dedupe, concurrent checkout creation,
  // and final delivery must still be reconciled before enabling a sender.
  return {status:'review',reason:'MAPPED_CHECKOUT_AND_DND_CHECKED',recoveryAuthorized:false,blockers:['OTHER_PAYMENT_CHANNELS_NOT_RECONCILED','ATOMIC_RECIPIENT_DELIVERY_NOT_CONNECTED','WORKFLOW_DELIVERY_NOT_HOMOLOGATED']};
}
