(function(){
  const KEY='twp_v26_access_password';
  const original=window.fetch.bind(window);
  function isApi(input){ const u=typeof input==='string'?input:(input&&input.url)||''; return String(u).startsWith('/api/'); }
  async function request(input, init, retry){
    init=init||{}; const headers=new Headers(init.headers||((input&&input.headers)||{}));
    const pass=localStorage.getItem(KEY); if(pass && isApi(input)) headers.set('X-TWP-Access',pass);
    init.headers=headers;
    const r=await original(input,init);
    if(r.status===401 && isApi(input) && !retry){
      localStorage.removeItem(KEY);
      const p=prompt('Travel Work Planner: inserisci la password di accesso.');
      if(p){ localStorage.setItem(KEY,p); return request(input,init,true); }
    }
    return r;
  }
  window.fetch=function(input,init){ return request(input,init,false); };
})();
