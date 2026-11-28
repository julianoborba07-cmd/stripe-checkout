import { isDeepStrictEqual } from 'node:util';

export const LL_CM_MAPPED_SESSION_ID=/^cs_live_[A-Za-z0-9_]{12,200}$/;
const testSessionId=/^cs_test_[A-Za-z0-9_]{12,200}$/;
const metadataKeys=['cm_scope','hold_id','snapshot_id','campaign_key','campaign_version'];

export function llCmMappedSnapshotMatchesHold(snapshot,hold) {
  const terms=snapshot?.immutable_terms;
  return !!(hold?.id && snapshot?.id && snapshot.hold_id===hold.id &&
    hold.campaign_id && snapshot.campaign_id===hold.campaign_id &&
    hold.campaign_key && snapshot.campaign_key===hold.campaign_key &&
    Number.isSafeInteger(hold.campaign_version) && hold.campaign_version>0 &&
    snapshot.campaign_version===hold.campaign_version && terms?.mode==='mapped-service-v1' &&
    terms.campaignKey===hold.campaign_key && terms.campaignVersion===hold.campaign_version &&
    isDeepStrictEqual(terms,hold.quote_snapshot));
}

export function llCmMappedReconcileCheckoutContract({snapshot,hold,session,paymentIntent,expectedLiveMode}) {
  // This is a classification, not a booking or refund authorization. Inputs
  // must be retrieved by the backend after signed webhook authentication.
  const review=reason=>({action:'review',reason,bookingAuthorized:false});
  const q=snapshot?.immutable_terms||{};
  const h=hold||{},s=session||{},pi=paymentIntent||{},m=s.metadata||{},pm=pi.metadata||{};
  if(typeof expectedLiveMode!=='boolean'||s.livemode!==expectedLiveMode||s.object!=='checkout.session'||
    typeof s.id!=='string'||!(expectedLiveMode?LL_CM_MAPPED_SESSION_ID:testSessionId).test(s.id)||
    s.id!==h.stripe_session_id||!llCmMappedSnapshotMatchesHold(snapshot,h)||
    snapshot.currency!=='usd'||q.currency!=='usd'||!Number.isSafeInteger(snapshot.price_cents)||
    !Number.isSafeInteger(snapshot.deposit_cents)||snapshot.deposit_cents<=0||snapshot.price_cents<snapshot.deposit_cents||
    q.priceCents!==snapshot.price_cents||q.depositCents!==snapshot.deposit_cents||q.balanceCents!==snapshot.price_cents-snapshot.deposit_cents||
    s.mode!=='payment'||s.currency!=='usd'||s.amount_total!==snapshot.deposit_cents||
    m.cm_scope!=='lltouch-cm-mapped-v1'||m.hold_id!==h.id||m.snapshot_id!==snapshot.id||
    m.campaign_key!==snapshot.campaign_key||m.campaign_version!==String(snapshot.campaign_version))return review('SESSION_OR_TERMS_MISMATCH');
  const intentMatches=typeof s.payment_intent==='string'&&pi.object==='payment_intent'&&pi.id===s.payment_intent&&
    pi.livemode===expectedLiveMode&&pi.currency==='usd'&&pi.amount===snapshot.deposit_cents&&
    metadataKeys.every(key=>pm[key]===m[key]);
  if(s.payment_status!=='paid') {
    // Even an expired Checkout may have a processing payment. Only a
    // definitively cancelled/no-payment Intent can be considered for release.
    if(s.status==='expired'&&s.payment_status==='unpaid'&&(s.payment_intent===null||
      (intentMatches&&pi.status==='canceled'&&pi.amount_received===0)))
      return {action:'expiry_candidate',reason:'STRIPE_CLOSED_UNPAID',bookingAuthorized:false};
    return {action:'wait',reason:'PAYMENT_NOT_CONFIRMED',bookingAuthorized:false};
  }
  if(s.status!=='complete'||!['checkout','paid','processing','confirmed','review','expired','cancelled','refunded'].includes(h.state)||
    !intentMatches||!['automatic','automatic_async'].includes(pi.capture_method)||pi.status!=='succeeded'||
    pi.amount_received!==snapshot.deposit_cents)return review('PAYMENT_INTENT_MISMATCH');
  const charge=pi.latest_charge;
  if(charge?.object!=='charge'||!/^ch_[A-Za-z0-9]+$/.test(charge.id||'')||charge.payment_intent!==pi.id||
    charge.paid!==true||charge.captured!==true||charge.status!=='succeeded'||charge.disputed!==false||
    charge.livemode!==expectedLiveMode||charge.amount!==snapshot.deposit_cents||charge.amount_captured!==snapshot.deposit_cents||
    charge.currency!=='usd'||charge.refunded!==false||charge.amount_refunded!==0||
    !Number.isSafeInteger(charge.created)||charge.created<=0)return review('CHARGE_NOT_VERIFIED');
  const paidAt=charge.created*1000,expires=Date.parse(h.expires_at),created=Date.parse(h.created_at);
  if(!Number.isFinite(expires)||!Number.isFinite(created)||paidAt<Math.floor(created/1000)*1000||paidAt>=expires||['expired','cancelled','refunded','review'].includes(h.state))return review('LATE_OR_CLOSED_HOLD_PAYMENT');
  if(['paid','processing','confirmed'].includes(h.state))return {action:'already_reconciled',reason:'REPLAY_OR_IN_PROGRESS',bookingAuthorized:false};
  // A DB transaction must transition checkout -> paid exactly once and a
  // worker must revalidate the slot before booking. No booking here.
  return {action:'paid_candidate',reason:'VERIFIED_DEPOSIT_IN_WINDOW',paidAt:new Date(paidAt).toISOString(),bookingAuthorized:false};
}

export function llCmMappedReceiptState(hold,issue,booking,now=Date.now()){
  const paidAt=Date.parse(issue?.paid_at);
  const start=Date.parse(hold.created_at),end=Date.parse(hold.expires_at);
  const sessionBound=LL_CM_MAPPED_SESSION_ID.test(hold.stripe_session_id||'')&&issue?.session_id===hold.stripe_session_id;
  const paid=sessionBound&&issue.state==='paid'&&['paid','processing','confirmed','review'].includes(hold.state)&&
    Number.isFinite(start)&&Number.isFinite(end)&&paidAt>=Math.floor(start/1000)*1000&&paidAt<end;
  const calendarVerified=paid&&booking?.state==='calendar_verified'&&Boolean(booking.booking_id);
  const review=issue?.state==='review'||booking?.state==='review'||
    (hold.state==='review'&&!calendarVerified)||(issue?.state==='issuing'&&end<=now)||
    (booking?.state==='processing'&&Date.parse(booking.started_at)<=now-600000);
  const expired=(sessionBound&&issue.state==='expired'&&hold.state==='expired')||
    (!issue&&!hold.stripe_session_id&&['held','expired'].includes(hold.state)&&end<=now);
  let status='pending';
  if(review)status='review';
  else if(calendarVerified)status='calendar-verified';
  else if(paid)status='paid';
  else if(expired)status='expired';
  return {status,paid,calendarVerified,appointmentConfirmed:false};
}
