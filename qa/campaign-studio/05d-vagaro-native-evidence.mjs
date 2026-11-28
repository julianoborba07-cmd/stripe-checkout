import {readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9._:+/=\-]{1,200}$/.test(value);
function instant(value){
  if(typeof value!=='string'||
     !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return NaN;
  const day=value.slice(0,10);
  const midnight=new Date(day+'T00:00:00Z');
  if(!Number.isFinite(midnight.getTime())||midnight.toISOString().slice(0,10)!==day)return NaN;
  return Date.parse(value);
}
const verdict=(status,reason,appointmentId=null)=>({status,reason,appointmentId,provenanceVerified:false});

// Normalize the approved export or authenticated connector response into this
// contract before comparison. The CLI cannot establish the origin of a file.
export function matchVagaroNativeEvidence(booking,exported){
  const keys=['businessId','bookingId','googleEventId','providerId','serviceId'];
  const start=instant(booking?.startsAt),end=instant(booking?.endsAt);
  if(!keys.every(key=>identifier(booking?.[key]))||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)
    return verdict('unverified','INVALID_BOOKING_REFERENCE');
  if(!Array.isArray(exported?.records)||exported.records.length>5000)
    return verdict('unverified','INVALID_VAGARO_EXPORT');
  const scoped=exported.records.filter(row=>row?.businessId===booking.businessId&&row.kind==='appointment'&&
    row.correlation?.bookingId===booking.bookingId&&row.correlation?.googleEventId===booking.googleEventId);
  if(scoped.length!==1)
    return verdict('unverified',scoped.length>1?'AMBIGUOUS_NATIVE_CORRELATION':'MISSING_NATIVE_CORRELATION');
  const [row]=scoped;
  if(!identifier(row.appointmentId)||[booking.bookingId,booking.googleEventId].includes(row.appointmentId)||
     exported.records.filter(candidate=>candidate?.businessId===booking.businessId&&candidate.kind==='appointment'&&
       candidate.appointmentId===row.appointmentId).length!==1)
    return verdict('unverified','INVALID_NATIVE_APPOINTMENT_ID');
  if(row.status!=='confirmed'||row.providerId!==booking.providerId||row.serviceId!==booking.serviceId||
     instant(row.startsAt)!==start||instant(row.endsAt)!==end)
    return verdict('unverified','NATIVE_APPOINTMENT_DETAILS_MISMATCH');
  return verdict('matched','STRUCTURAL_MATCH_REQUIRES_TRUSTED_SOURCE',row.appointmentId);
}

async function readJson(file){
  const info=await stat(file);
  if(!info.isFile()||info.size>2097152)throw Error('Invalid local evidence file');
  return JSON.parse(await readFile(file,'utf8'));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv.length!==4)throw Error('Expected booking and normalized export paths');
    const [booking,exported]=await Promise.all(process.argv.slice(2).map(readJson));
    const result=matchVagaroNativeEvidence(booking,exported);
    console.log(JSON.stringify(result));
    if(result.status!=='matched')process.exitCode=1;
  }catch{
    console.error('Provide two local JSON files with the booking anchor and the normalized Vagaro export.');
    process.exitCode=2;
  }
}
