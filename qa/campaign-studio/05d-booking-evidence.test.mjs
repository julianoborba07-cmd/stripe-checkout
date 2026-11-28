import assert from 'node:assert/strict';
import test from 'node:test';
import {mappedGoogleBookingMatches} from '../../lltouch-cm-booking-evidence-v1.mjs';
import {matchVagaroNativeEvidence} from './05d-vagaro-native-evidence.mjs';

const booking={
  businessId:'synthetic-tenant',bookingId:'synthetic-booking',googleEventId:'synthetic-google-event',
  providerId:'c3ludGhldGljL3Byb3ZpZGVy+A==',serviceId:'c3ludGhldGljL3NlcnZpY2U/=',
  startsAt:'2027-02-02T15:00:00.000Z',endsAt:'2027-02-02T16:00:00.000Z'
};
const native={
  kind:'appointment',status:'confirmed',appointmentId:'synthetic-native-id',businessId:booking.businessId,
  providerId:booking.providerId,serviceId:booking.serviceId,
  startsAt:'2027-02-02T10:00:00-05:00',endsAt:'2027-02-02T11:00:00-05:00',
  correlation:{bookingId:booking.bookingId,googleEventId:booking.googleEventId}
};
const row={
  id:booking.bookingId,google_event_id:booking.googleEventId,stripe_session_id:'synthetic-stripe',
  service_id:booking.serviceId,starts_at:booking.startsAt,ends_at:booking.endsAt
};
const event={
  id:row.google_event_id,status:'confirmed',transparency:'opaque',
  start:{dateTime:row.starts_at},end:{dateTime:row.ends_at},
  extendedProperties:{private:{llTouchBooking:'1',llTouchBookingId:row.id,
    stripeSessionId:row.stripe_session_id,serviceId:row.service_id}}
};

test('exact correlated native appointment is a structural match that still requires external provenance',()=>{
  assert.deepEqual(matchVagaroNativeEvidence(booking,{records:[native]}),{
    status:'matched',reason:'STRUCTURAL_MATCH_REQUIRES_TRUSTED_SOURCE',appointmentId:native.appointmentId,
    provenanceVerified:false
  });
});

test('Google events and Personal Tasks do not provide native evidence',()=>{
  for(const records of [[event],[{...native,kind:'personal_task'}],[{...native,correlation:undefined}]]){
    assert.equal(matchVagaroNativeEvidence(booking,{records}).reason,'MISSING_NATIVE_CORRELATION');
  }
});

test('duplicate correlation and reused or borrowed native identity fail closed',()=>{
  assert.equal(matchVagaroNativeEvidence(booking,{records:[native,{...native,appointmentId:'second-id'}]}).reason,'AMBIGUOUS_NATIVE_CORRELATION');
  for(const records of [
    [{...native,appointmentId:booking.googleEventId}],
    [native,{...native,correlation:{bookingId:'different-booking',googleEventId:'different-event'}}]
  ]){
    assert.equal(matchVagaroNativeEvidence(booking,{records}).reason,'INVALID_NATIVE_APPOINTMENT_ID');
  }
});

test('tenant, provider, service, exact timezone window and confirmation status are required',()=>{
  for(const changes of [{businessId:'other-tenant'},{providerId:'different-provider'},{serviceId:'different-service'},
    {startsAt:'2027-02-02T10:00:00'},{endsAt:'2027-02-02T11:15:00-05:00'},{status:'cancelled'}]){
    assert.equal(matchVagaroNativeEvidence(booking,{records:[{...native,...changes}]}).status,'unverified');
  }
});

test('normalized export cannot use an invalid rollover date as an exact match',()=>{
  const march={...booking,startsAt:'2027-03-02T15:00:00Z',endsAt:'2027-03-02T16:00:00Z'};
  const malformed={...native,startsAt:'2027-02-30T10:00:00-05:00',endsAt:'2027-02-30T11:00:00-05:00'};
  assert.equal(matchVagaroNativeEvidence(march,{records:[malformed]}).reason,'NATIVE_APPOINTMENT_DETAILS_MISMATCH');
});

test('Google calendar block proof is bound to the exact session, service, booking, event and window',()=>{
  assert.equal(mappedGoogleBookingMatches(event,row),true);
  for(const changes of [{id:'different-event'},{status:'cancelled'},{transparency:'transparent'},
    {end:{dateTime:row.starts_at}},{extendedProperties:{private:{...event.extendedProperties.private,serviceId:'different'}}},
    {extendedProperties:{private:{...event.extendedProperties.private,stripeSessionId:'different'}}}]){
    assert.equal(mappedGoogleBookingMatches({...event,...changes},row),false);
  }
});
