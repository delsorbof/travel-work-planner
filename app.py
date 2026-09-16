import os, json, base64, re, tempfile, shutil, threading, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import requests
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import importlib.util

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("twp_core", ROOT / "backend_core.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)

# Cloud secrets can supply Hotelbeds mTLS material without putting certificates in the repository.
secret_dir = Path(tempfile.gettempdir()) / "travel-work-planner-secrets"
secret_dir.mkdir(parents=True, exist_ok=True)
cert_pem = os.environ.get("HOTELBEDS_CERT_PEM", "").strip()
key_pem = os.environ.get("HOTELBEDS_KEY_PEM", "").strip()
if cert_pem:
    cert_path = secret_dir / "hotelbeds-client.pem"
    cert_path.write_text(cert_pem.replace('\\n','\n'), encoding='utf-8')
    core.HOTELBEDS_CERT = str(cert_path)
if key_pem:
    key_path = secret_dir / "hotelbeds-client.key"
    key_path.write_text(key_pem.replace('\\n','\n'), encoding='utf-8')
    core.HOTELBEDS_KEY_FILE = str(key_path)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
ACCESS_PASSWORD = os.environ.get("TWP_ACCESS_PASSWORD", "")
STORE_ID = os.environ.get("TWP_STORE_ID", "main")
BUCKET = os.environ.get("TWP_STORAGE_BUCKET", "twp-files")


RETENTION_HOURS = max(24, int(os.environ.get('TWP_RETENTION_HOURS','48') or 48))
CLEANUP_INTERVAL_SECONDS = max(900, int(os.environ.get('TWP_CLEANUP_INTERVAL_SECONDS','3600') or 3600))

def _parse_end_date(value):
    try:
        return datetime.strptime(str(value), '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except Exception:
        return None

def cleanup_expired_trips():
    """Remove whole trips (and their cloud attachments) after return + retention hours."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return 0
    try:
        row=sb_table_get()
        if not row: return 0
        payload=row.get('payload')
        if not isinstance(payload,dict) or not isinstance(payload.get('trips'),dict): return 0
        trips=dict(payload.get('trips') or {})
        now=datetime.now(timezone.utc)
        expired=[]
        for tid,trip in trips.items():
            if not isinstance(trip,dict): continue
            end=_parse_end_date(trip.get('endDate'))
            if end and now >= end + timedelta(hours=RETENTION_HOURS): expired.append(tid)
        if not expired: return 0
        manifest=row.get('attachments') or []
        stale_paths=[x.get('storagePath') for x in manifest if isinstance(x,dict) and x.get('tripId') in expired and x.get('storagePath')]
        sb_remove(stale_paths)
        new_manifest=[x for x in manifest if not (isinstance(x,dict) and x.get('tripId') in expired)]
        for tid in expired: trips.pop(tid,None)
        active=payload.get('activeTripId')
        if active in expired: active=next(iter(trips),None)
        new_payload=dict(payload); new_payload['trips']=trips; new_payload['activeTripId']=active
        sb_table_upsert(new_payload,new_manifest)
        print(f'TWP cleanup: removed {len(expired)} expired trip(s) and {len(stale_paths)} attachment(s).')
        return len(expired)
    except Exception as e:
        print('TWP cleanup skipped:', e)
        return 0

def _cleanup_loop():
    while True:
        try: cleanup_expired_trips()
        except Exception as e: print('TWP cleanup loop:', e)
        time.sleep(CLEANUP_INTERVAL_SECONDS)

app = FastAPI(title="Travel Work Planner V26", version="26.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

threading.Thread(target=_cleanup_loop, name="twp-trip-cleanup", daemon=True).start()

STATIC_EXT = {".html":"text/html; charset=utf-8", ".js":"application/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".webmanifest":"application/manifest+json", ".svg":"image/svg+xml", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".ico":"image/x-icon"}


def check_access(request: Request):
    if not ACCESS_PASSWORD:
        return
    got = request.headers.get("x-twp-access", "")
    if got != ACCESS_PASSWORD:
        raise HTTPException(status_code=401, detail="Accesso richiesto")


def sb_headers(content_type=None):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Supabase non configurato: imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.")
    h={"apikey":SUPABASE_KEY,"Authorization":"Bearer "+SUPABASE_KEY}
    if content_type: h["Content-Type"]=content_type
    return h


def sb_table_get():
    url=f"{SUPABASE_URL}/rest/v1/twp_store?id=eq.{requests.utils.quote(STORE_ID, safe='')}"
    r=requests.get(url, headers=sb_headers(), timeout=20)
    if r.status_code >= 300: raise RuntimeError(f"Supabase GET {r.status_code}: {r.text[:800]}")
    arr=r.json()
    return arr[0] if arr else None


def sb_table_upsert(payload, manifest):
    url=f"{SUPABASE_URL}/rest/v1/twp_store"
    row={"id":STORE_ID,"payload":payload,"attachments":manifest}
    h=sb_headers("application/json")
    h["Prefer"]="resolution=merge-duplicates,return=minimal"
    r=requests.post(url, headers=h, json=row, timeout=30)
    if r.status_code >= 300: raise RuntimeError(f"Supabase UPSERT {r.status_code}: {r.text[:1000]}")


def sb_upload(path, raw, mime):
    url=f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}"
    h=sb_headers(mime); h["x-upsert"]="true"
    r=requests.post(url, headers=h, data=raw, timeout=60)
    if r.status_code >= 300: raise RuntimeError(f"Supabase Storage upload {r.status_code}: {r.text[:1000]}")


def sb_remove(paths):
    if not paths: return
    url=f"{SUPABASE_URL}/storage/v1/object/{BUCKET}"
    h=sb_headers("application/json")
    try:
        requests.delete(url, headers=h, json={"prefixes":paths}, timeout=30)
    except Exception:
        pass


def sb_download(path):
    url=f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}"
    r=requests.get(url, headers=sb_headers(), timeout=60)
    if r.status_code >= 300: raise RuntimeError(f"Supabase Storage download {r.status_code}: {r.text[:500]}")
    return r.content


def save_cloud(payload, attachments):
    if not SUPABASE_URL or not SUPABASE_KEY:
        # Useful fallback for local testing; cloud deployment should configure Supabase.
        data_file=ROOT/"DATA"/"planner-data.json"; data_file.parent.mkdir(exist_ok=True)
        data_file.write_text(json.dumps(payload,ensure_ascii=False),encoding="utf-8")
        return {"ok":True,"attachments":0,"storage":"local-fallback"}
    old=sb_table_get() or {}
    old_manifest=old.get("attachments") or []
    wanted=[]; manifest=[]
    for item in attachments if isinstance(attachments,list) else []:
        if not isinstance(item,dict) or not item.get("base64") or not item.get("name"): continue
        fid=re.sub(r'[^A-Za-z0-9_-]+','_',str(item.get('id') or 'file'))[:100]
        safe=re.sub(r'[^A-Za-z0-9._ -]+','_',str(item.get('name'))).strip() or 'allegato.pdf'
        path=f"{STORE_ID}/{fid}__{safe}"
        try: raw=base64.b64decode(item['base64'], validate=False)
        except Exception: continue
        sb_upload(path, raw, item.get('mimeType') or 'application/pdf')
        wanted.append(path)
        manifest.append({k:item.get(k) for k in ['id','tripId','section','row','rowId','name','size','mimeType']} | {"storagePath":path})
    old_paths=[x.get('storagePath') for x in old_manifest if isinstance(x,dict) and x.get('storagePath')]
    stale=[p for p in old_paths if p not in wanted]
    sb_remove(stale)
    sb_table_upsert(payload, manifest)
    return {"ok":True,"attachments":len(manifest),"storage":"supabase"}


def load_cloud():
    # Cleanup is also triggered on every Planner load, so expired trips are
    # removed even if the periodic worker was asleep between visits.
    cleanup_expired_trips()
    if not SUPABASE_URL or not SUPABASE_KEY:
        p=ROOT/"DATA"/"planner-data.json"
        if not p.exists(): return {"ok":True,"data":None,"attachments":[]}
        return {"ok":True,"data":json.loads(p.read_text(encoding='utf-8')),"attachments":[]}
    row=sb_table_get()
    if not row: return {"ok":True,"data":None,"attachments":[]}
    payload=row.get('payload')
    manifest=row.get('attachments') or []
    attachments=[]
    for item in manifest:
        if not isinstance(item,dict) or not item.get('storagePath'): continue
        try:
            raw=sb_download(item['storagePath'])
            attachments.append({k:item.get(k) for k in ['id','tripId','section','row','rowId','name','size','mimeType']} | {'base64':base64.b64encode(raw).decode('ascii')})
        except Exception as e:
            print('Attachment restore skipped:', e)
    return {"ok":True,"data":payload,"attachments":attachments}


def clear_cloud():
    if not SUPABASE_URL or not SUPABASE_KEY:
        p=ROOT/"DATA"/"planner-data.json"
        if p.exists(): p.unlink()
        return {"ok":True}
    old=sb_table_get() or {}; paths=[x.get('storagePath') for x in (old.get('attachments') or []) if isinstance(x,dict) and x.get('storagePath')]
    sb_remove(paths)
    url=f"{SUPABASE_URL}/rest/v1/twp_store?id=eq.{requests.utils.quote(STORE_ID, safe='')}"
    r=requests.delete(url, headers=sb_headers(), timeout=20)
    if r.status_code >= 300: raise RuntimeError(f"Supabase DELETE {r.status_code}: {r.text[:800]}")
    return {"ok":True}


@app.middleware("http")
async def access_middleware(request: Request, call_next):
    if request.url.path.startswith('/api/'):
        try: check_access(request)
        except HTTPException as e: return JSONResponse({"ok":False,"error":e.detail}, status_code=e.status_code)
    return await call_next(request)


@app.get('/api/health')
def health(request: Request):
    check_access(request)
    return {"ok":True,"version":"26.0.0","storage":"supabase" if SUPABASE_URL and SUPABASE_KEY else "local-fallback","hotelbeds":bool(core.HOTELBEDS_API_KEY and core.HOTELBEDS_API_SECRET)}

@app.get('/api/apify-status')
def apify_status(request: Request):
    check_access(request)
    try: return core.apify_validate_token()
    except Exception as e: return JSONResponse({"ok":False,"error":str(e)}, status_code=getattr(e,'http_status',500))

@app.post('/api/apify-status')
def apify_status_post(request: Request):
    return apify_status(request)


def endpoint(fn):
    def inner(body: dict):
        return fn(body)
    return inner

@app.get('/api/airport-catalog')
def airport_catalog(request: Request):
    check_access(request)
    rows = core._load_airport_index()
    # Send only fields needed by the flight autocomplete.
    airports=[]
    for r in rows:
        if not isinstance(r,dict) or not r.get('iata'): continue
        airports.append({k:r.get(k) for k in ('iata','name','city','country','type','keywords')})
    return {'ok':True,'ready':True,'indexVersion':getattr(core,'AIRPORT_INDEX_VERSION','world'),'count':len(airports),'downloaded':True,'airports':airports}

@app.post('/api/place-suggestions')
def place_suggestions(body:dict, request:Request): check_access(request); return core.place_suggestions(body.get('query',''))
@app.post('/api/search-flights')
def search_flights(body:dict, request:Request): check_access(request); return core.search_flights(body)
@app.post('/api/train-place-suggestions')
def train_place_suggestions(body:dict, request:Request): check_access(request); return core.train_place_suggestions(body.get('query',''))
@app.post('/api/search-trains')
def search_trains(body:dict, request:Request): check_access(request); return core.search_trains(body)
@app.post('/api/hotel-place-suggestions')
def hotel_place_suggestions(body:dict, request:Request): check_access(request); return core.hotel_place_suggestions(body.get('query',''))
@app.post('/api/search-hotels')
def search_hotels(body:dict, request:Request): check_access(request); return core.search_hotels(body)
@app.post('/api/car-place-suggestions')
def car_place_suggestions(body:dict, request:Request): check_access(request); return core.car_place_suggestions(body.get('query',''))
@app.post('/api/search-cars')
def search_cars(body:dict, request:Request): check_access(request); return core.search_cars(body)
@app.post('/api/travel-map')
def travel_map(body:dict, request:Request):
    check_access(request); loc=body.get('locations') if isinstance(body,dict) else []
    if not isinstance(loc,list): loc=[]
    resolved=core._resolve_travel_map_locations(loc)
    return {'ok':bool(resolved),'locations':resolved} if resolved else {'ok':False,'error':'Nessuna località geocodificabile.'}

@app.get('/api/planner-data')
def planner_get(request:Request): check_access(request); return load_cloud()
@app.post('/api/planner-data')
def planner_post(body:dict, request:Request):
    check_access(request)
    payload=body.get('data') if isinstance(body,dict) and 'data' in body else body
    if not isinstance(payload,dict): raise HTTPException(400,'Dati Planner non validi.')
    return save_cloud(payload, body.get('attachments',[]) if isinstance(body,dict) else [])
@app.post('/api/planner-data/clear')
def planner_clear(request:Request): check_access(request); return clear_cloud()

@app.get('/{path:path}')
def static_files(path:str):
    rel=path or 'Home.html'
    target=(ROOT/rel).resolve()
    try: target.relative_to(ROOT)
    except ValueError: raise HTTPException(403)
    if not target.exists() or not target.is_file():
        if path=='': target=ROOT/'Home.html'
        else: raise HTTPException(404)
    resp = FileResponse(target, media_type=STATIC_EXT.get(target.suffix.lower()))
    # The web app is cloud-first: always fetch the latest HTML/JS/CSS from Render.
    # Images may remain cacheable, but executable/app-shell files must never be served stale.
    ext = target.suffix.lower()
    if ext in {'.html', '.js', '.css', '.json', '.webmanifest'}:
        resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
    return resp

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('app:app', host='0.0.0.0', port=int(os.environ.get('PORT','10000')))
