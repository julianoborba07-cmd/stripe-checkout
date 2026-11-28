// Read-only positive suppression from the existing LL Touch booking ledger.
// A negative result is NOT proof that no Vagaro appointment exists.
const result=(reason,status='blocked')=>({status,reason,recoveryAuthorized:false});
const cols='id,stripe_session_id,customer_email,status,starts_at';
const email=v=>typeof v==='string'?v.trim().toLowerCase():'';
const supportedEmail=v=>v.length<=254&&/^[a-z0-9.!+_'-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v);
const sessionId=v=>typeof v==='string'&&/^cs_live_[A-Za-z0-9_]{12,200}$/.test(v);
const read=async q=>{
  const {data,error}=await q.limit(21);
  if(error||!Array.isArray(data)||data.length>20||data.some(r=>!r||typeof r.id!=='string'||!r.id))throw Error('LEDGER_READ_INVALID');
  return data;
};
function classify(rows){
  if(rows.some(r=>r.status==='confirmed'))return result('BOOKING_LEDGER_CONFIRMED');
  if(rows.some(r=>r.status==='pending'))return result('BOOKING_LEDGER_PENDING');
  if(rows.length)return result('BOOKING_LEDGER_REQUIRES_REVIEW');
  return null;
}
export async function bookingLedgerEvidence({db,campaign,lead,holds,legacyBindings}){
  const start=Date.parse(campaign?.offer_starts_at);
  if(!db||!lead||!Number.isFinite(start)||!Array.isArray(holds)||!Array.isArray(legacyBindings)||holds.length>20||legacyBindings.length>20)return result('BOOKING_LEDGER_SCOPE_UNKNOWN');
  try{
    const values=[...holds,...legacyBindings].map(r=>{if(!r||typeof r!=='object')throw Error('INVALID_BINDING');return r.stripe_session_id;}).filter(v=>v!==null&&v!==undefined);
    if(values.some(v=>!sessionId(v)))return result('BOOKING_LEDGER_SCOPE_UNKNOWN');
    const ids=[...new Set(values)];
    if(ids.length){
      const rows=await read(db.from('lltouch_appointments').select(cols).in('stripe_session_id',ids));
      if(rows.some(r=>!ids.includes(r.stripe_session_id)))return result('BOOKING_LEDGER_SCOPE_UNKNOWN');
      const evidence=classify(rows);if(evidence)return evidence;
    }
    const e=email(lead.customer_email);
    if(!supportedEmail(e))return result('BOOKING_LEDGER_IDENTITY_UNKNOWN');
    // Case-insensitive exact email pattern; escape SQL LIKE underscore.
    // Restrict the date scope to appointments from the campaign start onward.
    const rows=await read(db.from('lltouch_appointments').select(cols)
      .ilike('customer_email',e.replace(/_/g,'\\_')).gte('starts_at',new Date(start).toISOString()));
    if(rows.some(r=>email(r.customer_email)!==e||!Number.isFinite(Date.parse(r.starts_at))||Date.parse(r.starts_at)<start))return result('BOOKING_LEDGER_SCOPE_UNKNOWN');
    return classify(rows)||result('BOOKING_LEDGER_NO_MATCH_NOT_PROOF','unknown');
  }catch(_e){return result('BOOKING_LEDGER_EVIDENCE_UNAVAILABLE');}
}
// This verifies the Google calendar block associated with the SQL appointment.
// Native Vagaro identity requires independent evidence.
export function mappedGoogleBookingMatches(event,booking){
  if(!event||!booking||!booking.id||!booking.google_event_id||!booking.stripe_session_id||!booking.service_id)
    return false;
  const details=event.extendedProperties?.private;
  const start=Date.parse(booking.starts_at),end=Date.parse(booking.ends_at);
  return Number.isFinite(start)&&Number.isFinite(end)&&end>start&&
    event.id===booking.google_event_id&&event.status==='confirmed'&&event.transparency==='opaque'&&
    details?.llTouchBooking==='1'&&details.llTouchBookingId===booking.id&&
    details.stripeSessionId===booking.stripe_session_id&&details.serviceId===booking.service_id&&
    Date.parse(event.start?.dateTime)===start&&Date.parse(event.end?.dateTime)===end;
}
