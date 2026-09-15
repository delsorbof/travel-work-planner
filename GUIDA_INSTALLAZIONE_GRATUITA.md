# Travel Work Planner V26 Web — installazione gratuita

Questa cartella è la versione web preparata a partire dalla V25. La V25 Windows resta intatta nel tuo ZIP originale.

## Cosa è già pronto
- Backend Python/FastAPI per Render.
- Tutte le pagine HTML/JavaScript originali.
- API voli, treni, hotel, autonoleggio e mappa.
- Salvataggio Planner e PDF su Supabase Storage.
- PWA installabile su smartphone/tablet.
- Password unica per proteggere il tuo Planner.
- Nessun database locale del server: il cloud usa Supabase.

## Servizi gratuiti
- Render Free per il backend/web app.
- Supabase Free per database e allegati.
- Apify Free per le ricerche che usano l'Actor già presente nel progetto (entro i crediti gratuiti).
- Hotelbeds Evaluation per le ricerche hotel in ambiente di test (quota giornaliera limitata).

## 1 — Crea Supabase
1. Crea un progetto gratuito su Supabase.
2. Apri **SQL Editor**.
3. Incolla tutto `supabase_setup.sql` ed eseguilo.
4. In **Project Settings → API** copia `Project URL` e la **service_role key**.

La service_role key deve rimanere SOLO nelle variabili segrete di Render. Non inserirla in HTML/JS/GitHub.

## 2 — Pubblica su Render
1. Crea un repository GitHub privato e carica questa cartella.
2. In Render scegli **New → Web Service** e collega il repository.
3. Puoi usare il `render.yaml` come configurazione.
4. Piano: **Free**.
5. Inserisci nelle Environment Variables:
   - `SUPABASE_URL` = URL Supabase
   - `SUPABASE_SERVICE_ROLE_KEY` = service_role key
   - `TWP_ACCESS_PASSWORD` = una password scelta da te
   - `APIFY_API_TOKEN` = il token Apify già usato dalla V25
   - `HOTELBEDS_API_KEY` e `HOTELBEDS_API_SECRET` se vuoi gli hotel
   - `HOTELBEDS_CERT_PEM` e `HOTELBEDS_KEY_PEM` se il tuo accesso Hotelbeds richiede mTLS
   - `HOTELBEDS_KEY_PASSWORD` se la chiave è protetta da password
6. Deploy. Render fornirà un indirizzo `onrender.com`.

## 3 — Uso da telefono/tablet
Apri l'indirizzo Render. Alla prima chiamata API verrà chiesta la password. Poi puoi usare il browser normalmente.
Su iPhone/iPad: **Condividi → Aggiungi alla schermata Home**.
Su Android: **Installa app/Aggiungi alla schermata Home** quando il browser lo propone.

## Importante sui costi
La struttura è stata preparata per restare entro i piani gratuiti. Render Free può andare in sospensione dopo inattività e Supabase Free può mettere in pausa un progetto inattivo; la prima apertura successiva può quindi richiedere qualche secondo. Apify e Hotelbeds hanno a loro volta quote gratuite, quindi le ricerche non sono illimitate.

## Dati e privacy
Il database contiene un singolo archivio Planner protetto dalla password dell'app. Se in futuro vuoi più utenti separati, la V27 può introdurre account personali Supabase Auth senza riscrivere il motore di ricerca.
