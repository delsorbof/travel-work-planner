/* Travel Work Planner V26.1 — autenticazione utenti e API cloud */
(()=>{
  const TOKEN_KEY='twp_auth_token_v26';
  const page=(location.pathname.split('/').pop()||'Home.html').toLowerCase();
  const isLogin=page==='login.html';
  const originalFetch=window.fetch.bind(window);
  window.twpAuthToken=()=>localStorage.getItem(TOKEN_KEY)||'';
  window.twpSetAuth=(token)=>{if(token)localStorage.setItem(TOKEN_KEY,token);else localStorage.removeItem(TOKEN_KEY)};
  window.twpLogout=()=>{localStorage.removeItem(TOKEN_KEY);location.href='Login.html'};
  window.fetch=async function(input,init={}){
    const opts={...init,headers:new Headers(init.headers||{})};
    const token=localStorage.getItem(TOKEN_KEY);
    if(token) opts.headers.set('Authorization','Bearer '+token);
    const res=await originalFetch(input,opts);
    if(res.status===401 && !isLogin){localStorage.removeItem(TOKEN_KEY);location.href='Login.html';}
    return res;
  };
  if(isLogin)return;
  const guard=async()=>{
    const token=localStorage.getItem(TOKEN_KEY);
    if(!token){location.replace('Login.html');return;}
    try{
      const r=await originalFetch('/api/auth/me',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
      if(!r.ok){localStorage.removeItem(TOKEN_KEY);location.replace('Login.html');return;}
      const d=await r.json();
      document.documentElement.dataset.twpUser=d.username||'';
      const addLogout=()=>{
        if(document.getElementById('twpLogoutBtn'))return;
        const b=document.createElement('button');b.id='twpLogoutBtn';b.type='button';b.textContent='Esci';
        b.style.cssText='position:fixed;right:14px;bottom:14px;z-index:99999;border:0;border-radius:10px;padding:9px 13px;background:#17324c;color:#fff;font-weight:700;box-shadow:0 5px 18px #0002;cursor:pointer';
        b.title='Disconnetti utente';b.onclick=window.twpLogout;document.body.appendChild(b);
      };
      if(document.body)addLogout();else window.addEventListener('DOMContentLoaded',addLogout,{once:true});
    }catch(e){localStorage.removeItem(TOKEN_KEY);location.replace('Login.html');}
  };
  guard();
})();
