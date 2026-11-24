/** Run after npm install pdf-lib in the real Node project: node qa/node_smoke_test.mjs */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
const home=path.dirname(fileURLToPath(import.meta.url));
const direct=path.join(home,'../llmk-contracts/generator.js');
const fallback=path.join(home,'../backend/llmk-contracts/generator.js');
const {createContractPdf}=await import(pathToFileURL(existsSync(direct)?direct:fallback).href);
const sample=JSON.parse(await readFile(path.join(home,'sample_review_only.json'),'utf8'));
await mkdir(path.join(home,'test_generated_pdf'),{recursive:true});
for(const lang of ['en','pt','es']){
 for(const plan of ['full','foundation','growth','performance']){
  const v=await createContractPdf({...sample,plan},lang,{preview:true});
  if(v.sha256.length!==64 || v.fingerprint.length!==64 || v.bytes.length<10000)throw Error('Invalid output '+lang+plan);
  await writeFile(path.join(home,'test_generated_pdf',`qa_${lang}_${plan}.pdf`),v.bytes);
  console.log(lang,plan,v.bytes.length,v.sha256.slice(0,12));
 }
}
// Fail-closed live Spanish test.
try{await createContractPdf(sample,'es',{preview:false});throw Error('Spanish live was allowed')}
catch(e){if(e.message==='Spanish live was allowed')throw e;console.log('ES live correctly blocked')}
