// LL Touch Campaign Studio — HydraFacial compatibility bridge, QA ONLY.
// No Stripe, Vagaro, calendar, GHL, external network, or database mutations.
const DEFAULT_TERMS = Object.freeze({regularPriceCents:34900,priceCents:14900,depositCents:2500});
const SERVICE = Object.freeze({type:'med-spa',service:'hydrafacial',package:'single',addon:'none',quantity:1});
const LIVE_STATUSES = new Set(['draft','scheduled','published','paused','archived']);
const safeText = (v,max=1500)=>typeof v==='string'?v.trim().slice(0,max):'';
const isHttps = value => {
  if(typeof value!=='string'||value.length>2048||/[\s<>"']/.test(value))return false;
  try { const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&Boolean(url.hostname); }
  catch {return false;}
};
const isInt = (n,min=0)=>Number.isSafeInteger(n)&&n>=min;

/** Pure contract adapter from database rows to the legacy HydraFacial config.
 *  A draft is previewable only. No field in this response authorizes a charge. */
export function buildHydraBridge(c, assets=[], opts={}) {
  if(!c||typeof c!=='object')throw new TypeError('Campaign required');
  const now=Number.isFinite(opts.nowMs)?opts.nowMs:Date.now();
  const errors=[],notices=[];
  const check=(ok,code,message)=>{if(!ok)errors.push({code,message});};
  const item=c.site_item||{};
  const serviceMatch=Object.entries(SERVICE).every(([k,v])=>item[k]===v);
  check(serviceMatch,'SERVICE_MISMATCH','Selecione o serviço HydraFacial single já mapeado no Editor.');
  check(LIVE_STATUSES.has(c.status),'STATUS_INVALID','Estado de campanha inválido.');
  const windowStart=Date.parse(c.offer_starts_at||'');
  const windowEnd=Date.parse(c.offer_ends_at||'');
  check(Number.isFinite(windowStart)&&Number.isFinite(windowEnd)&&windowStart<windowEnd&&windowEnd>now,
    'WINDOW_INVALID','Defina novas datas válidas; a campanha anterior de novembro expirou.');
  check(c.timezone==='America/New_York','TIMEZONE_INVALID','Use America/New_York para Massachusetts.');
  check(isInt(c.regular_price_cents,1)&&isInt(c.price_cents,1)&&
        c.regular_price_cents>c.price_cents&&isInt(c.deposit_cents,0)&&
        c.deposit_cents<=c.price_cents,'PRICE_INVALID','Revise preço regular, oferta e depósito.');
  check(c.hold_minutes===10,'HOLD_MISMATCH','O motor original usa reserva de 10 minutos.');
  const m=c.marketing&&typeof c.marketing==='object'&&!Array.isArray(c.marketing)?c.marketing:{};
  check(safeText(m.headline,200).length>=3&&safeText(m.description,1500).length>=15,
    'COPY_MISSING','Headline e descrição são obrigatórias.');
  const providers=Array.isArray(c.provider_keys)?c.provider_keys:[];
  check(providers.length===2&&new Set(providers).size===2&&
        providers.includes('ludimilla')&&providers.includes('carol'),
    'PROVIDERS_INVALID','O piloto HydraFacial requer Ludimilla e Carol.');
  const getAsset=(device)=>(assets||[]).find(a=>a.asset_type==='hero'&&a.device===device&&a.position===0&&isHttps(a.image_url));
  const desktop=getAsset('desktop')||getAsset('all');
  const mobile=getAsset('mobile')||getAsset('tablet')||desktop;
  check(Boolean(desktop&&mobile),'HERO_MISSING','Salve capas HTTPS válidas para desktop e celular.');
  check(opts.vagaroMappingReady===true,'VAGARO_MAPPING_UNVERIFIED','O mapeamento HydraFacial/Vagaro não foi confirmado neste ambiente.');
  const displayable = errors.length===0;
  if(c.campaign_purpose!=='commercial')notices.push('Finalidade de teste: não pode ser publicada comercialmente.');
  if(c.status!=='published')notices.push('Rascunho ou campanha não publicada: visualização privada somente.');
  if(opts.legacyCampaignKey && opts.legacyCampaignKey!==c.campaign_key)
    notices.push('O funil anterior usa uma chave fixa diferente. Não reutilize o checkout legado sem a adaptação de todos os endpoints e webhooks.');
  const contract={
    // These are the fields used by the existing /lltouch/offer/config contract.
    enabled:false, // ALWAYS false: QA bridge never enables a public or financial action.
    campaignKey:safeText(c.campaign_key,100),campaignVersion:c.version,
    title:safeText(c.service_title,160),
    regularPriceCents:c.regular_price_cents,priceCents:c.price_cents,
    depositCents:c.deposit_cents,balanceDueCents:c.price_cents-c.deposit_cents,holdMinutes:c.hold_minutes,
    offerLabel:safeText(c.offer_label,160),
    offerStartsAt:c.offer_starts_at,offerEndsAt:c.offer_ends_at,
    timezone:c.timezone,providerKeys:[...providers],siteItem:{...SERVICE},
    preferredBookingEnabled:c.preferred_booking_enabled===true,
    marketing:{headline:safeText(m.headline,200),headlineEm:safeText(m.headlineEm,200),
      description:safeText(m.description,1500),featureIntro:safeText(m.featureIntro,1500),
      features:Array.isArray(m.features)?m.features.slice(0,6):[]},
    hero:{desktop:desktop?.image_url||null,mobile:mobile?.image_url||null}
  };
  return {ok:true,mode:'hydrafacial-original-reuse',qaOnly:true,readOnly:true,
    stage:'HydraFacial QA Compatibility Bridge',
    campaignKey:contract.campaignKey,version:c.version,status:c.status,
    campaignPurpose:c.campaign_purpose,
    configurationMapped:displayable,readyForPayments:false,readyForBookings:false,
    publicReleaseApproved:false,legacyEngineStaticKey:opts.legacyCampaignKey||null,
    errors,notices,preview:contract,
    nextGate:'Wire hold, availability, checkout, Stripe webhook, receipt and booking to one versioned campaign snapshot before enabling the public page.'};
}

/** Creates a safe HydraFacial draft from the tested legacy offer data.
 *  Nothing can be published: status=draft and purpose=internal_test are forced. */
export function makeHydraQaDraft(input,legacy,opts={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid draft input');
  const allowed=['campaignKey','internalName','startDate','endDate','regularPriceUsd','offerPriceUsd','depositUsd'];
  if(Object.keys(input).some(k=>!allowed.includes(k))||['campaignKey','internalName','startDate','endDate'].some(k=>typeof input[k]!=='string'))
    throw Error('Invalid draft fields');
  const key=input.campaignKey.trim(),name=input.internalName.trim();
  if(!/^[a-z0-9][a-z0-9-]{3,95}$/.test(key)||name.length<3||name.length>160)
    throw Error('Invalid campaign key or name');
  const validDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T12:00:00Z'))&&
    new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d;
  const start=input.startDate.trim(),end=input.endDate.trim();
  if(!validDate(start)||!validDate(end)||end<start||
    Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z')>44*86400000)
    throw Error('Período inválido: escolha datas válidas, com até 45 dias corridos incluindo o último dia.');
  const now=Number.isFinite(opts.nowMs)?opts.nowMs:Date.now();
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const today=p.year+'-'+p.month+'-'+p.day;
  if(start<today)throw Error('Start date in past');
  function maMidnight(date){
    const guess=new Date(date+'T05:00:00Z');
    const tz=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}).formatToParts(guess)
      .find(x=>x.type==='timeZoneName')?.value||'';
    const m=tz.match(/^GMT([+-]\d{1,2})(?::(\d{2}))?$/);
    if(!m)throw Error('Cannot resolve Massachusetts timezone');
    const minutes=Number(m[1])*60+Math.sign(Number(m[1]))*Number(m[2]||0);
    return new Date(Date.parse(date+'T00:00:00Z')-minutes*60000).toISOString();
  }
  const afterEnd=new Date(Date.parse(end+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  function dollars(v,defaultCents){
    if(v===undefined)return defaultCents;
    if(typeof v!=='string'||!/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?$/.test(v))throw Error('Invalid USD amount');
    const [whole,cents='']=v.split('.');
    return Number(whole)*100+Number(cents.padEnd(2,'0'));
  }
  const regularPriceCents=dollars(input.regularPriceUsd,DEFAULT_TERMS.regularPriceCents);
  const priceCents=dollars(input.offerPriceUsd,DEFAULT_TERMS.priceCents);
  const depositCents=dollars(input.depositUsd,DEFAULT_TERMS.depositCents);
  if(!isInt(priceCents,2500)||!isInt(depositCents,0)||!isInt(regularPriceCents,1)||
      depositCents>priceCents||priceCents>=regularPriceCents||legacy?.holdMinutes!==10)
    throw Error('Offer/deposit/regular price is invalid');
  const duration=opts.bookingDurationMinutes;
  if(!isInt(duration,5)||duration>480)throw Error('Vagaro HydraFacial service mapping required');
  return {
    campaign_key:key,internal_name:name,status:'draft',campaign_purpose:'internal_test',
    service_title:'HydraFacial',site_item:{...SERVICE},currency:'usd',
    regular_price_cents:regularPriceCents,price_cents:priceCents,
    deposit_cents:depositCents,hold_minutes:10,treatment_duration_min:duration,
    preferred_booking_enabled:true,preferred_max_days:90,
    preferred_start_time:'09:00',preferred_end_time:'18:00',
    provider_keys:['ludimilla','carol'],offer_starts_at:maMidnight(start),
    offer_ends_at:maMidnight(afterEnd),timezone:'America/New_York',
    offer_label:'HydraFacial · Campaign Studio Pilot',
    marketing:structuredClone(legacy.marketing||{}),ghl_settings:{}
  };
}

export function hydraBridgeHtml(){return String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LL Touch · HydraFacial QA Bridge</title>
<style>
:root{color-scheme:light;--ink:#392a23;--muted:#74675f;--paper:#f5f2ed;--surface:#fffdfa;--line:#e4dbd2;--copper:#a4784e;--warn:#8c4c27}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}main{max-width:960px;margin:0 auto;padding:38px 22px 90px}nav{display:flex;gap:18px;flex-wrap:wrap}a{color:var(--ink)}h1,h2{font-family:Georgia,serif;font-weight:normal}h1{font-size:42px;margin:16px 0 9px}.muted{color:var(--muted)}.notice{border-left:3px solid var(--copper);background:#ebe4db;padding:15px 18px;margin:20px 0}.card{background:var(--surface);border:1px solid var(--line);padding:22px;border-radius:10px;margin-top:18px}.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}input,select,button{font:inherit;padding:11px 13px;background:white;border:1px solid var(--line);border-radius:7px}input{padding:11px 13px;background:white;border:1px solid var(--line);border-radius:7px;max-width:100%}label{display:block;margin:7px 0}select{flex:1;min-width:240px}button{cursor:pointer;background:#392a23;color:white}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.stat{padding:12px;background:#f6f2ed;border-radius:7px}.stat small{display:block;color:var(--muted)}.warn{padding:9px 12px;margin:7px 0;background:#fbf0e9;border-left:3px solid #b66b42}.good{padding:11px;background:#edf4ef;color:#28583b;border-radius:7px}pre{overflow:auto;background:#f4f0eb;border-radius:6px;padding:16px;font-size:12px;max-height:440px}small{font-size:12px}@media(max-width:700px){h1{font-size:33px}.summary{grid-template-columns:1fr}}</style>
</head><body><main><nav><a href="/lltouch/campaigns/admin/lifecycle">Lifecycle</a><a href="/lltouch/campaigns/admin/editor">Editor</a><a href="/lltouch/campaigns/admin/ai">Criar campanha com IA</a></nav>
<h1>HydraFacial · QA Bridge</h1><p class="muted">Comparação entre uma campanha do Supabase e o contrato do funil HydraFacial testado anteriormente. Esta tela não cobra, agenda, publica nem envia mensagens.</p>
<div class="notice"><strong>Recuperação do fluxo original — fase de conexão.</strong> A configuração é lida da campanha selecionada; as rotas antigas de pagamento ainda não estão conectadas a esta configuração. Nenhuma data de novembro é reutilizada.</div>
<div class="card"><h2>Criar piloto HydraFacial no QA</h2><p class="muted">Serviço, profissionais e fluxo técnico reaproveitados da campanha anterior. Oferta padrão US$ 149 (regular US$ 349), depósito US$ 25 e saldo US$ 124; valores e datas são configuráveis aqui. A campanha nasce em rascunho de teste; sem publicação, pagamento ou agendamento.</p><form id="createForm"><div class="row"><label>Nome interno<br><input name="internalName" value="HydraFacial · Piloto QA" required maxlength="160"></label><label>Identificador<br><input name="campaignKey" value="hydrafacial-piloto-qa" required pattern="[a-z0-9][a-z0-9-]{3,95}"></label></div><div class="row"><label>Preço regular (US$)<br><input type="number" name="regularPriceUsd" value="349.00" min="25" max="99999" step="0.01" required></label><label>Preço da oferta (US$)<br><input type="number" name="offerPriceUsd" value="149.00" min="25" max="99999" step="0.01" required></label><label>Depósito (US$)<br><input type="number" name="depositUsd" value="25.00" min="0" max="99999" step="0.01" required></label></div><div class="row"><label>Início (Massachusetts)<br><input type="date" name="startDate" required></label><label>Último dia (Massachusetts)<br><input type="date" name="endDate" required></label><button type="submit">Criar rascunho QA</button></div></form><p id="created" class="muted" role="status"></p></div>
<div class="card"><label for="campaign">Campanha cadastrada</label><div class="row"><select id="campaign" aria-label="Selecionar campanha"></select><button type="button" id="refresh">Verificar compatibilidade</button></div><p id="message" class="muted" role="status">Carregando…</p></div>
<div class="card" id="report" hidden><h2>Contrato reutilizável</h2><div class="summary"><div class="stat"><small>Configuração</small><strong id="config">—</strong></div><div class="stat"><small>Checkout</small><strong>Bloqueado em QA</strong></div><div class="stat"><small>Agendamento</small><strong>Bloqueado em QA</strong></div></div><div class="notice"><h2>Checkout Stripe TEST · US$ 25</h2><p>Teste isolado da campanha HydraFacial US$ 149. Não cria agendamento, não recebe pagamento real e não envia mensagens. Use somente cartão de teste Stripe.</p><button id="checkoutTest" type="button">Abrir checkout Stripe TEST (US$ 25)</button><p id="checkoutStatus" role="status" class="muted">A disponibilidade do teste depende da autorização do ambiente QA.</p></div><div class="notice"><h2>Disponibilidade · Ludimilla e Carol (somente leitura)</h2><p>Consulta Vagaro + Google Calendar + Supabase. Não bloqueia horários, não cria reservas e não modifica a agenda.</p><div class="row"><label>Profissional<br><select id="hydraQaProvider"><option value="ludimilla">Ludimilla</option><option value="carol">Carol</option></select></label><label>Data (Massachusetts)<br><input type="date" id="hydraQaDate"></label><button type="button" id="hydraQaCheck">Consultar horários</button></div><div id="hydraQaSlots" class="muted" role="status">Escolha uma data até 28 dias à frente e consulte a disponibilidade.</div></div><h2>Verificações</h2><div id="issues"></div><h2>Configuração da campanha</h2><pre id="contract"></pre></div>
</main><script nonce="__NONCE__">(function(){'use strict';var $=id=>document.getElementById(id);var base='/lltouch/campaigns/admin/api/';function show(x){$('message').textContent=x}async function get(path){var r=await fetch(base+path,{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);var x=await r.json();if(!x.ok)throw new Error('Resposta inválida');return x}async function load(){try{var data=await get('campaigns');var rows=Array.isArray(data.campaigns)?data.campaigns:[];var select=$('campaign');while(select.firstChild)select.removeChild(select.firstChild);rows.forEach(function(c){var o=document.createElement('option');o.value=c.campaignKey;o.textContent=c.internalName+' · '+c.campaignKey+' · '+c.status;select.appendChild(o)});if(!rows.length){show('Nenhuma campanha cadastrada. Crie um rascunho pelo Editor ou pelo estúdio de IA.');return}var hydra=rows.find(x=>/hydrafacial/i.test(x.serviceTitle||''));if(hydra)select.value=hydra.campaignKey;await run()}catch(e){show('Falha na listagem: '+e.message)}}async function run(){var key=$('campaign').value;if(!key)return;show('Consultando configuração QA…');$('report').hidden=true;try{var data=await get('reuse/hydrafacial/'+encodeURIComponent(key));$('report').hidden=false;$('config').textContent=data.configurationMapped?'Compatível':'Revisão necessária';var root=$('issues');while(root.firstChild)root.removeChild(root.firstChild);var issues=(data.errors||[]).map(x=>x.message).concat(data.notices||[]);if(!issues.length){var d=document.createElement('div');d.className='good';d.textContent='Contrato validado em leitura. Pagamentos e agenda continuam desligados.';root.appendChild(d)}issues.forEach(function(i){var d=document.createElement('div');d.className='warn';d.textContent=i;root.appendChild(d)});$('contract').textContent=JSON.stringify(data.preview,null,2);show('Consulta concluída; nenhuma alteração feita.')}catch(e){show('Não foi possível consultar: '+e.message)}}$('createForm').addEventListener('submit',async function(e){e.preventDefault();var f=e.currentTarget;var button=f.querySelector('button');button.disabled=true;$('created').textContent='Salvando rascunho no PREVIEW…';try{var body={campaignKey:f.elements.campaignKey.value,internalName:f.elements.internalName.value,startDate:f.elements.startDate.value,endDate:f.elements.endDate.value,regularPriceUsd:f.elements.regularPriceUsd.value,offerPriceUsd:f.elements.offerPriceUsd.value,depositUsd:f.elements.depositUsd.value};var r=await fetch(base+'reuse/hydrafacial/draft',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});var data=await r.json();if(!r.ok||data.ok!==true)throw new Error(data.error||'HTTP '+r.status);$('created').textContent='Rascunho criado: '+data.campaignKey+'. Configure imagens em Capas; nenhuma campanha foi publicada.';await load();$('campaign').value=data.campaignKey;await run()}catch(err){$('created').textContent='Falha: '+err.message}finally{button.disabled=false}});
$('checkoutTest').addEventListener('click',async function(){
  if(!confirm('Abrir pagamento de TESTE (US$ 25 fictícios). Não será criado agendamento. Continuar?'))return;
  var button=this;button.disabled=true;$('checkoutStatus').textContent='Criando sessão Stripe TEST…';
  try{var key=$('campaign').value;
    if(key!=='hydrafacial-piloto-qa')throw Error('Selecione HydraFacial · Piloto QA.');
    var r=await fetch(base+'reuse/hydrafacial/stripe-test/'+encodeURIComponent(key),{
      method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});
    var d=await r.json();if(!r.ok||d.ok!==true)throw Error(d.error||'HTTP '+r.status);
    if(!/^https:\/\/checkout\.stripe\.com\//.test(d.url||''))throw Error('URL Stripe inválida');
    window.location.assign(d.url);
  }catch(e){$('checkoutStatus').textContent='Teste indisponível: '+e.message;button.disabled=false;}
});
(async function(){
  var sid=new URLSearchParams(window.location.search).get('qa_session_id');
  if(!sid)return;
  try{var d=await get('reuse/hydrafacial/stripe-test/status?session_id='+encodeURIComponent(sid));
    $('checkoutStatus').textContent='Stripe TEST: '+d.paymentStatus+' · US$ 25 de teste · Agendamento não realizado.';
  }catch(e){$('checkoutStatus').textContent='Não foi possível verificar a sessão TEST: '+e.message;}
})();
(function(){
  var parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  var fields={};parts.forEach(function(p){fields[p.type]=p.value});
  $('hydraQaDate').value=fields.year+'-'+fields.month+'-'+fields.day;
})();
$('hydraQaCheck').addEventListener('click',async function(){
  var key=$('campaign').value;
  var result=$('hydraQaSlots');
  if(key!=='hydrafacial-piloto-qa'){result.textContent='Selecione a campanha HydraFacial · Piloto QA.';return}
  var d=$('hydraQaDate').value, p=$('hydraQaProvider').value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!['ludimilla','carol'].includes(p)){
    result.textContent='Escolha data e profissional válidos.';return;
  }
  var button=this;button.disabled=true;result.textContent='Consultando Vagaro, Google Calendar e Supabase…';
  try{
    var x=await get('reuse/hydrafacial/availability/'+encodeURIComponent(key)+'?date='+encodeURIComponent(d)+'&provider='+encodeURIComponent(p));
    result.textContent=x.slots.length?'Horários encontrados: '+x.slots.join(' · ')+' (horário de Massachusetts). Consulta informativa.':'Nenhum horário confirmado para essa data. Consulte outro dia.';
  }catch(e){result.textContent='Consulta indisponível: '+e.message}
  finally{button.disabled=false}
});
$('refresh').addEventListener('click',run);$('campaign').addEventListener('change',run);load();})();</script></body></html>`}
