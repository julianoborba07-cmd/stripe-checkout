/**
 * LL Brows Media Kit — Signature V2 Phase C / QA PDF access only.
 * This is a READ-ONLY endpoint. No binding, consent, signature or contract issuance.
 * Scoped to a single explicitly configured QA client and watermarked QA drafts.
 * Mounted before admin-only middleware but after the origin filter and rate limiter.
 */
import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const notFound = res => res.status(404).json({error:'LLMK_V2_QA_DOCUMENT_NOT_FOUND'});

// The caller supplies the existing service-role client factory. The service
// role stays on the backend and NEVER enters browser-visible code.
export function registerSigningV2QaViewRoute(router, {clientFor}) {
  router.get('/signing-v2/qa-document/:envelopeId', async (req,res) => {
    if (process.env.LLMK_SIGNING_V2_QA_VIEW_ENABLED !== '1' ||
        process.env.LLMK_LIVE_ISSUANCE_ENABLED === '1' ||
        process.env.LLMK_SIGNATURE_FLOW_APPROVED === '1') {
      return res.status(409).json({error:'LLMK_V2_QA_DOCUMENT_VIEW_DISABLED'});
    }
    const allowedClientId = (process.env.LLMK_SIGNING_V2_QA_CLIENT_ID || '').trim();
    const envelopeId = req.params.envelopeId;
    if (!UUID_RE.test(allowedClientId) || !UUID_RE.test(envelopeId)) return notFound(res);
    const authorization = req.headers.authorization || '';
    const match = /^Bearer\s+([^\s]+)$/.exec(authorization);
    if (!match) return res.status(401).json({error:'LLMK_SESSION_REQUIRED'});
    const url = process.env.LLMK_SUPABASE_URL || '';
    const key = process.env.LLMK_SUPABASE_SERVICE_ROLE_KEY || '';
    if (!/^https:\/\/.+\.supabase\.co\/?$/.test(url) || !key) {
      return res.status(503).json({error:'LLMK_V2_QA_SERVICE_UNAVAILABLE'});
    }
    try {
      const db = clientFor({url,serviceKey:key});
      // Get user server-side; never trust user IDs, roles or client IDs in browser payload.
      const {data:userData,error:authError}=await db.auth.getUser(match[1]);
      if (authError || !userData?.user?.id) return res.status(401).json({error:'LLMK_INVALID_SESSION'});
      const userId = userData.user.id;
      const {data:envelope,error:envelopeErr}=await db.from('llmk_signing_envelopes_v2')
        .select('id,contract_id,environment,status,source_document_sha256')
        .eq('id',envelopeId).maybeSingle();
      if (envelopeErr) throw new Error('envelope_lookup');
      if (!envelope || envelope.environment!=='qa' || envelope.status!=='qa_draft') return notFound(res);
      const {data:contract,error:contractErr}=await db.from('llmk_contracts')
        .select('id,client_id,status,contract_language,generation_source,storage_path,document_sha256,contract_snapshot')
        .eq('id',envelope.contract_id).maybeSingle();
      if (contractErr) throw new Error('contract_lookup');
      if (!contract || contract.client_id!==allowedClientId || contract.status!=='draft' ||
          contract.generation_source!=='qa_signing_v2_node' ||
          contract.contract_snapshot?.qa_not_for_signature!==true ||
          contract.contract_snapshot?.llmk_signing_v2_qa!==true ||
          !['en','pt'].includes(contract.contract_language) ||
          !SHA_RE.test(contract.document_sha256||'') ||
          envelope.source_document_sha256!==contract.document_sha256) return notFound(res);
      // Only a client owner or an LL Media Kit admin may view this QA document.
      // This is NOT a verification that the owner matches a fictional signer name.
      const {data:owner,error:ownerErr}=await db.from('llmk_clients')
        .select('owner_id').eq('id',allowedClientId).maybeSingle();
      if (ownerErr) throw new Error('owner_lookup');
      let authorized = Boolean(owner?.owner_id && owner.owner_id === userId);
      if (!authorized) {
        const {data:admin,error:adminErr}=await db.from('llmk_admins')
          .select('user_id').eq('user_id',userId).maybeSingle();
        if (adminErr) throw new Error('admin_lookup');
        authorized = Boolean(admin?.user_id===userId);
      }
      if (!authorized) return notFound(res);
      const pathRe = new RegExp('^'+allowedClientId+'/qa-signing-v2/[0-9a-f-]{36}\\.pdf$','i');
      if (!pathRe.test(contract.storage_path||'')) return notFound(res);
      const {data:blob,error:storageErr}=await db.storage.from('llmk-contracts').download(contract.storage_path);
      if (storageErr || !blob) throw new Error('storage_read');
      const bytes=Buffer.from(await blob.arrayBuffer());
      if (!bytes.length || bytes.length>10*1024*1024 || sha256(bytes)!==contract.document_sha256) {
        console.error('LLMK_V2_QA_DOCUMENT_INTEGRITY_MISMATCH');
        return res.status(503).json({error:'LLMK_V2_QA_DOCUMENT_INTEGRITY_FAILURE'});
      }
      return res.status(200)
        .set('Content-Type','application/pdf')
        .set('Content-Disposition','inline; filename="LLMK_QA_NOT_FOR_SIGNATURE.pdf"')
        .set('Content-Security-Policy','sandbox')
        .set('X-LLMK-Document-Type','QA-DRAFT-NOT-FOR-SIGNATURE')
        .send(bytes);
    } catch(error) {
      console.error('LLMK_V2_QA_DOCUMENT_READ_UNAVAILABLE',error.message);
      return res.status(503).json({error:'LLMK_V2_QA_DOCUMENT_READ_UNAVAILABLE'});
    }
  });
}
