// LL Touch HydraFacial — Stripe TEST preview of an immutable Campaign Studio quote.
// QA ONLY. Pure helpers. No calendar, Vagaro, webhook, CRM, or public checkout.
export const HYDRA_QA_STRIPE_SCOPE = 'lltouch-hydra-bridge-test-qa-v1';
export const HYDRA_QA_PUBLIC_URL = 'https://lltouch-campaign-studio-qa.onrender.com';
const SERVICE_KEY = 'hydrafacial-piloto-qa';
const MAX_KEY = /^[a-z0-9][a-z0-9-]{3,95}$/;
const canInt = (v)=>Number.isSafeInteger(v)&&v>=0;
const strict = (v,m)=>{if(!v)throw new Error(m)};

export function makeHydraStripeQaCheckout(bridge,{nowMs=Date.now(),nonce,baseUrl=HYDRA_QA_PUBLIC_URL}={}){
  strict(bridge?.ok===true && bridge.qaOnly===true && bridge.readOnly===true, 'QA_BRIDGE_REQUIRED');
  strict(bridge.configurationMapped===true && Array.isArray(bridge.errors)&&bridge.errors.length===0,
    'QA_CAMPAIGN_CONTRACT_NOT_READY');
  strict(bridge.campaignKey===SERVICE_KEY && MAX_KEY.test(bridge.campaignKey), 'QA_PILOT_KEY_MISMATCH');
  strict(bridge.campaignPurpose==='internal_test' && bridge.status==='draft', 'QA_PILOT_NOT_ISOLATED');
  strict(bridge.publicReleaseApproved===false && bridge.readyForPayments===false,
    'QA_BRIDGE_BECAME_PUBLIC');
  const c=bridge.preview;
  strict(c && c.enabled===false && c.campaignKey===bridge.campaignKey && c.campaignVersion===bridge.version,
    'QA_SNAPSHOT_MISMATCH');
  strict(Number.isSafeInteger(c.campaignVersion)&&c.campaignVersion>0,'QA_VERSION_INVALID');
  strict(c.title==='HydraFacial' && c.siteItem?.service==='hydrafacial' &&
    c.siteItem?.package==='single' && c.siteItem?.quantity===1, 'QA_SERVICE_MISMATCH');
  strict(c.timezone==='America/New_York' && c.holdMinutes===10 &&
    c.providerKeys?.includes('ludimilla') && c.providerKeys?.includes('carol'), 'QA_BOOKING_CONTRACT_MISMATCH');
  strict(canInt(c.priceCents)&&canInt(c.depositCents)&&canInt(c.regularPriceCents)&&
    c.regularPriceCents===34900 && c.priceCents===14900 && c.depositCents===2500 &&
    c.balanceDueCents===12400 && c.regularPriceCents>c.priceCents, 'QA_PRICE_MISMATCH');
  const begin=Date.parse(c.offerStartsAt),end=Date.parse(c.offerEndsAt);
  strict(Number.isFinite(begin)&&Number.isFinite(end)&&begin<=nowMs&&nowMs<end,
    'QA_WINDOW_CLOSED');
  strict(c.offerEndsAt.startsWith('2027-01-01T05:00:00'), 'QA_END_DATE_MISMATCH');
  strict(/^https:\/\/[a-z0-9.-]+$/.test(baseUrl) && baseUrl===HYDRA_QA_PUBLIC_URL,'QA_RETURN_URL_INVALID');
  strict(typeof nonce==='string' && /^[0-9a-f-]{36}$/.test(nonce),'QA_NONCE_INVALID');
  const metadata={cm_scope:HYDRA_QA_STRIPE_SCOPE,cm_test_only:'true',campaign_key:c.campaignKey,
    campaign_version:String(c.campaignVersion),offer_cents:String(c.priceCents),
    deposit_cents:String(c.depositCents),balance_cents:String(c.balanceDueCents),
    test_nonce:nonce};
  const payload={
    mode:'payment',payment_method_types:['card'],client_reference_id:c.campaignKey,
    expires_at:Math.floor(nowMs/1000)+1860,
    line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:c.depositCents,
      product_data:{name:'HydraFacial — QA TEST ONLY',
        description:'TEST MODE ONLY: $25 simulated deposit for a $149 HydraFacial; $124 simulated balance. NO APPOINTMENT WILL BE BOOKED.'}}}],
    metadata,payment_intent_data:{metadata},
    success_url:baseUrl+'/lltouch/campaigns/admin/hydrafacial?qa_session_id={CHECKOUT_SESSION_ID}',
    cancel_url:baseUrl+'/lltouch/campaigns/admin/hydrafacial?qa_test_cancel=1'
  };
  return {payload,idempotencyKey:`lltouch-hydra-qa-v1-${nonce}`,expectedAmountCents:2500};
}

export function verifyHydraStripeQaSession(session){
  strict(session?.object==='checkout.session' && session?.livemode===false &&
    /^cs_test_[A-Za-z0-9_]{10,180}$/.test(String(session.id||'')), 'QA_SESSION_NOT_TEST');
  const m=session.metadata||{};
  strict(m.cm_scope===HYDRA_QA_STRIPE_SCOPE && m.cm_test_only==='true' &&
    m.campaign_key===SERVICE_KEY && /^\d+$/.test(String(m.campaign_version||'')),
    'QA_SESSION_SCOPE_MISMATCH');
  strict(session.currency==='usd' && session.amount_total===2500 &&
    m.offer_cents==='14900' && m.deposit_cents==='2500' && m.balance_cents==='12400',
    'QA_SESSION_AMOUNT_MISMATCH');
  return {ok:true,qaOnly:true,sessionId:session.id,campaignKey:m.campaign_key,
    campaignVersion:Number(m.campaign_version),depositCents:2500,offerCents:14900,
    balanceDueCents:12400,paymentStatus:session.payment_status,checkoutStatus:session.status,
    bookingCreated:false,crmDispatched:false,realPayment:false,
    note:'Somente Stripe TEST. Sem agendamento ou publicação comercial.'};
}
