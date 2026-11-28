import assert from 'node:assert/strict';
import test from 'node:test';
import {llCmMappedReceiptState,llCmMappedReconcileCheckoutContract} from './lltouch-cm-mapped-payment-v1.mjs';

const at=Date.parse('2027-02-02T15:00:00.000Z');
const start=new Date(at).toISOString();
const deadline=new Date(at+600000).toISOString();
const paidAt=new Date(at+120000).toISOString();
const sessionId='cs_live_synthetic_123456789';

function fixture(){
  const immutable_terms={mode:'mapped-service-v1',campaignKey:'hydrafacial-piloto-qa',campaignVersion:2,
    currency:'usd',priceCents:14900,depositCents:2500,balanceCents:12400,regularPriceCents:34900};
  const hold={id:'hold',campaign_id:'campaign',campaign_key:immutable_terms.campaignKey,campaign_version:2,
    state:'checkout',stripe_session_id:sessionId,created_at:start,expires_at:deadline,quote_snapshot:immutable_terms};
  const snapshot={id:'snapshot',hold_id:'hold',campaign_id:'campaign',campaign_key:hold.campaign_key,
    campaign_version:2,currency:'usd',price_cents:14900,deposit_cents:2500,immutable_terms};
  const metadata={cm_scope:'lltouch-cm-mapped-v1',hold_id:'hold',snapshot_id:'snapshot',
    campaign_key:hold.campaign_key,campaign_version:'2'};
  const session={id:sessionId,livemode:true,object:'checkout.session',mode:'payment',currency:'usd',
    amount_total:2500,metadata,payment_status:'paid',status:'complete',payment_intent:'pi_synthetic'};
  const paymentIntent={id:'pi_synthetic',object:'payment_intent',livemode:true,status:'succeeded',currency:'usd',
    amount:2500,amount_received:2500,capture_method:'automatic',metadata:{...metadata},
    latest_charge:{id:'ch_synthetic123',object:'charge',payment_intent:'pi_synthetic',paid:true,captured:true,
      status:'succeeded',livemode:true,amount:2500,amount_captured:2500,disputed:false,
      currency:'usd',refunded:false,amount_refunded:0,created:Date.parse(paidAt)/1000}};
  return {snapshot,hold,session,paymentIntent,expectedLiveMode:true};
}

test('a verified HydraFacial deposit in the hold window is a reconciliation candidate',()=>{
  assert.deepEqual(llCmMappedReconcileCheckoutContract(fixture()),{
    action:'paid_candidate',reason:'VERIFIED_DEPOSIT_IN_WINDOW',paidAt,bookingAuthorized:false
  });
});

test('mismatched amount, payment intent, mismatched campaign version and missing charge are held for review',()=>{
  const cases=[
    [x=>{x.session.amount_total=2499;},'SESSION_OR_TERMS_MISMATCH'],
    [x=>{x.paymentIntent.amount_received=2499;},'PAYMENT_INTENT_MISMATCH'],
    [x=>{x.paymentIntent.metadata.campaign_version='3';},'PAYMENT_INTENT_MISMATCH'],
    [x=>{x.paymentIntent.latest_charge=null;},'CHARGE_NOT_VERIFIED'],
    [x=>{x.paymentIntent.latest_charge.amount_refunded=2500;},'CHARGE_NOT_VERIFIED']
  ];
  for(const [change,reason] of cases){
    const x=fixture();
    change(x);
    assert.deepEqual(llCmMappedReconcileCheckoutContract(x),{action:'review',reason,bookingAuthorized:false});
  }
});

test('a replay does not authorize booking and a late or already expired charge goes to review',()=>{
  const x=fixture();
  x.hold.state='paid';
  assert.equal(llCmMappedReconcileCheckoutContract(x).action,'already_reconciled');
  x.hold.state='checkout';
  x.paymentIntent.latest_charge.created=Date.parse(deadline)/1000;
  assert.equal(llCmMappedReconcileCheckoutContract(x).reason,'LATE_OR_CLOSED_HOLD_PAYMENT');
  x.paymentIntent.latest_charge.created=Date.parse(paidAt)/1000;
  x.hold.state='expired';
  assert.equal(llCmMappedReconcileCheckoutContract(x).action,'review');
});

test('a different immutable quote or unsafe charge cannot verify the deposit',()=>{
  const cases=[
    [x=>{x.hold.quote_snapshot={...x.hold.quote_snapshot,regularPriceCents:35000};},'SESSION_OR_TERMS_MISMATCH'],
    [x=>{x.paymentIntent.capture_method='manual';},'PAYMENT_INTENT_MISMATCH'],
    [x=>{x.paymentIntent.latest_charge.payment_intent='pi_unrelated';},'CHARGE_NOT_VERIFIED'],
    [x=>{x.paymentIntent.latest_charge.amount_captured=2400;},'CHARGE_NOT_VERIFIED'],
    [x=>{x.paymentIntent.latest_charge.disputed=true;},'CHARGE_NOT_VERIFIED']
  ];
  for(const [change,reason] of cases){
    const input=fixture();
    change(input);
    assert.equal(llCmMappedReconcileCheckoutContract(input).reason,reason);
  }
});

test('expiry requires closed Stripe checkout and a demonstrably unpaid intent',()=>{
  const x=fixture();
  Object.assign(x.session,{payment_status:'unpaid',status:'expired'});
  Object.assign(x.paymentIntent,{status:'processing',amount_received:0});
  assert.equal(llCmMappedReconcileCheckoutContract(x).action,'wait');
  x.paymentIntent.status='canceled';
  assert.equal(llCmMappedReconcileCheckoutContract(x).action,'expiry_candidate');
  x.paymentIntent.metadata.snapshot_id='other-snapshot';
  assert.equal(llCmMappedReconcileCheckoutContract(x).action,'wait');
  x.session.payment_intent=null;
  x.paymentIntent=null;
  assert.equal(llCmMappedReconcileCheckoutContract(x).action,'expiry_candidate');
});

test('receipt distinguishes unsettled, expired and uncertain issuance',()=>{
  const {hold}=fixture();
  const issue={session_id:sessionId,state:'bound'};
  assert.equal(llCmMappedReceiptState(hold,issue,null,at+1000).status,'pending');
  assert.equal(llCmMappedReceiptState(hold,issue,null,at+700000).status,'pending');
  hold.state='expired';
  issue.state='expired';
  assert.equal(llCmMappedReceiptState(hold,issue,null,at+700000).status,'expired');
  hold.state='checkout';
  hold.stripe_session_id=null;
  assert.equal(llCmMappedReceiptState(hold,{state:'issuing'},null,at+700000).status,'review');
});

test('calendar proof and booking failure both preserve settled payment without claiming a native booking',()=>{
  const {hold}=fixture();
  const issue={session_id:sessionId,state:'paid',paid_at:paidAt};
  hold.state='review';
  assert.deepEqual(llCmMappedReceiptState(hold,issue,{state:'calendar_verified',booking_id:'booking'},at+300000),
    {status:'calendar-verified',paid:true,calendarVerified:true,appointmentConfirmed:false});
  assert.deepEqual(llCmMappedReceiptState(hold,issue,{state:'review'},at+300000),
    {status:'review',paid:true,calendarVerified:false,appointmentConfirmed:false});
  issue.session_id='cs_live_unrelated_123456789';
  assert.equal(llCmMappedReceiptState(hold,issue,{state:'calendar_verified',booking_id:'booking'},at+300000).paid,false);
});
