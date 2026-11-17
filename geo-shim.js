/* geo-shim.js — hace que la «Carga de Novedades GeoVictoria» (carga-geo.html) funcione DENTRO del Radar.
   La carga Geo se escribió para claude.ai (usa su base compartida `db`, `user` y `downloads`). Acá se reemplazan esas tres
   capacidades por lo del Radar, sin tocar el código de la carga Geo:
     · db        -> tabla `geo_docs` de Supabase (ruta del documento -> JSON). Mismas rutas que usa la carga Geo
                    (cfg/main, req/<uid>, days/<fecha>, days/<fecha>/emps/<UN>, days/<fecha>/nov/<UN>, shared/art, shared/mail).
     · user      -> el usuario con sesión iniciada en el Radar (id, mail, y es «dueño» si su perfil es Administrador).
     · downloads -> descarga normal del navegador.
   Lo que el Radar le pasa a esta página está en window.parent.__RADAR = {supabase, userId, email, rol, theme}.
   Abierta suelta (sin el Radar) la carga Geo queda en modo local, como siempre.
   Parámetro de la página: ?v=pres  ->  solo el «Cuadro de Presentismo» (sin carga de archivos ni pestañas). Sin parámetro: la herramienta completa. */
(function(){
  "use strict";
  var P = null, R = null;
  try{ P = (window.parent && window.parent !== window) ? window.parent : null; R = P && P.__RADAR ? P.__RADAR : null; }catch(e){ R = null; }
  var TABLE = "geo_docs";
  var POLL_MS = 5000;

  /* ---------- aspecto: modo claro/oscuro del Radar, y qué se oculta ---------- */
  var params = new URLSearchParams(location.search);
  var view = params.get("v") || "";
  var root = document.documentElement;
  if(view) root.setAttribute("data-embed", view);
  function setTheme(t){
    if(t === "light" || t === "dark"){ root.setAttribute("data-theme", t); }
    else root.removeAttribute("data-theme");
  }
  if(R && R.theme){ try{ localStorage.setItem("cn.theme", JSON.stringify(R.theme)); }catch(e){} setTheme(R.theme); }
  window.addEventListener("message", function(ev){
    if(ev.origin !== location.origin || !ev.data) return;
    if(ev.data.type === "radar-theme") setTheme(ev.data.theme);
  });
  var st = document.createElement("style");
  st.textContent =
    ".theme{display:none!important}" +                       // el modo claro/oscuro lo maneja el Radar
    "#tabHist{display:none!important}" +                     // el historial no se usa en el Radar
    "html[data-embed=pres] .loads,html[data-embed=pres] .tabs{display:none!important}" +
    "html[data-embed=pres] .wrap{padding-top:8px}";
  (document.head || root).appendChild(st);
  document.addEventListener("DOMContentLoaded", function(){
    if(view === "pres"){
      var h = document.querySelector(".top h1"); if(h) h.textContent = "Cuadro de Presentismo diario";
      var p = document.querySelector(".top p"); if(p) p.textContent = "Cuadro del día (o de los días guardados) con la clasificación de permisos de Carga Geo.";
      var t = document.querySelector('.tab[data-view="pres"]'); if(t) t.click();
    }
  });

  if(!R || !R.supabase){ /* sin Radar: la carga Geo sigue en modo local */ return; }
  var sb = R.supabase;

  /* ---------- utilidades ---------- */
  var clean = function(o){ return JSON.parse(JSON.stringify(o == null ? {} : o)); };
  var norm = function(p){ return String(p).replace(/^\/+|\/+$/g, ""); };
  function split(p){ var i = p.lastIndexOf("/"); return i < 0 ? {parent:"", id:p} : {parent:p.slice(0, i), id:p.slice(i + 1)}; }
  function err(e){
    var code = (e && e.code) || "";
    var msg = (e && e.message) || String(e || "");
    var c = code === "42501" || /row-level security|permission denied/i.test(msg) ? "not_granted" : (code || "error");
    return {code:c, message:msg};
  }
  // aviso al Radar: cambió algo de un día (la base de Crónicos se puede actualizar con eso)
  var notifyT = null, notifyDays = {};
  function notify(path){
    var m = /^days\/([^/]+)\/(emps|nov)\//.exec(path); if(!m || !P) return;
    notifyDays[m[1]] = true; clearTimeout(notifyT);
    notifyT = setTimeout(function(){ var days = Object.keys(notifyDays); notifyDays = {}; try{ P.postMessage({type:"geo-changed", days:days}, location.origin); }catch(e){} }, 1200);
  }

  /* ---------- «tiempo real» por consulta periódica ---------- */
  var listeners = new Set(), pollTimer = null, nowT = null;
  function ensurePolling(){
    if(pollTimer) return;
    pollTimer = setInterval(function(){ if(document.hidden) return; listeners.forEach(function(l){ l.poll(); }); }, POLL_MS);
  }
  function pollSoon(){ clearTimeout(nowT); nowT = setTimeout(function(){ listeners.forEach(function(l){ l.poll(true); }); }, 250); }
  document.addEventListener("visibilitychange", function(){ if(!document.hidden) listeners.forEach(function(l){ l.poll(); }); });
  function addListener(l){ listeners.add(l); ensurePolling(); l.poll(true); return function(){ listeners.delete(l); }; }

  /* ---------- documentos y colecciones ---------- */
  function snapDoc(path, row){
    var d = row ? row.data : null;
    return {id: split(path).id, exists: !!row, data: function(){ return clean(d); }};
  }
  function DocRef(path){
    path = norm(path);
    var sp = split(path);
    return {
      id: sp.id, path: path,
      get: async function(){
        var r = await sb.from(TABLE).select("data").eq("path", path).maybeSingle();
        if(r.error) throw err(r.error);
        return snapDoc(path, r.data);
      },
      set: async function(data){
        var r = await sb.from(TABLE).upsert({path:path, parent:sp.parent, doc_id:sp.id, data:clean(data)});
        if(r.error) throw err(r.error);
        notify(path); pollSoon();
      },
      // fusiona campos sueltos (de forma atómica en el servidor). Si el documento no existe: error invalid_argument (la carga Geo lo resuelve con set)
      update: async function(data){
        var r = await sb.rpc("geo_merge", {p_path:path, p_patch:clean(data)});
        if(r.error) throw err(r.error);
        if(!r.data){ var e = new Error("el documento no existe"); e.code = "invalid_argument"; throw e; }
        notify(path); pollSoon();
      },
      delete: async function(){
        var r = await sb.from(TABLE).delete().eq("path", path);
        if(r.error) throw err(r.error);
        notify(path); pollSoon();
      },
      collection: function(sub){ return CollRef(path + "/" + norm(sub)); },
      onSnapshot: function(cb, ecb){
        var last = null, busy = false;
        return addListener({poll: async function(force){
          if(busy) return; busy = true;
          try{
            var m = await sb.from(TABLE).select("updated_at").eq("path", path).maybeSingle();
            if(m.error) throw m.error;
            var sig = m.data ? m.data.updated_at : "none";
            if(sig === last && last !== null) return;
            var r = await sb.from(TABLE).select("data").eq("path", path).maybeSingle();
            if(r.error) throw r.error;
            last = sig; cb(snapDoc(path, r.data));
          }catch(e){ if(ecb) ecb(err(e)); }
          finally{ busy = false; }
        }});
      }
    };
  }
  function CollRef(path, q){
    path = norm(path);
    q = q || {};
    function again(extra){ return CollRef(path, Object.assign({}, q, extra)); }
    function shape(rows){
      var docs = rows.map(function(r){ var d = r.data; return {id:r.doc_id, exists:true, data:function(){ return clean(d); }}; });
      if(q.order){
        var f = q.order, dir = q.dir === "desc" ? -1 : 1;
        docs.sort(function(a, b){ var x = a.data()[f], y = b.data()[f]; return x === y ? 0 : (x == null ? -1 : y == null ? 1 : (x < y ? -dir : dir)); });
      }
      if(q.lim) docs = docs.slice(0, q.lim);
      return {docs:docs, size:docs.length, empty:!docs.length};
    }
    async function fetchRows(){
      var out = [], from = 0;
      while(true){
        var r = await sb.from(TABLE).select("doc_id,data").eq("parent", path).order("doc_id").range(from, from + 999);
        if(r.error) throw err(r.error);
        out = out.concat(r.data || []);
        if(!r.data || r.data.length < 1000) break;
        from += 1000;
      }
      return out;
    }
    return {
      path: path,
      doc: function(id){ return DocRef(path + "/" + norm(id)); },
      orderBy: function(f, dir){ return again({order:f, dir:dir || "asc"}); },
      limit: function(n){ return again({lim:n}); },
      get: async function(){ return shape(await fetchRows()); },
      add: async function(data){
        var id = "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        await DocRef(path + "/" + id).set(data);
        return DocRef(path + "/" + id);
      },
      onSnapshot: function(cb, ecb){
        var last = null, busy = false;
        return addListener({poll: async function(force){
          if(busy) return; busy = true;
          try{
            var m = await sb.from(TABLE).select("doc_id,updated_at").eq("parent", path).range(0, 999);
            if(m.error) throw m.error;
            var sig = (m.data || []).map(function(x){ return x.doc_id + "@" + x.updated_at; }).sort().join("|");
            if(sig === last && last !== null) return;
            var rows = await fetchRows();
            last = sig; cb(shape(rows));
          }catch(e){ if(ecb) ecb(err(e)); }
          finally{ busy = false; }
        }});
      }
    };
  }
  var dbApi = {doc: DocRef, collection: CollRef};

  /* ---------- usuario ---------- */
  var me = {name: (R.email || "Usuario").split("@")[0], email: R.email || ""};
  var userApi = {
    id: async function(){ return R.userId; },
    isOwner: async function(){ return R.rol === "admin"; },
    canEdit: async function(){ return R.rol === "admin" || R.rol === "rrhh"; },
    name: async function(){ return me.name; },
    me: async function(){ return {name:me.name, email:me.email}; },
    // Los otros usuarios se leen de los perfiles del Radar (solo el Administrador puede verlos a todos)
    profiles: async function(ids){
      var out = {};
      ids = (ids || []).filter(Boolean);
      if(!ids.length) return out;
      try{
        var r = await sb.from("perfiles").select("user_id,email").in("user_id", ids);
        (r.data || []).forEach(function(p){ out[p.user_id] = {name:(p.email || "").split("@")[0], email:p.email || ""}; });
      }catch(e){}
      return out;
    },
    search: async function(q){
      q = String(q || "").trim().toLowerCase();
      try{
        var r = await sb.from("perfiles").select("user_id,email,rol").in("rol", ["admin", "rrhh"]).order("email");
        return (r.data || []).filter(function(p){ return !q || (p.email || "").toLowerCase().indexOf(q) >= 0; })
          .slice(0, 20).map(function(p){ return {id:p.user_id, name:(p.email || "").split("@")[0], email:p.email || "", isMe:p.user_id === R.userId}; });
      }catch(e){ return []; }
    }
  };

  /* ---------- descargas ---------- */
  var downloadsApi = {
    save: async function(o){
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data]);
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = o.filename || "archivo";
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
  };

  window.claude = {
    use: async function(name){
      if(name === "db") return dbApi;
      if(name === "user") return userApi;
      if(name === "downloads") return downloadsApi;
      return null;
    }
  };
})();
