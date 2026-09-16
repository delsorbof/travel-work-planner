/* Travel Work Planner V26.1 — autenticazione utenti e API cloud */
(()=>{
  const TOKEN_KEY='twp_auth_token_v26';
  const page=(location.pathname.split('/').pop()||'Home.html').toLowerCase();
  const isLogin=page==='login.html';
  const originalFetch=window.fetch.bind(window);

  // La sessione vera vive in sessionStorage: un refresh la mantiene,
  // mentre la chiusura della sessione/finestra del browser la perde.
  // Compatibilità: Login.html della versione precedente scrive ancora il token
  // in localStorage dopo un login riuscito. Alla prima pagina protetta lo
  // trasferiamo subito in sessionStorage e cancelliamo il residuo persistente.
  if(!isLogin){
    try{
      const legacy=localStorage.getItem(TOKEN_KEY);
      if(!sessionStorage.getItem(TOKEN_KEY) && legacy) sessionStorage.setItem(TOKEN_KEY,legacy);
      localStorage.removeItem(TOKEN_KEY);
    }catch(e){}
  }else{
    // Non lasciare vecchi token persistenti che potrebbero saltare il login.
    try{ localStorage.removeItem(TOKEN_KEY); }catch(e){}
  }

  window.twpAuthToken=()=>sessionStorage.getItem(TOKEN_KEY)||'';
  window.twpSetAuth=(token)=>{
    try{
      if(token) sessionStorage.setItem(TOKEN_KEY,token);
      else sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
    }catch(e){}
  };
  window.twpLogout=()=>{
    try{sessionStorage.removeItem(TOKEN_KEY);localStorage.removeItem(TOKEN_KEY);}catch(e){}
    location.href='Login.html';
  };

  window.fetch=async function(input,init={}){
    const opts={...init,headers:new Headers(init.headers||{})};
    const token=sessionStorage.getItem(TOKEN_KEY);
    if(token) opts.headers.set('Authorization','Bearer '+token);
    const res=await originalFetch(input,opts);
    if(res.status===401 && !isLogin){
      try{sessionStorage.removeItem(TOKEN_KEY);localStorage.removeItem(TOKEN_KEY);}catch(e){}
      location.href='Login.html';
    }
    return res;
  };

  if(isLogin)return;

  const guard=async()=>{
    const token=sessionStorage.getItem(TOKEN_KEY);
    if(!token){location.replace('Login.html');return;}
    try{
      const r=await originalFetch('/api/auth/me',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
      if(!r.ok){
        sessionStorage.removeItem(TOKEN_KEY);
        location.replace('Login.html');
        return;
      }
      const d=await r.json();
      document.documentElement.dataset.twpUser=d.username||'';
      const addUserControls=()=>{
        if(document.getElementById('twpUserBadge'))return;
        const wrap=document.createElement('div'); wrap.id='twpUserBadge';
        wrap.style.cssText='position:fixed;right:14px;top:14px;z-index:99999;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #d7e2ec;border-radius:12px;padding:7px 9px 7px 11px;box-shadow:0 5px 18px #0002;font:700 13px Segoe UI,Arial,sans-serif;color:#17324c';
        const label=document.createElement('span'); label.textContent='👤 '+(d.username||'');
        const b=document.createElement('button'); b.id='twpLogoutBtn'; b.type='button'; b.textContent='Esci';
        b.style.cssText='border:0;border-radius:8px;padding:6px 9px;background:#17324c;color:#fff;font-weight:700;cursor:pointer';
        b.title='Disconnetti utente'; b.onclick=window.twpLogout; wrap.append(label,b); document.body.appendChild(wrap);
      };
      if(document.body)addUserControls();else window.addEventListener('DOMContentLoaded',addUserControls,{once:true});
    }catch(e){
      sessionStorage.removeItem(TOKEN_KEY);
      location.replace('Login.html');
    }
  };
  guard();
})();
