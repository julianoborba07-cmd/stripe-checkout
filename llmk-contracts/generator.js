/**
 * LL Brows Media Kit / Node.js PDF contract generator / QA v2.
 * - pdf-lib runs in the EXISTING Node Render process.
 * - The three approved-source PDF contracts were sanitized OFFLINE with true
 *   redaction. Only blank dynamic fields remain: no cover-up of searchable text.
 * - Never receive or use SSN. Spanish remains review-only.
 * npm install pdf-lib@1.17.1
 */
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Imported lazily to avoid taking down the shared backend if this optional
// module is not installed yet. npm install pdf-lib@1.17.1 before QA.
let pdfLibPromise;
const pdfLibrary=()=>pdfLibPromise??=(import('pdf-lib'));

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = join(HERE, 'templates');
const ALLOWED_PLANS = ['full', 'foundation', 'growth', 'performance'];
const ALLOWED_LANGUAGES = ['en', 'pt', 'es'];
const REQUIRED = [
  'agency_legal_name','agency_address','agency_email',
  'client_legal_name','client_business_name','client_address','client_email',
  'client_signer','client_title','effective_date','service_location',
  'timezone','governing_state','venue','plan'
];
let cachePromise;

export class ContractInputError extends Error {
  constructor(message) { super(message); this.name = 'ContractInputError'; }
}

const clean = (v) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const strictDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T12:00:00Z')) && new Date(v + 'T12:00:00Z').toISOString().slice(0,10) === v;

async function assets() {
  if (!cachePromise) cachePromise = (async () => {
    const manifest = JSON.parse(await readFile(join(TEMPLATE_ROOT, 'placements.json'),'utf8'));
    const files = {};
    for (const lang of ALLOWED_LANGUAGES) {
      const info = manifest.languages[lang];
      if (!info || !/^llmk_clean_(en|pt|es)(_DRAFT)?\.pdf$/.test(info.file)) throw new Error('LLMK_TEMPLATE_MANIFEST_INVALID');
      files[lang] = await readFile(join(TEMPLATE_ROOT, info.file));
      if (sha(files[lang]) !== info.clean_sha256) throw new Error('LLMK_TEMPLATE_CHECKSUM_MISMATCH');
    }
    return { manifest, files };
  })();
  return cachePromise;
}

export function validateContractData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContractInputError('Contract data object required');
  for (const k of Object.keys(raw)) {
    if (/ssn|social.?security|tax.?id|\bein\b/i.test(k)) throw new ContractInputError('Sensitive identifiers are not accepted by this generator');
  }
  const data = {};
  for (const k of REQUIRED) {
    data[k] = clean(raw[k]);
    if (!data[k]) throw new ContractInputError(`Missing required contract field: ${k}`);
    if (data[k].length > 145) throw new ContractInputError(`Contract field too long: ${k}`);
  }
  if (!ALLOWED_PLANS.includes(data.plan)) throw new ContractInputError('Unsupported service plan');
  if (!strictDate(data.effective_date)) throw new ContractInputError('Invalid effective date');
  for (const email of [data.agency_email,data.client_email]) {
    if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ContractInputError('Invalid contract email');
  }
  if (data.client_title.length > 70) throw new ContractInputError('Client signatory title too long');
  if (typeof raw.deposit_enabled !== 'boolean') throw new ContractInputError('deposit_enabled must be boolean');
  data.deposit_enabled = raw.deposit_enabled;
  return data;
}

function formattedDate(iso,lang) {
  const [y,m,d]=iso.split('-');
  return lang === 'en' ? `${m}/${d}/${y.slice(-2)}` : `${d}/${m}/${y.slice(-2)}`;
}

const planTitle = {
  en:{full:'FULL SERVICE',foundation:'DIGITAL FOUNDATION',growth:'GROWTH MANAGEMENT',performance:'PERFORMANCE PARTNER'},
  pt:{full:'FULL SERVICE',foundation:'DIGITAL FOUNDATION',growth:'GROWTH MANAGEMENT',performance:'PERFORMANCE PARTNER'},
  es:{full:'FULL SERVICE',foundation:'DIGITAL FOUNDATION',growth:'GROWTH MANAGEMENT',performance:'PERFORMANCE PARTNER'}
};
const depositTitle = {
  en: ['Not enabled','Enabled'],
  pt: ['Não ativado','Ativado'],
  es: ['No activado','Activado']
};

function fieldValues(data,lang) {
  return {
    ...data,
    client_signer_title:`${data.client_signer} - ${data.client_title}`,
    effective_date:formattedDate(data.effective_date,lang),
    timezone:data.timezone==='America/New_York'?'Eastern Time':data.timezone
  };
}

function measureWidth(rect,section) {
  const maxRight = section==='agency'?307:section==='ack'?rect.x1+3:section==='inline'?rect.x1+7:
    section==='date'?rect.x0+40:section==='location'?rect.x0+65:
    section==='timezone'?rect.x0+150:573;
  return Math.max(15,maxRight-rect.x0-3);
}

function sectionFor(field,pageIndex) {
  if (field==='client_signer') return 'client';
  if (['governing_state','venue','client_title'].includes(field)) return 'inline';
  if (pageIndex!==0) return 'normal';
  if (['agency_legal_name','agency_address','agency_email'].includes(field)) return 'agency';
  if (['client_legal_name','client_business_name','client_address','client_email','client_signer_title'].includes(field)) return 'client';
  if (field==='effective_date') return 'date';
  if (field==='service_location') return 'location';
  if (field==='timezone') return 'timezone';
  return 'inline';
}

function stamp(page, font, rect, text, { section='normal', preferred=8.4, ink }={}) {
  const value=clean(text);
  if (!value) throw new ContractInputError('Missing value for a contract PDF field');
  const maxW = measureWidth(rect,section);
  let size=preferred;
  try {
    while (font.widthOfTextAtSize(value,size) > maxW && size > 5.5) size -= 0.2;
    if (font.widthOfTextAtSize(value,size) > maxW) throw new ContractInputError('A contract field does not fit the official PDF layout');
    // FitZ source coordinates are top-origin; pdf-lib uses bottom-origin.
    page.drawText(value,{x:rect.x0, y:page.getHeight()-rect.y1+1,
      size, font, color:ink});
  } catch(e) {
    if (e instanceof ContractInputError) throw e;
    // No silent dropping/replacing unsupported characters in legal party names.
    throw new ContractInputError('Unsupported character in contract field: verify spelling/Unicode');
  }
}

function fingerprintData(data,lang,manifest) {
  // Explicit order; never include browser-only parameters or an SSN.
  const stable={language:lang,template_sha256:manifest.languages[lang].clean_sha256};
  for (const k of REQUIRED) stable[k]=data[k];
  stable.deposit_enabled=data.deposit_enabled;
  return sha(Buffer.from(JSON.stringify(stable),'utf8'));
}

export async function createContractPdf(raw, language, {preview=true}={}) {
  const lang=clean(language).toLowerCase();
  if (!ALLOWED_LANGUAGES.includes(lang)) throw new ContractInputError('Unsupported contract language');
  if (lang==='es' && !preview) throw new ContractInputError('Spanish contract requires legal review before live issuance');
  const data=validateContractData(raw);
  const {PDFDocument,StandardFonts,rgb}=await pdfLibrary();
  const ink=rgb(.12,.17,.25);
  const {manifest,files}=await assets();
  const layout=manifest.languages[lang];
  const pdf=await PDFDocument.load(files[lang],{updateMetadata:false});
  if (pdf.getPageCount()!==8) throw new Error('LLMK_TEMPLATE_PAGE_COUNT_MISMATCH');
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  const values=fieldValues(data,lang);
  for(const [field,rect] of Object.entries(layout.fields)){
    if (values[field]===undefined) throw new Error('LLMK_FIELD_MAPPING_INCOMPLETE');
    stamp(pdf.getPage(rect.page),font,rect,values[field],{section:sectionFor(field,rect.page),preferred:8.1,ink});
  }
  const selectedNames=new Set([data.plan,data.deposit_enabled?'deposit_yes':'deposit_no']);
  for(const rect of layout.checkboxes){
    stamp(pdf.getPage(rect.page),font,rect,selectedNames.has(rect.name)?'[X]':'[ ]',{section:'normal',preferred:8.6,ink});
  }
  stamp(pdf.getPage(layout.ack_plan.page),font,layout.ack_plan,planTitle[lang][data.plan],{section:'ack',preferred:8.6,ink});
  stamp(pdf.getPage(layout.ack_deposit.page),font,layout.ack_deposit,depositTitle[lang][Number(data.deposit_enabled)],{section:'ack',preferred:8.6,ink});
  if(preview){
    for (const page of pdf.getPages()) {
      page.drawText('QA PREVIEW - NOT FOR SIGNATURE', {
        x:page.getWidth()-192,y:19,size:7,font,color:rgb(.38,.41,.48),opacity:.65
      });
    }
  }
  const bytes=Buffer.from(await pdf.save({useObjectStreams:false}));
  if(bytes.length>10*1024*1024) throw new Error('LLMK_RENDERED_PDF_TOO_LARGE');
  return {
    bytes,
    sha256:sha(bytes),
    fingerprint:fingerprintData(data,lang,manifest),
    language:lang,
    templateVersion:manifest.revision+(lang==='es'?'-ES-DRAFT':'-'+lang.toUpperCase()),
    snapshot:{...data,language:lang,template_version:manifest.revision,template_sha256:layout.clean_sha256}
  };
}
