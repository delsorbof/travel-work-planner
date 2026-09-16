import os, json, base64, re, tempfile, threading, time, hashlib, hmac, secrets, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import importlib.util

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("twp_core", ROOT / "backend_core.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)

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
STORE_ID = os.environ.get("TWP_STORE_ID", "main")
BUCKET = os.environ.get("TWP_STORAGE_BUCKET", "twp-files")
AUTH_SECRET = os.environ.get("TWP_AUTH_SECRET", "") or hashlib.sha256((SUPABASE_KEY + "|" + STORE_ID).encode()).hexdigest()
TOKEN_DAYS = max(1, int(os.environ.get("TWP_TOKEN_DAYS", "30") or 30))
RETENTION_HOURS = max(24, int(os.environ.get('TWP_RETENTION_HOURS','48') or 48))
CLEANUP_INTERVAL_SECONDS = max(900, int(os.environ.get('TWP_CLEANUP_INTERVAL_SECONDS','3600') or 3600))
USERS_ROW_ID = f"{STORE_ID}__users"


def _parse_end_date(value):
    try:
        return datetime.strptime(str(value), '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except Exception:
        return None


def sb_headers(content_type=None):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Supabase non configurato: imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.")
    h={"apikey":SUPABASE_KEY,"Authorization":"Bearer "+SUPABASE_KEY}
    if content_type: h["Content-Type"]=content_type
    return h


def sb_get_by_id(row_id):
    url=f"{SUPABASE_URL}/rest/v1/twp_store?id=eq.{requests.utils.quote(row_id, safe='')}"
    r=requests.get(url, headers=sb_headers(), timeout=20)
    if r.status_code >= 300: raise RuntimeError(f"Supabase GET {r.status_code}: {r.text[:800]}")
    arr=r.json()
    return arr[0] if arr else None


def sb_upsert_row(row_id, payload, manifest):
    url=f"{SUPABASE_URL}/rest/v1/twp_store"
    row={"id":row_id,"payload":payload,"attachments":manifest}
    h=sb_headers("application/json"); h["Prefer"]="resolution=merge-duplicates,return=minimal"
    r=requests.post(url, headers=h, json=row, timeout=30)
    if r.status_code >= 300: raise RuntimeError(f"Supabase UPSERT {r.status_code}: {r.text[:1000]}")


def sb_delete_row(row_id):
    url=f"{SUPABASE_URL}/rest/v1/twp_store?id=eq.{requests.utils.quote(row_id, safe='')}"
    r=requests.delete(url, headers=sb_headers(), timeout=20)
    if r.status_code >= 300: raise RuntimeError(f"Supabase DELETE {r.status_code}: {r.text[:800]}")


def sb_table_get():
    return sb_get_by_id(STORE_ID)


def sb_table_upsert(payload, manifest):
    sb_upsert_row(STORE_ID, payload, manifest)


def sb_upload(path, raw, mime):
    url=f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}"
    h=sb_headers(mime); h["x-upsert"]="true"
    r=requests.post(url, headers=h, data=raw, timeout=60)
    if r.status_code >= 300: raise RuntimeError(f"Supabase Storage upload {r.status_code}: {r.text[:1000]}")


def sb_remove(paths):
    if not paths: return
    url=f"{SUPABASE_URL}/storage/v1/object/{BUCKET}"
    h=sb_headers("application/json")
    try: requests.delete(url, headers=h, json={"prefixes":paths}, timeout=30)
    except Exception: pass


def sb_download(path):
    url=f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}"
    r=requests.get(url, headers=sb_headers(), timeout=60)
    if r.status_code >= 300: raise RuntimeError(f"Supabase Storage download {r.status_code}: {r.text[:500]}")
    return r.content


def _users_payload():
    row=sb_get_by_id(USERS_ROW_ID) if SUPABASE_URL and SUPABASE_KEY else None
    p=row.get('payload') if row else None
    return p if isinstance(p,dict) else {"users":{}}


def _save_users(payload):
    sb_upsert_row(USERS_ROW_ID, payload, [])


def _user_key(username):
    return str(username or '').strip().casefold()


def _hash_password(password, salt_hex=None):
    salt=bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest=hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 220000)
    return salt.hex(), digest.hex()


def _verify_password(password, salt_hex, digest_hex):
    try:
        _, got=_hash_password(password, salt_hex)
        return hmac.compare_digest(got, digest_hex)
    except Exception:
        return False


def _make_token(user_id, username):
    exp=int(time.time())+TOKEN_DAYS*86400
    raw=f"{user_id}|{username}|{exp}"
    sig=hmac.new(AUTH_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()
    return raw+"|"+sig


def _current_user(request: Request):
    auth=request.headers.get('authorization','')
    if not auth.lower().startswith('bearer '): raise HTTPException(401,'Accesso richiesto')
    token=auth[7:].strip()
    parts=token.split('|')
    if len(parts)!=4: raise HTTPException(401,'Sessione non valida')
    user_id,username,exp_s,sig=parts
    try: exp=int(exp_s)
    except Exception: raise HTTPException(401,'Sessione non valida')
    raw='|'.join(parts[:3])
    expected=hmac.new(AUTH_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()
    if exp<int(time.time()) or not hmac.compare_digest(sig,expected): raise HTTPException(401,'Sessione scaduta')
    users=_users_payload().get('users',{})
    u=users.get(_user_key(username))
    if not isinstance(u,dict) or u.get('id')!=user_id: raise HTTPException(401,'Utente non valido')
    return {'id':user_id,'username':u.get('username') or username}


def _user_row_id(user_id):
    return f"{STORE_ID}__user__{user_id}"


def _legacy_payload():
    row=sb_table_get()
    return row


def register_user(username, password):
    if not SUPABASE_URL or not SUPABASE_KEY: raise HTTPException(503,'Supabase non configurato')
    username=str(username or '').strip()
    password=str(password or '')
    if not re.fullmatch(r'[A-Za-z0-9_.@-]{3,40}', username): raise HTTPException(400,'Nome utente non valido (3-40 caratteri).')
    if len(password)<8: raise HTTPException(400,'La password deve avere almeno 8 caratteri.')
    key=_user_key(username)
    payload=_users_payload(); users=payload.setdefault('users',{})
    if key in users: raise HTTPException(409,'Nome utente già utilizzato.')
    salt,digest=_hash_password(password)
    uid=str(uuid.uuid4())
    users[key]={'id':uid,'username':username,'salt':salt,'hash':digest,'createdAt':datetime.now(timezone.utc).isoformat()}
    first=len(users)==1
    _save_users(payload)
    # Il primo account prende in carico l'archivio storico condiviso della V26.
    if first:
        legacy=_legacy_payload()
        if legacy and isinstance(legacy.get('payload'),dict):
            _upsert_user_row(uid, legacy.get('payload'), legacy.get('attachments') or [])
    return {'token':_make_token(uid,username),'username':username,'migratedLegacy':first}


def login_user(username, password):
    payload=_users_payload(); u=payload.get('users',{}).get(_user_key(username))
    if not isinstance(u,dict) or not _verify_password(str(password or ''),u.get('salt',''),u.get('hash','')):
        raise HTTPException(401,'Nome utente o password non corretti.')
    return {'token':_make_token(u['id'],u.get('username') or username),'username':u.get('username') or username}


def _upsert_user_row(user_id, payload, manifest):
    row_id=_user_row_id(user_id)
    fixed=[]
    for item in manifest if isinstance(manifest,list) else []:
        if isinstance(item,dict):
            fixed.append(dict(item))
    sb_upsert_row(row_id,payload,fixed)


def _get_user_row(user_id):
    return sb_get_by_id(_user_row_id(user_id))


def save_cloud(user_id, payload, attachments):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError('Supabase non configurato.')
    old=_get_user_row(user_id) or {}
    old_manifest=old.get('attachments') or []
    wanted=[]; manifest=[]
    for item in attachments if isinstance(attachments,list) else []:
        if not isinstance(item,dict) or not item.get('base64') or not item.get('name'): continue
        fid=re.sub(r'[^A-Za-z0-9_-]+','_',str(item.get('id') or 'file'))[:100]
        safe=re.sub(r'[^A-Za-z0-9._ -]+','_',str(item.get('name'))).strip() or 'allegato.pdf'
        path=f"{user_id}/{fid}__{safe}"
        try: raw=base64.b64decode(item['base64'], validate=False)
        except Exception: continue
        sb_upload(path,raw,item.get('mimeType') or 'application/pdf')
        wanted.append(path)
        manifest.append({k:item.get(k) for k in ['id','tripId','section','row','rowId','name','size','mimeType']} | {'storagePath':path})
    old_paths=[x.get('storagePath') for x in old_manifest if isinstance(x,dict) and x.get('storagePath')]
    stale=[p for p in old_paths if p not in wanted]
    sb_remove(stale)
    _upsert_user_row(user_id,payload,manifest)
    return {'ok':True,'attachments':len(manifest),'storage':'supabase'}


def load_cloud(user_id):
    cleanup_expired_trips(user_id)
    if not SUPABASE_URL or not SUPABASE_KEY: return {'ok':True,'data':None,'attachments':[]}
    row=_get_user_row(user_id)
    if not row: return {'ok':True,'data':None,'attachments':[]}
    payload=row.get('payload'); manifest=row.get('attachments') or []; attachments=[]
    for item in manifest:
        if not isinstance(item,dict) or not item.get('storagePath'): continue
        try:
            raw=sb_download(item['storagePath'])
            attachments.append({k:item.get(k) for k in ['id','tripId','section','row','rowId','name','size','mimeType']} | {'base64':base64.b64encode(raw).decode('ascii')})
        except Exception as e: print('Attachment restore skipped:',e)
    return {'ok':True,'data':payload,'attachments':attachments}


def clear_cloud(user_id):
    if not SUPABASE_URL or not SUPABASE_KEY: return {'ok':True}
    old=_get_user_row(user_id) or {}
    paths=[x.get('storagePath') for x in (old.get('attachments') or []) if isinstance(x,dict) and x.get('storagePath')]
    sb_remove(paths); sb_delete_row(user_id and _user_row_id(user_id))
    return {'ok':True}


def cleanup_expired_trips(user_id):
    if not SUPABASE_URL or not SUPABASE_KEY: return 0
    try:
        row=_get_user_row(user_id)
        if not row: return 0
        payload=row.get('payload')
        if not isinstance(payload,dict) or not isinstance(payload.get('trips'),dict): return 0
        trips=dict(payload.get('trips') or {}); now=datetime.now(timezone.utc); expired=[]
        for tid,trip in trips.items():
            if not isinstance(trip,dict): continue
            end=_parse_end_date(trip.get('endDate'))
            if end and now >= end+timedelta(hours=RETENTION_HOURS): expired.append(tid)
        if not expired: return 0
        manifest=row.get('attachments') or []
        stale=[x.get('storagePath') for x in manifest if isinstance(x,dict) and x.get('tripId') in expired and x.get('storagePath')]
        sb_remove(stale)
        new_manifest=[x for x in manifest if not (isinstance(x,dict) and x.get('tripId') in expired)]
        for tid in expired: trips.pop(tid,None)
        active=payload.get('activeTripId')
        if active in expired: active=next(iter(trips),None)
        new_payload=dict(payload); new_payload['trips']=trips; new_payload['activeTripId']=active
        _upsert_user_row(user_id,new_payload,new_manifest)
        print(f'TWP cleanup: user={user_id} removed {len(expired)} trip(s), {len(stale)} attachment(s).')
        return len(expired)
    except Exception as e:
        print('TWP cleanup skipped:',e); return 0


def cleanup_all_users():
    if not SUPABASE_URL or not SUPABASE_KEY: return
    try:
        users=_users_payload().get('users',{})
        for u in users.values():
            if isinstance(u,dict) and u.get('id'): cleanup_expired_trips(u['id'])
    except Exception as e: print('TWP cleanup all users:',e)


def _cleanup_loop():
    while True:
        try: cleanup_all_users()
        except Exception as e: print('TWP cleanup loop:',e)
        time.sleep(CLEANUP_INTERVAL_SECONDS)

app=FastAPI(title='Travel Work Planner V26',version='26.1.0')
app.add_middleware(CORSMiddleware,allow_origins=['*'],allow_methods=['*'],allow_headers=['*'])
threading.Thread(target=_cleanup_loop,name='twp-trip-cleanup',daemon=True).start()
STATIC_EXT={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.ico':'image/x-icon'}


def require_user(request:Request): return _current_user(request)

@app.middleware('http')
async def access_middleware(request:Request,call_next):
    if request.url.path.startswith('/api/') and not request.url.path.startswith('/api/auth/'):
        try: _current_user(request)
        except HTTPException as e: return JSONResponse({'ok':False,'error':e.detail},status_code=e.status_code)
    return await call_next(request)

@app.get('/api/auth/status')
def auth_status():
    users=_users_payload().get('users',{}) if SUPABASE_URL and SUPABASE_KEY else {}
    return {'ok':True,'configured':bool(SUPABASE_URL and SUPABASE_KEY),'hasUsers':bool(users),'registration':True}

@app.post('/api/auth/register')
def auth_register(body:dict): return {'ok':True,**register_user(body.get('username'),body.get('password'))}

@app.post('/api/auth/login')
def auth_login(body:dict): return {'ok':True,**login_user(body.get('username'),body.get('password'))}

@app.get('/api/auth/me')
def auth_me(request:Request): return {'ok':True,**require_user(request)}

@app.get('/api/health')
def health(request:Request):
    u=require_user(request)
    return {'ok':True,'version':'26.1.0','user':u['username'],'storage':'supabase','hotelbeds':bool(core.HOTELBEDS_API_KEY and core.HOTELBEDS_API_SECRET)}

@app.get('/api/apify-status')
def apify_status(request:Request):
    require_user(request)
    try:return core.apify_validate_token()
    except Exception as e:return JSONResponse({'ok':False,'error':str(e)},status_code=getattr(e,'http_status',500))

@app.post('/api/apify-status')
def apify_status_post(request:Request): return apify_status(request)

@app.get('/api/airport-catalog')
def airport_catalog(request:Request):
    require_user(request); rows=core._load_airport_index(); airports=[]
    for r in rows:
        if isinstance(r,dict) and r.get('iata'): airports.append({k:r.get(k) for k in ('iata','name','city','country','type','keywords')})
    return {'ok':True,'ready':True,'indexVersion':getattr(core,'AIRPORT_INDEX_VERSION','world'),'count':len(airports),'downloaded':True,'airports':airports}

@app.post('/api/place-suggestions')
def place_suggestions(body:dict,request:Request): require_user(request); return core.place_suggestions(body.get('query',''))
@app.post('/api/search-flights')
def search_flights(body:dict,request:Request): require_user(request); return core.search_flights(body)
@app.post('/api/train-place-suggestions')
def train_place_suggestions(body:dict,request:Request): require_user(request); return core.train_place_suggestions(body.get('query',''))
@app.post('/api/search-trains')
def search_trains(body:dict,request:Request): require_user(request); return core.search_trains(body)
@app.post('/api/hotel-place-suggestions')
def search_hotel_places(body:dict,request:Request): require_user(request); return core.hotel_place_suggestions(body.get('query',''))
@app.post('/api/search-hotels')
def search_hotels(body:dict,request:Request): require_user(request); return core.search_hotels(body)
@app.post('/api/car-place-suggestions')
def car_place_suggestions(body:dict,request:Request): require_user(request); return core.car_place_suggestions(body.get('query',''))
@app.post('/api/search-cars')
def search_cars(body:dict,request:Request): require_user(request); return core.search_cars(body)
@app.post('/api/travel-map')
def travel_map(body:dict,request:Request):
    require_user(request); loc=body.get('locations') if isinstance(body,dict) else []
    if not isinstance(loc,list): loc=[]
    resolved=core._resolve_travel_map_locations(loc)
    return {'ok':bool(resolved),'locations':resolved} if resolved else {'ok':False,'error':'Nessuna località geocodificabile.'}

@app.get('/api/planner-data')
def planner_get(request:Request): return load_cloud(require_user(request)['id'])
@app.post('/api/planner-data')
def planner_post(body:dict,request:Request):
    user=require_user(request); payload=body.get('data') if isinstance(body,dict) and 'data' in body else body
    if not isinstance(payload,dict): raise HTTPException(400,'Dati Planner non validi.')
    return save_cloud(user['id'],payload,body.get('attachments',[]) if isinstance(body,dict) else [])
@app.post('/api/planner-data/clear')
def planner_clear(request:Request): return clear_cloud(require_user(request)['id'])

@app.get('/{path:path}')
def static_files(path:str):
    rel=path or 'Home.html'; target=(ROOT/rel).resolve()
    try: target.relative_to(ROOT)
    except ValueError: raise HTTPException(403)
    if not target.exists() or not target.is_file():
        if path=='': target=ROOT/'Home.html'
        else: raise HTTPException(404)
    resp=FileResponse(target,media_type=STATIC_EXT.get(target.suffix.lower()))
    if target.suffix.lower() in {'.html','.js','.css','.json','.webmanifest'}:
        resp.headers['Cache-Control']='no-store, no-cache, must-revalidate, max-age=0'; resp.headers['Pragma']='no-cache'; resp.headers['Expires']='0'
    return resp

if __name__=='__main__':
    import uvicorn
    uvicorn.run('app:app',host='0.0.0.0',port=int(os.environ.get('PORT','10000')))
