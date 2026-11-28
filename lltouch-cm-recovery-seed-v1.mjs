// Scheduler only. No contacts, payment calls, workflow calls or SMS.
export function createRecoverySeedWorker({enabled,listCampaigns,seed,now=Date.now}) {
  let busy=false;
  return async function tick(){
    if(!enabled())return {status:'disabled',seeded:0};
    if(busy)return {status:'busy',seeded:0};
    busy=true;
    try {
      const rows=await listCampaigns();
      if(!Array.isArray(rows)||rows.length>1)return {status:'blocked',seeded:0};
      if(!rows.length)return {status:'idle',seeded:0};
      const c=rows[0],t=now();
      if(!c||c.status!=='published'||!/^[a-z0-9][a-z0-9-]{3,95}$/.test(c.campaign_key||'')||!Number.isSafeInteger(c.version)||c.version<1||!(Date.parse(c.offer_starts_at)<=t&&t<Date.parse(c.offer_ends_at))||c.marketing?.campaignMeta?.mappedRecoveryPlanningAuthorized!==true||!enabled())return {status:'blocked',seeded:0};
      const n=await seed(c.campaign_key,c.version);
      if(!Number.isSafeInteger(n)||n<0||n>50)throw Error('invalid seed response');
      return {status:'ok',seeded:n};
    }catch(_e){return {status:'unavailable',seeded:0};}
    finally{busy=false;}
  };
}
