// Foreclosure door-knock pipeline — PARALLEL LOCAL workers (target: full month in <10 min).
// N local headless Chromium browsers run at once (no Browserless concurrency cap, no 60s session limit).
// Each worker: solve its own CapSolver token -> search once -> sweep its slice of CA cases
// (click docket -> download Complaint+Value -> enrich). Address via pdftotext, owed via FREE OCR (no AI).
// Live findings + progress written to scan-status.json. Run: node run-month.mjs   (env: CONCURRENCY, USE_AI)
import { chromium } from 'playwright';
import { Camoufox } from 'camoufox-js';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from './_env.mjs';
import { saveDocToStorage } from './_storage.mjs';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');               // standalone repo root (where .env lives)
const OUT = join(tmpdir(), 'dealfinder-cases');     // PDFs are processed then deleted — temp only
const env=loadEnv(ROOT);                            // .env locally, process.env on Railway/containers
const CAP=env.CAPSOLVER_API_KEY,BL=env.BROWSERLESS_API_KEY;
const CONCURRENCY=parseInt(process.env.CONCURRENCY||'1',10); // 1 = reliable; the clerk flakes on parallel searches from one IP
const USE_AI=process.env.USE_AI==='1';
const anthropic=new Anthropic({apiKey:env.ANTHROPIC_API_KEY||'no-key'}); // calls are wrapped in try/catch; OCR is the primary path
const post=(u,b)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const money=s=>{const m=(s==null?'':String(s)).replace(/[^0-9.]/g,'');return m?parseFloat(m):null;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);
const MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const now=new Date();
const MONTH=parseInt(process.env.SCAN_MONTH||String(now.getMonth()+1),10);
const YEAR=parseInt(process.env.SCAN_YEAR||String(now.getFullYear()),10);
const yy=String(YEAR).slice(-2);
const lastDay=new Date(YEAR,MONTH,0).getDate();
// Explicit date range (from the dashboard / daily cron) overrides the whole-month default. ISO YYYY-MM-DD → M/D/yy.
const isoMDyy=s=>{const[Y,M,D]=s.split('-').map(Number);return `${M}/${D}/${String(Y).slice(-2)}`;};
const DATE_FROM=process.env.DATE_FROM?isoMDyy(process.env.DATE_FROM):`${MONTH}/1/${yy}`;
const DATE_TO=process.env.DATE_TO?isoMDyy(process.env.DATE_TO):`${MONTH}/${lastDay}/${yy}`;
const STATUS=join(ROOT,'scan-status.json');

let tokIn=0,tokOut=0,ocrN=0;
const cost=()=>(tokIn/1e6*3+tokOut/1e6*15);

// ---- captcha: one fresh single-use token per worker ----
async function solveToken(){
  for(let a=1;a<=5;a++){ try{
    const c=await post('https://api.capsolver.com/createTask',{clientKey:CAP,task:{type:'ReCaptchaV2EnterpriseTaskProxyLess',websiteURL:'https://myeclerk.myorangeclerk.com/Cases/Search',websiteKey:'6LdtOBETAAAAABvi0Md4UUqb7GKfkRiUR6AsrFX-'}});
    for(let i=0;i<24&&c.taskId;i++){await sleep(3000);const r=await post('https://api.capsolver.com/getTaskResult',{clientKey:CAP,taskId:c.taskId});if(r.status==='ready')return r.solution.gRecaptchaResponse;if(r.status==='failed'||r.errorId)throw new Error(r.errorDescription);}
    throw new Error('timeout');
  }catch(e){ if(a===5)throw e; await sleep(1500); } }
}
// Pre-solve captcha tokens in the background so a case never waits ~15-40s for one.
const tokenBuf=[]; let fillTokens=true;
const PRESOLVE = Math.max(2, CONCURRENCY + 1);
async function tokenFiller(){ while(fillTokens){ if(tokenBuf.length<PRESOLVE){ try{ tokenBuf.push({t:await solveToken(),at:Date.now()}); }catch(e){ await sleep(1500); } } else await sleep(400); } }
async function getToken(){ for(;;){ while(tokenBuf.length&&Date.now()-tokenBuf[0].at>100000) tokenBuf.shift(); if(tokenBuf.length) return tokenBuf.shift().t; await sleep(400); } }

// ---- extraction (free) ----
function addr(file){try{const t=execFileSync('pdftotext',[file,'-'],{maxBuffer:2e8}).toString().replace(/\s+/g,' ');const m=t.match(/located at:?\s*(\d+\s+[A-Za-z0-9 .]+?,\s*[A-Za-z .]+?,\s*FL\s*\d{5})/i)||t.match(/(\d{2,6}\s+[A-Z][A-Za-z0-9 .]+?,\s*[A-Za-z .]+?,\s*FL\s*\d{5})/);return m?m[1].trim().replace(/\s{2,}/g,' '):null;}catch(e){return null;}}
async function owedOCR(file){
  const tmp=`/tmp/ocr-${process.pid}-${ocrN++}`;
  try{
    await execFileP('pdftoppm',['-r','200','-png','-singlefile',file,tmp]);
    const {stdout}=await execFileP('tesseract',[`${tmp}.png`,'-'],{maxBuffer:5e7});
    const p=stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Principal due/i), i=stdout.match(/([\d][\d,]*\.\d{2})[^\n]{0,18}Interest owed/i);
    return {principalDue:p?money(p[1]):null,interestOwed:i?money(i[1]):null};
  }catch(e){ return {}; } finally{ try{unlinkSync(`${tmp}.png`);}catch(e){} }
}
async function owedAI(file){try{const b64=readFileSync(file).toString('base64');const msg=await anthropic.messages.create({model:'claude-sonnet-4-6',max_tokens:300,messages:[{role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:b64}},{type:'text',text:'Florida "Value of Real Property or Mortgage Foreclosure Claim" form. Reply ONLY JSON {"principalDue":number,"interestOwed":number}. Numbers only.'}]}]});tokIn+=msg.usage?.input_tokens||0;tokOut+=msg.usage?.output_tokens||0;const j=JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);return{principalDue:money(j.principalDue),interestOwed:money(j.interestOwed)};}catch(e){return{};}}
// Free OCR first; fall back to Claude vision only when OCR fails (scrambled-font value forms).
async function owed(file){
  if(USE_AI) return owedAI(file);
  const r=await owedOCR(file);
  if(r.principalDue!=null||r.interestOwed!=null) return r;
  return owedAI(file); // OCR got nothing (encoded PDF) → accurate vision fallback
}
// Zillow via local Camoufox (home residential IP + stealth) — no Browserless, no proxy needed.
let zN=0;
async function zillow(a){
  let ctx=null;
  try{
    // normalize messy clerk addresses: drop unit/highway noise, collapse "Alt. 19" etc. to a clean street query
    const slug=a.replace(/\bAlt\.?\s*/ig,'Alternate ').replace(/[#.]/g,'').replace(/,/g,'').replace(/\s+/g,'-').replace(/-+/g,'-');
    ctx=await Camoufox({headless:true,user_data_dir:`/tmp/camou-zillow-${process.pid}-${zN++}`}); // unique profile per call
    const p=ctx.pages()[0]||await ctx.newPage();
    await p.goto(`https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`,{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
    await p.waitForTimeout(4000);
    const h=await p.content();
    const m=h.match(/Zestimate[^$]{0,40}\$([\d,]{6,})/i)||h.match(/"price":(\d{5,})/i)||h.match(/"zestimate":\s*(\d{5,})/i)||h.match(/\$([\d,]{6,})\b[^<]{0,30}(?:Zestimate|est\.)/i);
    return m?money(m[1]):null;
  }catch(e){ return null; }
  finally{ if(ctx) await ctx.close().catch(()=>{}); }
}

async function enrich(rec){
  const dir=`${OUT}/${rec.caseNumber}`,cF=`${dir}/Complaint.pdf`,vF=`${dir}/Value-of-Real-Property.pdf`;
  rec.complaintX=!existsSync(cF); rec.valueX=!existsSync(vF);
  if(existsSync(cF)) rec.propertyAddress=addr(cF);
  if(existsSync(vF)){ const v=await owed(vF); rec.principalDue=v.principalDue; rec.interestOwed=v.interestOwed; }
  const o=(rec.principalDue||0)+(rec.interestOwed||0); rec.totalOwed=o||null; rec.owedWithBuffer=o?o+10000:null;
  // research each case fully, one by one: value + spread + verdict inline
  rec.zillowValue = rec.propertyAddress ? await zillow(rec.propertyAddress) : null;
  if(rec.zillowValue&&rec.owedWithBuffer){ rec.spread=rec.zillowValue-rec.owedWithBuffer; rec.flagged=rec.spread>=200000; }
  else { rec.spread=null; rec.flagged=null; }
  if(rec.reviewStatus==='auto'&&(rec.complaintX||rec.valueX||!rec.propertyAddress)){ rec.reviewStatus='manual_review'; rec.reviewReason=rec.reviewReason||(rec.complaintX?'no_complaint':rec.valueX?'no_value':'no_address'); }
  writeFileSync(`${dir}/case.json`,JSON.stringify(rec,null,2));
  return rec;
}

// Zillow consumer: single Browserless slot, runs CONCURRENTLY with the local scrape workers.
const zq=[]; let scrapeDone=false;
async function zillowConsumer(){
  while(!scrapeDone || zq.length){
    const item=zq.shift();
    if(!item){ await sleep(400); continue; }
    const v=await zillow(item.address);
    const f=`${OUT}/${item.caseNumber}/case.json`;
    try{ const rec=JSON.parse(readFileSync(f,'utf8')); rec.zillowValue=v;
      if(v&&rec.owedWithBuffer){ rec.spread=v-rec.owedWithBuffer; rec.flagged=rec.spread>=200000; if(rec.flagged){ nKnock++; const r=recent.find(x=>x.caseNumber===rec.caseNumber); if(r){ r.spread=rec.spread; r.flagged=true; } } }
      writeFileSync(f,JSON.stringify(rec,null,2)); pushStatus();
    }catch(e){}
  }
}

// ---- local search session (no Browserless) ----
const ENGINE=process.env.ENGINE||'camoufox'; // local stealth Playwright (Camoufox) — no Browserless/quota. 'browserless' optional.
// Persistent session: grecaptcha override reads a MUTABLE window.__captok so we can re-search with a fresh token.
async function makeSession(initTok,profileDir){
  let b=null,ctx;
  if(ENGINE==='camoufox'){ ctx=await Camoufox({headless:true,user_data_dir:profileDir}); }
  else { b=await chromium.connectOverCDP(`wss://production-sfo.browserless.io/chromium?token=${BL}&timeout=60000`); ctx=b.contexts()[0]||await b.newContext(); }
  await ctx.addInitScript((t)=>{window.__captok=t;const f=()=>Promise.resolve(window.__captok);let g;Object.defineProperty(window,'grecaptcha',{configurable:true,get(){return g;},set(v){g=v;try{if(v){v.execute=f;v.getResponse=()=>window.__captok;v.ready=c=>c&&c();if(v.enterprise){v.enterprise.execute=f;v.enterprise.getResponse=()=>window.__captok;v.enterprise.ready=c=>c&&c();}}}catch(e){}}});},initTok);
  const p=ctx.pages&&ctx.pages()[0]?ctx.pages()[0]:await ctx.newPage();
  return {ctx: b||ctx, p}; // closeable: browser (browserless) or context (camoufox)
}
// Run (or re-run) the search on an existing page with a fresh token. Returns the result-row count.
async function runSearch(p,tok){
  await p.goto('https://myeclerk.myorangeclerk.com/Cases/Search',{waitUntil:'domcontentloaded'});
  await p.evaluate(({df,dt})=>{const t=document.querySelector('button.multiselect,.btn-group .multiselect,[class*=multiselect].dropdown-toggle');if(t)t.click();const f=document.querySelector('#input-caseTypes');if(f){f.value='Foreclosure';f.dispatchEvent(new Event('keyup',{bubbles:true}));}const cb=document.querySelector('input[type=checkbox][value="42"]');if(cb&&!cb.checked)cb.click();const d=document.querySelector('#DateFrom');if(d){d.value=df;d.dispatchEvent(new Event('input',{bubbles:true}));d.dispatchEvent(new Event('change',{bubbles:true}));}const d2=document.querySelector('#DateTo');if(d2){d2.value=dt;d2.dispatchEvent(new Event('input',{bubbles:true}));d2.dispatchEvent(new Event('change',{bubbles:true}));}if(t)t.click();},{df:DATE_FROM,dt:DATE_TO});
  await p.evaluate((t)=>{window.__captok=t;let ta=document.getElementById('g-recaptcha-response');if(!ta){ta=document.createElement('textarea');ta.id='g-recaptcha-response';ta.name='g-recaptcha-response';ta.style.display='none';(document.querySelector('form')||document.body).appendChild(ta);}ta.value=t;const el=document.querySelector('[data-callback]');const cb=el&&el.getAttribute('data-callback');if(cb&&typeof window[cb]==='function'){try{window[cb](t);}catch(e){}}const btn=document.querySelector('#caseSearch');if(btn)btn.removeAttribute('disabled');},tok);
  await Promise.all([p.waitForLoadState('networkidle').catch(()=>{}),p.click('#caseSearch',{force:true}).catch(()=>{})]);
  await p.waitForTimeout(2500);
  await p.evaluate(()=>{try{const $=window.jQuery;if($&&$.fn.dataTable&&$.fn.dataTable.isDataTable('#caseList'))$('#caseList').DataTable().page.len(-1).draw(false);}catch(e){}});
  await p.waitForTimeout(2500);
  return await p.evaluate(()=>document.querySelectorAll('#caseList tbody tr').length).catch(()=>0);
}

const lender=/\b(bank|mortgage|savings|lending|loan|financial|credit union|fund society|trust company|national association|n\.?a\.?|capital|servicing|federal home loan|freddie|fannie)\b/i;
const hoa=/homeowner|condominium|\bcondo\b|community (owners|assoc)|master assoc|owners association|villas?|townhom|\bhoa\b|association resources|club vacations|flex vacations/i;

// ---- shared progress ----
const recs=[]; const recent=[]; let nKnock=0,nReview=0,done=0,total=0;
const setStatus=o=>{try{writeFileSync(STATUS,JSON.stringify({county:env.COUNTY||'Orange',month:MONTH,year:YEAR,from:DATE_FROM,to:DATE_TO,...o},null,2));}catch(e){}};
const pushStatus=(extra={})=>setStatus({running:true,done,total,knock:nKnock,review:nReview,recent:recent.slice(0,12),tokensIn:tokIn,tokensOut:tokOut,aiCostUsd:Number(cost().toFixed(4)),mode:USE_AI?'ai':'ocr',workers:CONCURRENCY,...extra});
// live Google Sheet sync — POST each finished case to an Apps Script webhook (set SHEET_WEBHOOK_URL in .env.local)
const SHEET_WEBHOOK=env.SHEET_WEBHOOK_URL||'';
async function syncToSheet(rec){ if(!SHEET_WEBHOOK)return; try{ await fetch(SHEET_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caseNumber:rec.caseNumber,plaintiff:rec.plaintiff,defendant:rec.defendant,type:rec.type,address:rec.propertyAddress||'',owed:rec.owedWithBuffer||'',zillow:rec.zillowValue||'',spread:rec.spread||'',knock:rec.flagged?'KNOCK':(rec.reviewStatus==='manual_review'?'REVIEW':''),complaint:rec.complaintX?'X':'link',value:rec.valueX?'X':'link',status:rec.reviewStatus,county:env.COUNTY||'Orange'})}); }catch(e){} }
setStatus({running:true,done:0,total:0,startedAt:new Date().toISOString(),workers:CONCURRENCY,mode:USE_AI?'ai':'ocr'});

// ---- Supabase: the ONLY persistence (no local PDFs/JSON). Stores data + the document links. ----
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
async function upsertLead(rec){
  try{ await sb.from('foreclosure_leads').upsert({
    case_number:rec.caseNumber, county:env.COUNTY||'Orange',
    plaintiff:rec.plaintiff||null, defendant:rec.defendant||null, type:rec.type||null,
    property_address:rec.propertyAddress||null,
    principal_due:rec.principalDue??null, interest_owed:rec.interestOwed??null,
    total_owed:rec.totalOwed??null, owed_with_buffer:rec.owedWithBuffer??null,
    zillow_value:rec.zillowValue??null, spread:rec.spread??null, flagged:rec.flagged??null,
    review_status:rec.reviewStatus||null, review_reason:rec.reviewReason||null,
    complaint_url:rec.complaintUrl||null, value_url:rec.valueUrl||null, docket_url:rec.docketUrl||null,
    scan_month:MONTH, scan_year:YEAR, updated_at:new Date().toISOString()
  },{onConflict:'case_number'}); }catch(e){ log('supabase upsert err',String(e.message).slice(0,40)); }
}

const tStart=Date.now();
log(`scan ${MONTHS[MONTH-1]} ${YEAR} — ${CONCURRENCY} worker(s), re-search per case (goBack doesn't restore results)`);

// background captcha pre-solver so workers never wait ~20-40s for a token
fillTokens=true; const fillers=Array.from({length:Math.min(CONCURRENCY+1,4)},()=>tokenFiller());

// 1) collect the month's CA targets (one search, retry until rows)
let list=[];
for(let attempt=1; attempt<=6 && list.length===0; attempt++){
  let sess=null;
  try{
    sess=await makeSession(await getToken(), `/tmp/camou-collect-${process.pid}-${attempt}`);
    const n=await runSearch(sess.p, await getToken());
    const raw=await sess.p.evaluate(()=>[...document.querySelectorAll('#caseList tbody tr')].map(r=>[...r.querySelectorAll('td')].map(x=>x.innerText.replace(/\s+/g,' ').trim())));
    const all=raw.map(c=>{const cn=c.find(x=>/20\d{2}-CA-\d+-O/.test(x))||'';const ci=c.indexOf(cn);const[pl,def]=(c[ci+1]||'').split(/\s*vs\.?\s*/i);return{caseNumber:cn,plaintiff:(pl||'').trim(),defendant:(def||'').replace(/\bet al\.?/i,'').trim(),type:c[ci+2]||''};}).filter(x=>x.caseNumber);
    list=all.filter(x=>!(hoa.test(x.plaintiff)&&!lender.test(x.plaintiff)));
    if(list.length===0){ log(`collect attempt ${attempt}: ${n} rows, retrying`); await sleep(2000); }
  }catch(e){ log(`collect attempt ${attempt} err`,String(e.message).slice(0,40)); await sleep(2000); }
  finally{ if(sess) await sess.ctx.close().catch(()=>{}); }
}
const MAX=parseInt(process.env.MAX||'0',10); if(MAX) list=list.slice(0,MAX);
total=list.length; pushStatus(); log(`CA targets: ${total}`);

// 2) per-case workers — each holds a persistent session and RE-SEARCHES before clicking each case
const queue=[...list];
async function worker(slot){
  let sess=null;
  try{
    sess=await makeSession(await getToken(), `/tmp/camou-w${slot}-${process.pid}`);
    while(queue.length){
      const t=queue.shift(); if(!t) break;
      const rec={...t,reviewStatus:'auto',reviewReason:null,complaintX:true,valueX:true,complaintUrl:null,valueUrl:null,docketUrl:null};
      try{
        // re-search (fresh token) until rows appear, then click this case — up to 3 tries
        let clicked='no-row(0)';
        for(let a=1;a<=3 && clicked!=='ok';a++){
          const n=await runSearch(sess.p, await getToken());
          if(n===0){ if(a<3)await sleep(1500); continue; }
          clicked=await sess.p.evaluate((cn)=>{const r=[...document.querySelectorAll('#caseList tbody tr')].find(x=>x.textContent.includes(cn));if(!r)return'no-row('+document.querySelectorAll('#caseList tbody tr').length+')';const a=r.querySelector('a.caseLink,a[href*=CaseDetails]');if(!a)return'no-link';a.click();return'ok';},t.caseNumber);
          if(clicked!=='ok'&&a<3)await sleep(1500);
        }
        if(clicked!=='ok')throw new Error(clicked);
        await sess.p.waitForSelector('a[href*="/DocView/Doc"]',{timeout:15000}).catch(()=>{});
        // wait for the Complaint/Value links specifically (docbox.js renders aria-labels progressively — THE bug we fixed)
        await sess.p.waitForFunction(()=>{const L=[...document.querySelectorAll('a[href*="/DocView/Doc"]')];return L.some(a=>/complaint/i.test(a.getAttribute('aria-label')||''))||L.some(a=>/value of real property/i.test(a.getAttribute('aria-label')||''));},{timeout:15000}).catch(()=>{});
        await sess.p.waitForTimeout(1500);
        const info=await sess.p.evaluate(()=>{const L=[...document.querySelectorAll('a[href*="/DocView/Doc"]')];const pick=re=>{const a=L.find(x=>re.test(x.getAttribute('aria-label')||''));return a?new URL(a.getAttribute('href'),location.origin).href:null;};return{path:location.pathname,complaint:pick(/complaint/i),value:pick(/value of real property/i),n:L.length};});
        if(!/CaseDetails/i.test(info.path)) throw new Error('docket_blocked');
        // store the DOCUMENT LINKS (not the files) + the docket link
        rec.docketUrl=sess.p.url();
        // Download each PDF → extract → SAVE to Supabase Storage (Orange links die ~30 min post-scan) → store
        // the permanent URL. Fall back to the (expiring) county link only if the upload fails.
        const srcComplaint=info.complaint||null, srcValue=info.value||null;
        rec.complaintUrl=null; rec.valueUrl=null;
        if(srcComplaint){ const tmp=`/tmp/df-cmp-${slot}-${done}.pdf`; try{const r=await sess.p.request.get(srcComplaint); const buf=Buffer.from(await r.body()); writeFileSync(tmp,buf); rec.propertyAddress=addr(tmp); rec.complaintUrl=await saveDocToStorage(sb,rec.caseNumber,'complaint',buf)||srcComplaint;}catch(e){} finally{ try{unlinkSync(tmp);}catch(e){} } }
        if(srcValue){ const tmp=`/tmp/df-val-${slot}-${done}.pdf`; try{const r=await sess.p.request.get(srcValue); const buf=Buffer.from(await r.body()); writeFileSync(tmp,buf); const v=await owed(tmp); rec.principalDue=v.principalDue; rec.interestOwed=v.interestOwed; rec.valueUrl=await saveDocToStorage(sb,rec.caseNumber,'value',buf)||srcValue;}catch(e){} finally{ try{unlinkSync(tmp);}catch(e){} } }
      }catch(e){ rec.reviewReason='err:'+String(e.message).slice(0,24); }
      rec.complaintX=!rec.complaintUrl; rec.valueX=!rec.valueUrl;
      const o=(rec.principalDue||0)+(rec.interestOwed||0); rec.totalOwed=o||null; rec.owedWithBuffer=o?o+10000:null;
      if(rec.complaintX||rec.valueX||!rec.propertyAddress){ rec.reviewStatus='manual_review'; rec.reviewReason=rec.reviewReason||(rec.complaintX?'no_complaint':rec.valueX?'no_value':'no_address'); }
      recs.push(rec); await upsertLead(rec); // Supabase only — no local files
      if(rec.reviewStatus==='manual_review')nReview++;
      recent.unshift({caseNumber:rec.caseNumber,address:rec.propertyAddress||null,spread:null,flagged:false,x:!!(rec.complaintX||rec.valueX)}); if(recent.length>12)recent.pop();
      done++; pushStatus(); await syncToSheet(rec);
      log(`  ${done}/${total} ${rec.caseNumber} | ${rec.propertyAddress||'?'} | owed ${rec.owedWithBuffer||'?'} | ${rec.reviewStatus}`);
    }
  }catch(e){ log(`worker ${slot} died`,String(e.message).slice(0,40)); }
  finally{ if(sess) await sess.ctx.close().catch(()=>{}); }
}
await Promise.all(Array.from({length:CONCURRENCY},(_,i)=>worker(i)));
fillTokens=false;

// 3) Valuation — reliable Zillow at scale via Apify (local scraping gets IP-blocked after ~1 lookup).
//    value-with-apify.mjs values every address, recomputes spread/worth-it, updates Supabase + the sheet.
scrapeDone=true;
log('valuation pass (Apify Zillow)…');
try{ execFileSync(process.execPath,[join(__dirname,'value-with-apify.mjs')],{stdio:'inherit',env:process.env}); }
catch(e){ log('apify valuation step failed',String(e.message).slice(0,60)); }

// (door-knock CSV is written by value-with-apify.mjs from Supabase, with final Zillow values)
// read the real worth-it count back from Supabase (the Apify subprocess set flagged there)
// Summarize ONLY this run's leads (touched since tStart), not the whole month.
let knockCount=nKnock, reviewCount=nReview, pipelineAdded=0, notWorth=0;
try{ const since=new Date(tStart).toISOString(); const {data}=await sb.from('foreclosure_leads').select('flagged,review_status,spread').eq('county',env.COUNTY||'Orange').gte('updated_at',since); let k=0,rv=0,nw=0; for(const r of data||[]){ if(r.flagged){k++; pipelineAdded+=Number(r.spread)||0;} else if(r.review_status==='manual_review') rv++; else nw++; } if((data||[]).length){ knockCount=k; reviewCount=rv; notWorth=nw; } }catch(e){}
const mins=((Date.now()-tStart)/60000).toFixed(1);
setStatus({running:false,county:env.COUNTY||'Orange',done:recs.length,total:recs.length||total,knock:knockCount,review:reviewCount,notWorth,pipelineAdded,recent:recent.slice(0,12),tokensIn:tokIn,tokensOut:tokOut,aiCostUsd:Number(cost().toFixed(4)),mode:USE_AI?'ai':'ocr',workers:CONCURRENCY,minutes:Number(mins),finishedAt:new Date().toISOString()});
log(`DONE in ${mins} min | ${recs.length} cases | KNOCK ${knockCount} | review ${nReview} | tokens ${tokIn}/${tokOut} ($${cost().toFixed(3)})`);

// Telegram report after a manual scan. daily.mjs sets NOTIFY_ON_SCAN=0 and sends one combined report itself.
if(env.TELEGRAM_BOT_TOKEN && process.env.NOTIFY_ON_SCAN!=='0'){
  try{ const {notifyTelegram}=await import('./notify-telegram.mjs'); log('telegram:',JSON.stringify(await notifyTelegram())); }
  catch(e){ log('telegram failed',String(e.message).slice(0,60)); }
}
process.exit(0);
