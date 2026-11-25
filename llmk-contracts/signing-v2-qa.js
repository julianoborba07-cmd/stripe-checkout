/**
 * LL Brows Media Kit | Signature V2 - QA document + envelope bootstrap.
 * This is NOT a signing endpoint and does not issue legally executable contracts.
 * Route inherits the parent router's origin filter, rate limit and requireAdmin.
 * Fail closed unless explicitly enabled and bound to ONE QA-only client account.
 */
import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIRMATION = 'CREATE_QA_DRAFT_ONLY_NOT_FOR_SIGNATURE';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const qaFailure = (message, http=503) => Object.assign(new Error(message), {http});

async function tryRemove(db, path) {
  try {
    const {error} = await db.storage.from('llmk-contracts').remove([path]);
    if (error) console.error('LLMK_V2_QA_STORAGE_CLEANUP_REQUIRED', error.code);
  } catch {
    console.error('LLMK_V2_QA_STORAGE_CLEANUP_REQUIRED');
  }
}

export function registerSigningV2QaRoutes(router, {checkInput, gatherContract, createContractPdf, respondError}) {
  router.post('/signing-v2/qa-create-envelope', async (req, res) => {
    const {db, config:c, adminId} = req.llmk; // requireAdmin ran earlier
    const allowedClientId = (process.env.LLMK_SIGNING_V2_QA_CLIENT_ID || '').trim();
    if (
      process.env.LLMK_SIGNING_V2_QA_CREATE_ENABLED !== '1' ||
      c.liveEnabled || c.signingApproved || !c.previewEnabled
    ) return res.status(409).json({error:'LLMK_SIGNING_V2_QA_CREATION_DISABLED'});
    if (!UUID_RE.test(allowedClientId)) {
      return res.status(503).json({error:'LLMK_SIGNING_V2_QA_CLIENT_ALLOWLIST_NOT_CONFIGURED'});
    }
    if (req.body?.qa_confirmation !== CONFIRMATION) {
      return res.status(422).json({error:'LLMK_SIGNING_V2_QA_EXPLICIT_CONFIRMATION_REQUIRED'});
    }

    let path = null;
    let rpcAttempted = false;
    let registered = false;
    try {
      const p = checkInput(req.body);
      if (p.clientId !== allowedClientId) {
        return res.status(403).json({error:'LLMK_SIGNING_V2_QA_CLIENT_NOT_ALLOWED'});
      }
      // First QA cycle is limited to Full Service in EN or PT; ES has a
      // legacy llmk_contracts CHECK and remains preview-only pending review.
      if (p.plan !== 'full') {
        return res.status(409).json({error:'LLMK_SIGNING_V2_QA_FULL_SERVICE_ONLY'});
      }
      const {language, data} = await gatherContract(req, p);
      if (!['en','pt'].includes(language)) {
        return res.status(409).json({error:'LLMK_SIGNING_V2_QA_ES_REGISTRATION_NOT_READY'});
      }
      const pdf = await createContractPdf(data, language, {preview:true});
      if (!pdf?.bytes || !/^[0-9a-f]{64}$/.test(pdf.sha256) ||
          sha256(pdf.bytes) !== pdf.sha256) {
        throw qaFailure('LLMK_SIGNING_V2_QA_PDF_HASH_INVALID');
      }

      // An existing QA draft blocks accidental duplicate creation.
      // An additional partial unique index in the SQL migration closes races.
      const {data:existing,error:findError} = await db.from('llmk_contracts')
        .select('id')
        .eq('client_id',p.clientId)
        .eq('generation_source','qa_signing_v2_node')
        .eq('status','draft').limit(1);
      if (findError) throw qaFailure('LLMK_SIGNING_V2_QA_CONTRACT_LOOKUP_FAILED');
      if (existing?.length) {
        return res.status(409).json({error:'LLMK_SIGNING_V2_QA_DRAFT_ALREADY_EXISTS'});
      }

      path = `${p.clientId}/qa-signing-v2/${crypto.randomUUID()}.pdf`;
      const bucket = db.storage.from('llmk-contracts');
      const {error:uploadErr} = await bucket.upload(path,pdf.bytes,{
        contentType:'application/pdf',cacheControl:'0',upsert:false
      });
      if (uploadErr) {
        path=null;
        throw qaFailure('LLMK_SIGNING_V2_QA_STORAGE_UPLOAD_FAILED');
      }
      // Read back the exact stored bytes. Never trust only the returned upload status.
      const {data:stored,error:downloadErr} = await bucket.download(path);
      if (downloadErr || !stored) throw qaFailure('LLMK_SIGNING_V2_QA_STORAGE_READBACK_FAILED');
      const storedDigest = sha256(Buffer.from(await stored.arrayBuffer()));
      if (storedDigest !== pdf.sha256) throw qaFailure('LLMK_SIGNING_V2_QA_STORAGE_HASH_MISMATCH');

      const snapshot = {
        ...pdf.snapshot,
        preview_fingerprint:pdf.fingerprint,
        llmk_signing_v2_qa:true,
        qa_not_for_signature:true,
        qa_source:'watermarked_preview'
      };
      rpcAttempted = true;
      const {data:result,error:registerErr} = await db.rpc('llmk_v2_qa_register_document',{
        p_client_id:p.clientId,
        p_actor_user_id:adminId,
        p_contract_language:language,
        p_contract_version:pdf.templateVersion,
        p_storage_path:path,
        p_document_sha256:pdf.sha256,
        p_contract_snapshot:snapshot
      });
      if (registerErr) {
        if (registerErr.code==='23505') {
          throw qaFailure('LLMK_SIGNING_V2_QA_DRAFT_ALREADY_EXISTS',409);
        }
        console.error('LLMK_SIGNING_V2_QA_REGISTER_FAILED',registerErr.code);
        throw qaFailure('LLMK_SIGNING_V2_QA_REGISTER_UNAVAILABLE');
      }
      if (!UUID_RE.test(result?.contract_id) || !UUID_RE.test(result?.envelope_id)) {
        throw qaFailure('LLMK_SIGNING_V2_QA_REGISTER_RESULT_INVALID');
      }
      registered = true;
      return res.status(201).json({
        ok:true,qa:true,readOnlySigning:true,
        contractId:result.contract_id,envelopeId:result.envelope_id,
        status:'qa_draft',language,documentSha256:pdf.sha256,
        note:'Watermarked QA draft. No signature or live issuance performed.'
      });
    } catch(e) {
      if (path && !registered) {
        if (!rpcAttempted) {
          await tryRemove(db,path);
        } else {
          // An RPC network failure may happen after DB commit. Never delete
          // a PDF unless we can confirm no registered contract uses its path.
          try {
            const {data:linked,error:checkErr} = await db.from('llmk_contracts')
              .select('id').eq('storage_path',path).maybeSingle();
            if (checkErr || linked) {
              console.error('LLMK_V2_QA_MANUAL_RECONCILIATION_REQUIRED');
              return res.status(503).json({error:'LLMK_SIGNING_V2_QA_REGISTRATION_STATUS_UNCERTAIN'});
            }
            await tryRemove(db,path);
          } catch {
            console.error('LLMK_V2_QA_MANUAL_RECONCILIATION_REQUIRED');
            return res.status(503).json({error:'LLMK_SIGNING_V2_QA_REGISTRATION_STATUS_UNCERTAIN'});
          }
        }
      }
      return respondError(res,e);
    }
  });
}
