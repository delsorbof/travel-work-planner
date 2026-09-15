import json, os, re, webbrowser, hashlib, time, ssl, gzip, csv, io, unicodedata, difflib, threading
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, unquote, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8799
APIFY_API = 'https://api.apify.com/v2'
ACTOR_ID = 'memo23~skyscanner-scraper'
TRAIN_API_BASE = 'https://api.transitous.org/api'
TRANSITOUS_API_BASE = 'https://api.transitous.org/api'
HOTELBEDS_API_BASE = 'https://api-mtls.test.hotelbeds.com'
HOTELBEDS_LIVE_BASE = 'https://api.hotelbeds.com'
GEOCODER_URL = 'https://nominatim.openstreetmap.org/search'
HOTELBEDS_DAILY_LIMIT = 50
OCTOTRIP_CARS_MCP = 'https://mcp.octotrip.app/rental-cars/mcp'



def _read_env_file(path):
    out = {}
    if not path.exists(): return out
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        out[k.strip().lstrip('\ufeff')] = v.strip().strip('"').strip("'")
    return out

def load_env():
    # CONFIG/.env is authoritative, but also merge a legacy/root .env so an
    # older launcher cannot hide Hotelbeds credentials written at ROOT/.env.
    env = _read_env_file(ROOT / '.env')
    env.update(_read_env_file(ROOT / 'CONFIG' / '.env'))
    return env

ENV = load_env()
APIFY_TOKEN = (ENV.get('APIFY_API_TOKEN', '') or ENV.get('APIFY_TOKEN', '') or os.environ.get('APIFY_API_TOKEN', '') or os.environ.get('APIFY_TOKEN', '')).strip()
HOTELBEDS_API_KEY = os.environ.get('HOTELBEDS_API_KEY') or ENV.get('HOTELBEDS_API_KEY', '')
HOTELBEDS_API_SECRET = os.environ.get('HOTELBEDS_API_SECRET') or ENV.get('HOTELBEDS_API_SECRET', '')
HOTELBEDS_BASE = os.environ.get('HOTELBEDS_API_BASE_URL') or ENV.get('HOTELBEDS_API_BASE_URL', HOTELBEDS_API_BASE)
HOTELBEDS_CERT = os.environ.get('HOTELBEDS_CERT') or ENV.get('HOTELBEDS_CERT', '')
HOTELBEDS_KEY_FILE = os.environ.get('HOTELBEDS_KEY_FILE') or ENV.get('HOTELBEDS_KEY_FILE', '')
HOTELBEDS_KEY_PASSWORD = os.environ.get('HOTELBEDS_KEY_PASSWORD') or ENV.get('HOTELBEDS_KEY_PASSWORD', '')
TRAIN_BASE = os.environ.get('TRAIN_API_BASE_URL') or ENV.get('TRAIN_API_BASE_URL', TRAIN_API_BASE)
TRANSITOUS_BASE = os.environ.get('TRANSITOUS_API_BASE_URL') or ENV.get('TRANSITOUS_API_BASE_URL', TRANSITOUS_API_BASE)
DATA_DIR = ROOT / 'DATA'
DATA_DIR.mkdir(exist_ok=True)
RUNTIME_DIR = ROOT / 'RUNTIME'
RUNTIME_DIR.mkdir(exist_ok=True)
PLANNER_DATA_FILE = DATA_DIR / 'planner-data.json'
USB_SAVE_FILE = DATA_DIR / 'Travel_Work_Planner_Salvataggio.json'
AIRPORT_INDEX_FILE = RUNTIME_DIR / 'airports-iata.json'
AIRPORT_SOURCE_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv'
AIRPORT_INDEX_VERSION = '26.0.0-world'
AIRPORT_INDEX_MAX_AGE = 24 * 60 * 60


def json_out(h, status, obj):
    raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    h.send_response(status)
    h.send_header('Content-Type', 'application/json; charset=utf-8')
    h.send_header('Cache-Control', 'no-store')
    h.send_header('Content-Length', str(len(raw)))
    h.end_headers()
    h.wfile.write(raw)


def require_token():
    global APIFY_TOKEN
    # Always reload CONFIG/.env so a token changed after server startup is used immediately.
    fresh = load_env()
    APIFY_TOKEN = (fresh.get('APIFY_API_TOKEN', '') or fresh.get('APIFY_TOKEN', '') or os.environ.get('APIFY_API_TOKEN', '') or os.environ.get('APIFY_TOKEN', '')).strip().strip('\"').strip("'")
    if not APIFY_TOKEN or APIFY_TOKEN.startswith('apify_test_INCOLLA'):
        raise RuntimeError('Token Apify non configurato. Controlla CONFIG\.env: APIFY_API_TOKEN=...')
    # Accept common copy/paste forms without ever storing the Bearer prefix.
    if APIFY_TOKEN.lower().startswith('bearer '):
        APIFY_TOKEN = APIFY_TOKEN[7:].strip()
    if APIFY_TOKEN.startswith('APIFY_API_TOKEN='):
        APIFY_TOKEN = APIFY_TOKEN.split('=',1)[1].strip().strip('\"').strip("'")
    return APIFY_TOKEN


def apify_validate_token():
    token=require_token()
    headers={'Authorization':'Bearer '+token,'Accept':'application/json','User-Agent':'TravelWorkPlanner/22.9'}
    req=Request(f'{APIFY_API}/users/me',headers=headers,method='GET')
    try:
        with urlopen(req,timeout=20) as r:
            data=json.loads(r.read().decode('utf-8'))
        return {'ok':True,'username':str(((data.get('data') or {}).get('username') or ''))}
    except HTTPError as e:
        body=e.read().decode('utf-8','replace')[:1500]
        # Some corporate/security proxies strip Authorization headers. Apify also
        # supports ?token= as a less-secure fallback. Retry only for token-not-provided.
        if e.code==401 and 'token-not-provided' in body:
            try:
                qreq=Request(f'{APIFY_API}/users/me?token={quote(token)}',headers={'Accept':'application/json','User-Agent':'TravelWorkPlanner/22.9'},method='GET')
                with urlopen(qreq,timeout=20) as r:
                    data=json.loads(r.read().decode('utf-8'))
                return {'ok':True,'username':str(((data.get('data') or {}).get('username') or ''))}
            except HTTPError as e2:
                b2=e2.read().decode('utf-8','replace')[:1500]
                raise RuntimeError(f'Apify ha restituito HTTP {e2.code}. {b2}')
        if e.code==401:
            raise RuntimeError(f'Token Apify rifiutato da Apify (HTTP 401). lunghezza={len(token)}, fingerprint={hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]}. Risposta Apify: {body[:500]}')
        raise RuntimeError(f'Apify ha restituito HTTP {e.code}. {body}')
    except URLError as e:
        raise RuntimeError('Connessione ad Apify non riuscita: '+str(e.reason))


def apify_token_diagnostic():
    token = require_token()
    # Never return the token itself; only a short fingerprint and length.
    fp = hashlib.sha256(token.encode('utf-8')).hexdigest()[:12]
    try:
        data = apify_validate_token()
        return {'ok': True, 'username': data.get('username',''), 'token_length': len(token), 'token_fingerprint': fp}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'token_length': len(token), 'token_fingerprint': fp}

def apify_run(payload, timeout=300):
    token = require_token()
    url = f'{APIFY_API}/actors/{ACTOR_ID}/run-sync-get-dataset-items'
    headers = {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'TravelWorkPlanner/22.7'
    }
    req = Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
    try:
        with urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8')
            return json.loads(body)
    except HTTPError as e:
        try:
            body = e.read().decode('utf-8')
        except Exception:
            body = ''
        # Retry only when a proxy/network layer appears to have stripped the
        # Authorization header. Apify documents the token query parameter as a
        # supported fallback, although the header remains the preferred method.
        if e.code == 401 and 'token-not-provided' in body:
            try:
                qurl = url + ('&' if '?' in url else '?') + 'token=' + quote(token)
                qreq = Request(qurl, data=json.dumps(payload).encode('utf-8'), headers={
                    'Accept':'application/json', 'Content-Type':'application/json',
                    'User-Agent':'TravelWorkPlanner/22.9'
                }, method='POST')
                with urlopen(qreq, timeout=timeout) as r:
                    return json.loads(r.read().decode('utf-8'))
            except HTTPError as e2:
                try: body2=e2.read().decode('utf-8')
                except Exception: body2=''
                body = body2 or body
                e = e2
        try:
            detail = json.loads(body)
        except Exception:
            detail = body
        msg = f'Apify ha restituito HTTP {e.code}.'
        if detail:
            msg += ' ' + (json.dumps(detail, ensure_ascii=False) if not isinstance(detail, str) else detail[:1500])
        err = RuntimeError(msg)
        err.http_status = e.code
        raise err
    except URLError as e:
        raise RuntimeError('Connessione ad Apify non riuscita: ' + str(e.reason))


def duration_minutes(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v)
    m = re.fullmatch(r'PT(?:(\d+)H)?(?:(\d+)M)?', s)
    if m:
        return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)
    try:
        return int(float(s))
    except Exception:
        return None


def fmt_duration(mins):
    if mins is None:
        return ''
    h, m = divmod(int(mins), 60)
    return f'{h}h {m:02d}m' if h else f'{m}m'


def as_float(v):
    try:
        return float(v)
    except Exception:
        return None


def val(obj, *keys, default=None):
    if not isinstance(obj, dict):
        return default
    for k in keys:
        if k in obj and obj[k] not in (None, ''):
            return obj[k]
    return default


def place_code(p):
    if isinstance(p, str):
        return p.upper()
    if not isinstance(p, dict):
        return ''
    return str(val(p, 'displayCode', 'iata', 'iataCode', 'code', 'alternateId', default='')).upper()


def place_city(p):
    if isinstance(p, str):
        return p
    if not isinstance(p, dict):
        return ''
    return str(val(p, 'city', 'name', 'displayName', default=''))


def carrier_name(c):
    if isinstance(c, str):
        return c
    if not isinstance(c, dict):
        return ''
    return str(val(c, 'name', 'displayName', default=''))


def carrier_code(c):
    if isinstance(c, str):
        return c.upper()
    if not isinstance(c, dict):
        return ''
    return str(val(c, 'alternateId', 'iata', 'iataCode', 'code', default='')).upper()


def extract_segments(leg):
    raw = leg.get('segments') if isinstance(leg, dict) else None
    if not isinstance(raw, list):
        raw = []
    out = []
    for seg in raw:
        if not isinstance(seg, dict):
            continue
        origin = val(seg, 'origin', 'from', default={})
        destination = val(seg, 'destination', 'to', default={})
        marketing = val(seg, 'marketingCarrier', 'marketing_carrier', default={})
        operating = val(seg, 'operatingCarrier', 'operating_carrier', default={})
        if isinstance(marketing, list): marketing = marketing[0] if marketing else {}
        if isinstance(operating, list): operating = operating[0] if operating else {}
        fn = val(seg, 'flightNumber', 'flight_number', 'marketingFlightNumber', 'flightNo', default='')
        out.append({
            'origin': place_code(origin),
            'destination': place_code(destination),
            'originCity': place_city(origin),
            'destinationCity': place_city(destination),
            'departure': val(seg, 'departure', 'departureTime', 'departAt', default=val(leg, 'departure', default='')),
            'arrival': val(seg, 'arrival', 'arrivalTime', 'arriveAt', default=val(leg, 'arrival', default='')),
            'flightNumber': str(fn or ''),
            'carrier': carrier_name(operating) or carrier_name(marketing) or carrier_name(val(leg, 'carriers', default=[])[0] if isinstance(val(leg, 'carriers', default=[]), list) and val(leg, 'carriers', default=[]) else {}),
            'carrierCode': carrier_code(operating) or carrier_code(marketing),
            'duration': duration_minutes(val(seg, 'durationInMinutes', 'duration', default=None))
        })
    if not out:
        origin = val(leg, 'origin', default={})
        destination = val(leg, 'destination', default={})
        carriers = val(leg, 'carriers', default=[])
        c = carriers[0] if isinstance(carriers, list) and carriers else {}
        out.append({
            'origin': place_code(origin),
            'destination': place_code(destination),
            'originCity': place_city(origin),
            'destinationCity': place_city(destination),
            'departure': val(leg, 'departure', default=''),
            'arrival': val(leg, 'arrival', default=''),
            'flightNumber': '',
            'carrier': carrier_name(c),
            'carrierCode': carrier_code(c),
            'duration': duration_minutes(val(leg, 'durationInMinutes', 'duration', default=None))
        })
    return out


def extract_baggage(raw):
    """Best-effort extraction of explicitly exposed baggage fields from the Actor output.
    Unknown is kept unknown; we never infer baggage inclusion from fare price alone.
    """
    result = {'carry_on': 0, 'checked': 0, 'known': False, 'details': {}}
    def walk(x, path=''):
        if isinstance(x, dict):
            for k,v in x.items():
                lk=str(k).lower().replace('-', '_')
                if isinstance(v, (str,int,float,bool)):
                    sv=str(v).lower()
                    if any(t in lk for t in ('carry_on','carryon','cabin_bag','cabinbag','hand_bag','handbag')):
                        result['known']=True
                        if isinstance(v,(int,float)) and v>0: result['carry_on']=max(result['carry_on'], int(v))
                        elif sv in ('true','yes','included','included_in_price','1'): result['carry_on']=max(result['carry_on'],1)
                        result['details'][path+k]=v
                    elif any(t in lk for t in ('checked_bag','checkedbag','hold_bag','holdbag','baggage_checked','luggage_checked')):
                        result['known']=True
                        if isinstance(v,(int,float)) and v>0: result['checked']=max(result['checked'], int(v))
                        elif sv in ('true','yes','included','included_in_price','1'): result['checked']=max(result['checked'],1)
                        result['details'][path+k]=v
                walk(v, path+k+'.')
        elif isinstance(x,list):
            for i,v in enumerate(x): walk(v, path+str(i)+'.')
    walk(raw)
    return result

def normalize_itinerary(item):
    if not isinstance(item, dict):
        return None
    # The actor can add informational rows. Ignore them.
    if item.get('type') in ('Date auto-adjusted', 'notice') or item.get('notice'):
        return None
    legs = item.get('legs') or []
    if not isinstance(legs, list) or not legs:
        return None
    norm_legs = []
    all_segments = []
    airline = ''
    airline_code = ''
    for leg in legs:
        if not isinstance(leg, dict):
            continue
        segs = extract_segments(leg)
        if segs:
            if not airline:
                airline = segs[0].get('carrier', '')
            if not airline_code:
                airline_code = segs[0].get('carrierCode', '')
            all_segments.append(segs)
            norm_legs.append({
                'segments': segs,
                'origin': place_code(val(leg, 'origin', default={})) or segs[0]['origin'],
                'destination': place_code(val(leg, 'destination', default={})) or segs[-1]['destination'],
                'departure': val(leg, 'departure', default=segs[0]['departure']),
                'arrival': val(leg, 'arrival', default=segs[-1]['arrival']),
                'durationMinutes': duration_minutes(val(leg, 'durationInMinutes', 'duration', default=None)),
                'stopCount': int(val(leg, 'stopCount', default=max(0, len(segs)-1)) or 0),
            })
    if not norm_legs:
        return None
    price_obj = item.get('price') if isinstance(item.get('price'), dict) else {}
    price = as_float(val(price_obj, 'raw', default=item.get('price-raw')))
    pricing_id = val(price_obj, 'pricingOptionId', default=item.get('price-pricingOptionId', ''))
    tags = []
    for k, v in item.items():
        if str(k).startswith('tags-') and v:
            tags.append(str(v))
    duration_total = sum((l['durationMinutes'] or 0) for l in norm_legs) or None
    return {
        'offerId': str(item.get('id') or pricing_id or ''),
        'airline': airline,
        'airlineCode': airline_code,
        'price': price,
        'currency': 'EUR',
        'durationMinutes': duration_total,
        'duration': fmt_duration(duration_total),
        'slices': all_segments,
        'bags': extract_baggage(item),
        'stops': [l['stopCount'] for l in norm_legs],
        'tags': tags,
        'score': item.get('score'),
        'pricingOptionId': pricing_id,
        'skyscannerId': str(item.get('id') or ''),
        'raw': item,
    }


def flatten_currency(items, requested='EUR'):
    # The actor documents that price-raw is returned in the requested currency.
    # Keep the requested currency on every normalized result.
    for x in items:
        x['currency'] = requested.upper()
    return items


def search_flights(body):
    origin = str(body.get('origin', '')).strip().upper()
    destination = str(body.get('destination', '')).strip().upper()

    # Normalize legacy/ambiguous airport aliases before sending them to
    # Skyscanner/Apify. Some airport datasets contain MPX for Milan Malpensa,
    # while Skyscanner expects the current IATA code MXP.
    IATA_ALIASES = {
        'MPX': 'MXP',
    }
    origin = IATA_ALIASES.get(origin, origin)
    destination = IATA_ALIASES.get(destination, destination)
    depart = str(body.get('departure_date', '')).strip()
    ret = str(body.get('return_date', '')).strip()
    pax = max(1, min(9, int(body.get('passengers') or 1)))
    cabin = str(body.get('cabin') or 'economy')
    direct = bool(body.get('direct'))
    currency = str(body.get('currency') or 'EUR').upper()
    market = str(body.get('market') or 'IT').upper()
    locale = str(body.get('locale') or 'it-IT')
    if len(origin) < 2 or len(destination) < 2:
        raise ValueError('Inserisci origine e destinazione come città o codici IATA, ad esempio Roma/FCO e Londra/LHR.')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', depart):
        raise ValueError('Data di andata non valida.')
    if ret and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', ret):
        raise ValueError('Data di ritorno non valida.')
    if ret and ret < depart:
        raise ValueError('La data di ritorno non può essere precedente all’andata.')

    payload = {
        'startUrls': [{'url': 'https://www.skyscanner.net/'}],
        'departureAirport': origin,
        'arrivalAirport': destination,
        'departureDate': depart,
        'cabinClass': cabin,
        'adults': pax,
        'skyscannerMarket': market,
        'skyscannerCurrency': currency,
        'skyscannerLocale': locale,
        'resultSort': 'cheapest',
        'resultLimit': 60,
        'maxItems': 60,
        'flattenOutput': False,
        'proxy': {'useApifyProxy': True, 'apifyProxyGroups': ['RESIDENTIAL']},
    }
    if ret:
        payload['returnDate'] = ret
    if direct:
        payload['filterNonStop'] = True
        payload['filterOneStop'] = False
        payload['filterTwoPlusStops'] = False

    raw = apify_run(payload, timeout=300)
    if isinstance(raw, dict) and isinstance(raw.get('items'), list):
        rows = raw['items']
    elif isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict) and isinstance(raw.get('data'), list):
        rows = raw['data']
    else:
        rows = []
    normalized = [normalize_itinerary(x) for x in rows]
    normalized = [x for x in normalized if x and x.get('slices')]
    normalized = flatten_currency(normalized, currency)
    normalized.sort(key=lambda x: (x['price'] is None, x['price'] if x['price'] is not None else 10**12, x['durationMinutes'] if x['durationMinutes'] is not None else 10**9))
    return {'ok': True, 'source': 'Skyscanner via Apify', 'count': len(normalized), 'offers': normalized, 'currency': currency}


def place_suggestions(query):
    """Autocomplete aeroporti usata dalla pagina Voli.

    La ricerca Voli deve usare lo stesso indice aeroporti della pagina Autonoleggio:
    IATA + citta + nome aeroporto + keywords/alias multilingua.
    """
    try:
        return airport_place_suggestions(query)
    except Exception as e:
        print('Airport index unavailable for flights:', e)
        return {'ok': False, 'error': f'Indice aeroporti non disponibile: {e}'}


def http_json_get(url, timeout=45):
    req=Request(url, headers={'Accept':'application/json','User-Agent':'TravelWorkPlanner/16.0'}, method='GET')
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except HTTPError as e:
        body=e.read().decode('utf-8','replace')[:2000]
        err=RuntimeError(f'Provider treni ha restituito HTTP {e.code}. {body}')
        err.http_status=e.code
        raise err
    except URLError as e:
        raise RuntimeError('Connessione al provider treni non riuscita: '+str(e.reason))


def http_json_post(url, payload, headers=None, timeout=60):
    h={'Accept':'application/json','Content-Type':'application/json','User-Agent':'TravelWorkPlanner/16.0'}
    if headers: h.update(headers)
    req=Request(url, data=json.dumps(payload).encode('utf-8'), headers=h, method='POST')
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except HTTPError as e:
        body=e.read().decode('utf-8','replace')[:3000]
        try:
            detail=json.loads(body)
            body=json.dumps(detail,ensure_ascii=False)
        except Exception:
            pass
        err=RuntimeError(f'Provider hotel ha restituito HTTP {e.code}. {body}')
        err.http_status=e.code
        raise err
    except URLError as e:
        raise RuntimeError('Connessione al provider hotel non riuscita: '+str(e.reason))


def parse_iso_duration_minutes(start, end):
    try:
        a=datetime.fromisoformat(str(start).replace('Z','+00:00')); b=datetime.fromisoformat(str(end).replace('Z','+00:00'))
        return max(0,int((b-a).total_seconds()/60))
    except Exception:
        return None


def http_json_get_generic(url, provider='Provider', timeout=45):
    req=Request(url, headers={'Accept':'application/json','User-Agent':'Travel Work Planner/22.2 (+Travel Work Planner desktop app)'}, method='GET')
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except HTTPError as e:
        body=e.read().decode('utf-8','replace')[:2500]
        err=RuntimeError(f'{provider} ha restituito HTTP {e.code}. {body}')
        err.http_status=e.code
        raise err
    except URLError as e:
        raise RuntimeError(f'Connessione a {provider} non riuscita: {e.reason}')


def transitous_geocode(query):
    from urllib.parse import quote
    q=str(query or '').strip()
    if len(q)<2: return []
    # MOTIS 2 current API: /api/v1/geocode?text=...&type=STOP
    url=f"{TRANSITOUS_BASE.rstrip('/')}/v1/geocode?text={quote(q)}&type=STOP&language=it"
    raw=http_json_get_generic(url, 'Transitous', timeout=45)
    arr=raw if isinstance(raw,list) else []
    out=[]
    for x in arr:
        if not isinstance(x,dict): continue
        typ=str(x.get('type') or '').upper()
        if typ and typ!='STOP': continue
        sid=x.get('id') or x.get('stopId')
        name=x.get('name') or x.get('displayName')
        lat=x.get('lat'); lon=x.get('lon')
        if not sid or not name or lat is None or lon is None: continue
        areas=x.get('areas') or []
        locality=''
        if isinstance(areas,list):
            for a in areas:
                if isinstance(a,dict) and a.get('name'):
                    locality=str(a.get('name')); break
        country=str(x.get('country') or '')
        out.append({'id':str(sid),'name':str(name),'lat':float(lat),'lon':float(lon),'type':'STOP','locality':locality,'country':country,'label':str(x.get('description') or '')})
    return out[:8]

def normalize_transitous_itinerary(j):
    if not isinstance(j,dict): return None
    legs=j.get('legs') or []
    if not isinstance(legs,list) or not legs: return None
    transit=[l for l in legs if isinstance(l,dict) and str(l.get('mode') or '').upper() in ('RAIL','HIGHSPEED_RAIL','LONG_DISTANCE','NIGHT_RAIL','REGIONAL_FAST_RAIL','REGIONAL_RAIL','SUBURBAN','TRANSIT')]
    # If mode is missing, retain legs that carry a route/trip object.
    if not transit:
        transit=[l for l in legs if isinstance(l,dict) and (l.get('route') or l.get('trip') or l.get('serviceName'))]
    if not transit: return None
    first=legs[0] if isinstance(legs[0],dict) else transit[0]
    last=legs[-1] if isinstance(legs[-1],dict) else transit[-1]
    dep=j.get('startTime') or j.get('departureTime') or first.get('startTime') or first.get('departureTime') or first.get('departure')
    arr=j.get('endTime') or j.get('arrivalTime') or last.get('endTime') or last.get('arrivalTime') or last.get('arrival')
    def place_name(x):
        if not isinstance(x,dict): return ''
        p=x.get('place') or x.get('stop') or x.get('from') or x.get('to') or x.get('departureStop') or x.get('arrivalStop') or {}
        if isinstance(p,dict): return str(p.get('name') or p.get('displayName') or p.get('stopName') or '')
        return str(p or '')
    names=[]; ops=[]; rail_legs=[]
    for l in transit:
        route=l.get('route') or l.get('line') or {}
        trip=l.get('trip') or {}
        name=(route.get('name') if isinstance(route,dict) else '') or (route.get('shortName') if isinstance(route,dict) else '') or (l.get('serviceName') if isinstance(l,dict) else '') or (trip.get('name') if isinstance(trip,dict) else '')
        op=(route.get('operator') if isinstance(route,dict) else {}) or (trip.get('operator') if isinstance(trip,dict) else {}) or {}
        if isinstance(op,dict): op=op.get('name') or op.get('id') or ''
        if name: names.append(str(name))
        if op: ops.append(str(op))
        if str(l.get('mode') or '').upper() in ('RAIL','HIGHSPEED_RAIL','LONG_DISTANCE','NIGHT_RAIL','REGIONAL_FAST_RAIL','REGIONAL_RAIL','SUBURBAN') or name:
            rail_legs.append(l)
    # MOTIS/Transitous has returned fares in more than one JSON shape over time
    # (object, list, nested fare products). Search only fare-like objects and
    # require a currency or an amount/price field before accepting a value.
    fare=j.get('fares') if 'fares' in j else j.get('fare')
    price=None; currency='EUR'
    def extract_fare(node):
        if isinstance(node, dict):
            cur=node.get('currency') or node.get('currencyCode') or node.get('currency_code')
            for key in ('total','amount','price','value','fareAmount','totalFare'):
                val=node.get(key)
                if isinstance(val,(int,float)) and val >= 0:
                    return float(val), str(cur or 'EUR').upper()
                if isinstance(val,str):
                    try: return float(val.replace(',','.')), str(cur or 'EUR').upper()
                    except Exception: pass
            # Common MOTIS shapes: fares.fare, fares.fares, fareProducts,
            # fareProducts[].price / amount.
            for key in ('fare','fares','fareProducts','products','prices','components','items'):
                if key in node:
                    got=extract_fare(node[key])
                    if got: return got
            return None
        if isinstance(node,list):
            for item in node:
                got=extract_fare(item)
                if got: return got
        return None
    got=extract_fare(fare)
    if got: price,currency=got
    duration=parse_iso_duration_minutes(dep,arr)
    origin=place_name(first) or str(first.get('fromPlace') or '')
    destination=place_name(last) or str(last.get('toPlace') or '')
    return {'id':str(j.get('id') or j.get('connectionId') or j.get('refreshToken') or '|'.join(names)),
            'origin':origin,'destination':destination,'departure':dep,'arrival':arr,'durationMinutes':duration,
            'transfers':max(0,len(rail_legs)-1),'train':' · '.join(dict.fromkeys(names)),
            'operator':' · '.join(dict.fromkeys(ops)) or 'Transitous','price':price,'currency':currency,
            'firstClass':False,'legs':rail_legs,'priceAvailable':price is not None,'priceStatus':('Prezzo restituito da Transitous' if price is not None else 'PREZZO NON DISPONIBILE — DA INSERIRE'),'raw':j}


def search_trains_transitous(body, from_place, to_place):
    from urllib.parse import urlencode
    date=str(body.get('date') or '').strip(); tm=str(body.get('time') or '08:00').strip()
    if not from_place or not to_place:
        raise ValueError('Stazione non trovata.')

    def place_values(p):
        vals=[]
        # First try the actual Transitous/MOTIS stop id returned by geocoding.
        sid=str(p.get('id') or '').strip()
        if sid: vals.append(sid)
        # Then try coordinates, which are also officially supported by MOTIS.
        try:
            lat=float(p.get('lat')); lon=float(p.get('lon'))
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                vals.append(f"{lat:.7f},{lon:.7f}")
        except Exception:
            pass
        return list(dict.fromkeys(vals))

    # MOTIS expects RFC3339 date-time. Send UTC explicitly to avoid parser ambiguity.
    try:
        local_dt=datetime.strptime(f'{date} {tm}', '%Y-%m-%d %H:%M')
        when=local_dt.astimezone().astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:
        when=f'{date}T{tm}:00Z'

    base_params={
        'time':when,
        'arriveBy':'false',
        'transitModes':'RAIL',
        'timetableView':'true',
        'numItineraries':'20',
        'withFares':'true'
    }
    if bool(body.get('direct')):
        base_params['maxTransfers']='0'

    from_vals=place_values(from_place); to_vals=place_values(to_place)
    if not from_vals or not to_vals:
        raise ValueError('Origine o destinazione senza ID/coordinate validi.')

    # Try the smallest valid MOTIS request first. This avoids optional parameters
    # that have changed between deployments and were causing generic "missing parameter"
    # responses. Each endpoint is tried with stop IDs first, then coordinates.
    attempts=[]
    for endpoint in ('v6','v1'):
        for fv,tv in [(from_vals[0],to_vals[0])]+(
            [(from_vals[1],to_vals[1])] if len(from_vals)>1 and len(to_vals)>1 else []):
            params=dict(base_params); params['fromPlace']=fv; params['toPlace']=tv
            attempts.append((endpoint,params))

    last_error=None
    raw=None; used_version=None; used_params=None
    for endpoint,params in attempts:
        url=f"{TRANSITOUS_BASE.rstrip('/')}/{endpoint}/plan?{urlencode(params)}"
        try:
            raw=http_json_get_generic(url,'Transitous',timeout=45)
            used_version=endpoint; used_params=params
            break
        except RuntimeError as e:
            last_error=e
            if getattr(e,'http_status',None) in (400,404,405,422,500,502,503,504):
                continue
            raise
    if raw is None:
        # Include the endpoint variants tried, but never expose credentials.
        tried=', '.join(f"{v} fromPlace={params.get('fromPlace')} toPlace={params.get('toPlace')}" for v,params in attempts)
        raise RuntimeError(f'{last_error or "Transitous non ha restituito dati."} | tentativi: {tried}')

    journeys=[]
    if isinstance(raw,dict):
        journeys=raw.get('itineraries') or raw.get('journeys') or raw.get('connections') or []
    offers=[normalize_transitous_itinerary(j) for j in journeys]
    offers=[x for x in offers if x]
    return {'ok':True,'source':f'Transitous / MOTIS {used_version}','count':len(offers),'offers':offers}

def train_place_suggestions(query):
    q=str(query or '').strip()
    if len(q)<2: return {'ok':True,'places':[]}
    try:
        arr=transitous_geocode(q)
        if arr: return {'ok':True,'places':arr[:8], 'source':'Transitous'}
        return {'ok':True,'places':[], 'source':'Transitous'}
    except Exception as e:
        print('Transitous geocode unavailable:',e)
        raise RuntimeError('Suggerimenti stazioni Transitous non disponibili. Riprova tra poco.')


def search_trains(body):
    from urllib.parse import urlencode
    from_id=str(body.get('from') or '').strip(); to_id=str(body.get('to') or '').strip(); date=str(body.get('date') or '').strip(); tm=str(body.get('time') or '08:00').strip()
    if not from_id or not to_id: raise ValueError('Inserisci origine e destinazione.')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date): raise ValueError('Data treno non valida.')
    if not re.fullmatch(r'\d{2}:\d{2}',tm): tm='08:00'
    fp=body.get('fromPlace') or {'id':from_id,'name':from_id}
    tp=body.get('toPlace') or {'id':to_id,'name':to_id}
    # If the UI has text-only ids, geocode now.
    if fp.get('type')=='text' or (not fp.get('lat') and not fp.get('id')):
        fp=(transitous_geocode(fp.get('name') or from_id) or [fp])[0]
    if tp.get('type')=='text' or (not tp.get('lat') and not tp.get('id')):
        tp=(transitous_geocode(tp.get('name') or to_id) or [tp])[0]
    try:
        return search_trains_transitous(body,fp,tp)
    except Exception as e:
        raise RuntimeError('Ricerca treni Transitous non disponibile: '+str(e))


def require_hotelbeds():
    global HOTELBEDS_API_KEY, HOTELBEDS_API_SECRET, HOTELBEDS_BASE, HOTELBEDS_CERT, HOTELBEDS_KEY_FILE, HOTELBEDS_KEY_PASSWORD
    HOTELBEDS_API_KEY=(HOTELBEDS_API_KEY or '').strip().strip('"').strip("'")
    HOTELBEDS_API_SECRET=(HOTELBEDS_API_SECRET or '').strip().strip('"').strip("'")
    HOTELBEDS_BASE=(HOTELBEDS_BASE or HOTELBEDS_API_BASE).rstrip('/')
    HOTELBEDS_CERT=(HOTELBEDS_CERT or '').strip().strip('"').strip("'")
    HOTELBEDS_KEY_FILE=(HOTELBEDS_KEY_FILE or '').strip().strip('"').strip("'")
    HOTELBEDS_KEY_PASSWORD=(HOTELBEDS_KEY_PASSWORD or '').strip().strip('"').strip("'")
    if not HOTELBEDS_API_KEY or not HOTELBEDS_API_SECRET:
        raise RuntimeError('Hotelbeds non configurato. Inserisci HOTELBEDS_API_KEY=... e HOTELBEDS_API_SECRET=... nel file .env e riavvia il programma.')
    if not HOTELBEDS_CERT or not HOTELBEDS_KEY_FILE:
        raise RuntimeError('Hotelbeds richiede anche il certificato mTLS. Inserisci HOTELBEDS_CERT=... e HOTELBEDS_KEY_FILE=... nel file .env e riavvia il programma.')
    cert=Path(HOTELBEDS_CERT); key=Path(HOTELBEDS_KEY_FILE)
    if not cert.is_absolute(): cert=ROOT / cert
    if not key.is_absolute(): key=ROOT / key
    if not cert.is_absolute(): cert=ROOT/cert
    if not key.is_absolute(): key=ROOT/key
    if not cert.exists() or not key.exists():
        raise RuntimeError('Certificato/key mTLS Hotelbeds non trovati. Controlla HOTELBEDS_CERT e HOTELBEDS_KEY_FILE nel file .env.')
    return HOTELBEDS_API_KEY, HOTELBEDS_API_SECRET, cert, key


def hotelbeds_usage_file():
    return ROOT / '.hotelbeds_usage.json'


def check_hotelbeds_quota():
    p=hotelbeds_usage_file(); today=datetime.now().strftime('%Y-%m-%d'); data={}
    try:
        if p.exists(): data=json.loads(p.read_text(encoding='utf-8'))
    except Exception: data={}
    if data.get('date')!=today: data={'date':today,'count':0}
    count=int(data.get('count') or 0)
    if count>=HOTELBEDS_DAILY_LIMIT:
        raise RuntimeError(f'Limite locale Hotelbeds raggiunto: {HOTELBEDS_DAILY_LIMIT} richieste oggi. Il contatore si azzera domani.')
    return data


def consume_hotelbeds_quota():
    p=hotelbeds_usage_file(); data=check_hotelbeds_quota(); data['count']=int(data.get('count') or 0)+1
    p.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    return data['count']


def hotelbeds_signature(api_key, secret):
    return hashlib.sha256((api_key+secret+str(int(time.time()))).encode('utf-8')).hexdigest()


def hotelbeds_post(path, payload):
    api_key,secret,cert,key=require_hotelbeds()
    consume_hotelbeds_quota()
    url=HOTELBEDS_BASE.rstrip('/')+path
    headers={'Api-key':api_key,'X-Signature':hotelbeds_signature(api_key,secret),'Accept':'application/json','Content-Type':'application/json','Accept-Encoding':'gzip','User-Agent':'TravelWorkPlanner/22.9'}
    body=json.dumps(payload).encode('utf-8')
    ctx=ssl.create_default_context()
    ctx.load_cert_chain(certfile=str(cert),keyfile=str(key),password=(HOTELBEDS_KEY_PASSWORD or None))
    req=Request(url,data=body,headers=headers,method='POST')
    try:
        with urlopen(req,timeout=35,context=ctx) as r:
            raw=r.read()
            # urllib does not transparently decompress gzip. Hotelbeds may
            # return gzip even when Accept-Encoding is explicitly requested.
            # Handle both the declared encoding and the gzip magic bytes.
            if r.headers.get('Content-Encoding','').lower() == 'gzip' or raw[:2] == b'\\x1f\\x8b':
                raw=gzip.decompress(raw)
            return json.loads(raw.decode('utf-8'))
    except HTTPError as e:
        try: b=e.read().decode('utf-8','replace')[:3000]
        except Exception: b=''
        err=RuntimeError(f'Hotelbeds ha restituito HTTP {e.code}. {b}'); err.http_status=e.code; raise err
    except URLError as e:
        raise RuntimeError('Hotelbeds non ha risposto entro il tempo massimo. Controlla connessione, certificato mTLS e ambiente TEST e riprova.')


def geocode_destination(query):
    q=str(query or '').strip()
    if len(q)<2: raise ValueError('Inserisci una destinazione hotel.')
    params=urlencode({'q':q,'format':'jsonv2','limit':1,'accept-language':'it'})
    req=Request(GEOCODER_URL+'?'+params,headers={'User-Agent':'TravelWorkPlanner/21.1 hotel-search/1.0'},method='GET')
    try:
        with urlopen(req,timeout=20) as r: arr=json.loads(r.read().decode('utf-8'))
    except Exception as e:
        raise RuntimeError('Impossibile risolvere la destinazione. Controlla la connessione e riprova.')
    if not arr: raise RuntimeError('Destinazione non trovata.')
    x=arr[0]
    return {'id':str(x.get('place_id') or ''),'name':str(x.get('display_name') or q),'lat':float(x['lat']),'lon':float(x['lon'])}


def parse_hotelbeds_offers(raw, nights, body):
    hotels=((raw.get('hotels') or {}).get('hotels') or []) if isinstance(raw,dict) else []
    offers=[]
    for h in hotels:
        if not isinstance(h,dict): continue
        stars=None
        cat=str(h.get('categoryName') or '')
        m=re.search(r'(\d+)',cat)
        if m: stars=int(m.group(1))
        rooms=h.get('rooms') or {}
        room_list=rooms.get('room') if isinstance(rooms,dict) else rooms
        if isinstance(room_list,dict): room_list=[room_list]
        best=None
        for room in room_list or []:
            rates=(room.get('rates') or {}) if isinstance(room,dict) else {}
            rate_list=rates.get('rate') if isinstance(rates,dict) else rates
            if isinstance(rate_list,dict): rate_list=[rate_list]
            for rate in rate_list or []:
                if not isinstance(rate,dict): continue
                try: price=float(rate.get('sellingRate') or rate.get('net'))
                except Exception: continue
                if body.get('maxPrice') and price/nights>float(body['maxPrice']): continue
                board=str(rate.get('boardName') or rate.get('boardCode') or '')
                if body.get('breakfast') and str(rate.get('boardCode') or '').upper() not in ('BB','HB','FB','AI'): continue
                if best is None or price<best['price']:
                    cps=rate.get('cancellationPolicies') or []
                    if isinstance(cps,dict): cps=[cps]
                    cancel=cps[0] if cps else {}
                    best={'price':price,'currency':str(rate.get('hotelCurrency') or raw.get('currency') or 'EUR').upper(),'room':str(room.get('name') or room.get('code') or ''),'board':board,'rateType':str(rate.get('rateType') or ''),'rateKey':str(rate.get('rateKey') or ''),'paymentType':str(rate.get('paymentType') or ''),'cancelFrom':str(cancel.get('from') or ''),'cancelAmount':cancel.get('amount')}
        if not best: continue
        offers.append({'id':str(h.get('code') or ''),'name':str(h.get('name') or ''),'address':', '.join([str(v) for v in [h.get('zoneName'),h.get('destinationName')] if v]),'latitude':h.get('latitude'),'longitude':h.get('longitude'),'stars':stars,'price':best['price']/nights,'total':best['price'],'currency':best['currency'],'nights':nights,'room':best['room'],'board':best['board'],'rateType':best['rateType'],'rateKey':best['rateKey'],'paymentType':best['paymentType'],'freeCancellation':bool(best['cancelFrom'] and str(best['cancelAmount'] or '0') in ('0','0.0','0.00')),'cancelFrom':best['cancelFrom'],'cancelAmount':best['cancelAmount'],'platform':'Hotelbeds','url':'','raw':h})
    offers.sort(key=lambda o:o.get('price') if o.get('price') is not None else 10**12)
    if body.get('sort')=='stars': offers.sort(key=lambda o:o.get('stars') or 0,reverse=True)
    return offers[:30]


def search_hotels(body):
    dest=str(body.get('destination') or '').strip(); ci=str(body.get('checkin') or '').strip(); co=str(body.get('checkout') or '').strip()
    if not dest: raise ValueError('Inserisci una destinazione hotel.')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',ci) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',co): raise ValueError('Date hotel non valide.')
    if co<=ci: raise ValueError('Il check-out deve essere successivo al check-in.')
    adults=max(1,min(20,int(body.get('adults') or 2))); rooms=max(1,min(10,int(body.get('rooms') or 1))); children=max(0,min(20,int(body.get('children') or 0)))
    nights=max(1,(datetime.fromisoformat(co)-datetime.fromisoformat(ci)).days)
    try:
        lat=float(body.get('lat')); lon=float(body.get('lon'))
        if not (-90<=lat<=90 and -180<=lon<=180): raise ValueError
        geo={'id':str(body.get('destinationId') or ''),'name':dest,'lat':lat,'lon':lon}
    except Exception:
        geo=geocode_destination(dest)
    radius=max(1,min(100,float(body.get('radius') or 20)))
    payload={'stay':{'checkIn':ci,'checkOut':co},'occupancies':[{'rooms':rooms,'adults':adults,'children':children}],'geolocation':{'latitude':geo['lat'],'longitude':geo['lon'],'radius':radius,'unit':'km'}}
    if body.get('stars'):
        try: payload['filter']={'minCategory':int(body['stars']),'maxCategory':5}
        except Exception: pass
    raw=hotelbeds_post('/hotel-api/1.0/hotels',payload)
    offers=parse_hotelbeds_offers(raw,nights,body)
    return {'ok':True,'source':'Hotelbeds','count':len(offers),'offers':offers,'destination':geo,'remainingDaily':max(0,HOTELBEDS_DAILY_LIMIT-int(check_hotelbeds_quota().get('count') or 0))}


def hotel_place_suggestions(query):
    q=str(query or '').strip()
    if len(q)<2: return {'ok':True,'places':[]}
    # Prefer Nominatim for cities/regions; if unavailable, fall back to Transitous geocoding.
    try:
        params=urlencode({'q':q,'format':'jsonv2','limit':8,'addressdetails':1,'accept-language':'it'})
        req=Request(GEOCODER_URL+'?'+params,headers={'User-Agent':'TravelWorkPlanner/21.6 (+https://transitworkplanner.local) hotel-search/1.0','Accept-Language':'it'},method='GET')
        with urlopen(req,timeout=20) as r:
            arr=json.loads(r.read().decode('utf-8'))
        out=[]
        for x in arr if isinstance(arr,list) else []:
            try:
                addr=x.get('address') or {}
                city=addr.get('city') or addr.get('town') or addr.get('municipality') or addr.get('village') or ''
                country=addr.get('country') or ''
                out.append({'id':str(x.get('place_id') or ''),'name':str(x.get('display_name') or q),'lat':float(x['lat']),'lon':float(x['lon']),'city':str(city),'country':str(country)})
            except Exception:
                continue
        if out: return {'ok':True,'places':out[:8],'source':'OpenStreetMap Nominatim'}
    except Exception as e:
        print('Nominatim hotel autocomplete unavailable:',e)
    try:
        # Transitous geocoder can resolve cities/places too; do not require STOP here.
        from urllib.parse import quote
        url=f"{TRANSITOUS_BASE.rstrip('/')}/v1/geocode?text={quote(q)}&language=it"
        raw=http_json_get_generic(url,'Transitous',timeout=30)
        arr=raw if isinstance(raw,list) else []
        out=[]
        for x in arr:
            if not isinstance(x,dict): continue
            if not x.get('id') or not x.get('name') or x.get('lat') is None or x.get('lon') is None: continue
            out.append({'id':str(x['id']),'name':str(x['name']),'lat':float(x['lat']),'lon':float(x['lon']),'city':str((x.get('areas') or [{}])[0].get('name') if isinstance(x.get('areas'),list) and x.get('areas') and isinstance(x.get('areas')[0],dict) else ''),'country':str(x.get('country') or '')})
        return {'ok':True,'places':out[:8],'source':'Transitous geocoder'}
    except Exception as e:
        print('Transitous hotel geocoder unavailable:',e)
        return {'ok':True,'places':[],'source':'geocoder'}


def _mcp_sse_json(text):
    """Extract the last JSON-RPC message from an SSE response."""
    msgs=[]
    for line in str(text or '').splitlines():
        line=line.strip()
        if line.startswith('data:'):
            payload=line[5:].strip()
            if payload and payload != '[DONE]':
                try: msgs.append(json.loads(payload))
                except Exception: pass
    if msgs:
        return msgs[-1]
    try:
        return json.loads(str(text or '').strip())
    except Exception:
        return None

def _octotrip_mcp(method, req_id, params=None, timeout=55):
    payload={'jsonrpc':'2.0','id':req_id,'method':method,'params':params or {}}
    req=Request(OCTOTRIP_CARS_MCP, data=json.dumps(payload).encode('utf-8'), headers={
        'Content-Type':'application/json',
        'Accept':'application/json, text/event-stream',
        'User-Agent':'TravelWorkPlanner/24.4 (rental-car-search)'
    }, method='POST')
    try:
        with urlopen(req, timeout=timeout) as r:
            raw=r.read()
            charset='utf-8'
            ct=(r.headers.get('Content-Type') or '').lower()
            if 'charset=' in ct:
                charset=ct.split('charset=',1)[1].split(';',1)[0].strip() or 'utf-8'
            return _mcp_sse_json(raw.decode(charset, errors='replace'))
    except HTTPError as e:
        body=e.read().decode('utf-8','replace')[:2000]
        raise RuntimeError(f'OctoTrip ha restituito HTTP {e.code}. {body}')
    except URLError as e:
        raise RuntimeError('Connessione a OctoTrip non riuscita: '+str(e.reason))

def _octotrip_search(args):
    # The hosted server is stateless: initialize and call the read-only search tool.
    init=_octotrip_mcp('initialize', 1, {'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'TravelWorkPlanner','version':'24.1'}}, timeout=25)
    if isinstance(init,dict) and init.get('error'):
        raise RuntimeError('OctoTrip initialize: '+json.dumps(init['error'],ensure_ascii=False))
    res=_octotrip_mcp('tools/call', 2, {'name':'search','arguments':args}, timeout=55)
    if isinstance(res,dict) and res.get('error'):
        raise RuntimeError('OctoTrip search: '+json.dumps(res['error'],ensure_ascii=False))
    result=(res or {}).get('result') if isinstance(res,dict) else None
    content=(result or {}).get('content') if isinstance(result,dict) else None
    if not content:
        return {}
    for item in content:
        if isinstance(item,dict) and item.get('type')=='text':
            txt=item.get('text','')
            try: return json.loads(txt)
            except Exception:
                # Some MCP implementations may return nested JSON-RPC data.
                nested=_mcp_sse_json(txt)
                if isinstance(nested,dict): return nested
    return {}

def _fold_search_text(value):
    value = str(value or '').strip().lower()
    value = unicodedata.normalize('NFKD', value)
    value = ''.join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r'[^a-z0-9]+', ' ', value).strip()

AIRPORT_CITY_ALIASES = {
    'praga':['prague','praha'],'prague':['praga','praha'],'praha':['praga','prague'],
    'vienna':['wien'],'wien':['vienna'],'munich':['monaco di baviera','munchen','muenchen'],
    'monaco di baviera':['munich','munchen','muenchen'],'cologne':['colonia','koln','koeln'],
    'colonia':['cologne','koln','koeln'],'frankfurt':['francoforte'],'francoforte':['frankfurt'],
    'brussels':['bruxelles','brussel'],'bruxelles':['brussels','brussel'],'zurich':['zurigo','zuerich'],
    'zurigo':['zurich'],'geneva':['ginevra','geneve'],'ginevra':['geneva','geneve'],
    'lisbon':['lisbona','lisboa'],'lisbona':['lisbon','lisboa'],'barcelona':['barcellona'],
    'barcellona':['barcelona'],'seville':['siviglia','sevilla'],'siviglia':['seville','sevilla'],
    'athens':['atene','athina'],'atene':['athens','athina'],'copenhagen':['copenaghen','kobenhavn'],
    'copenaghen':['copenhagen'],'stockholm':['stoccolma'],'stoccolma':['stockholm'],
    'warsaw':['varsavia','warszawa'],'varsavia':['warsaw','warszawa'],'krakow':['cracovia','kraków'],
    'cracovia':['krakow'],'bucharest':['bucarest','bucuresti'],'bucarest':['bucharest'],
    'zagreb':['zagabria'],'zagabria':['zagreb'],'belgrade':['belgrado','beograd'],
    'belgrado':['belgrade','beograd'],'moscow':['mosca','moskva'],'mosca':['moscow'],
    'st petersburg':['san pietroburgo','sankt peterburg'],'san pietroburgo':['st petersburg'],
    'rome':['roma'],'roma':['rome'],'milan':['milano'],'milano':['milan'],'naples':['napoli'],
    'napoli':['naples'],'florence':['firenze'],'firenze':['florence'],'venice':['venezia'],
    'venezia':['venice'],'turin':['torino'],'torino':['turin'],'genoa':['genova'],'genova':['genoa'],
    'london':['londra'],'londra':['london'],'paris':['parigi'],'parigi':['paris'],
    'berlin':['berlino'],'berlino':['berlin']
}

# Airports that commonly serve a metropolitan city even when the municipality
# field is a nearby suburb. This is intentionally small and only expands major hubs.
# Built-in fallback catalog for the most common Italian/European airports.
# It keeps autocomplete usable even when the remote OurAirports index is slow or unavailable.
STATIC_AIRPORTS = [
    ('FCO','Roma Fiumicino','Rome','IT','large_airport'), ('CIA','Roma Ciampino','Rome','IT','medium_airport'),
    ('MXP','Milano Malpensa','Milan','IT','large_airport'), ('LIN','Milano Linate','Milan','IT','medium_airport'), ('BGY','Bergamo Orio al Serio','Bergamo','IT','large_airport'),
    ('NAP','Napoli Capodichino','Naples','IT','large_airport'), ('VCE','Venezia Marco Polo','Venice','IT','large_airport'),
    ('BLQ','Bologna Guglielmo Marconi','Bologna','IT','large_airport'), ('TRN','Torino Caselle','Turin','IT','large_airport'),
    ('FLR','Firenze Peretola','Florence','IT','medium_airport'), ('PSA','Pisa Galileo Galilei','Pisa','IT','large_airport'),
    ('GOA','Genova Cristoforo Colombo','Genoa','IT','medium_airport'), ('BRI','Bari Karol Wojtyla','Bari','IT','large_airport'),
    ('CTA','Catania Fontanarossa','Catania','IT','large_airport'), ('PMO','Palermo Falcone Borsellino','Palermo','IT','large_airport'),
    ('CAG','Cagliari Elmas','Cagliari','IT','large_airport'), ('OLB','Olbia Costa Smeralda','Olbia','IT','large_airport'),
    ('VRN','Verona Villafranca','Verona','IT','large_airport'), ('TSF','Treviso Canova','Treviso','IT','medium_airport'),
    ('LHR','London Heathrow','London','GB','large_airport'), ('LGW','London Gatwick','London','GB','large_airport'), ('STN','London Stansted','London','GB','large_airport'),
    ('CDG','Paris Charles de Gaulle','Paris','FR','large_airport'), ('ORY','Paris Orly','Paris','FR','large_airport'),
    ('MAD','Madrid Barajas','Madrid','ES','large_airport'), ('BCN','Barcelona El Prat','Barcelona','ES','large_airport'),
    ('AMS','Amsterdam Schiphol','Amsterdam','NL','large_airport'), ('FRA','Frankfurt','Frankfurt','DE','large_airport'),
    ('MUC','Munich','Munich','DE','large_airport'), ('VIE','Vienna','Vienna','AT','large_airport'),
    ('ZRH','Zurich','Zurich','CH','large_airport'), ('BRU','Brussels','Brussels','BE','large_airport'),
    ('LIS','Lisbon','Lisbon','PT','large_airport'), ('ATH','Athens','Athens','GR','large_airport'),
    ('DUB','Dublin','Dublin','IE','large_airport'), ('IST','Istanbul','Istanbul','TR','large_airport'),
]

def _static_airport_rows():
    return [{'iata':i,'name':n,'city':c,'country':co,'keywords':'','type':t,'lat':None,'lon':None} for i,n,c,co,t in STATIC_AIRPORTS]


AIRPORT_METRO_ALIASES = {
    'milan':['milan','milano','bergamo'],'milano':['milan','milano','bergamo'],
    'rome':['rome','roma'],'roma':['rome','roma'],'london':['london','londra'],
    'londra':['london','londra'],'paris':['paris','parigi'],'parigi':['paris','parigi'],
    'berlin':['berlin','berlino'],'berlino':['berlin','berlino'],'brussels':['brussels','bruxelles'],
    'bruxelles':['brussels','bruxelles'],'vienna':['vienna','wien'],'wien':['vienna','wien'],
    'milan':['milan','milano','bergamo','malpensa','linate'],'milano':['milan','milano','bergamo','malpensa','linate'],
    'rome':['rome','roma','fiumicino','ciampino'],'roma':['rome','roma','fiumicino','ciampino'],
    'naples':['naples','napoli','capodichino'],'napoli':['naples','napoli','capodichino']
}

def _airport_download_index():
    """Download the current OurAirports CSV and build a compact flight-search index.
    We keep only airports with IATA codes and scheduled airline service, which is
    the useful subset for passenger flight searches. The source is public-domain
    OurAirports data and is regenerated daily.
    """
    RUNTIME_DIR.mkdir(exist_ok=True)
    req=Request(AIRPORT_SOURCE_URL,headers={'Accept':'text/csv,*/*','User-Agent':'TravelWorkPlanner/26 airport index'},method='GET')
    with urlopen(req,timeout=120) as r:
        raw=r.read()
    reader=csv.DictReader(io.StringIO(raw.decode('utf-8-sig',errors='replace')))
    rows=[]; seen=set()
    for row in reader:
        if str(row.get('scheduled_service') or '').strip().lower()!='yes':
            continue
        if str(row.get('type') or '').strip() not in ('large_airport','medium_airport','small_airport'):
            continue
        iata=str(row.get('iata_code') or '').strip().upper()
        iata={'MPX':'MXP'}.get(iata,iata)
        if not re.fullmatch(r'[A-Z]{3}',iata) or iata in seen:
            continue
        seen.add(iata)
        rows.append({
            'iata':iata,
            'name':str(row.get('name') or '').strip(),
            'city':str(row.get('municipality') or '').strip(),
            'country':str(row.get('iso_country') or '').strip().upper(),
            'keywords':str(row.get('keywords') or '').strip(),
            'type':str(row.get('type') or '').strip(),
            'lat':row.get('latitude_deg'),
            'lon':row.get('longitude_deg')
        })
    tmp=AIRPORT_INDEX_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps({'source':'OurAirports','index_version':AIRPORT_INDEX_VERSION,
        'downloaded':datetime.utcnow().isoformat()+'Z','count':len(rows),'airports':rows},
        ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    tmp.replace(AIRPORT_INDEX_FILE)
    print(f'Airport catalog updated: {len(rows)} airports')
    return rows

_AIRPORT_UPDATE_LOCK=threading.Lock()
_AIRPORT_UPDATE_RUNNING=False

def _airport_catalog_rows_from_disk():
    try:
        if AIRPORT_INDEX_FILE.exists() and AIRPORT_INDEX_FILE.stat().st_size>1000:
            data=json.loads(AIRPORT_INDEX_FILE.read_text(encoding='utf-8'))
            if isinstance(data,dict) and isinstance(data.get('airports'),list):
                return data.get('airports'), data
    except Exception as e:
        print('Airport index read failed:',e)
    return None, None

def _airport_update_worker():
    global _AIRPORT_UPDATE_RUNNING
    if _AIRPORT_UPDATE_RUNNING:
        return
    with _AIRPORT_UPDATE_LOCK:
        if _AIRPORT_UPDATE_RUNNING:
            return
        _AIRPORT_UPDATE_RUNNING=True
    try:
        _airport_download_index()
    except Exception as e:
        print('Airport catalog background update failed:',e)
    finally:
        _AIRPORT_UPDATE_RUNNING=False

def _schedule_airport_update(force=False):
    rows,meta=_airport_catalog_rows_from_disk()
    stale=True
    if rows and AIRPORT_INDEX_FILE.exists():
        try:
            stale=(time.time()-AIRPORT_INDEX_FILE.stat().st_mtime) > AIRPORT_INDEX_MAX_AGE
        except Exception:
            stale=True
    if force or not rows or stale or (isinstance(meta,dict) and meta.get('index_version')!=AIRPORT_INDEX_VERSION):
        threading.Thread(target=_airport_update_worker,daemon=True,name='airport-catalog-updater').start()

def _load_airport_index():
    rows,meta=_airport_catalog_rows_from_disk()
    # Never block the flight autocomplete on a remote download. Use the last
    # good catalog immediately and refresh it in the background when stale.
    if not isinstance(rows,list) or not rows:
        rows=_static_airport_rows()
        _schedule_airport_update(force=True)
        return rows
    if not isinstance(meta,dict) or meta.get('index_version')!=AIRPORT_INDEX_VERSION:
        _schedule_airport_update(force=True)
    else:
        _schedule_airport_update(force=False)
    by_code={str(r.get('iata') or '').upper():r for r in rows if isinstance(r,dict) and r.get('iata')}
    for r in _static_airport_rows():
        by_code.setdefault(r['iata'], r)
    return list(by_code.values())

def _airport_query_variants(q):
    base=_fold_search_text(q); variants={base}
    for key,vals in AIRPORT_CITY_ALIASES.items():
        k=_fold_search_text(key)
        if base==k or k.startswith(base):
            variants.add(k); variants.update(_fold_search_text(v) for v in vals)
    variants.update(_fold_search_text(v) for v in AIRPORT_METRO_ALIASES.get(base,[]))
    return {v for v in variants if v}

def _airport_score(variants,row):
    """Score city/name matches; broad keyword substrings are intentionally excluded."""
    city=_fold_search_text(row.get('city')); name=_fold_search_text(row.get('name'))
    best=0
    for v in variants:
        if not v: continue
        if city==v: best=max(best,145)
        elif city.startswith(v+' '): best=max(best,125)
        elif name==v: best=max(best,120)
        elif name.startswith(v+' '): best=max(best,105)
        elif v in city: best=max(best,95)
        elif v in name: best=max(best,80)
        else:
            ratio=difflib.SequenceMatcher(None,v,city).ratio()
            if ratio>=0.82: best=max(best,90*ratio)
    if row.get('type')=='large_airport': best+=18
    elif row.get('type')=='medium_airport': best+=8
    return best

def _airport_city_candidates(rows, qfold):
    aliases=set(AIRPORT_CITY_ALIASES.get(qfold, [])) | {qfold}
    metro=set(AIRPORT_METRO_ALIASES.get(qfold, []))
    return [r for r in rows if _fold_search_text(r.get('city')) in aliases or _fold_search_text(r.get('city')) in metro]

def airport_place_suggestions(query):
    q=str(query or '').strip()
    if len(q)<2:return {'ok':True,'places':[]}
    rows=_load_airport_index()
    if re.fullmatch(r'[A-Za-z]{3}',q):
        code=q.upper(); exact=[r for r in rows if r['iata']==code]
        if exact:
            out=[]
            for row in exact:
                out.append({'label':f"{row['iata']} — {row['name']} · {row['city']} · {row['country']}",'name':row['name'],'type':'airport','category':'aeroway','displayType':'✈️ Aeroporto','iata':row['iata'],'lat':as_float(row.get('lat')),'lon':as_float(row.get('lon')),'city':row.get('city',''),'country':row.get('country',''),'score':999})
            return {'ok':True,'places':out[:10]}
        return {'ok':True,'places':[{'label':f'{code} — Aeroporto (codice IATA)','type':'airport','category':'aeroway','iata':code,'lat':None,'lon':None,'name':f'{code} — Aeroporto','city':'','country':''}]}

    qfold=_fold_search_text(q)
    city_rows=_airport_city_candidates(rows,qfold)
    if city_rows:
        city_rows.sort(key=lambda r:(r.get('type')!='large_airport',r.get('type')!='medium_airport',r.get('iata','')))
        scored=[(150 if _fold_search_text(r.get('city'))==qfold else 135,r) for r in city_rows]
    else:
        variants=_airport_query_variants(q)
        scored=[]
        for row in rows:
            score=_airport_score(variants,row)
            if score>0: scored.append((score,row))
        for row in rows:
            kws=[_fold_search_text(x) for x in str(row.get('keywords') or '').split(',') if _fold_search_text(x)]
            if qfold in kws: scored.append((100,row))
    scored.sort(key=lambda z:(-z[0],z[1].get('type')!='large_airport',z[1].get('iata','')))
    out=[];seen=set()
    for score,row in scored:
        if row['iata'] in seen: continue
        seen.add(row['iata'])
        out.append({'label':f"{row['iata']} — {row['name']} · {row['city']} · {row['country']}",'name':row['name'],'type':'airport','category':'aeroway','displayType':'✈️ Aeroporto','iata':row['iata'],'lat':as_float(row.get('lat')),'lon':as_float(row.get('lon')),'city':row.get('city',''),'country':row.get('country',''),'score':round(score,2)})
        if len(out)>=10: break
    return {'ok':True,'places':out}

def car_place_suggestions(query):
    try:return airport_place_suggestions(query)
    except Exception as e:
        print('Airport index unavailable:',e)
        return {'ok':False,'error':f'Indice aeroporti non disponibile: {e}'}

def _car_preference_score(o, body):
    """Score preferences locally without discarding offers. OctoTrip's public tool schema
    currently accepts location/dates/times/age/currency/language, not transmission,
    mileage, seats, category or depot filters.
    """
    score=0
    cat=str(body.get('category') or '').lower(); trans=str(body.get('transmission') or '').lower()
    mileage=str(body.get('mileage') or '').lower(); seats=body.get('seats')
    if cat:
        c=(str(o.get('category') or '')+' '+str(o.get('sipp') or '')+' '+str(o.get('name') or '')).lower()
        cmap={'small':['economy','mini','small','a','b'],'medium':['compact','medium','c','d'],'large':['fullsize','large','standard','e','f'],'suvs':['suv'],'carriers':['van','mpv','monovolume','carriers'],'premium':['premium','luxury'],'estate':['estate','wagon','station']}
        if any(x in c for x in cmap.get(cat,[cat])): score += 30
    if trans:
        actual=str(o.get('transmission') or '').lower()
        if actual==trans: score += 40
    if mileage:
        m=str(o.get('mileage') or '').lower()
        unlimited=('unlimited' in m or 'illimit' in m)
        if (mileage=='unlimited' and unlimited) or (mileage=='limited' and not unlimited): score += 20
    if seats:
        try:
            if int(o.get('passengers') or 0)>=int(seats): score += 10
        except Exception: pass
    return score

def search_cars(body):
    try:
        pickup=body.get('pickup') or {}; dropoff=body.get('dropoff') or {}
        # OctoTrip accepts human-readable places, airports and landmarks directly.
        location=str(pickup.get('name') or pickup.get('label') or pickup.get('iata') or body.get('pickupLabel') or '').strip()
        drop_location=str(dropoff.get('name') or dropoff.get('label') or dropoff.get('iata') or body.get('dropoffLabel') or '').strip()
        if not location: raise ValueError('Località di ritiro non valida.')
        pdt=str(pickup.get('datetime') or ''); ddt=str(dropoff.get('datetime') or '')
        if 'T' not in pdt or 'T' not in ddt: raise ValueError('Data/ora di ritiro o riconsegna non valida.')
        args={'location':location,'pickup_date':pdt[:10],'dropoff_date':ddt[:10],
              'pickup_time':pdt[11:16],'dropoff_time':ddt[11:16],
              'currency':str(body.get('currency') or 'EUR').upper(),'language':'it',
              'age':max(18,min(99,int(body.get('driverAge') or 30)))}
        if drop_location and drop_location.lower()!=location.lower(): args['dropoff_location']=drop_location
        raw=_octotrip_search(args)
        if isinstance(raw,dict) and raw.get('error'):
            raise RuntimeError(json.dumps(raw['error'],ensure_ascii=False))
        arr=raw.get('results') if isinstance(raw,dict) else []
        offers=[]
        for x in arr if isinstance(arr,list) else []:
            if not isinstance(x,dict): continue
            offers.append({'offerId':f"octotrip-{len(offers)+1}",'carId':x.get('sipp') or x.get('name'),'supplierId':x.get('vendor') or '',
                           'name':x.get('name') or 'Auto','category':x.get('category') or '', 'sipp':x.get('sipp') or '',
                           'price':x.get('price'),'pricePerDay':x.get('price_per_day'),'payNow':x.get('pay_now'),'payLater':x.get('pay_later'),
                           'currency':str(x.get('currency') or args['currency']).upper(),'transmission':x.get('transmission') or '',
                           'passengers':x.get('passengers'),'bags':x.get('bags'),'doors':x.get('doors'),'airCon':x.get('air_con'),
                           'extraCharges':[], 'pickupDepot':'','dropoffDepot':'','pickupDepotType':'','dropoffDepotType':'',
                           'policies':{'fuel':x.get('fuel_policy'),'mileage':{'type':x.get('mileage')},'deposit':x.get('deposit'),'damage_excess':x.get('excess'),
                                       'free_cancellation':x.get('free_cancellation'),'free_amendment':x.get('free_amendment'),'included_protections':x.get('included_protections') or []},
                           'imageUrl':x.get('image_url') or '', 'url':x.get('booking_url') or '', 'linkType':x.get('link_type') or 'affiliate', '_preferenceScore':_car_preference_score(x,body)} )
        offers.sort(key=lambda o:(-int(o.pop('_preferenceScore',0)), float(o.get('price')) if isinstance(o.get('price'),(int,float)) else 1e18))
        selected_prefs=bool(body.get('category') or body.get('transmission') or body.get('mileage') or body.get('seats') or body.get('depot'))
        exact_matches=0
        if selected_prefs:
            # Re-score the normalized offer using the same preference rules is not necessary;
            # count whether at least one offer visibly matches all requested fields.
            for o in offers:
                ok=True
                if body.get('transmission') and str(o.get('transmission') or '').lower()!=str(body.get('transmission')).lower(): ok=False
                if body.get('mileage'):
                    mm=str((o.get('policies') or {}).get('mileage',{}).get('type') or '').lower()
                    un=('unlimited' in mm or 'illimit' in mm)
                    if body.get('mileage')=='unlimited' and not un: ok=False
                    if body.get('mileage')=='limited' and un: ok=False
                if body.get('seats'):
                    try:
                        if int(o.get('passengers') or 0)<int(body.get('seats')): ok=False
                    except Exception: pass
                if ok: exact_matches+=1
        return {'ok':True,'source':'OctoTrip Rental Cars','count':len(offers),'preferenceMode':selected_prefs,'exactPreferenceMatches':exact_matches,'totalAvailable':raw.get('total_available') if isinstance(raw,dict) else None,
                'rentalDays':raw.get('rental_days') if isinstance(raw,dict) else None,'pickupResolved':raw.get('pickup_location_resolved') if isinstance(raw,dict) else location,
                'dropoffResolved':raw.get('dropoff_location_resolved') if isinstance(raw,dict) else drop_location or location,'offers':offers}
    except Exception as e:
        return {'ok':False,'error':'RICERCA_AUTONOLEGGIO_FALLITA','message':str(e)}



# ===== Mappa Travel Report =====
_MAP_GEOCODE_CACHE={}

def _map_geocode(query):
    q=str(query or '').strip()
    if not q:return None
    key=q.lower()
    if key in _MAP_GEOCODE_CACHE:return _MAP_GEOCODE_CACHE[key]
    try:
        req=Request(GEOCODER_URL+'?q='+quote(q)+'&format=jsonv2&limit=1',headers={'Accept':'application/json','User-Agent':'TravelWorkPlanner/25.0.56 (local desktop app)'},method='GET')
        with urlopen(req,timeout=12) as r: obj=json.loads(r.read().decode('utf-8'))
        if obj:
            hit={'lat':float(obj[0]['lat']),'lon':float(obj[0]['lon']),'display':obj[0].get('display_name','')}
            _MAP_GEOCODE_CACHE[key]=hit; return hit
    except Exception as e: print('Map geocode failed:',q,e)
    _MAP_GEOCODE_CACHE[key]=None; return None

def _resolve_travel_map_locations(locations):
    airports={}
    # Usa la cache locale se presente; non forza il download OurAirports durante la mappa.
    try:
        if AIRPORT_INDEX_FILE.exists() and AIRPORT_INDEX_FILE.stat().st_size>1000:
            ad=json.loads(AIRPORT_INDEX_FILE.read_text(encoding='utf-8'))
            for a in (ad.get('airports') if isinstance(ad,dict) else []) or []: airports[a.get('iata','')]=a
    except Exception as e: print('Map airport cache unavailable:',e)
    resolved=[]
    for item in locations[:30]:
        item=item if isinstance(item,dict) else {}
        kind=str(item.get('kind') or 'place'); label=str(item.get('label') or '').strip(); iata=str(item.get('iata') or '').upper()
        hit=None
        try:
            if item.get('lat') is not None and item.get('lon') is not None:
                hit={'lat':float(item['lat']),'lon':float(item['lon']),'display':label}
        except Exception: hit=None
        # Coordinate certe per i principali aeroporti usati nei report: evitano
        # che una cache locale assente/obsoleta mandi il codice IATA a un
        # geocoder generico e produca una posizione geografica errata.
        if not hit and iata:
            known_airports={
                'NAP':(40.884444,14.290833,'Naples International Airport','Viale F. Ruffo di Calabria, 80144 Napoli NA, Italy'),
                'BER':(52.361738,13.502341,'Berlin Brandenburg Airport','Willy-Brandt-Platz 1, 12529 Schönefeld, Germany'),
                'FCO':(41.80028,12.23889,'Rome Fiumicino Airport'),
                'MXP':(45.63061,8.72811,'Milan Malpensa Airport'),
                'LIN':(45.44510,9.27674,'Milan Linate Airport'),
                'LHR':(51.47002,-0.45430,'London Heathrow Airport'),
                'CDG':(49.00972,2.54778,'Paris Charles de Gaulle Airport'),
                'AMS':(52.30861,4.76389,'Amsterdam Airport Schiphol'),
                'FRA':(50.03780,8.55580,'Frankfurt Airport'),
                'VIE':(48.11028,16.56972,'Vienna International Airport'),
                'BRU':(50.90139,4.48444,'Brussels Airport'),
                'MAD':(40.47222,-3.56083,'Adolfo Suarez Madrid-Barajas Airport'),
                'BCN':(41.29708,2.07846,'Barcelona El Prat Airport')
            }
            if iata in known_airports:
                vals=known_airports[iata]
                la,lo,name=vals[:3]
                address=vals[3] if len(vals)>3 else ''
                hit={'lat':la,'lon':lo,'display':name,'address':address}
        if not hit and iata and iata in airports:
            arow=airports[iata]
            try: hit={'lat':float(arow['lat']),'lon':float(arow['lon']),'display':arow.get('name','')}
            except Exception: pass
        # Se la cache OurAirports non è presente, non geocodificare il solo codice
        # IATA (es. BER può essere interpretato in modo errato): chiediamo esplicitamente
        # all'aeroporto, così Nominatim restituisce il terminal corretto.
        if not hit and iata:
            hit=_map_geocode(f'{iata} airport')
        if not hit: hit=_map_geocode(item.get('query') or label)
        if hit: resolved.append({'kind':kind,'label':label,'lat':hit['lat'],'lon':hit['lon'],'iata':iata,'display':hit.get('display',''),'address':hit.get('address','')})
    seen=set();out=[]
    for x in resolved:
        k=(round(x['lat'],5),round(x['lon'],5),x['label'].lower())
        if k not in seen:seen.add(k);out.append(x)
    return out

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args))

    def do_POST(self):
        p = unquote(urlparse(self.path).path)
        try:
            n = int(self.headers.get('Content-Length', '0'))
            body = json.loads(self.rfile.read(n).decode('utf-8') or '{}') if n else {}
            if p == '/api/place-suggestions':
                return json_out(self, 200, place_suggestions(body.get('query', '')))
            if p == '/api/apify-status':
                return json_out(self, 200, apify_token_diagnostic())
            if p == '/api/search-flights':
                return json_out(self, 200, search_flights(body))
            if p == '/api/train-place-suggestions':
                return json_out(self, 200, train_place_suggestions(body.get('query', '')))
            if p == '/api/search-trains':
                return json_out(self, 200, search_trains(body))
            if p == '/api/hotel-place-suggestions':
                return json_out(self, 200, hotel_place_suggestions(body.get('query', '')))
            if p == '/api/search-hotels':
                return json_out(self, 200, search_hotels(body))
            if p == '/api/car-place-suggestions':
                return json_out(self, 200, car_place_suggestions(body.get('query', '')))
            if p == '/api/search-cars':
                return json_out(self, 200, search_cars(body))
            if p == '/api/travel-map':
                locations=body.get('locations') if isinstance(body,dict) else []
                if not isinstance(locations,list): locations=[]
                resolved=_resolve_travel_map_locations(locations)
                if not resolved: return json_out(self, 200, {'ok':False,'error':'Nessuna località geocodificabile.'})
                return json_out(self, 200, {'ok':True,'locations':resolved})
            if p == '/api/planner-data':
                payload = body.get('data') if isinstance(body, dict) and 'data' in body else body
                if not isinstance(payload, dict):
                    return json_out(self, 400, {'error': 'Dati Planner non validi.'})
                # Il file persistente USB contiene i dati del Planner e il manifest
                # dei PDF materializzati, così CARICA può ricostruire anche gli allegati
                # dopo la chiusura del browser/computer.
                attachments = body.get('attachments', []) if isinstance(body, dict) else []
                usb_payload = dict(payload)
                usb_payload['_usbAttachments'] = []
                raw=json.dumps(payload, ensure_ascii=False)
                tmp = PLANNER_DATA_FILE.with_suffix('.tmp')
                tmp.write_text(raw, encoding='utf-8'); tmp.replace(PLANNER_DATA_FILE)
                # File portabile esplicito: viene sovrascritto ad ogni SALVA.
                # Il manifest viene completato sotto, dopo aver scritto fisicamente i PDF.
                # Gli allegati vengono materializzati fisicamente sulla USB.
                attach_dir = DATA_DIR / 'attachments'
                attach_dir.mkdir(parents=True, exist_ok=True)
                wanted=set()
                for item in attachments if isinstance(attachments,list) else []:
                    if not isinstance(item,dict) or not item.get('base64') or not item.get('name'): continue
                    import base64, re
                    safe=re.sub(r'[^A-Za-z0-9._ -]+','_',str(item.get('name'))).strip() or 'allegato.pdf'
                    # Il nome fisico resta unico ma leggibile; il manifest nel JSON conserva il legame.
                    stem=Path(safe).stem; ext=Path(safe).suffix or '.pdf'
                    fid=re.sub(r'[^A-Za-z0-9_-]+','_',str(item.get('id') or 'file'))
                    physical=f'{fid}__{stem}{ext}'
                    out=attach_dir / physical
                    try: out.write_bytes(base64.b64decode(item['base64']))
                    except Exception: continue
                    item['usbFile']=str(out.relative_to(ROOT)).replace('\\','/')
                    wanted.add(physical)
                for old in attach_dir.iterdir():
                    if old.is_file() and old.name not in wanted:
                        try: old.unlink()
                        except Exception: pass
                # Nel file JSON conserviamo solo il manifest (non i base64), così resta leggero.
                manifest=[]
                for item in attachments if isinstance(attachments,list) else []:
                    if isinstance(item,dict) and item.get('usbFile'):
                        manifest.append({k:item.get(k) for k in ['id','section','row','rowId','name','size','mimeType','usbFile']})
                payload['_usbAttachments']=manifest
                # Riscrivi entrambi i JSON con il manifest aggiornato.
                raw=json.dumps(payload, ensure_ascii=False)
                tmp = PLANNER_DATA_FILE.with_suffix('.tmp'); tmp.write_text(raw, encoding='utf-8'); tmp.replace(PLANNER_DATA_FILE)
                tmp2 = USB_SAVE_FILE.with_suffix('.tmp'); tmp2.write_text(raw, encoding='utf-8'); tmp2.replace(USB_SAVE_FILE)
                return json_out(self, 200, {'ok': True, 'file': str(USB_SAVE_FILE.relative_to(ROOT)).replace('\\','/'), 'attachments':len(attachments) if isinstance(attachments,list) else 0})
            if p == '/api/planner-data/clear':
                try: PLANNER_DATA_FILE.unlink()
                except FileNotFoundError: pass
                try: USB_SAVE_FILE.unlink()
                except FileNotFoundError: pass
                return json_out(self, 200, {'ok': True})
            if p == '/api/shutdown':
                json_out(self, 200, {'ok': True})
                raise KeyboardInterrupt
            return json_out(self, 404, {'error': 'Endpoint non trovato.'})
        except KeyboardInterrupt:
            raise
        except Exception as e:
            status = int(getattr(e, 'http_status', 500) or 500)
            if status < 400 or status > 599: status = 500
            return json_out(self, status, {'error': str(e)})

    def do_GET(self):
        route = unquote(urlparse(self.path).path)
        if route == '/api/apify-status':
            try:
                return json_out(self, 200, apify_validate_token())
            except Exception as e:
                status=int(getattr(e,'http_status',500) or 500)
                return json_out(self, status, {'ok':False,'error':str(e)})
        if route == '/api/airport-catalog':
            rows,meta=_airport_catalog_rows_from_disk()
            if not isinstance(rows,list) or not rows:
                rows=_static_airport_rows()
                ready=False
            else:
                ready=True
            _schedule_airport_update(force=not ready)
            payload={'ok':True,'ready':ready,'source':'OurAirports','indexVersion':(meta or {}).get('index_version',AIRPORT_INDEX_VERSION),
                     'downloaded':(meta or {}).get('downloaded'),'count':len(rows),'airports':rows}
            return json_out(self, 200, payload)
        if route == '/api/planner-data':
            # La fonte persistente per la ripresa tra sessioni è il file esplicito sulla USB.
            source = USB_SAVE_FILE if USB_SAVE_FILE.exists() else PLANNER_DATA_FILE
            if not source.exists():
                return json_out(self, 200, {'ok': True, 'data': None, 'attachments': []})
            try:
                obj = json.loads(source.read_text(encoding='utf-8'))
                attachments=[]
                if isinstance(obj,dict):
                    raw_att=obj.get('_usbAttachments') or []
                    # Compatibilità: nel JSON precedente il manifest è al livello del payload.
                    raw_att=raw_att if isinstance(raw_att,list) else []
                    for item in raw_att:
                        if not isinstance(item,dict): continue
                        physical=item.get('usbFile')
                        if physical and (ROOT/physical).exists():
                            try:
                                import base64
                                b=base64.b64encode((ROOT/physical).read_bytes()).decode('ascii')
                                attachments.append({k:item.get(k) for k in ['id','section','row','rowId','name','size','mimeType']} | {'base64':b})
                            except Exception: pass
                return json_out(self, 200, {'ok': True, 'data': obj, 'attachments': attachments})
            except Exception as e:
                return json_out(self, 500, {'error': 'Archivio Planner non leggibile: ' + str(e)})
        p = route.lstrip('/') or 'Home.html'
        path = (ROOT / p).resolve()
        try:
            path.relative_to(ROOT)
        except ValueError:
            self.send_error(403); return
        if not path.exists() or not path.is_file():
            self.send_error(404); return
        data = path.read_bytes()
        ext = path.suffix.lower()
        ctype = {'html':'text/html; charset=utf-8','js':'application/javascript; charset=utf-8','css':'text/css; charset=utf-8'}.get(ext.lstrip('.'),'application/octet-stream')
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    if '--validate-apify' in os.sys.argv:
        try:
            result = apify_validate_token()
            print('APIFY_OK')
            if result.get('username'):
                print('ACCOUNT=' + result['username'])
            raise SystemExit(0)
        except Exception as e:
            print('APIFY_ERROR=' + str(e))
            raise SystemExit(2)
    _schedule_airport_update(force=False)
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Travel Work Planner V22.7 USB Portable in ascolto su http://127.0.0.1:{PORT}/')
    print('Token Apify:', 'CONFIGURATO' if APIFY_TOKEN else 'NON CONFIGURATO')
    print('Hotelbeds:', 'CONFIGURATO' if HOTELBEDS_API_KEY and HOTELBEDS_API_SECRET and HOTELBEDS_CERT and HOTELBEDS_KEY_FILE else 'NON CONFIGURATO')
    print('Train API:', TRAIN_BASE)
    try:
        webbrowser.open(f'http://127.0.0.1:{PORT}/Home.html')
        server.serve_forever()
    except KeyboardInterrupt:
        pass
