// Positive suppression only. A negative result is never evidence of nonpayment.
const result=(reason,status='unknown')=>({status,reason,recoveryAuthorized:false});
const email=x=>typeof x==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim())?x.trim().toLowerCase():null;
const phone=x=>{if(typeof x!=='string')return null;const s=x.trim();if(!/^\+?[\d().\s-]+$/.test(s))return null;const d=s.replace(/\D/g,'');return d.length===10?'1'+d:d.length===11&&d.startsWith('1')?d:s.startsWith('+')&&d.length>=8&&d.length<=15?d:null;};
function identity(lead,details){
  const e=email(lead.customer_email),p=phone(lead.customer_phone);
  const es=new Set(details.map(x=>email(x?.email)).filter(Boolean));const ps=new Set(details.map(x=>phone(x?.phone)).filter(Boolean));
  const em=e&&es.has(e),pm=p&&ps.has(p);
  if(!em&&!pm)return 'none';
  if((e&&es.size&&(!em||es.size>1))||(p&&ps.size&&(!pm||ps.size>1)))return 'conflict';
  return 'match';
}
function category(value){const t=String(value||'').toLowerCase();const found=[[/\bhydra[\s-]*facial\b/,'hydrafacial'],[/\bmorpheus\s*8\b/,'morpheus8'],[/\blaser\s+hair\s+removal\b|\blaser\s+offer\b/,'laser'],[/\bmicro[\s-]*needling\b/,'microneedling']].filter(([r])=>r.test(t)).map(([,k])=>k);return found.length===1?found[0]:null;}
async function* pages(list,params,maxPages){let cursor;for(let i=0;i<maxPages;i++){const p=await list({...params,limit:100,...(cursor?{starting_after:cursor}:{})});if(!p||!Array.isArray(p.data)||typeof p.has_more!=='boolean'||p.data.length>100)throw Error('LIST_INVALID');for(const row of p.data)yield row;if(!p.has_more)return;const next=p.data.at(-1)?.id;if(!next||next===cursor)throw Error('PAGINATION_INVALID');cursor=next;}throw Error('SCAN_LIMIT');}
export async function externalPaymentEvidence({stripe,campaign,lead,now=Date.now(),maxPages=3}){
  // The campaign window is intentionally bounded; earlier or differently identified payments remain unknown.
  const start=Date.parse(campaign?.offer_starts_at);const leadAt=Date.parse(lead?.created_at);const service=category(campaign?.service_title);
  if(!stripe||!Number.isFinite(start)||!Number.isFinite(leadAt)||start>leadAt||leadAt>now||now-start>40*86400000||(!email(lead?.customer_email)&&!phone(lead?.customer_phone))||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>3)return result('STRIPE_EXTERNAL_SCOPE_UNKNOWN');
  const created={gte:Math.floor(start/1000),lte:Math.floor(now/1000)};
  try{
    for await(const s of pages(p=>stripe.checkout.sessions.list(p),{created},maxPages)){
      if(s?.livemode!==true||typeof s.id!=='string'||!s.id.startsWith('cs_live_'))throw Error('MODE_UNKNOWN');
      if(s.mode!=='payment'||(s.status==='expired'&&s.payment_status==='unpaid'))continue;
      const m=identity(lead,[s.customer_details,{email:s.customer_email}]);if(m==='none')continue;
      if(m==='conflict')return result('STRIPE_EXTERNAL_IDENTITY_REVIEW','blocked');
      if(s.payment_status!=='paid'||s.status!=='complete'||!Number.isSafeInteger(s.amount_total)||s.amount_total<=0)return result('STRIPE_EXTERNAL_CHECKOUT_REVIEW','blocked');
      let matched=false;for await(const item of pages(p=>stripe.checkout.sessions.listLineItems(s.id,p),{},maxPages)){if(service&&category(item?.description)===service)matched=true;}
      return result(matched?'STRIPE_PAID_MATCHING_SERVICE':'STRIPE_PAID_SERVICE_REVIEW','blocked');
    }
    for await(const ch of pages(p=>stripe.charges.list(p),{created},maxPages)){
      if(ch?.livemode!==true||typeof ch.id!=='string'||!ch.id.startsWith('ch_'))throw Error('MODE_UNKNOWN');
      if(!['succeeded','pending'].includes(ch.status)&&ch.paid!==true)continue;
      const m=identity(lead,[ch.billing_details,{email:ch.receipt_email}]);if(m==='none')continue;
      if(m==='conflict')return result('STRIPE_EXTERNAL_IDENTITY_REVIEW','blocked');
      // A charge alone cannot establish the campaign conversion or exact product.
      return result('STRIPE_CHARGE_REQUIRES_REVIEW','blocked');
    }
    return result('STRIPE_EXTERNAL_NO_MATCH_NOT_PROOF');
  }catch(_e){return result('STRIPE_EXTERNAL_EVIDENCE_UNAVAILABLE');}
}
