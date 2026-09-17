const DB_NAME='TravelWorkPlannerDB_v13', STORE='files', DATA_KEY='travelWorkPlannerData_v13';
const SESSION_DATA_KEY='TravelWorkPlanner_Session_v25';
const USB_SAVE_FILE='DATA/Travel_Work_Planner_Salvataggio.json';
let db, data = {sections:{}, globalFiles:[]};
// API pubblica per le pagine collegate (es. Travel Report): restituisce sempre
// l'oggetto dati corrente del Planner, non una copia inizializzata troppo presto.
window.twpGetData=()=>data;
window.twpSetData=(obj)=>{
  if(obj && typeof obj==='object'){
    data=obj; data.sections=data.sections&&typeof data.sections==='object'?data.sections:{};
    delete data.sections.trains;
    if(document.getElementById('title')) document.getElementById('title').value=data.title||'';
    if(document.getElementById('startDate')) document.getElementById('startDate').value=data.startDate||'';
    if(document.getElementById('endDate')) document.getElementById('endDate').value=data.endDate||'';
  }
  return data;
};
// Memoria della SOLA sessione: serve a mantenere i dati mentre si passa tra Planner,
// Voli, Hotel e Autonoleggio. Non viene usata come archivio persistente.
function saveSessionState(){
  try{ collect(); data.sections=data.sections||{}; sessionStorage.setItem(SESSION_DATA_KEY,JSON.stringify(data)); return true; }
  catch(e){ console.warn('Sessione Planner non salvata:',e); return false; }
}
function loadSessionState(){
  try{ const raw=sessionStorage.getItem(SESSION_DATA_KEY); if(!raw)return false; const obj=JSON.parse(raw); if(!obj||typeof obj!=='object')return false; data=obj; data.sections=data.sections&&typeof data.sections==='object'?data.sections:{}; delete data.sections.trains; Object.keys(configs).forEach(id=>{data.sections[id]=Array.isArray(data.sections[id])?data.sections[id]:[];}); return true; }
  catch(e){ console.warn('Sessione Planner non leggibile:',e); return false; }
}
function clearPersistentBrowserPlanner(){
  try{ localStorage.removeItem(DATA_KEY); localStorage.removeItem(TRIPS_KEY); }catch(e){}
}
// Archivio principale portabile nel cloud: il file viene sovrascritto a ogni SALVA.
// planner-data.json resta come compatibilità tecnica/API; il file nominato è quello da conservare tra sessioni.
// Gli allegati PDF restano nell'archivio locale del browser e vengono incorporati nel Travel Report PDF.

const configs = {
 travelers:{title:'VIAGGIATORI', add:'＋ Aggiungi viaggiatore', cols:[
  ['nome','Nome','text'],['cognome','Cognome','text'],['ruolo','Ruolo','text'],['email','Email','email'],['telefono','Telefono','tel']]},
 flights:{title:'VOLI', add:'＋ Aggiungi volo', cols:[
  ['tipoVolo','Tipo','text'],['compagnia','Compagnia','text'],['numeroVolo','Numero volo','text'],['pnr','PNR','text'],['partenza','Aeroporto partenza','text'],['arrivo','Aeroporto arrivo','text'],
  ['dataPartenza','Data partenza','date'],['oraPartenza','Ora partenza','time'],['dataArrivo','Data arrivo','date'],['oraArrivo','Ora arrivo','time'],
  ['zaino','Zaino cabina','check'],['cabina','Bagaglio cabina','check'],['stiva','Bagaglio stiva','check'],['priority','Priority','check']]},
 hotels:{title:'HOTEL', add:'＋ Aggiungi hotel', cols:[
  ['nome','Nome hotel','text'],['piattaforma','Piattaforma prenotazione','text'],['pnr','PNR','text'],['checkin','Check-in','date'],['checkout','Check-out','date'],['indirizzo','Indirizzo','text'],['maps','Google Maps','url']]},
 cars:{title:'AUTONOLEGGIO', add:'＋ Aggiungi noleggio', cols:[
  ['pnr','PNR','text'],['prelievoData','Data prelievo','date'],['prelievoOra','Ora prelievo','time'],['riconsegnaData','Data riconsegna','date'],['riconsegnaOra','Ora riconsegna','time'],['note','Note','text']]},
 agenda:{title:'AGENDA', add:'＋ Aggiungi evento', cols:[
  ['data','Data','date'],['ora','Ora','time'],['descrizione','Descrizione','text'],['luogo','Luogo','text'],['note','Note','text']]},
 restaurants:{title:'RISTORANTI CONSIGLIATI', add:'＋ Aggiungi ristorante', cols:[
  ['nome','Nome','text'],['indirizzo','Indirizzo','text'],['maps','Google Maps','url'],['note','Note','text']]},
 places:{title:'LUOGHI DA VISITARE CONSIGLIATI', add:'＋ Aggiungi luogo', cols:[
  ['nome','Nome','text'],['indirizzo','Indirizzo','text'],['maps','Google Maps','url'],['note','Note','text']]},
 budget:{title:'BUDGET VIAGGIO', add:'＋ Aggiungi voce di spesa', cols:[
  ['categoria','Voce di spesa','budget-category'],['descrizione','Descrizione','text'],['costo','Costo preventivato (€)','number'],['perViaggiatore','Per viaggiatore','check'],['viaggiatori','N. viaggiatori','number'],['sostenuta','Già sostenuta','check']]}
};

function initDB(){
 return new Promise((resolve,reject)=>{
  if(!window.indexedDB){
    reject(new Error('IndexedDB non disponibile in questo browser/origine.'));
    return;
  }
  let req;
  try{ req=indexedDB.open(DB_NAME,1); }
  catch(err){ reject(err); return; }
  req.onupgradeneeded=e=>{
    const database=e.target.result;
    if(!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE,{keyPath:'id'});
  };
  req.onsuccess=e=>{
    db=e.target.result;
    db.onversionchange=()=>db.close();
    resolve();
  };
  req.onerror=()=>reject(req.error||new Error('Impossibile aprire IndexedDB.'));
  req.onblocked=()=>reject(new Error('Il database locale è bloccato.'));
 });
}

const LS_FILES_KEY='TravelWorkPlanner_PDF_Files_v11';
let storageMode='memory'; // fallback senza limiti artificiali di localStorage per i PDF
const memoryFiles=new Map();

function fileId(section,row){
  const u=(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():(Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
  return section+'_'+row+'_'+u;
}
function rowUid(row){
  if(!row._id) row._id=(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():(Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
  return row._id;
}
function readLSFiles(){
  try{const raw=localStorage.getItem(LS_FILES_KEY);if(!raw)return [];const arr=JSON.parse(raw);return Array.isArray(arr)?arr:[];}
  catch(err){return [];}
}
function writeLSFiles(arr){localStorage.setItem(LS_FILES_KEY,JSON.stringify(arr));}
function bytesToBase64(bytes){
  let binary='';const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
  return btoa(binary);
}
function base64ToBytes(b64){const binary=atob(b64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;}

async function putFile(obj){
  if(storageMode==='indexedDB' && db){
    try{
      await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(obj);tx.oncomplete=res;tx.onerror=()=>rej(tx.error||new Error('Errore IndexedDB'));tx.onabort=()=>rej(tx.error||new Error('Scrittura IndexedDB annullata'));});
      return;
    }catch(err){console.warn('IndexedDB non utilizzabile, uso memoria della sessione.',err);storageMode='memory';}
  }
  // Fallback in memoria: evita il limite molto basso di localStorage per PDF/base64.
  const copy={...obj};
  if(copy.blob instanceof ArrayBuffer) copy.blob=copy.blob.slice(0);
  else if(ArrayBuffer.isView(copy.blob)) copy.blob=new Uint8Array(copy.blob).buffer;
  memoryFiles.set(copy.id,copy);
}
window.twpRestoreAttachments=async function(list){
  if(!Array.isArray(list)) return 0;
  let count=0;
  for(const f of list){
    if(!f || !f.base64 || !f.id) continue;
    try{
      await putFile({id:f.id,tripId:f.tripId||activeTripId,section:f.section||'global',row:f.row,rowId:f.rowId||null,name:f.name||'allegato.pdf',size:f.size||0,mimeType:f.mimeType||'application/pdf',blob:base64ToBytes(f.base64).buffer});
      count++;
    }catch(err){console.warn('Ripristino allegato USB fallito:',f.name,err);}
  }
  return count;
};

async function getFiles(filter){
  if(storageMode==='indexedDB' && db){
    try{return await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).getAll();req.onsuccess=()=>res(req.result.filter(filter));req.onerror=()=>rej(req.error||new Error('Errore lettura IndexedDB'));});}
    catch(err){console.warn('Lettura IndexedDB fallita, uso memoria.',err);storageMode='memory';}
  }
  return Array.from(memoryFiles.values()).filter(filter);
}
async function deleteStoredFile(fid){
  if(storageMode==='indexedDB' && db){
    try{await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(fid);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});return;}
    catch(err){storageMode='memory';}
  }
  memoryFiles.delete(fid);
}


function addSection(id){
 const c=configs[id]; data.sections[id]=Array.isArray(data.sections[id])?data.sections[id]:[];
 const s=document.createElement('section'); s.id='sec_'+id;
 const extraHead=id==='budget'?'<th>Totale</th>':'';
 s.innerHTML=`<h2>${c.title}</h2>${id==='budget'?'<div class="small" style="margin:-4px 0 10px">Inserisci una voce per ogni spesa preventivata. Seleziona <b>Per viaggiatore</b> per moltiplicare automaticamente il costo per il numero di viaggiatori indicato.</div>':''}<div class="toolbar no-print"><button type="button" onclick="addRow('${id}')">${c.add}</button></div><div class="table-wrap"><table class="table"><thead><tr>${c.cols.map(x=>'<th>'+x[1]+'</th>').join('')}${extraHead}<th class="row-actions">Azioni</th></tr></thead><tbody></tbody></table></div>${id==='budget'?'<div id="budgetSummary" class="budget-summary"></div>':''}`;
 document.getElementById('sections').appendChild(s); renderRows(id);
}
const BUDGET_CATEGORIES=['Spesa autostradale (auto aziendale)','Spesa carburante (auto aziendale)','Parcheggio (auto aziendale)','Treno/Aereo','Hotel','Noleggio auto','Spesa autostradale (auto a noleggio)','Spesa carburante (auto a noleggio)','Vitto','Varie'];
function travelerCount(){return Math.max(1,(data.sections?.travelers||[]).length||1)}
function budgetRowTotal(row){const costo=Math.max(0,Number(row?.costo)||0),n=Math.max(1,Number(row?.viaggiatori)||1);return row?.perViaggiatore?costo*n:costo;}
function formatEuro(v){return new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(Number(v)||0)}
function budgetGrandTotal(){return (data.sections?.budget||[]).reduce((sum,row)=>sum+budgetRowTotal(row),0)}
function budgetSustainedTotal(){return (data.sections?.budget||[]).reduce((sum,row)=>sum+(row?.sostenuta?budgetRowTotal(row):0),0)}
function budgetToSustainTotal(){return budgetGrandTotal()-budgetSustainedTotal()}
function updateBudgetSummary(){
 const box=document.getElementById('budgetSummary'); if(!box)return;
 const rows=data.sections?.budget||[];
 if(!rows.length){box.innerHTML='<b>Totale spese: € 0,00</b> · <b>Già sostenute: € 0,00</b> · <b>Da sostenere: € 0,00</b>';return;}
 const byCat={}; rows.forEach(r=>{const cat=r.categoria||'Varie';byCat[cat]=(byCat[cat]||0)+budgetRowTotal(r);});
 box.innerHTML=`<div><b>Totale spese: ${formatEuro(budgetGrandTotal())}</b> · <b>Già sostenute: ${formatEuro(budgetSustainedTotal())}</b> · <b>Da sostenere: ${formatEuro(budgetToSustainTotal())}</b></div><div class="small" style="margin-top:5px">${Object.entries(byCat).map(([k,v])=>`${esc(k)}: <b>${formatEuro(v)}</b>`).join(' · ')}</div>`;
}
function inputHTML(id,r,col,value){
 const [key,label,type]=col;
 if(type==='check') return `<input type="checkbox" data-sec="${id}" data-row="${r}" data-key="${key}" ${value?'checked':''} onchange="changeValue(this)">`;
 if(type==='budget-category') return `<select data-sec="${id}" data-row="${r}" data-key="${key}" onchange="changeValue(this)">${BUDGET_CATEGORIES.map(x=>`<option value="${esc(x)}" ${x===value?'selected':''}>${esc(x)}</option>`).join('')}</select>`;
 const extra=type==='number'?` min="0" step="${key==='viaggiatori'?'1':'0.01'}"`:(key==='maps'?` placeholder="https://www.google.com/maps/..."`:'');
 return `<input type="${type}" data-sec="${id}" data-row="${r}" data-key="${key}" value="${esc(value??'')}"${extra} onchange="changeValue(this)">`;
}
function renderRows(id){
 const c=configs[id], tbody=document.querySelector('#sec_'+id+' tbody'); if(!tbody)return; tbody.innerHTML='';
 const rows=Array.isArray(data.sections[id])?data.sections[id]:[];
 rows.forEach((row,i)=>{
  rowUid(row);
  const tr=document.createElement('tr');
  const baseCells=c.cols.map(col=>`<td>${inputHTML(id,i,col,row[col[0]])}</td>`).join('');
  const budgetTotal=id==='budget'?`<td class="budget-total-cell"><strong>${formatEuro(budgetRowTotal(row))}</strong></td>`:'';
  tr.innerHTML=baseCells+budgetTotal+
   `<td class="row-actions"><button type="button" class="danger" onclick="removeRow('${id}',${i})">✕</button><div class="no-print" style="margin-top:5px"><input type="file" class="file-input" accept="application/pdf" multiple onchange="addRowFiles('${id}',${i},this.files)"></div><div class="file-list" id="files_${id}_${i}"></div><div class="print-files" id="printfiles_${id}_${i}"></div></td>`;
  tbody.appendChild(tr); listRowFiles(id,i);
 });
 if(id==='budget') updateBudgetSummary();
}
function addRow(id){
 if(!data.sections[id]) data.sections[id]=[];
 const row={_id:null};
 configs[id].cols.forEach(c=>{
   if(c[2]==='check') row[c[0]]=false;
   else if(c[2]==='number') row[c[0]]=c[0]==='viaggiatori'?1:'';
   else if(c[2]==='budget-category') row[c[0]]=BUDGET_CATEGORIES[0];
   else row[c[0]]='';
 });
 if(id==='budget') row.viaggiatori=travelerCount();
 rowUid(row);
 data.sections[id].push(row); renderRows(id); saveData(); setStatus(`${configs[id].title}: nuova riga aggiunta`);
}
async function removeRow(id,i){
 if(!confirm('Rimuovere questa riga e i suoi allegati?'))return;
 const row=data.sections[id]?.[i], rid=row?rowUid(row):null;
 data.sections[id].splice(i,1);
 const files=await getFiles(x=>x.section===id && (x.rowId===rid || (x.rowId==null && x.row===i)));
 for(const f of files) await deleteStoredFile(f.id);
 renderRows(id); saveData(); await renderPDFManifest();
}
function budgetBookingLinkFor(section,row){
  const rid=rowUid(row);
  return (data.sections?.budget||[]).filter(b=>Array.isArray(b._sourceRowIds)?b._sourceRowIds.includes(rid):b._sourceRowId===rid);
}
function syncBudgetSustainedFromPNR(section,row){
  if(!row || !String(row.pnr||'').trim()) return;
  const linked=budgetBookingLinkFor(section,row);
  linked.forEach(b=>b.sostenuta=true);
  if(linked.length) renderRows('budget');
}

function changeValue(el){
 const id=el.dataset.sec,i=+el.dataset.row,key=el.dataset.key;
 if(!data.sections[id]||!data.sections[id][i])return;
 rowUid(data.sections[id][i]);
 data.sections[id][i][key]=el.type==='checkbox'?el.checked:el.value;
 if(key==='pnr' && ['flights','hotels','cars'].includes(id)) syncBudgetSustainedFromPNR(id,data.sections[id][i]);
 if(id==='budget' && key==='perViaggiatore' && el.checked && (!Number(data.sections[id][i].viaggiatori)||Number(data.sections[id][i].viaggiatori)<1)) data.sections[id][i].viaggiatori=travelerCount();
 saveData(false);
 if(id==='budget') renderRows('budget');
}
async function addRowFiles(id,i,files){
 const row=data.sections[id]?.[i]; if(!row)return;
 const rid=rowUid(row); let count=0;
 for(const f of Array.from(files||[])){
  if(f.type!=='application/pdf'){alert(`"${f.name}" non è un PDF e non verrà allegato.`);continue}
  try{
   const bytes=await f.arrayBuffer();
   await putFile({id:fileId(id,i),tripId:activeTripId,section:id,row:i,rowId:rid,name:f.name,size:f.size,mimeType:'application/pdf',blob:bytes}); count++;
  }catch(err){ console.error('Errore salvataggio allegato:',f.name,err); alert(`Impossibile salvare "${f.name}".\n\n${err.message||err}`); }
 }
 await listRowFiles(id,i); await renderPDFManifest(); setStatus(count?`${count} allegato/i salvato/i`:'Nessun allegato salvato');
}
async function addGlobalFiles(files){
 let count=0;
 for(const f of Array.from(files||[])){
  if(f.type!=='application/pdf'){alert(`"${f.name}" non è un PDF e non verrà allegato.`);continue}
  try{
   const bytes=await f.arrayBuffer();
   await putFile({id:'global_'+fileId('g',-1),tripId:activeTripId,section:'global',row:-1,rowId:null,name:f.name,size:f.size,mimeType:'application/pdf',blob:bytes}); count++;
  }catch(err){ console.error('Errore salvataggio allegato generale:',f.name,err); alert(`Impossibile salvare "${f.name}".\n\n${err.message||err}`); }
 }
 await renderGlobalFiles(); await renderPDFManifest(); setStatus(count?`${count} allegato/i salvato/i`:'Nessun allegato salvato');
}
function attachmentBytes4(f){
 if(f&&f.blob instanceof ArrayBuffer)return new Uint8Array(f.blob);
 if(f&&ArrayBuffer.isView(f.blob))return new Uint8Array(f.blob.buffer,f.blob.byteOffset,f.blob.byteLength);
 if(f&&f.base64)return base64ToBytes(f.base64);
 if(f&&f.blob&&typeof f.blob.arrayBuffer==='function')return f.blob.arrayBuffer().then(x=>new Uint8Array(x));
 throw new Error(`Dati binari mancanti per "${f?.name||'allegato'}".`);
}
async function listRowFiles(id,i){
 const row=data.sections[id]?.[i], rid=row?rowUid(row):null;
 const fs=await getFiles(x=>x.section===id && (x.rowId===rid || (x.rowId==null && x.row===i)));
 const box=document.getElementById(`files_${id}_${i}`),pbox=document.getElementById(`printfiles_${id}_${i}`); if(!box)return;
 box.innerHTML=fs.map(f=>`<div>${esc(f.name)} <button type="button" class="delete-file" onclick="deleteFile('${f.id}','${id}',${i})">✕</button></div>`).join('');
 pbox.innerHTML=fs.length?'<b>Allegati:</b> '+fs.map(f=>esc(f.name)).join(', '):'';
}
async function deleteFile(fid,id,i){try{await deleteStoredFile(fid);await listRowFiles(id,i);await renderPDFManifest();}catch(err){alert(err.message||err)}}
async function renderPDFManifest(){
 const fs=await getFiles(x=>true),box=document.getElementById('pdfAttachmentManifest'); if(!box)return;
 if(!fs.length){box.textContent='Nessun allegato PDF.';return}
 box.innerHTML=fs.map(f=>{const sec=f.section==='global'?'Allegati vari':(configs[f.section]?.title||f.section);const row=f.row>=0?` — riga ${f.row+1}`:'';return `<div>📎 <b>${esc(f.name)}</b> <span class="small">(${esc(sec)}${row})</span></div>`}).join('');
}
async function renderGlobalFiles(){
 const fs=await getFiles(x=>x.section==='global');
 document.getElementById('globalFileList').innerHTML=fs.map(f=>`<div style="padding:5px 0;border-bottom:1px solid #eee">📎 ${esc(f.name)} <button type="button" class="danger no-print" onclick="deleteGlobal('${f.id}')">✕</button></div>`).join('');
}
async function deleteGlobal(id){try{await deleteStoredFile(id);await renderGlobalFiles();await renderPDFManifest();}catch(err){alert(err.message||err)}}

function updateHeader(){
 const titleEl=document.getElementById('title'), startEl=document.getElementById('startDate'), endEl=document.getElementById('endDate');
 const t=titleEl?.value||'Viaggio di lavoro', a=startEl?.value||'', b=endEl?.value||'';
 const titleNode=document.getElementById('docTitle'), datesNode=document.getElementById('docDates');
 if(titleNode) titleNode.textContent=t;
 if(datesNode) datesNode.textContent=(a||b)?`${formatDate(a)}${a&&b?' -> ':''}${formatDate(b)}`:'Inserisci titolo e periodo del viaggio';
}
function formatDate(x){if(!x)return '';const [y,m,d]=x.split('-');return `${d}/${m}/${y}`}
async function exportPDF(){
  saveData();
  updateHeader();
  await renderPDFManifest();
  setStatus('Preparazione riepilogo PDF…');
  setTimeout(()=>window.print(),120);
}

/* ============================================================
   VERSIONE 4 — VERA FUSIONE PDF
   Richiede pdf-lib.min.js nella stessa cartella del file HTML.
   La libreria viene caricata LOCALMENTE: nessun CDN/server.
   ============================================================ */

function pdfEscapeText(s){
  return String(s ?? '').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/\r/g,'').replace(/\n/g,' ');
}


function pdfSafeText4(s,font){
  const text=String(s ?? '');
  if(!font) return text.replace(/→/g,'->');
  let out='';
  for(const ch of text){
    try{
      font.encodeText(ch);
      out+=ch;
    }catch(e){
      // Sostituzioni utili per caratteri comuni non presenti in WinAnsi.
      const repl={
        '→':'->','←':'<-','↔':'<->',
        '•':'-','✓':'OK','✕':'X','📎':'[PDF]',
        '📚':'[PDF]','＋':'+','🖨':'[PDF]','💾':'[SALVA]',
        '↻':'[CARICA]','🗑':'[CANCELLA]','—':'-','–':'-'
      };
      out += repl[ch] ?? '?';
    }
  }
  return out;
}

function cleanText4(s){
  return String(s ?? '').replace(/\s+/g,' ').trim();
}

function wrapText4(text, max){
  const words=String(text||'').split(/\s+/), out=[]; let line='';
  for(const w of words){
    if(!line){line=w;continue}
    if((line+' '+w).length<=max) line+=' '+w;
    else {out.push(line);line=w}
  }
  if(line)out.push(line);
  return out.length?out:[''];
}

function dossierText4(s,font){
  return pdfSafeText4(cleanText4(s),font);
}

function rowDetailLines4(id,row,index){
  const c=configs[id], lines=[];
  c.cols.forEach(([key,label,type])=>{
    let v=row[key];
    if(type==='check') v=v?'SI':'NO';
    if(v!==undefined && v!==null && String(v).trim()!==''){
      const value=type==='date'?formatDate(v):cleanText4(v);
      // Una voce per campo: la suddivisione in righe viene fatta una sola volta
      // in base alla larghezza reale del PDF, evitando sovrapposizioni.
      lines.push(`${label}: ${value}`);
    }
  });
  if(!lines.length) lines.push('Nessun dettaglio compilato.');
  return lines;
}

function wrappedRowPdfLines4(lines,font,size,maxWidth){
  const out=[];
  for(const line of lines){
    const words=String(line).split(/\s+/);
    let cur='';
    for(const word of words){
      const test=cur?cur+' '+word:word;
      if(font.widthOfTextAtSize(dossierText4(test,font),size)>maxWidth && cur){
        out.push(cur);
        cur=word;
      }else cur=test;
    }
    if(cur) out.push(cur);
  }
  return out.length?out:['Nessun dettaglio compilato.'];
}

async function getDossierFiles4(){
  // Ordine aziendale: modulo -> riga -> allegati della riga -> allegati vari.
  // Eliminiamo eventuali duplicati presenti nell'archivio locale, così lo stesso
  // allegato non può essere incorporato due volte nel dossier.
  const raw=await getFiles(x=>true);
  const seen=new Set(), all=[];
  for(const f of raw){
    const key=[f.tripId||'',f.section||'',f.rowId||'',f.row??'',f.name||'',f.size||''].join('|');
    if(seen.has(key)) continue;
    seen.add(key); all.push(f);
  }
  const ordered=[];
  for(const id of Object.keys(configs)){
    const rows=data.sections[id]||[];
    for(let i=0;i<rows.length;i++){
      all.filter(f=>f.section===id && (f.rowId===rowUid(rows[i]) || (f.rowId==null && f.row===i)))
        .sort((a,b)=>String(a.name).localeCompare(String(b.name),'it'))
        .forEach(f=>ordered.push(f));
    }
  }
  all.filter(f=>f.section==='global')
    .sort((a,b)=>String(a.name).localeCompare(String(b.name),'it'))
    .forEach(f=>ordered.push(f));

  // Recupera anche eventuali allegati rimasti nel DB ma non più collegati
  // a una riga esistente: non vengono persi dal dossier.
  all.forEach(f=>{
    if(!ordered.includes(f)) ordered.push(f);
  });
  return ordered;
}

function drawDossierHeader4(page, title, subtitle, bold, font, rgb){
  const {width,height}=page.getSize();
  const accent=rgb(0.72,0.04,0.12);
  const dark=rgb(0.07,0.19,0.30);
  const muted=rgb(0.38,0.45,0.51);
  page.drawRectangle({x:0,y:height-72,width,height:72,color:dark});
  page.drawRectangle({x:0,y:height-72,width:8,height:72,color:accent});
  page.drawText(dossierText4(title,bold),{
    x:32,y:height-31,size:20,font:bold,color:rgb(1,1,1)
  });
  if(subtitle){
    page.drawText(dossierText4(subtitle,font),{
      x:32,y:height-51,size:9.5,font,color:rgb(0.39,0.49,0.56)
    });
  }
  page.drawText(dossierText4('TRAVEL WORK PLANNER',font),{
    x:width-145,y:height-28,size:7.5,font,color:rgb(0.45,0.56,0.64)
  });
}

function addPageNumber4(page,num,font,rgb){
  // Legacy call kept for layout flow. Final page numbers are stamped once,
  // after all attachment pages have been inserted, so numbering is exact.
}

function drawWrappedPdfText4(page,text,x,y,size,font,maxWidth,lineGap,rgb){
  const words=String(text||'').split(/\s+/);
  let line='', yy=y;
  for(const w of words){
    const test=line?line+' '+w:w;
    if(font.widthOfTextAtSize(test,size)>maxWidth && line){
      page.drawText(dossierText4(line,font),{x,y:yy,size,font,color:rgb(0.12,0.20,0.27)});
      yy-=lineGap; line=w;
    }else line=test;
  }
  if(line){
    page.drawText(dossierText4(line,font),{x,y:yy,size,font,color:rgb(0.12,0.20,0.27)});
    yy-=lineGap;
  }
  return yy;
}

async function copyAttachmentPagesFull4(doc,f){
  const bytes=await attachmentBytes4(f);
  const donor=await PDFLib.PDFDocument.load(bytes,{ignoreEncryption:false,updateMetadata:false});
  const indices=donor.getPageIndices();
  if(!indices.length) throw new Error(`Il PDF "${f.name}" non contiene pagine.`);
  const pages=await doc.copyPages(donor,indices);
  const prevSkip=doc.__twpSkipPageRegister===true;
  doc.__twpSkipPageRegister=true;
  pages.forEach(p=>doc.addPage(p));
  doc.__twpSkipPageRegister=prevSkip;
  return pages.length;
}

function addPdfUriLink4(doc,page,url,x,y,width,height){
  try{
    const clean=String(url||'').trim();
    if(!/^https?:\/\//i.test(clean)) return;
    const {PDFName,PDFString,PDFArray}=PDFLib;
    const link=doc.context.obj({
      Type:PDFName.of('Annot'),
      Subtype:PDFName.of('Link'),
      Rect:[x,y,x+width,y+height],
      Border:[0,0,0],
      A:{S:PDFName.of('URI'),URI:PDFString.of(clean)}
    });
    let annots=page.node.lookup(PDFName.of('Annots'),PDFArray);
    if(!annots){
      annots=doc.context.obj([]);
      page.node.set(PDFName.of('Annots'),annots);
    }
    annots.push(link);
  }catch(err){ console.warn('Impossibile creare il link Google Maps nel PDF:',err); }
}

function rowFieldBlocks4(id,row,font,valueSize,maxValueWidth){
  const c=configs[id], blocks=[];
  c.cols.forEach(([key,label,type])=>{
    let v=row[key];
    if(type==='check') v=v?'SI':'NO';
    if(v!==undefined && v!==null && String(v).trim()!==''){
      const rawValue=type==='date'?formatDate(v):cleanText4(v);
      const value=(key==='maps' && /^https?:\/\//i.test(String(rawValue)))?'Apri Google Maps':rawValue;
      const words=String(value).split(/\s+/);
      let lines=[],cur='';
      for(const word of words){
        const test=cur?cur+' '+word:word;
        if(font.widthOfTextAtSize(dossierText4(test,font),valueSize)>maxValueWidth && cur){
          lines.push(cur); cur=word;
        }else cur=test;
      }
      if(cur)lines.push(cur);
      blocks.push({key,label:String(label),value:lines.length?lines:[''],url:key==='maps'?String(rawValue):''});
    }
  });
  if(!blocks.length)blocks.push({label:'Informazioni',value:['Nessun dettaglio compilato.']});
  return blocks;
}

function rowCardHeight4(id,row,w,font){
  const pad=13,labelW=128,valueW=w-pad*2-labelW-12;
  const valueSize=9.6,lineH=13.2,rowPad=7;
  const blocks=rowFieldBlocks4(id,row,font,valueSize,valueW);
  let h=40;
  blocks.forEach(b=>h+=Math.max(1,b.value.length)*lineH+rowPad*2);
  return h+8;
}

function drawModuleIntro4(doc,title,subtitle,bold,font,rgb){
  const W=595.28,H=841.89;
  const page=doc.addPage([W,H]);
  const accent=rgb(0.72,0.04,0.12), dark=rgb(0.07,0.19,0.30);
  page.drawRectangle({x:0,y:H-150,width:W,height:150,color:dark});
  page.drawRectangle({x:0,y:H-150,width:9,height:150,color:accent});
  page.drawText(dossierText4('MODULO',font),{x:38,y:H-49,size:9,font,color:rgb(0.43,0.54,0.62)});
  page.drawText(dossierText4(title,bold),{x:38,y:H-84,size:28,font:bold,color:rgb(1,1,1)});
  page.drawText(dossierText4(subtitle,font),{x:38,y:H-108,size:10,font,color:rgb(0.36,0.47,0.55)});
  page.drawText(dossierText4('SEZIONE DEL TRAVEL REPORT',font),{x:38,y:H-132,size:7.5,font,color:rgb(0.47,0.54,0.60)});
  page.drawRectangle({x:38,y:H-205,width:519,height:1.5,color:accent});
  page.drawText(dossierText4('CONTENUTO',bold),{x:38,y:H-244,size:9,font:bold,color:rgb(0.34,0.41,0.47)});
  page.drawText(dossierText4('Schede operative e documentazione allegata',font),{x:38,y:H-265,size:12,font,color:rgb(0.10,0.18,0.25)});
  page.drawText(dossierText4('Le informazioni sono organizzate per scheda e gli allegati PDF vengono',font),{x:38,y:H-303,size:9.5,font,color:rgb(0.34,0.41,0.47)});
  page.drawText(dossierText4('inseriti immediatamente dopo la relativa scheda.',font),{x:38,y:H-319,size:9.5,font,color:rgb(0.34,0.41,0.47)});
  page.drawText(dossierText4('TRAVEL WORK PLANNER • TRAVEL REPORT',font),{x:38,y:42,size:7.5,font,color:rgb(0.43,0.50,0.56)});
  return page;
}

// Coordinate PDF corrette: y rappresenta il bordo SUPERIORE della scheda.
// Tutti gli elementi della scheda vengono quindi disegnati verso il basso.
function drawRowCard4(page,id,row,i,x,y,w,font,bold,rgb){
  const pad=13,labelW=128,valueW=w-pad*2-labelW-12;
  const valueSize=9.6,lineH=13.2,rowPad=7;
  const blocks=rowFieldBlocks4(id,row,font,valueSize,valueW);
  const cardHeight=rowCardHeight4(id,row,w,font);
  const accent=rgb(0.72,0.04,0.12);
  const dark=rgb(0.07,0.19,0.30);
  const border=rgb(0.83,0.88,0.91);
  const paper=rgb(1,1,1);
  const bottom=y-cardHeight;

  page.drawRectangle({x,y:bottom,width:w,height:cardHeight,color:paper,borderColor:border,borderWidth:0.8});
  page.drawRectangle({x,y:y-31,width:w,height:31,color:dark});
  page.drawRectangle({x,y:y-31,width:6,height:31,color:accent});
  page.drawText(dossierText4(`SCHEDA ${String(i+1).padStart(2,'0')}`,bold),{
    x:x+pad+5,y:y-22,size:10.5,font:bold,color:rgb(1,1,1)
  });

  let yy=y-43;
  blocks.forEach((b,idx)=>{
    const rowH=Math.max(1,b.value.length)*lineH+rowPad*2;
    const rowBottom=yy-rowH+rowPad;
    if(idx%2===0){
      page.drawRectangle({x:x+1,y:yy-rowH+1,width:w-2,height:rowH,color:rgb(0.94,0.96,0.97)});
    }
    page.drawText(dossierText4(b.label.toUpperCase(),bold),{
      x:x+pad,y:yy-rowPad-7,size:7.2,font:bold,color:rgb(0.32,0.40,0.47)
    });
    b.value.forEach((line,j)=>{
      const tx=x+pad+labelW+12, ty=yy-rowPad-7-j*lineH;
      const isMaps=b.key==='maps'&&b.url;
      page.drawText(dossierText4(line,font),{
        x:tx,y:ty,size:valueSize,font,color:isMaps?rgb(0.05,0.25,0.62):rgb(0.12,0.20,0.27)
      });
      if(isMaps){
        const tw=font.widthOfTextAtSize(dossierText4(line,font),valueSize);
        addPdfUriLink4(page.__twpDoc,page,b.url,tx,ty-2,tw,valueSize+5);
      }
    });
    yy-=rowH;
  });
  return bottom-10;
}

function drawAttachmentLabel4(page,f,rowLabel,y,bold,font,rgb){
  const x=36,w=523,h=28;
  const bottom=y-h;
  page.drawRectangle({x,y:bottom,width:w,height:h,color:rgb(0.94,0.96,0.97),borderColor:rgb(0.85,0.89,0.92),borderWidth:0.5});
  page.drawRectangle({x,y:bottom,width:4,height:h,color:rgb(0.72,0.04,0.12)});
  const name=cleanText4(f.name);
  const maxNameW=340;
  let display=name;
  while(display.length>8 && font.widthOfTextAtSize(dossierText4(display,bold),8.8)>maxNameW) display=display.slice(0,-1);
  if(display!==name)display+='…';
  page.drawText(dossierText4(display,bold),{
    x:x+12,y:bottom+10,size:8.8,font:bold,color:rgb(0.10,0.18,0.25)
  });
  const rw=font.widthOfTextAtSize(dossierText4(rowLabel,font),8);
  page.drawText(dossierText4(rowLabel,font),{
    x:x+w-12-rw,y:bottom+10,size:8,font,color:rgb(0.38,0.45,0.51)
  });
  return bottom-12;
}

function drawBudgetTable4(page,y,rows,font,bold,rgb,newPage,H){
 const x=36,W=523,headerH=25,rowH=29;
 const cols=[['Voce di spesa',150],['Descrizione',105],['Costo unit.',65],['N.',38],['Totale',85],['Stato',80]];
 const drawHeader=()=>{page.drawRectangle({x,y:y-headerH,width:W,height:headerH,color:rgb(0.07,0.19,0.30)});let xx=x;cols.forEach(([label,w])=>{page.drawText(dossierText4(label.toUpperCase(),bold),{x:xx+6,y:y-17,size:7.3,font:bold,color:rgb(1,1,1)});xx+=w;});};
 drawHeader(); y-=headerH;
 for(let i=0;i<rows.length;i++){
  const r=rows[i];
  if(y-rowH<60){page=newPage('BUDGET VIAGGIO','Riepilogo spese — continua');y=H-118;drawHeader();y-=headerH;}
  if(i%2===0)page.drawRectangle({x,y:y-rowH,width:W,height:rowH,color:rgb(0.94,0.96,0.97)});
  const vals=[r.categoria||'Varie',r.descrizione||'',formatEuro(Number(r.costo)||0),r.perViaggiatore?String(Math.max(1,Number(r.viaggiatori)||1)):'1',formatEuro(budgetRowTotal(r)),r.sostenuta?'SOSTENUTA':'DA SOSTENERE'];
  let xx=x;vals.forEach((v,j)=>{const w=cols[j][1];let txt=cleanText4(v),orig=txt;while(txt.length>8&&font.widthOfTextAtSize(dossierText4(txt,font),8.1)>w-12)txt=txt.slice(0,-1);if(txt!==orig)txt+='…';page.drawText(dossierText4(txt,font),{x:xx+6,y:y-18,size:8.1,font,color:j===4?rgb(0.72,0.04,0.12):rgb(0.07,0.19,0.30)});xx+=w;});
  page.drawLine({start:{x,y:y-rowH},end:{x:x+W,y:y-rowH},thickness:0.4,color:rgb(0.83,0.88,0.91)});y-=rowH;
 }
 if(y-72<45){page=newPage('BUDGET VIAGGIO','Riepilogo totale — continua');y=H-118;}
 page.drawRectangle({x,y:y-40,width:W,height:40,color:rgb(0.93,0.95,0.97),borderColor:rgb(0.78,0.84,0.88),borderWidth:0.6});
 const total=formatEuro(budgetGrandTotal()),sostenute=formatEuro(budgetSustainedTotal()),daSostenere=formatEuro(budgetToSustainTotal());
 page.drawRectangle({x,y:y-68,width:W,height:68,color:rgb(0.93,0.95,0.97),borderColor:rgb(0.78,0.84,0.88),borderWidth:0.6});
 page.drawText(dossierText4('TOTALE SPESE PREVENTIVATE',bold),{x:x+12,y:y-21,size:9.5,font:bold,color:rgb(0.10,0.18,0.25)});
 page.drawText(dossierText4(total,bold),{x:x+W-12-bold.widthOfTextAtSize(dossierText4(total,bold),12),y:y-23,size:12,font:bold,color:rgb(0.72,0.04,0.12)});
 page.drawText(dossierText4('GIÀ SOSTENUTE',bold),{x:x+12,y:y-43,size:8.5,font:bold,color:rgb(0.10,0.18,0.25)});
 page.drawText(dossierText4(sostenute,bold),{x:x+W-12-bold.widthOfTextAtSize(dossierText4(sostenute,bold),10),y:y-45,size:10,font:bold,color:rgb(0.10,0.18,0.25)});
 page.drawText(dossierText4('DA SOSTENERE',bold),{x:x+12,y:y-61,size:8.5,font:bold,color:rgb(0.10,0.18,0.25)});
 page.drawText(dossierText4(daSostenere,bold),{x:x+W-12-bold.widthOfTextAtSize(dossierText4(daSostenere,bold),10),y:y-63,size:10,font:bold,color:rgb(0.10,0.18,0.25)});
 // Nota metodologica: i valori del budget provenienti dalle ricerche sono indicativi.
 const budgetNote="NOTA SUI PREZZI: i prezzi riportati nel budget sono indicativi e si riferiscono alle condizioni disponibili al momento della ricerca. Non tengono conto di eventuali acquisti o supplementi accessori, ad esempio bagagli da stiva, priority boarding, scelta del posto, servizi extra o altre opzioni aggiuntive. Verificare sempre il prezzo finale prima dell'acquisto.";
 const noteLines=wrappedRowPdfLines4([budgetNote],font,8,505);
 let ny=y-94;
 page.drawText(dossierText4('NOTA IMPORTANTE',bold),{x:x+12,y:ny,size:8.5,font:bold,color:rgb(0.72,0.04,0.12)});
 ny-=13;
 for(const line of noteLines){
   page.drawText(dossierText4(line,font),{x:x+12,y:ny,size:8,font,color:rgb(0.34,0.41,0.47)});
   ny-=10;
 }
 return {page,y:ny-8};
}

async function embedTravelHero4(doc){
  try{
    const r=await fetch('home-hero.jpg',{cache:'no-store'});
    if(!r.ok) return null;
    const bytes=await r.arrayBuffer();
    return await doc.embedJpg(bytes);
  }catch(e){
    console.warn('Immagine copertina non disponibile:',e);
    return null;
  }
}

// ===== MAPPA ITINERARIO =====
function travelMapLocations4(){
  // La mappa della prima pagina del Travel Report mostra esclusivamente
  // gli aeroporti dei voli e il relativo itinerario aereo.
  const out=[];
  const push=(label,query,iata)=>{
    const q=String(query||label||'').trim(); if(!q && !iata)return;
    out.push({kind:'airport',label:String(label||q||iata||'').trim(),query:q,iata:iata?String(iata).toUpperCase():''});
  };
  const airportCode=v=>{
    const m=String(v||'').match(/^\s*([A-Za-z]{3})\s*[—-]/);
    return m?m[1].toUpperCase():(/^[A-Za-z]{3}$/.test(String(v||'').trim())?String(v).trim().toUpperCase():'');
  };
  (data.sections?.flights||[]).forEach(f=>{
    push(f.partenza||'',f.partenza||'',airportCode(f.partenza));
    push(f.arrivo||'',f.arrivo||'',airportCode(f.arrivo));
  });
  const seen=new Set();
  return out.filter(x=>{const k=(x.iata+'|'+x.query).toLowerCase();if(!x.label||seen.has(k))return false;seen.add(k);return true}).slice(0,12);
}
async function resolveTravelMapLocations4(){
  const locations=travelMapLocations4(); if(!locations.length)return null;
  try{
    const r=await fetch('/api/travel-map',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locations})});
    if(!r.ok)return null; const obj=await r.json(); if(!obj?.ok||!Array.isArray(obj.locations)||!obj.locations.length)return null; return obj;
  }catch(e){console.warn('Coordinate mappa itinerario non disponibili:',e);return null}
}
function tilePoint4(lat,lon,z){
  const n=2**z, la=Math.max(-85.05112878,Math.min(85.05112878,Number(lat))); const lr=la*Math.PI/180;
  return {x:(Number(lon)+180)/360*n,y:(1-Math.asinh(Math.tan(lr))/Math.PI)/2*n};
}
function loadImage4(src){return new Promise((resolve,reject)=>{const im=new Image();im.crossOrigin='anonymous';im.onload=()=>resolve(im);im.onerror=()=>reject(new Error('Immagine non caricabile'));im.src=src})}
function dataUrlBytes4(dataUrl){
  const m=String(dataUrl||'').match(/^data:[^;]+;base64,(.*)$/);
  if(!m) return null;
  try{return base64ToBytes(m[1]);}catch(e){console.warn('Conversione immagine mappa fallita:',e);return null;}
}
async function buildTravelMapCanvas4(locations,width=760,height=760){
  if(!Array.isArray(locations)||!locations.length)return null;
  // Proiezione geografica corretta: X e Y usano SEMPRE la stessa scala.
  // La versione precedente stirava separatamente il mosaico in larghezza e
  // altezza; con NAP-BER questo spostava visivamente gli aeroporti rispetto
  // alla loro reale posizione sulla cartografia.
  let z=7;
  for(let zz=3;zz<=12;zz++){
    const pp=locations.map(x=>tilePoint4(x.lat,x.lon,zz));
    const sx=Math.max(...pp.map(q=>q.x))-Math.min(...pp.map(q=>q.x));
    const sy=Math.max(...pp.map(q=>q.y))-Math.min(...pp.map(q=>q.y));
    // scegliamo il livello più dettagliato che consenta di coprire il viaggio
    // con un piccolo margine, senza mai deformare la cartografia.
    if(sx<=5.5 && sy<=5.5) z=zz;
    else break;
  }
  const pp0=locations.map(x=>tilePoint4(x.lat,x.lon,z));
  let minx=Math.min(...pp0.map(q=>q.x)),maxx=Math.max(...pp0.map(q=>q.x));
  let miny=Math.min(...pp0.map(q=>q.y)),maxy=Math.max(...pp0.map(q=>q.y));
  let spanx=Math.max(.12,maxx-minx),spany=Math.max(.12,maxy-miny);
  // Vista quadrata: allarghiamo la finestra geografica soprattutto in longitudine,
  // senza deformare la cartografia. In questo modo NAP-BER resta verticale come
  // geografia, ma la mappa occupa davvero un riquadro quadrato leggibile.
  const targetSpan=Math.max(spanx*1.08,spany*1.08);
  const padX=Math.max(.34,(targetSpan-spanx)/2),padY=Math.max(.18,(targetSpan-spany)/2);
  minx-=padX;maxx+=padX;miny-=padY;maxy+=padY;
  spanx=maxx-minx;spany=maxy-miny;

  const tx0=Math.floor(minx),tx1=Math.floor(maxx),ty0=Math.floor(miny),ty1=Math.floor(maxy);
  const cw=(tx1-tx0+1)*256,ch=(ty1-ty0+1)*256;
  const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');
  ctx.fillStyle='#eef3f7';ctx.fillRect(0,0,width,height);
  let tilesOk=0;
  const tileSources=[
    x=>`https://tile.openstreetmap.org/${z}/${((x.tx%(2**z))+(2**z))%(2**z)}/${x.ty}.png`,
    x=>`https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${((x.tx%(2**z))+(2**z))%(2**z)}/${x.ty}.png`
  ];
  // Mosaico geografico non deformato: ogni tile mantiene il proprio rapporto 1:1.
  const scale=Math.min(width/(spanx*256),height/(spany*256));
  const viewW=spanx*256*scale,viewH=spany*256*scale;
  const ox=(width-viewW)/2,oy=(height-viewH)/2;
  const tileScale=scale;
  for(let tx=tx0;tx<=tx1;tx++)for(let ty=ty0;ty<=ty1;ty++){
    let loaded=false;
    for(const src of tileSources){
      try{
        const im=await loadImage4(src({tx,ty}));
        const dx=ox+(tx-minx)*256*tileScale,dy=oy+(ty-miny)*256*tileScale;
        ctx.drawImage(im,dx,dy,256*tileScale,256*tileScale);
        tilesOk++;loaded=true;break;
      }catch(e){}
    }
  }
  if(!tilesOk){
    ctx.fillStyle='#f4f7fa';ctx.fillRect(0,0,width,height);
    ctx.strokeStyle='#d7e2eb';ctx.lineWidth=1;
    for(let x=0;x<width;x+=55){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke()}
    for(let y=0;y<height;y+=55){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke()}
  }
  const project=q=>{
    const pt=tilePoint4(q.lat,q.lon,z);
    return {x:ox+(pt.x-minx)*256*scale,y:oy+(pt.y-miny)*256*scale};
  };

  // Percorsi aerei: primo volo cronologico = ANDATA, ultimo = RITORNO.
  try{
    const flightRows=Array.isArray(data.sections?.flights)?data.sections.flights:[];
    const flightKey=f=>String(f.dataPartenza||'')+'T'+String(f.oraPartenza||'00:00');
    const orderedFlights=flightRows.filter(f=>f?.partenza&&f?.arrivo).slice().sort((a,b)=>flightKey(a).localeCompare(flightKey(b)));
    const airportsByIata=new Map();
    locations.forEach(q=>{if(q.kind==='airport'&&q.iata)airportsByIata.set(q.iata.toUpperCase(),q)});
    const airportIata=v=>{const m=String(v||'').match(/^\s*([A-Za-z]{3})\s*[—-]/);return m?m[1].toUpperCase():(/^[A-Za-z]{3}$/.test(String(v||'').trim())?String(v).trim().toUpperCase():'')};
    const drawRoute=(a,b,dashed,stroke)=>{
      if(!a||!b)return;
      const lat1=Number(a.lat)*Math.PI/180,lon1=Number(a.lon)*Math.PI/180;
      const lat2=Number(b.lat)*Math.PI/180,lon2=Number(b.lon)*Math.PI/180;
      const p1=[Math.cos(lat1)*Math.cos(lon1),Math.cos(lat1)*Math.sin(lon1),Math.sin(lat1)];
      const p2=[Math.cos(lat2)*Math.cos(lon2),Math.cos(lat2)*Math.sin(lon2),Math.sin(lat2)];
      let dot=p1[0]*p2[0]+p1[1]*p2[1]+p1[2]*p2[2];dot=Math.max(-1,Math.min(1,dot));
      const omega=Math.acos(dot),sinOmega=Math.sin(omega),points=[];
      const count=Math.max(40,Math.ceil(omega*180/Math.PI*2));
      for(let i=0;i<=count;i++){
        const t=i/count; let q;
        if(sinOmega<1e-8)q=p1.slice();
        else{
          const s1=Math.sin((1-t)*omega)/sinOmega,s2=Math.sin(t*omega)/sinOmega;
          q=[s1*p1[0]+s2*p2[0],s1*p1[1]+s2*p2[1],s1*p1[2]+s2*p2[2]];
        }
        const qlat=Math.atan2(q[2],Math.hypot(q[0],q[1]))*180/Math.PI;
        const qlon=Math.atan2(q[1],q[0])*180/Math.PI;
        const pp=project({lat:qlat,lon:qlon});
        // La rotta di ritorno segue la stessa tratta ma viene separata
        // leggermente al centro; gli estremi restano esattamente sugli aeroporti.
        if(dashed){
          const pStart=project(a),pEnd=project(b);
          const dx=pEnd.x-pStart.x,dy=pEnd.y-pStart.y,len=Math.hypot(dx,dy)||1;
          const nx=-dy/len,ny=dx/len,off=7*Math.sin(Math.PI*t);
          pp.x+=nx*off;pp.y+=ny*off;
          if(i===0||i===count){pp.x=i===0?pStart.x:pEnd.x;pp.y=i===0?pStart.y:pEnd.y;}
        }
        points.push(pp);
      }
      const draw=()=>{ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);ctx.stroke()};
      ctx.save();ctx.strokeStyle='rgba(255,255,255,.96)';ctx.lineWidth=7;ctx.setLineDash([]);draw();
      ctx.strokeStyle=stroke;ctx.lineWidth=3.2;ctx.setLineDash(dashed?[10,7]:[]);draw();ctx.restore();
    };
    orderedFlights.forEach((f,idx)=>{
      const a=airportsByIata.get(airportIata(f.partenza)),b=airportsByIata.get(airportIata(f.arrivo));
      drawRoute(a,b,idx===orderedFlights.length-1&&orderedFlights.length>1,idx===orderedFlights.length-1&&orderedFlights.length>1?'#c92c3b':'#1b73c9');
    });
  }catch(e){console.warn('Percorsi aerei mappa non disponibili:',e)}

  locations.forEach(q=>{
    const {x:px,y:py}=project(q);
    const col='#0b477a';
    ctx.beginPath();ctx.arc(px,py,11,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();ctx.lineWidth=3;ctx.strokeStyle='#fff';ctx.stroke();
    ctx.fillStyle='#fff';ctx.font='bold 12px Segoe UI,Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('✈',px,py+1);ctx.textAlign='left';ctx.textBaseline='alphabetic';
    const lab=(q.iata||q.label||'').slice(0,28),tw=ctx.measureText(lab).width+18;let bx=px+15;if(bx+tw>width-8)bx=px-tw-15;let by=Math.max(8,Math.min(height-34,py-29));ctx.fillStyle='rgba(255,255,255,.97)';ctx.strokeStyle='#d7e0e7';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(bx,by,tw,30,7);ctx.fill();ctx.stroke();ctx.fillStyle='#18324a';ctx.font='bold 13px Segoe UI,Arial';ctx.fillText(lab,bx+9,by+20);
  });
  // La legenda Andata/Ritorno non viene più disegnata sopra la cartografia:
  // nella prima pagina del PDF è già presente la legenda nella colonna laterale.
  // Questo evita il rettangolo bianco che copriva la parte alta della mappa.
  ctx.font='11px Segoe UI,Arial';ctx.fillStyle='#687b8b';ctx.fillText('© OpenStreetMap contributors · mappa stradale reale',18,height-12);
  return {dataUrl:c.toDataURL('image/jpeg',.9),locations};
}
async function getTravelMapImage4(){
  try{const obj=await resolveTravelMapLocations4();if(!obj)return null;return await buildTravelMapCanvas4(obj.locations)}catch(e){console.warn('Mappa itinerario non disponibile:',e);return null}
}
window.twpGetTravelMapImage4=getTravelMapImage4;

async function createDossierPDF(){
  try{
    if(!window.PDFLib || !PDFLib.PDFDocument){
      alert('Motore PDF non trovato.\\n\\nAssicurati che pdf-lib.min.js sia nella stessa cartella del file HTML.');
      return;
    }
    collect();
    await saveData(false);
    setStatus('Preparazione Travel Report…');
    const {PDFDocument,StandardFonts,rgb}=PDFLib;
    const doc=await PDFDocument.create();
    const font=await doc.embedFont(StandardFonts.Helvetica);
    const bold=await doc.embedFont(StandardFonts.HelveticaBold);
    const W=595.28,H=841.89;
    const dossierPages=[];
    const files=await getDossierFiles4();
    let incorporatedPages=0;
    let page=null;
    const newPage=(title,subtitle,header=true)=>{
      const p=doc.addPage([W,H]);
      p.__twpDoc=doc; dossierPages.push(p);
      if(header) drawDossierHeader4(p,title,subtitle,bold,font,rgb);
      return p;
    };
    const drawSectionLabel=(p,text,x,y,color)=>{
      p.drawText(dossierText4(text,bold),{x,y,size:10.2,font:bold,color});
      p.drawRectangle({x,y:y-8,width:58,height:2,color});
    };
    const drawPin=(p,cx,cy,color)=>{
      p.drawCircle({x:cx,y:cy+3,size:4.1,color,borderColor:color,borderWidth:.4});
      p.drawCircle({x:cx,y:cy+3,size:1.45,color:rgb(1,1,1)});
      p.drawLine({start:{x:cx-3,y:cy},end:{x:cx,y:cy-5.1},thickness:1.3,color});
      p.drawLine({start:{x:cx+3,y:cy},end:{x:cx,y:cy-5.1},thickness:1.3,color});
    };
    const drawAirplane=(p,cx,cy,color)=>{
      p.drawLine({start:{x:cx,y:cy-6},end:{x:cx,y:cy+6},thickness:2,color});
      p.drawLine({start:{x:cx-6,y:cy-1},end:{x:cx+6,y:cy-1},thickness:2,color});
      p.drawLine({start:{x:cx-3.5,y:cy+3},end:{x:cx+3.5,y:cy+3},thickness:1.5,color});
      p.drawLine({start:{x:cx,y:cy+4},end:{x:cx-3,y:cy+7},thickness:1.3,color});
      p.drawLine({start:{x:cx,y:cy+4},end:{x:cx+3,y:cy+7},thickness:1.3,color});
    };
    const drawCalendar=(p,cx,cy,color)=>{
      p.drawRectangle({x:cx-7,y:cy-6,width:14,height:13,borderColor:color,borderWidth:1.5,color:rgb(1,1,1)});
      p.drawLine({start:{x:cx-7,y:cy+2},end:{x:cx+7,y:cy+2},thickness:1.5,color});
      p.drawLine({start:{x:cx-3.5,y:cy+8},end:{x:cx-3.5,y:cy+4},thickness:1.6,color});
      p.drawLine({start:{x:cx+3.5,y:cy+8},end:{x:cx+3.5,y:cy+4},thickness:1.6,color});
    };
    const drawBed=(p,cx,cy,color)=>{
      p.drawRectangle({x:cx-8,y:cy-5,width:16,height:8,borderColor:color,borderWidth:1.5,color:rgb(1,1,1)});
      p.drawRectangle({x:cx-7,y:cy+1,width:5,height:4,borderColor:color,borderWidth:1,color:rgb(1,1,1)});
      p.drawLine({start:{x:cx-8,y:cy-5},end:{x:cx-8,y:cy+7},thickness:1.5,color});
      p.drawLine({start:{x:cx+8,y:cy-5},end:{x:cx+8,y:cy+7},thickness:1.5,color});
    };
    const drawCar=(p,cx,cy,color)=>{
      p.drawRectangle({x:cx-9,y:cy-4,width:18,height:8,borderColor:color,borderWidth:1.5,color:rgb(1,1,1)});
      p.drawLine({start:{x:cx-6,y:cy+4},end:{x:cx-3,y:cy+8},thickness:1.5,color});
      p.drawLine({start:{x:cx+6,y:cy+4},end:{x:cx+3,y:cy+8},thickness:1.5,color});
      p.drawCircle({x:cx-6,y:cy-5,size:2.5,color}); p.drawCircle({x:cx+6,y:cy-5,size:2.5,color});
    };
    const drawMoney=(p,cx,cy,color)=>{
      p.drawCircle({x:cx,y:cy,size:7,color:rgb(1,1,1),borderColor:color,borderWidth:1.5});
      p.drawText(dossierText4('€',bold),{x:cx-3.1,y:cy-3.3,size:7,font:bold,color});
    };
    const drawPerson=(p,cx,cy,color)=>{
      p.drawCircle({x:cx,y:cy+4,size:3.2,color});
      p.drawLine({start:{x:cx-6,y:cy-5},end:{x:cx+6,y:cy-5},thickness:2,color});
      p.drawLine({start:{x:cx-4,y:cy-4},end:{x:cx-2,y:cy+1},thickness:1.8,color});
      p.drawLine({start:{x:cx+4,y:cy-4},end:{x:cx+2,y:cy+1},thickness:1.8,color});
    };
    const drawWrapped=(p,text,x,y,size,maxWidth,lineGap,color,maxLines=3)=>{
      const words=String(text||'').split(/\s+/).filter(Boolean); let line='',yy=y,count=0;
      for(const w of words){
        const test=line?line+' '+w:w;
        if(font.widthOfTextAtSize(dossierText4(test,font),size)>maxWidth && line){
          p.drawText(dossierText4(line,font),{x,y:yy,size,font,color}); yy-=lineGap; count++; line=w;
          if(count>=maxLines-1){
            let rest=line; while(rest.length>5&&font.widthOfTextAtSize(dossierText4(rest+'…',font),size)>maxWidth)rest=rest.slice(0,-1);
            p.drawText(dossierText4(rest+'…',font),{x,y:yy,size,font,color}); return yy-lineGap;
          }
        }else line=test;
      }
      if(line){p.drawText(dossierText4(line,font),{x,y:yy,size,font,color});yy-=lineGap;}
      return yy;
    };

    // DATI CONDIVISI
    const flights=(data.sections?.flights||[]).filter(f=>f?.partenza&&f?.arrivo).slice().sort((a,b)=>{
      const ka=String(a.dataPartenza||'')+'T'+String(a.oraPartenza||'00:00');
      const kb=String(b.dataPartenza||'')+'T'+String(b.oraPartenza||'00:00');
      return ka.localeCompare(kb);
    });
    const hotels=(data.sections?.hotels||[]).filter(Boolean);
    const cars=(data.sections?.cars||[]).filter(Boolean);
    const restaurants=(data.sections?.restaurants||[]).filter(Boolean);
    const places=(data.sections?.places||[]).filter(Boolean);
    const agenda=(data.sections?.agenda||[]).filter(a=>a&&(a.data||a.ora||a.descrizione||a.luogo||a.note)).slice().sort((a,b)=>{
      return (String(a.data||'')+'T'+String(a.ora||'00:00')).localeCompare(String(b.data||'')+'T'+String(b.ora||'00:00'));
    });
    const travelers=(data.sections?.travelers||[]).filter(t=>t&&(t.nome||t.cognome||t.ruolo||t.email||t.telefono));
    const mapInfo=await getTravelMapImage4();
    const airportCode4=v=>{const m=String(v||'').match(/^\s*([A-Za-z]{3})\s*[—-]/);return m?m[1].toUpperCase():(/^[A-Za-z]{3}$/.test(String(v||'').trim())?String(v).trim().toUpperCase():'')};
    const airportSeen=new Set(),airportRows=[];
    const mapLocs=mapInfo?.locations||[],mapByIata=new Map(mapLocs.filter(x=>x?.iata).map(x=>[String(x.iata).toUpperCase(),x]));
    flights.forEach(f=>[['partenza',f.partenza],['arrivo',f.arrivo]].forEach(([side,val])=>{
      const iata=airportCode4(val); if(!iata||airportSeen.has(iata))return; airportSeen.add(iata);
      const m=mapByIata.get(iata)||{};
      const label=String(m.display||m.label||iata);
      airportRows.push({iata,nome:label,indirizzo:String(m.address||''),maps:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label+' airport')}`});
    }));

    // PAGINA 1 — TESTATA + MAPPA QUADRATA + LEGENDA/AEROPORTI + BARRA RIEPILOGO
    const reportTitle=String(data.title||'Travel Report').trim()||'Travel Report';
    const reportDates=(data.startDate||data.endDate)?`${formatDate(data.startDate)||'Data da definire'}${data.endDate?' → '+(formatDate(data.endDate)||'Data da definire'):''}`:'Pianificazione viaggio';
    page=newPage(reportTitle,reportDates,true);
    {
      const dark=rgb(0.07,0.19,0.30),muted=rgb(0.38,0.45,0.51),blue=rgb(0.07,0.36,0.61),red=rgb(0.72,0.04,0.12),green=rgb(0.08,0.49,0.40);
      page.drawText(dossierText4(travelers.length?`VIAGGIATORI · ${travelers.map(t=>[t.nome,t.cognome].filter(Boolean).join(' ')).filter(Boolean).join(' · ')}`:'VIAGGIATORI · Nessun nominativo inserito',font),{x:36,y:748,size:7.3,font,color:muted});
      const mapX=36,mapY=294,mapSize=380,sideX=426,sideW=133,topY=674;
      page.drawRectangle({x:mapX,y:mapY,width:mapSize,height:mapSize,color:rgb(.96,.98,.99),borderColor:rgb(.82,.88,.92),borderWidth:.7});
      let mapImg=null;
      try{const b=mapInfo?.dataUrl?dataUrlBytes4(mapInfo.dataUrl):null;if(b)mapImg=await doc.embedJpg(b);}catch(e){console.warn('Embedding mappa nel PDF fallito:',e)}
      if(mapImg){
        const iw=mapImg.width||760,ih=mapImg.height||760,fit=Math.min((mapSize-8)/iw,(mapSize-8)/ih),dw=iw*fit,dh=ih*fit;
        page.drawImage(mapImg,{x:mapX+(mapSize-dw)/2,y:mapY+(mapSize-dh)/2,width:dw,height:dh});
      }else{
        page.drawRectangle({x:mapX+4,y:mapY+4,width:mapSize-8,height:mapSize-8,color:rgb(.94,.97,.99),borderColor:rgb(.82,.88,.92),borderWidth:.6});
        page.drawText(dossierText4('MAPPA NON DISPONIBILE',bold),{x:mapX+112,y:mapY+188,size:9,font:bold,color:muted});
      }
      // Barra laterale: legenda
      page.drawRectangle({x:sideX,y:mapY,width:sideW,height:mapSize,color:rgb(.97,.985,.995),borderColor:rgb(.82,.88,.92),borderWidth:.7});
      page.drawText(dossierText4('LEGENDA',bold),{x:sideX+10,y:topY-17,size:10.5,font:bold,color:dark});
      page.drawLine({start:{x:sideX+10,y:topY-26},end:{x:sideX+sideW-10,y:topY-26},thickness:.7,color:rgb(.82,.88,.92)});
      let sy=topY-45;
      // aeroporto partenza
      page.drawCircle({x:sideX+18,y:sy+2,size:7,color:green});drawAirplane(page,sideX+18,sy+2,rgb(1,1,1));
      page.drawText(dossierText4('Aeroporto partenza',font),{x:sideX+31,y:sy,size:6.6,font,color:dark});sy-=25;
      page.drawCircle({x:sideX+18,y:sy+2,size:7,color:red});drawAirplane(page,sideX+18,sy+2,rgb(1,1,1));
      page.drawText(dossierText4('Aeroporto arrivo',font),{x:sideX+31,y:sy,size:6.6,font,color:dark});sy-=25;
      page.drawLine({start:{x:sideX+11,y:sy+2},end:{x:sideX+27,y:sy+2},thickness:3,color:blue});page.drawText(dossierText4('Rotta andata',font),{x:sideX+31,y:sy,size:6.6,font,color:dark});sy-=25;
      page.drawLine({start:{x:sideX+11,y:sy+2},end:{x:sideX+27,y:sy+2},thickness:3,color:red,dashArray:[6,4]});page.drawText(dossierText4('Rotta ritorno',font),{x:sideX+31,y:sy,size:6.6,font,color:dark});
      sy-=29; page.drawLine({start:{x:sideX+10,y:sy+9},end:{x:sideX+sideW-10,y:sy+9},thickness:.7,color:rgb(.82,.88,.92)});
      page.drawText(dossierText4('AEROPORTI',bold),{x:sideX+10,y:sy-7,size:9,font:bold,color:dark}); sy-=24;
      airportRows.slice(0,3).forEach(a=>{
        page.drawText(dossierText4(`${a.iata}  ${a.nome.replace(/\s+Airport$/i,'')}`,bold),{x:sideX+10,y:sy,size:6.6,font:bold,color:dark});sy-=10;
        if(a.indirizzo)sy=drawWrapped(page,a.indirizzo,sideX+10,sy,5.8,sideW-20,7,rgb(.30,.38,.45),2);
        sy-=5;
        drawPin(page,sideX+13,sy+1,blue);
        const txt='Google Maps';page.drawText(dossierText4(txt,bold),{x:sideX+24,y:sy,size:5.9,font:bold,color:blue});
        addPdfUriLink4(doc,page,a.maps,sideX+22,sy-3,sideW-32,10);sy-=18;
      });
      if(!airportRows.length)page.drawText(dossierText4('Nessun aeroporto',font),{x:sideX+10,y:sy,size:6.2,font,color:muted});

      // Barra orizzontale riepilogo operativo
      const barX=36,barY=82,barW=523,barH=154;
      page.drawRectangle({x:barX,y:barY,width:barW,height:barH,color:rgb(.965,.98,.99),borderColor:rgb(.80,.87,.91),borderWidth:.7});
      const cells=[
        ['VOLI',flights.length?`${flights.length} ${flights.length===1?'volo':'voli'}`:'Nessun volo',blue,'flight'],
        ['HOTEL',hotels.length?(hotels[0].nome||`${hotels.length} hotel`):'Nessun hotel',green,'hotel'],
        ['AUTONOLEGGIO',cars.length?'Presente':'Nessun noleggio',blue,'car'],
        ['APPUNTAMENTI',String(agenda.length),rgb(.35,.28,.60),'agenda'],
        ['BUDGET',formatEuro(budgetGrandTotal()),red,'money']
      ];
      const cellW=barW/5;
      cells.forEach((c,i)=>{
        const cx=barX+i*cellW;
        if(i)page.drawLine({start:{x:cx,y:barY+18},end:{x:cx,y:barY+barH-18},thickness:.6,color:rgb(.78,.85,.90)});
        const ix=cx+18,iy=barY+barH-34;
        if(c[3]==='flight')drawAirplane(page,ix,iy,c[2]);
        if(c[3]==='hotel')drawBed(page,ix,iy,c[2]);
        if(c[3]==='car')drawCar(page,ix,iy,c[2]);
        if(c[3]==='agenda')drawCalendar(page,ix,iy,c[2]);
        if(c[3]==='money')drawMoney(page,ix,iy,c[2]);
        page.drawText(dossierText4(c[0],bold),{x:cx+32,y:iy-3,size:6.8,font:bold,color:dark});
        drawWrapped(page,c[1],cx+18,iy-24,7.4,cellW-28,9,dark,3);
        if(c[3]==='flight'&&flights[0]){
          page.drawText(dossierText4(`${formatDate(flights[0].dataPartenza)||''} · ${flights[0].oraPartenza||''}`,font),{x:cx+18,y:barY+25,size:6.3,font,color:muted});
        }
        if(c[3]==='hotel'&&hotels[0])page.drawText(dossierText4(`${formatDate(hotels[0].checkin)||''} → ${formatDate(hotels[0].checkout)||''}`,font),{x:cx+18,y:barY+25,size:6.3,font,color:muted});
        if(c[3]==='car'&&cars[0])page.drawText(dossierText4(`${formatDate(cars[0].prelievoData)||''} → ${formatDate(cars[0].riconsegnaData)||''}`,font),{x:cx+18,y:barY+25,size:6.3,font,color:muted});
        if(c[3]==='agenda')page.drawText(dossierText4('inseriti nel Planner',font),{x:cx+18,y:barY+25,size:6.3,font,color:muted});
        if(c[3]==='money')page.drawText(dossierText4('totale preventivato',font),{x:cx+18,y:barY+25,size:6.3,font,color:muted});
      });
      page.drawText(dossierText4('TRAVEL WORK PLANNER · SINTESI OPERATIVA',bold),{x:36,y:58,size:6.7,font:bold,color:muted});
    }

    // PAGINA 2+ — TRE COLONNE DINAMICHE: AGENDA / RISTORANTI / LUOGHI
    // Ogni pagina contiene fino a 6 schede per colonna. Se una sezione supera
    // lo spazio disponibile, continua automaticamente nella pagina successiva
    // senza nascondere elementi e senza la vecchia dicitura "+ altri elementi".
    {
      const dark=rgb(.07,.19,.30),blue=rgb(.07,.36,.61),red=rgb(.72,.04,.12),green=rgb(.08,.49,.40);
      const x0=28,gap=8,colW=(W-56-gap*2)/3,top=730,bottom=55;
      const pageChunkSize=6;
      const maxLen=Math.max(agenda.length,restaurants.length,places.length);
      const pageCount=Math.max(1,Math.ceil(maxLen/pageChunkSize));
      const drawColumnCard=(p,item,x,y,w,accent,kind)=>{
        const h=91;p.drawRectangle({x,y:y-h,width:w,height:h,color:rgb(.985,.99,1),borderColor:rgb(.82,.88,.92),borderWidth:.55});
        p.drawRectangle({x,y:y-h,width:3.5,height:h,color:accent});
        const title=cleanText4(item.nome||item.descrizione||item.luogo||'Elemento');
        drawWrapped(p,title,x+10,y-15,8.1,w-20,9,dark,2);
        let yy=y-34;
        if(kind==='agenda'){
          const dateLine=`${formatDate(item.data)||'Data da definire'}${item.ora?' · '+item.ora:''}`;
          p.drawText(dossierText4(dateLine,bold),{x:x+10,y:yy,size:6.7,font:bold,color:accent});yy-=11;
          if(item.luogo)yy=drawWrapped(p,item.luogo,x+10,yy,6.4,w-20,8,rgb(.25,.34,.42),1);
          if(item.note)drawWrapped(p,item.note,x+10,yy-2,6.2,w-20,7,rgb(.38,.45,.51),2);
        }else{
          if(item.indirizzo){p.drawText(dossierText4('INDIRIZZO',bold),{x:x+10,y:yy,size:5.2,font:bold,color:rgb(.45,.52,.58)});yy-=8;yy=drawWrapped(p,item.indirizzo,x+10,yy,6.1,w-20,7,rgb(.22,.31,.39),2);}
          if(item.maps && /^https?:\/\//i.test(String(item.maps))){
            yy-=5;
            drawPin(p,x+13,yy+1,accent);
            const tx=x+25;
            p.drawText(dossierText4('GOOGLE MAPS',bold),{x:tx,y:yy,size:6.1,font:bold,color:accent});
            const lw=bold.widthOfTextAtSize(dossierText4('GOOGLE MAPS',bold),6.1);
            addPdfUriLink4(doc,p,item.maps,tx-2,yy-3,lw+5,10);
            yy-=12;
          }
          if(item.note){p.drawText(dossierText4('NOTE',bold),{x:x+10,y:yy,size:5.2,font:bold,color:rgb(.45,.52,.58)});yy-=8;drawWrapped(p,item.note,x+10,yy,6.1,w-20,7,rgb(.38,.45,.51),2);}
        }
      };
      for(let pg=0;pg<pageCount;pg++){
        const isFirst=pg===0;
        page=newPage(isFirst?'AGENDA E SUGGERIMENTI':'AGENDA E SUGGERIMENTI · CONTINUA',isFirst?'Agenda, ristoranti e luoghi da visitare · collegamenti Google Maps cliccabili':`Continuazione delle sezioni operative · pagina ${pg+2}`);
        const cols=[
          {x:x0,title:'AGENDA',accent:blue,items:agenda.slice(pg*pageChunkSize,(pg+1)*pageChunkSize),kind:'agenda'},
          {x:x0+colW+gap,title:'RISTORANTI',accent:red,items:restaurants.slice(pg*pageChunkSize,(pg+1)*pageChunkSize),kind:'restaurant'},
          {x:x0+2*(colW+gap),title:'LUOGHI DA VISITARE',accent:green,items:places.slice(pg*pageChunkSize,(pg+1)*pageChunkSize),kind:'place'}
        ];
        cols.forEach(c=>{
          page.drawRectangle({x:c.x,y:bottom,width:colW,height:top-bottom,color:rgb(.975,.985,.992),borderColor:rgb(.80,.87,.91),borderWidth:.7});
          page.drawRectangle({x:c.x,y:top-34,width:colW,height:34,color:c.accent});
          page.drawText(dossierText4(c.title,bold),{x:c.x+11,y:top-22,size:9.3,font:bold,color:rgb(1,1,1)});
          let yy=top-45;
          c.items.forEach(item=>{drawColumnCard(page,item,c.x+7,yy,colW-14,c.accent,c.kind);yy-=96;});
          if(!c.items.length)page.drawText(dossierText4(pg===0?'Nessun elemento inserito.':'Nessun altro elemento.',font),{x:c.x+12,y:top-60,size:6.8,font,color:rgb(.45,.52,.58)});
        });
        page.drawText(dossierText4('I link “GOOGLE MAPS” sono cliccabili direttamente dal PDF.',font),{x:36,y:38,size:6.5,font,color:rgb(.40,.48,.55)});
      }
    }

    // PAGINE SUCCESSIVE — DETTAGLI COMPLETI DEL PLANNING
    // Tutti i campi compilati vengono riportati nel dossier, senza limitarsi ai riepiloghi.
    {
      const dark=rgb(.07,.19,.30), blue=rgb(.07,.36,.61), red=rgb(.72,.04,.12), green=rgb(.08,.49,.40), muted=rgb(.38,.45,.51);
      const sectionList=[
        ['VIAGGIATORI',travelers,[['nome','Nome'],['cognome','Cognome'],['ruolo','Ruolo'],['email','Email'],['telefono','Telefono']]],
        ['VOLI',flights,[['tipoVolo','Tipo'],['compagnia','Compagnia'],['numeroVolo','Numero volo'],['pnr','PNR'],['partenza','Partenza'],['arrivo','Arrivo'],['dataPartenza','Data partenza'],['oraPartenza','Ora partenza'],['dataArrivo','Data arrivo'],['oraArrivo','Ora arrivo'],['zaino','Zaino cabina'],['cabina','Bagaglio cabina'],['stiva','Bagaglio stiva'],['priority','Priority']]],
        ['HOTEL',hotels,[['nome','Nome hotel'],['piattaforma','Piattaforma'],['pnr','PNR'],['checkin','Check-in'],['checkout','Check-out'],['indirizzo','Indirizzo'],['maps','Google Maps']]],
        ['AUTONOLEGGIO',cars,[['pnr','PNR'],['prelievoData','Data prelievo'],['prelievoOra','Ora prelievo'],['riconsegnaData','Data riconsegna'],['riconsegnaOra','Ora riconsegna'],['note','Note']]],
      ];
      const fmtField=(key,val)=>{
        if(val===true)return 'Sì'; if(val===false)return 'No'; if(val==null||val==='')return '—';
        if(/Data|checkin|checkout/i.test(key) && /^\d{4}-\d{2}-\d{2}$/.test(String(val))) return formatDate(val)||String(val);
        return cleanText4(String(val));
      };
      for(const [section,items,fields] of sectionList){
        if(!items.length) continue;
        for(let start=0;start<items.length;start+=5){
          const chunk=items.slice(start,start+5);
          page=newPage(section+(items.length>5?' · CONTINUA':''),`${section} · dettagli completi${items.length>5?` · pagina ${Math.floor(start/5)+1}`:''}`);
          let y=735;
          chunk.forEach((item,idx)=>{
            const cardH=126;
            page.drawRectangle({x:32,y:y-cardH,width:531,height:cardH,color:rgb(.98,.99,1),borderColor:rgb(.82,.88,.92),borderWidth:.6});
            page.drawRectangle({x:32,y:y-cardH,width:5,height:cardH,color:[blue,green,red][idx%3]});
            const itemTitle=section==='VOLI' ? `${item.partenza||'—'} → ${item.arrivo||'—'} · ${item.compagnia||''} ${item.numeroVolo||''}`.trim() : (item.nome||item.descrizione||item.luogo||`${section} ${start+idx+1}`);
            page.drawText(dossierText4(cleanText4(itemTitle),bold),{x:48,y:y-18,size:9.5,font:bold,color:dark});
            fields.forEach((f,fi)=>{
              const col=fi%2, row=Math.floor(fi/2), xx=48+col*271, lineY=y-36-row*20;
              if(lineY<y-cardH+10)return;
              const label=f[1], val=fmtField(f[0],item[f[0]]);
              page.drawText(dossierText4(label.toUpperCase(),bold),{x:xx,y:lineY,size:5.5,font:bold,color:muted});
              drawWrapped(page,val,xx,lineY-8,6.8,255,8,dark,2);
            });
            y-=cardH+10;
          });
        }
      }
    }

    // PAGINE SUCCESSIVE — DETTAGLIO BUDGET COMPLETO
    {
      const rows=data.sections?.budget||[],x=36,tableW=523,dark=rgb(.07,.19,.30),blue=rgb(.07,.36,.61),red=rgb(.72,.04,.12),muted=rgb(.38,.45,.51);
      const total=budgetGrandTotal(),sustained=budgetSustainedTotal(),remaining=budgetToSustainTotal();
      const widths=[105,255,78,85],headers=['Categoria','Descrizione','Costo','Totale'];
      const drawBudgetTable=(p,chunk,startIndex)=>{
        let y=720;
        p.drawRectangle({x,y:y-24,width:tableW,height:24,color:dark});
        let xx=x;headers.forEach((h,i)=>{p.drawText(dossierText4(h.toUpperCase(),bold),{x:xx+7,y:y-16,size:6.8,font:bold,color:rgb(1,1,1)});xx+=widths[i]});
        y-=24;
        if(!chunk.length){p.drawText(dossierText4('Nessuna voce di spesa inserita.',font),{x:x+8,y:y-18,size:8,font,color:muted});return y-28;}
        chunk.forEach((r,i)=>{
          const rh=31;
          if(i%2===0)p.drawRectangle({x,y:y-rh,width:tableW,height:rh,color:rgb(.95,.97,.98)});
          const vals=[r.categoria||'Varie',r.descrizione||'',formatEuro(Number(r.costo)||0),formatEuro(budgetRowTotal(r))];
          let qx=x;
          vals.forEach((v,j)=>{let txt=cleanText4(v),orig=txt;while(txt.length>5&&font.widthOfTextAtSize(dossierText4(txt,font),7.2)>widths[j]-12)txt=txt.slice(0,-1);if(txt!==orig)txt+='…';p.drawText(dossierText4(txt,font),{x:qx+7,y:y-20,size:7.2,font,color:j===3?red:rgb(.10,.18,.25)});qx+=widths[j]});
          p.drawLine({start:{x,y:y-rh},end:{x:x+tableW,y:y-rh},thickness:.35,color:rgb(.83,.88,.91)});y-=rh;
        });
        p.drawText(dossierText4(`Voci ${startIndex+1}–${startIndex+chunk.length} di ${rows.length}`,font),{x,y:y-14,size:6.5,font,color:muted});
        return y-25;
      };
      const firstChunk=rows.slice(0,14);
      page=newPage('DETTAGLIO BUDGET','Voci di spesa, totale preventivato e stato economico del viaggio');
      let y=720;
      const cards=[['TOTALE PREVENTIVATO',formatEuro(total),dark],['GIÀ SOSTENUTO',formatEuro(sustained),blue],['DA SOSTENERE',formatEuro(remaining),red]];
      let cx=x;cards.forEach(([lab,val,col])=>{page.drawRectangle({x:cx,y:y-52,width:165,height:52,color:rgb(.95,.97,.98),borderColor:rgb(.83,.89,.92),borderWidth:.6});page.drawText(dossierText4(lab,bold),{x:cx+9,y:y-17,size:6.7,font:bold,color:muted});page.drawText(dossierText4(val,bold),{x:cx+9,y:y-39,size:12,font:bold,color:col});cx+=179;});
      y-=70;
      drawBudgetTable(page,firstChunk,0);
      const note='I prezzi riportati nel budget sono indicativi e dipendono dalle condizioni disponibili al momento della ricerca. Verificare sempre il prezzo finale prima dell’acquisto; eventuali bagagli, priority, scelta del posto e altri servizi extra possono non essere inclusi.';
      page.drawText(dossierText4('TOTALE SPESE PREVENTIVATE',bold),{x:x,y:92,size:8.5,font:bold,color:rgb(.10,.18,.25)});
      page.drawText(dossierText4(formatEuro(total),bold),{x:x+tableW-bold.widthOfTextAtSize(dossierText4(formatEuro(total),bold),12),y:90,size:12,font:bold,color:red});
      drawWrapped(page,note,x,70,6.7,tableW,9,muted,4);
      for(let start=14;start<rows.length;start+=18){
        const chunk=rows.slice(start,start+18);
        page=newPage('DETTAGLIO BUDGET · CONTINUA',`Voci di spesa ${start+1}–${Math.min(start+chunk.length,rows.length)} di ${rows.length}`);
        drawBudgetTable(page,chunk,start);
      }
    }

    // ALLEGATI — solo dopo le 3 pagine del report
    for(const f of files){
      setStatus(`Incorporazione allegato: ${f.name}`);
      incorporatedPages+=await copyAttachmentPagesFull4(doc,f);
    }
    if(files.length && incorporatedPages===0)throw new Error('Sono stati trovati allegati, ma nessuna pagina PDF è stata incorporata.');

    const finalPages=doc.getPages();
    for(const p4 of dossierPages){
      const idx=finalPages.indexOf(p4);if(idx<0)continue;
      const {width:pw}=p4.getSize();
      p4.drawRectangle({x:25,y:8,width:pw-50,height:22,color:rgb(1,1,1)});
      p4.drawLine({start:{x:32,y:30},end:{x:pw-32,y:30},thickness:.5,color:rgb(.85,.89,.92)});
      p4.drawText(dossierText4('TRAVEL REPORT',font),{x:32,y:17,size:7,font,color:rgb(.40,.47,.53)});
      const label=`Pagina ${idx+1} / ${finalPages.length}`,tw=font.widthOfTextAtSize(label,7);p4.drawText(label,{x:pw-32-tw,y:17,size:7,font,color:rgb(.40,.47,.53)});
    }
    doc.setTitle(cleanText4(data.title)||'Viaggio di lavoro');doc.setSubject('Travel Report — viaggio di lavoro');doc.setCreator('Travel Work Planner — Travel Report');
    setStatus('Salvataggio dossier PDF…');
    const out=await doc.save({useObjectStreams:false}),blob=new Blob([out],{type:'application/pdf'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    const safe=(cleanText4(data.title)||'Viaggio_di_lavoro').replace(/[^\w\-]+/g,'_');a.href=url;a.download=safe+'_Travel_Report.pdf';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
    const reportPageCount=doc.getPages().length-incorporatedPages;
    setStatus(`Travel Report creato — ${reportPageCount} pagine report + ${incorporatedPages} pagine allegati`);
  }catch(err){console.error(err);alert('Errore nella creazione del dossier PDF:\n\n'+(err?.message||err));setStatus('Errore creazione PDF');}
}

// Bridge pubblico usato da Travel_Report.html per l'esportazione del report.
window.twpCreateTravelReportPDF=createDossierPDF;
window.getDossierFiles4=getDossierFiles4;

function importPendingCar(){
  try{
    let queue=[];const raw=localStorage.getItem('travelWorkPlannerPendingCars_v25');
    if(raw){try{queue=JSON.parse(raw);if(!Array.isArray(queue))queue=[]}catch(e){queue=[]}}
    if(!queue.length)return false;
    data.sections=data.sections||{};data.sections.cars=Array.isArray(data.sections.cars)?data.sections.cars:[];data.sections.budget=Array.isArray(data.sections.budget)?data.sections.budget:[];
    let count=0;
    for(const r of queue){const o=r&&r.offer;if(!o)continue;
      const row={_id:(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'_'+Math.random()),pnr:'',prelievoData:r.pickupDate||'',prelievoOra:r.pickupTime||'',riconsegnaData:r.dropoffDate||'',riconsegnaOra:r.dropoffTime||'',note:`${r.pickupLabel||''} → ${r.dropoffLabel||''} — Offerta OctoTrip — € ${Number(o.price||0).toFixed(2)} — Fornitore ${o.supplierId||'n/d'} — Auto ID ${o.carId||'n/d'} — deposito ritiro ${o.pickupDepot||'n/d'} — deposito riconsegna ${o.dropoffDepot||'n/d'}`,_carSourceId:o.carId||'',_carOfferId:o.offerId||''};
      data.sections.cars.push(row);
      const total=Number(o.price),currency=String(o.currency||'EUR').toUpperCase();
      const desc=`Noleggio auto ${r.pickupLabel||''} → ${r.dropoffLabel||''} — ${r.pickupDate||''} ${r.pickupTime||''} → ${r.dropoffDate||''} ${r.dropoffTime||''}`;
      data.sections.budget.push({_id:(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'_'+Math.random()),categoria:'Noleggio auto',descrizione:desc+(Number.isFinite(total)?` — totale ${total.toFixed(2)} ${currency}`:' — PREZZO NON DISPONIBILE / DA INSERIRE'),costo:Number.isFinite(total)&&currency==='EUR'?total.toFixed(2):'0.00',perViaggiatore:false,viaggiatori:1,sostenuta:false,valuta:currency,prezzoTotale:Number.isFinite(total)?total:0,prezzoPerPasseggero:Number.isFinite(total)?total:0,statoPrezzo:Number.isFinite(total)?'Prezzo ricerca OctoTrip; soggetto a variazione — extra non inclusi':'PREZZO NON DISPONIBILE — DA INSERIRE',_sourceSection:'cars',_sourceRowIds:[row._id]});count++;}
    localStorage.removeItem('travelWorkPlannerPendingCars_v25');if(count>0){saveSessionState();}return count>0;
  }catch(e){console.warn('Importazione autonoleggio fallita',e);return false;}
}

function importPendingHotel(){
  try{
    let queue=[];const raw=localStorage.getItem('travelWorkPlannerPendingHotels_v25');
    if(raw){try{queue=JSON.parse(raw);if(!Array.isArray(queue))queue=[]}catch(e){queue=[]}}
    if(!queue.length)return false;
    data.sections=data.sections||{};data.sections.hotels=Array.isArray(data.sections.hotels)?data.sections.hotels:[];data.sections.budget=Array.isArray(data.sections.budget)?data.sections.budget:[];
    let count=0;
    for(const r of queue){const h=r&&r.hotel;if(!h)continue;const row={_id:(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'_'+Math.random()),nome:h.name||'',piattaforma:h.platform || 'Hotelbeds',pnr:'',checkin:r.checkin||'',checkout:r.checkout||'',indirizzo:h.address||'',maps:h.url||'',_hotelSourceId:h.id||''};data.sections.hotels.push(row);
      const pax=Math.max(1,Number(r.adults)||2),rooms=Math.max(1,Number(r.rooms)||1),total=Number(h.total!=null?h.total:h.price);const currency=String(h.currency||'EUR').toUpperCase();let desc=`Hotel ${h.name||''} — ${r.checkin||''} → ${r.checkout||''}`;if(Number.isFinite(total)&&total>=0&&currency==='EUR'){data.sections.budget.push({_id:(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'_'+Math.random()),categoria:'Hotel',descrizione:desc+` — totale ${total.toFixed(2)} EUR`,costo:(total).toFixed(2),perViaggiatore:false,viaggiatori:1,sostenuta:false,valuta:'EUR',prezzoTotale:total,prezzoPerPasseggero:total/pax,statoPrezzo:'Prezzo ricerca Hotelbeds; soggetto a variazione',_sourceSection:'hotels',_sourceRowIds:[row._id]});}else{data.sections.budget.push({_id:(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'_'+Math.random()),categoria:'Hotel',descrizione:desc+' — PREZZO DA VERIFICARE / INSERIRE',costo:'0.00',perViaggiatore:false,viaggiatori:1,sostenuta:false,valuta:currency,prezzoTotale:0,prezzoPerPasseggero:0,statoPrezzo:'PREZZO DA VERIFICARE / INSERIRE',_sourceSection:'hotels',_sourceRowIds:[row._id]});}count++;}
    localStorage.removeItem('travelWorkPlannerPendingHotels_v25');return count>0;
  }catch(e){console.warn('Importazione hotel fallita',e);return false;}
}

function importPendingFlight(){
  try{
    let queue=[];
    const queuedRaw=localStorage.getItem('travelWorkPlannerPendingFlights_v25');
    if(queuedRaw){
      try{ queue=JSON.parse(queuedRaw); if(!Array.isArray(queue))queue=[]; }catch(e){ queue=[]; }
    }
    // Compatibilità con la V7 precedente: una sola offerta in attesa.
    if(!queue.length){
      const legacy=localStorage.getItem('travelWorkPlannerPendingFlight_v25');
      if(legacy){try{const one=JSON.parse(legacy);if(one)queue=[one];}catch(e){}}
    }
    if(!queue.length)return false;

    data.sections=data.sections||{};
    data.sections.flights=Array.isArray(data.sections.flights)?data.sections.flights:[];
    data.sections.budget=Array.isArray(data.sections.budget)?data.sections.budget:[];
    let importedCount=0;

    const makeFlightRow=(segments,tipo,carrierFallback)=>{
      const first=segments[0], last=segments[segments.length-1];
      const d1=new Date(first.departure), d2=new Date(last.arrival);
      return {
        _id:(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():(Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)),tipoVolo:tipo,
        compagnia:carrierFallback||first.operatingCarrier||first.marketingCarrier||'',numeroVolo:first.flightNumber||'',pnr:'',
        partenza:first.origin||'',arrivo:last.destination||'',
        dataPartenza:Number.isNaN(d1.getTime())?'':String(first.departure).slice(0,10),
        oraPartenza:Number.isNaN(d1.getTime())?'':String(first.departure).slice(11,16),
        dataArrivo:Number.isNaN(d2.getTime())?'':String(last.arrival).slice(0,10),
        oraArrivo:Number.isNaN(d2.getTime())?'':String(last.arrival).slice(11,16),
        zaino:false,cabina:false,stiva:false,priority:false
      };
    };

    for(const r of queue){
      if(!r || !Array.isArray(r.segments) || !r.segments.length)continue;
      // Ogni importazione è intenzionalmente APPEND-ONLY: anche una nuova ricerca con lo stesso volo crea nuove righe.
      const outSegs=r.segments, inSegs=Array.isArray(r.returnSegments)?r.returnSegments:[];
      const outRow=makeFlightRow(outSegs,'Andata',r.airline);
      const inRow=inSegs.length?makeFlightRow(inSegs,'Ritorno',r.returnAirline):null;
      const bagIncluded=r.bags||{};
      const carry=Number(bagIncluded.carry_on||0), checked=Number(bagIncluded.checked||0);
      outRow.zaino=carry>0; outRow.cabina=carry>0; outRow.stiva=checked>0;
      outRow._flightSourceId=r.sourceOfferId||'';
      if(inRow){
        const rb=r.returnBags||bagIncluded;
        inRow.zaino=Number(rb.carry_on||0)>0; inRow.cabina=Number(rb.carry_on||0)>0; inRow.stiva=Number(rb.checked||0)>0;
        inRow._flightSourceId=r.sourceOfferId||'';
      }
      // Append, never replace.
      data.sections.flights.push(outRow);
      if(inRow)data.sections.flights.push(inRow);

      const pax=Math.max(1,Number(r.passengers)||1), totalPrice=Number(r.price), currency=String(r.currency||'EUR').toUpperCase();
      if(Number.isFinite(totalPrice)&&totalPrice>=0 && currency==='EUR'){
        // Il prezzo ricevuto da Skyscanner/Apify è il totale mostrato per la ricerca effettuata.
        // Il Planner conserva il costo per viaggiatore e lo moltiplica poi per pax nel totale budget.
        const perPassenger=totalPrice/pax;
        const route=`${r.origin||outSegs[0].origin||''} → ${r.destination||outSegs[outSegs.length-1].destination||''}`;
        const tripLabel=inSegs.length?'A/R':'Sola andata';
        data.sections.budget.push({
          _id:(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():(Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)),categoria:'Treno/Aereo',
          descrizione:`Volo ${tripLabel} ${route}${r.airline?' — '+r.airline:''} — totale ${totalPrice.toFixed(2)} EUR`,costo:perPassenger.toFixed(2),perViaggiatore:true,viaggiatori:pax,sostenuta:false,
          valuta:'EUR',prezzoTotale:totalPrice,prezzoPerPasseggero:perPassenger,statoPrezzo:r.priceStatus||'',_sourceSection:'flights',_sourceRowIds:inRow? [outRow._id,inRow._id] : [outRow._id]
        });
      } else if(Number.isFinite(totalPrice)&&totalPrice>=0){
        // Non convertiamo valute estere in EUR senza un tasso: meglio non falsare il budget.
        data.sections.budget.push({
          _id:(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():(Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)),categoria:'Treno/Aereo',
          descrizione:`Volo ${inSegs.length?'A/R':'Sola andata'} ${r.origin||outSegs[0].origin||''} → ${r.destination||outSegs[outSegs.length-1].destination||''}${r.airline?' — '+r.airline:''} — prezzo ${totalPrice.toFixed(2)} ${currency} (non convertito)`,costo:'0.00',perViaggiatore:false,viaggiatori:1,sostenuta:false,
          valuta:currency,prezzoTotale:totalPrice,prezzoPerPasseggero:totalPrice/pax,statoPrezzo:(r.priceStatus||'')+' — valuta diversa da EUR: nessuna conversione automatica.',_sourceSection:'flights',_sourceRowIds:inRow? [outRow._id,inRow._id] : [outRow._id]
        });
      }

      // Bagagli: aggiungiamo al budget SOLO quelli richiesti dall'utente e non inclusi.
      // Se il filtro è 'Indifferente', non creiamo righe a costo zero inutili.
      const bagRows=[];
      const requestedBag=r.baggageRequest||'any';
      const addBagBudget=(bag,label)=>{
        if(!bag || requestedBag==='any')return;
        const missing=[];
        if(requestedBag==='cabin' || requestedBag==='both'){
          if(!bag.known || !Number(bag.carry_on||0)) missing.push('bagaglio cabina');
        }
        if(requestedBag==='checked' || requestedBag==='both'){
          if(!bag.known || !Number(bag.checked||0)) missing.push('bagaglio da stiva');
        }
        for(const item of missing){
          const reason=!bag.known?'dati non disponibili nel feed':'non incluso nel prezzo mostrato';
          bagRows.push({label:`${label} — ${item} — ${reason}`,cost:0,status:'PREZZO DA VERIFICARE / INSERIRE'});
        }
      };
      addBagBudget(r.bags,'Bagagli volo '+(inSegs.length?'andata':'solo andata'));
      if(inSegs.length)addBagBudget(r.returnBags||r.bags,'Bagagli volo ritorno');
      for(const br of bagRows){
        data.sections.budget.push({
          _id:(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():(Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)),
          categoria:'Treno/Aereo', descrizione:br.label+' — '+br.status, costo:'0.00', perViaggiatore:false, viaggiatori:1, sostenuta:false, valuta:'EUR', prezzoTotale:0, prezzoPerPasseggero:0, statoPrezzo:br.status
        });
      }
      importedCount++;
    }
    localStorage.removeItem('travelWorkPlannerPendingFlights_v25');
    localStorage.removeItem('travelWorkPlannerPendingFlight_v25');
    return importedCount>0;
  }catch(e){console.warn('Importazione volo selezionato fallita',e);return false;}
}


// ===== GESTIONE MULTI-VIAGGIO =====
const TRIPS_KEY='TravelWorkPlanner_Trips_v1';
let tripArchive=null;
let activeTripId=null;
function newTripId(){return (window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():('trip_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));}
function blankTrip(){
  const sections={}; Object.keys(configs).forEach(id=>sections[id]=[]);
  return {title:'',startDate:'',endDate:'',sections,globalFiles:[]};
}
function normalizeTrip(t){
  const out=(t&&typeof t==='object')?JSON.parse(JSON.stringify(t)):blankTrip();
  out.sections=out.sections&&typeof out.sections==='object'?out.sections:{};
  Object.keys(configs).forEach(id=>{out.sections[id]=Array.isArray(out.sections[id])?out.sections[id]:[];});
  delete out.sections.trains;
  out.globalFiles=Array.isArray(out.globalFiles)?out.globalFiles:[];
  out.title=out.title||out.name||out.tripName||out.testata||''; out.startDate=out.startDate||''; out.endDate=out.endDate||'';
  return out;
}
function normalizeArchive(raw){
  if(!raw||typeof raw!=='object')return null;
  if(raw.trips&&typeof raw.trips==='object'){
    const trips={}; Object.entries(raw.trips).forEach(([id,t])=>{trips[id]=normalizeTrip(t);});
    const ids=Object.keys(trips); if(!ids.length)return null;
    const active=raw.activeTripId&&trips[raw.activeTripId]?raw.activeTripId:ids[0];
    return {version:2,activeTripId:active,trips};
  }
  // Compatibilità con il vecchio archivio a viaggio singolo.
  if(raw.sections||raw.title||raw.startDate||raw.endDate){const id=newTripId();return {version:2,activeTripId:id,trips:{[id]:normalizeTrip(raw)}};}
  return null;
}
function persistArchiveLocal(){try{if(tripArchive)localStorage.setItem(TRIPS_KEY,JSON.stringify(tripArchive));}catch(e){console.warn('Archivio viaggi locale non salvato:',e)}}
function loadArchiveLocal(){try{const raw=localStorage.getItem(TRIPS_KEY);return raw?normalizeArchive(JSON.parse(raw)):null}catch(e){return null}}
function refreshTripSelector(){
  const sel=document.getElementById('tripSelector'); if(!sel||!tripArchive)return;
  const ids=Object.keys(tripArchive.trips||{}); sel.innerHTML='';
  ids.forEach(id=>{const t=tripArchive.trips[id]||{};const o=document.createElement('option');o.value=id;o.textContent=(t.title||'Viaggio senza nome');o.dataset.tripId=id;sel.appendChild(o);});
  if(activeTripId&&tripArchive.trips[activeTripId])sel.value=activeTripId;
  const del=document.getElementById('deleteTripBtn'); if(del)del.disabled=ids.length<=1;
}
function renderCurrentTrip(){
  if(!data)return; Object.keys(configs).forEach(id=>{data.sections[id]=Array.isArray(data.sections[id])?data.sections[id]:[];renderRows(id);});
  const title=document.getElementById('title'), start=document.getElementById('startDate'), end=document.getElementById('endDate');
  if(title)title.value=data.title||''; if(start)start.value=data.startDate||''; if(end)end.value=data.endDate||'';
  updateHeader(); renderGlobalFiles(); renderPDFManifest(); refreshTripSelector();
}
async function createTrip(){
  collect();
  if(!tripArchive)tripArchive=normalizeArchive(null)||{version:2,activeTripId:null,trips:{}};
  if(activeTripId&&tripArchive.trips[activeTripId])tripArchive.trips[activeTripId]=normalizeTrip(data);
  const proposed=prompt('Nome del nuovo viaggio:', 'Nuovo viaggio');
  if(proposed===null)return;
  const id=newTripId(); const t=blankTrip(); t.title=String(proposed).trim()||'Nuovo viaggio';
  tripArchive.trips[id]=t; tripArchive.activeTripId=id; activeTripId=id; data=t;
  persistArchiveLocal(); renderCurrentTrip();
  await saveData(true);
}
async function switchTrip(id){
  if(!tripArchive||!tripArchive.trips[id]||id===activeTripId)return;
  collect(); if(activeTripId&&tripArchive.trips[activeTripId])tripArchive.trips[activeTripId]=normalizeTrip(data);
  activeTripId=id; tripArchive.activeTripId=id; data=tripArchive.trips[id]; persistArchiveLocal(); renderCurrentTrip();
  await saveData(true);
}
async function deleteCurrentTrip(){
  if(!tripArchive||!activeTripId)return;
  const ids=Object.keys(tripArchive.trips||{}); if(ids.length<=1){setStatus('Deve esistere almeno un viaggio');return;}
  const title=tripArchive.trips[activeTripId]?.title||'Viaggio senza nome';
  if(!confirm(`Eliminare definitivamente "${title}" e i suoi allegati dal cloud?`))return;
  try{
    const files=await getFiles(x=>(x.tripId||activeTripId)===activeTripId);
    for(const f of files){try{await deleteFile(f.id)}catch(e){}}
  }catch(e){}
  delete tripArchive.trips[activeTripId]; activeTripId=Object.keys(tripArchive.trips)[0]; tripArchive.activeTripId=activeTripId; data=tripArchive.trips[activeTripId];
  persistArchiveLocal(); renderCurrentTrip(); await saveData(true);
}

function setStatus(t){const s=document.getElementById('status');if(!s)return;s.textContent=t;setTimeout(()=>{if(s)s.textContent=''},1800)}
function collect(){data.title=document.getElementById('title').value;data.startDate=document.getElementById('startDate').value;data.endDate=document.getElementById('endDate').value}
let saveChain=Promise.resolve();
async function buildUsbAttachmentManifest(){
  const files=await getFiles(x=>true);
  const out=[];
  for(const f of files){
    let blob=f.blob;
    if(blob instanceof Blob) blob=await blob.arrayBuffer();
    if(ArrayBuffer.isView(blob)) blob=blob.buffer;
    if(!(blob instanceof ArrayBuffer)) continue;
    out.push({id:f.id,tripId:f.tripId||activeTripId,section:f.section||'global',row:Number.isFinite(f.row)?f.row:-1,rowId:f.rowId||null,name:f.name||'allegato.pdf',size:f.size||blob.byteLength,mimeType:f.mimeType||'application/pdf',base64:bytesToBase64(new Uint8Array(blob))});
  }
  return out;
}
async function saveData(show=true){
  try{
    collect();
    tripArchive=tripArchive||{version:1,activeTripId:activeTripId||newTripId(),trips:{}};
    if(!activeTripId){activeTripId=tripArchive.activeTripId||newTripId();tripArchive.activeTripId=activeTripId;}
    tripArchive.trips[activeTripId]=data; tripArchive.activeTripId=activeTripId;
    persistArchiveLocal();
    const attachments=await buildUsbAttachmentManifest();
    const payload=JSON.stringify({data:tripArchive,filename:USB_SAVE_FILE,attachments});
    saveChain=saveChain.catch(()=>{}).then(()=>fetch('/api/planner-data',{method:'POST',headers:{'Content-Type':'application/json'},body:payload}).then(async r=>{
      if(!r.ok) throw new Error(`Archivio cloud non raggiungibile (HTTP ${r.status})`);
      const result=await r.json(); if(!result||result.ok!==true) throw new Error('Archivio cloud ha rifiutato il salvataggio'); return result;
    }));
    await saveChain; refreshTripSelector(); if(show)setStatus(`Dati salvati nel cloud · ${Object.keys(tripArchive.trips).length} viaggio/i${attachments.length?` · ${attachments.length} allegato/i`:''}`); return true;
  }catch(err){console.error('Errore salvataggio dati:',err);if(show)setStatus('Dati salvati localmente (backup browser)');return false;}
}
async function loadData(){
  try{
    let archive=null, restored=[];
    try{
      const r=await fetch('/api/planner-data',{cache:'no-store'});
      if(r.ok){const obj=await r.json();if(obj&&obj.ok===false)throw new Error('Archivio cloud ha restituito un errore'); archive=normalizeArchive(obj&&obj.data?obj.data:null); if(Array.isArray(obj?.attachments)){restored=obj.attachments;for(const f of restored){try{await putFile({id:f.id,tripId:f.tripId||archive.activeTripId,section:f.section,row:f.row,rowId:f.rowId,name:f.name,size:f.size,mimeType:f.mimeType||'application/pdf',blob:base64ToBytes(f.base64).buffer});}catch(err){console.warn('Ripristino allegato fallito:',f.name,err);}}}}
    }catch(e){console.warn('Archivio cloud non disponibile, provo il backup del browser.',e);}
    // Sicurezza multiutente: se il cloud risponde correttamente ma non contiene dati
    // per questo utente, NON usare il localStorage globale, altrimenti un secondo
    // utente potrebbe vedere l'archivio del primo utente sullo stesso dispositivo.
    if(!archive){
      const token = window.twpAuthToken ? window.twpAuthToken() : localStorage.getItem('twp_auth_token_v26') || '';
      if(!token){
        archive=loadArchiveLocal();
        if(!archive){ const raw=localStorage.getItem(DATA_KEY); archive=raw?normalizeArchive(JSON.parse(raw)):null; }
      }
    }
    if(!archive){ tripArchive={version:2,activeTripId:newTripId(),trips:{}}; activeTripId=tripArchive.activeTripId; tripArchive.trips[activeTripId]=blankTrip(); data=tripArchive.trips[activeTripId]; persistArchiveLocal(); renderCurrentTrip(); setStatus('Nuovo archivio personale vuoto'); return false; }
    tripArchive=archive; activeTripId=tripArchive.activeTripId||Object.keys(tripArchive.trips)[0]; if(!activeTripId){const id=newTripId();tripArchive.trips[id]=blankTrip();activeTripId=id;tripArchive.activeTripId=id;}
    data=tripArchive.trips[activeTripId]||blankTrip();tripArchive.trips[activeTripId]=data; persistArchiveLocal(); renderCurrentTrip(); setStatus(`Dati caricati dal cloud · ${Object.keys(tripArchive.trips).length} viaggio/i`); return true;
  }catch(err){console.error('Errore caricamento dati:',err);alert('Impossibile caricare i dati salvati.\n\n'+(err.message||err));return false;}
}
async function clearAll(){
  if(!confirm('Ripulire tutti i campi del viaggio corrente? Il viaggio resterà nell’elenco e la testata verrà mantenuta. Gli allegati verranno eliminati.'))return;
  try{
    // Mantiene la testata del viaggio, ma elimina tutti i dati e TUTTI gli allegati
    // associati al viaggio corrente, sia per riga sia nella sezione "Allegati vari".
    const preservedTitle = data?.title || '';
    const preservedStartDate = data?.startDate || '';
    const preservedEndDate = data?.endDate || '';
    const currentTripId = activeTripId || '';
    const filesToDelete = await getFiles(x => (x.tripId || currentTripId) === currentTripId);
    for(const f of filesToDelete){
      try{ await deleteStoredFile(f.id); }
      catch(e){ console.warn('Eliminazione allegato fallita:',f?.name,e); }
    }
    const cleaned=blankTrip();
    cleaned.title = preservedTitle;
    cleaned.startDate = preservedStartDate;
    cleaned.endDate = preservedEndDate;
    cleaned.globalFiles = [];
    data=cleaned;
    if(tripArchive && activeTripId){
      tripArchive.trips[activeTripId]=data;
      tripArchive.activeTripId=activeTripId;
    }
    persistArchiveLocal();
    renderCurrentTrip();
    await saveData(true);
    await renderGlobalFiles();
    await renderPDFManifest();
    setStatus('Campi ripuliti · testata mantenuta · allegati eliminati');
  }catch(e){
    console.error('Errore nella pulizia dei campi:',e);
    renderCurrentTrip();
    setStatus('Impossibile completare la pulizia');
  }
}
function esc(v){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
function addAllSamples(){
 document.getElementById('title').value='Trasferta di lavoro'; document.getElementById('startDate').value=new Date().toISOString().slice(0,10);
 document.getElementById('endDate').value=new Date(Date.now()+86400000*2).toISOString().slice(0,10);
 addRow('travelers');data.sections.travelers[0]={nome:'Francesco',cognome:'',ruolo:'Responsabile',email:'',telefono:''};
 addRow('agenda');data.sections.agenda[0]={data:data.startDate,ora:'09:00',descrizione:'Riunione con il cliente',luogo:'',note:''};
 Object.keys(configs).forEach(id=>renderRows(id));updateHeader();saveData();setStatus('Esempio inserito')}
async function importSearchQueueOnEntry(){
  const qs=new URLSearchParams(location.search);
  const isImport=qs.has('flight')||qs.has('hotel')||qs.has('car');
  if(!isImport)return false;
  const importedFlight=qs.has('flight')?importPendingFlight():false;
  const importedHotel=qs.has('hotel')?importPendingHotel():false;
  const importedCar=qs.has('car')?importPendingCar():false;
  const imported=importedFlight||importedHotel||importedCar;
  if(imported){
    Object.keys(configs).forEach(id=>renderRows(id));
    updateHeader(); renderGlobalFiles(); renderPDFManifest();
    saveSessionState();
    setStatus('Risultato di ricerca importato nel Planner');
    // Evita di reimportare la stessa coda se la pagina viene ricaricata.
    history.replaceState({},'',location.pathname);
  }
  return imported;
}

window.addEventListener('beforeunload',()=>{ try{ saveSessionState(); }catch(e){} });

window.twpReady=(async function(){
 // Prima costruisce sempre tutti i moduli: un problema del database non deve
 // lasciare una pagina vuota con la sola testata.
 Object.keys(configs).forEach(id=>{
   data.sections[id]=[];
   addSection(id);
 });
 updateHeader();

 try{
   await initDB();
   storageMode='indexedDB';
   // All'avvio non si carica mai l'archivio USB. Si ripristina soltanto la memoria
   // della sessione, così la navigazione tra Voli/Hotel/Auto non perde il lavoro corrente.
   try{ await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).clear();tx.oncomplete=res;tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error);}); }catch(e){ console.warn('Pulizia allegati di avvio:',e); }
   const loaded=await loadData();
   if(!loaded){ refreshTripSelector(); updateHeader(); renderGlobalFiles(); renderPDFManifest(); }
   const importedOnEntry=await importSearchQueueOnEntry();
   if(importedOnEntry) await saveData(false);
   if(!loaded&&!importedOnEntry)setStatus('Pronto — planner vuoto');
   data._ready=true;
   window.dispatchEvent(new CustomEvent('twp-data-ready'));
 }catch(err){
   console.warn('IndexedDB non disponibile: attivo archivio locale alternativo.',err);
   storageMode='localStorage';
   // Anche nel fallback si ripristina soltanto la sessione corrente, mai il salvataggio USB.
   const loaded=await loadData();
   if(!loaded){ refreshTripSelector(); updateHeader(); renderGlobalFiles(); renderPDFManifest(); }
   const importedOnEntry=await importSearchQueueOnEntry();
   if(importedOnEntry) await saveData(false);
   if(!loaded&&!importedOnEntry)setStatus('Pronto — planner vuoto');
   data._ready=true;
   window.dispatchEvent(new CustomEvent('twp-data-ready'));
 }
})();