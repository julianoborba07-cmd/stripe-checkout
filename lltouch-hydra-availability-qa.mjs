// LL Touch HydraFacial | QA availability filter, read-only.
// Pure helper: the caller does Vagaro, Google and Supabase reads. No writes.
const TIME=/^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const ms=(value)=>value instanceof Date?value.getTime():new Date(value).getTime();
const validRange=(r)=>r&&Number.isFinite(ms(r.start))&&Number.isFinite(ms(r.end))&&ms(r.end)>ms(r.start);
const overlaps=(w,r)=>ms(w.start)<ms(r.end)&&ms(w.end)>ms(r.start);

export function hydraQaFilteredSlots({date,nowMs,durationMinutes,rawSlots,calendarBusy,bookingBusy,holdBusy,buildWindow}){
  if(!DATE.test(date)||!Number.isFinite(Date.parse(date+'T12:00:00Z'))||
     !Number.isFinite(nowMs)||!Number.isSafeInteger(durationMinutes)||durationMinutes<5||durationMinutes>240||
     !Array.isArray(rawSlots)||rawSlots.length>200||
     ![calendarBusy,bookingBusy,holdBusy].every(Array.isArray)||
     typeof buildWindow!=='function')throw new Error('QA_AVAILABILITY_INPUT_INVALID');
  const dow=new Date(date+'T12:00:00Z').getUTCDay();
  if(dow===0)return [];
  const allBusy=[...calendarBusy,...bookingBusy,...holdBusy];
  if(allBusy.length>3000||!allBusy.every(validRange))throw new Error('QA_BUSY_INTERVAL_UNVERIFIED');
  const unique=new Set();
  for(const raw of rawSlots){
    if(typeof raw!=='string'||!TIME.test(raw))continue;
    const [h,m]=raw.split(':').map(Number);
    const startMinute=h*60+m;
    if(startMinute<9*60 || startMinute>=18*60)continue;
    const window=buildWindow(date,raw,durationMinutes);
    if(!validRange(window)||window.endWallClock?.date!==date)continue;
    if(window.start.getTime()<nowMs+10*60000)continue;
    const endWall=window.endWallClock.time;
    if(!TIME.test(String(endWall||'')))continue;
    const [endH,endM]=endWall.split(':').map(Number);
    if(endH*60+endM>18*60)continue;
    if(allBusy.some(b=>overlaps(window,b)))continue;
    unique.add(raw);
  }
  return Array.from(unique).sort();
}

export function hydraQaHeldIntervals(rows,nowMs){
  if(!Array.isArray(rows)||!Number.isFinite(nowMs)||rows.length>500)
    throw new Error('QA_HOLD_READ_INVALID');
  const out=[];
  for(const r of rows){
    const state=String(r?.state||'');
    if(!['held','checkout','paid','processing','confirmed','review'].includes(state))continue;
    if(state==='held'){
      const exp=Date.parse(r.hold_expires_at||'');
      if(!Number.isFinite(exp))throw new Error('QA_HOLD_EXPIRY_UNKNOWN');
      if(exp<=nowMs)continue;
    }
    const interval={start:r.starts_at,end:r.ends_at};
    if(!validRange(interval))throw new Error('QA_HOLD_WINDOW_INVALID');
    out.push({start:new Date(r.starts_at),end:new Date(r.ends_at)});
  }
  return out;
}
