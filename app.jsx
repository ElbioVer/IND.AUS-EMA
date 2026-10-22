const {useState,useMemo,useCallback,useEffect,useRef} = React;

/* Estado que sobrevive al cambiar de pestaña (las pestañas se desmontan al salir de ellas). */
const KEPT_UI_STATE = new Map();
function useKeptState(key, initial){
  const [value, setValue] = useState(() => KEPT_UI_STATE.has(key) ? KEPT_UI_STATE.get(key) : (typeof initial==="function" ? initial() : initial));
  const set = useCallback(val => {
    setValue(prev => {
      const next = typeof val==="function" ? val(prev) : val;
      KEPT_UI_STATE.set(key, next);
      return next;
    });
  }, [key]);
  return [value, set];
}
function escHtml(s){
  return String(s==null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ===================== supabase (login + guardado de cronicos) ===================== */
const SUPABASE_URL = "https://rfavfuibywwaytlgpcqp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_SiBV5y1l6xs2bLr8HvCl6A_Syc89Xkn";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ===================== guardado en Supabase: ausentismo + plantel ===================== */
const AUSENTISMO_TABLE = "ausentismo_registros";
const PLANTEL_TABLE = "plantel_empleados";
// Espacio de la base de datos (plan Free de Supabase = 500 MB). Si se pasa a Pro, cambiar DB_LIMIT_MB (ej. 8192).
const DB_LIMIT_MB = 500;
const DB_WARN_PCT = 70;   // desde acá aparece una marca discreta arriba (ámbar)
const DB_ALERT_PCT = 85;  // y desde acá se pone roja
const SYNC_PAGE_SIZE = 1000;
const SYNC_BATCH_SIZE = 1000;

// Trae solo las filas nuevas/modificadas desde "sinceIso" (updated_at > sinceIso).
// Sin sinceIso, trae todo — se usa una sola vez, la primera vez que se abre en un navegador.
// tieField (opcional): columna única para desempatar el orden. Muchas filas se guardan con el mismo updated_at (mismo milisegundo),
// y sin desempate dos páginas seguidas podrían repetir o saltear filas. onProgress(cantidad) avisa cuántas filas se bajaron.
async function fetchRowsSince(table, sinceIso, onProgress, tieField){
  let from = 0, out = [];
  while(true){
    let q = supabaseClient.from(table).select("*");
    if(sinceIso) q = q.gt("updated_at", sinceIso);
    q = q.order("updated_at", {ascending:true});
    if(tieField) q = q.order(tieField, {ascending:true});
    q = q.range(from, from+SYNC_PAGE_SIZE-1);
    const {data, error} = await q;
    if(error) throw error;
    out = out.concat(data);
    if(onProgress) onProgress(out.length);
    if(!data.length || data.length < SYNC_PAGE_SIZE) break;
    from += SYNC_PAGE_SIZE;
  }
  return out;
}
function maxUpdatedAt(rows, startFrom){
  return rows.reduce((a,r)=> (r.updated_at && r.updated_at>a ? r.updated_at : a), startFrom||"1970-01-01T00:00:00Z");
}
function mergeRawRowsById(existingRows, newRows, idField){
  const map = new Map(existingRows.map(r=>[r[idField], r]));
  newRows.forEach(r=> map.set(r[idField], r));
  return Array.from(map.values());
}

/* ===================== caché local (IndexedDB) — evita re-descargar todo en cada visita ===================== */
const IDB_NAME = "radar_ausentismo_cache";
const IDB_STORE = "kv";
function idbOpen(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = ()=>{ req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
async function idbGet(key){
  try{
    const db = await idbOpen();
    return await new Promise((resolve,reject)=>{
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    });
  }catch(e){ return undefined; } // sin IndexedDB (privado/bloqueado): sigue andando sin caché
}
async function idbSet(key, value){
  try{
    const db = await idbOpen();
    await new Promise((resolve,reject)=>{
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
    });
  }catch(e){ /* caché best-effort, no rompe nada si falla */ }
}
async function upsertWithRetry(table, batch, onConflict, attempts){
  let lastErr = null;
  for(let a=0; a<attempts; a++){
    if(a>0) await new Promise(res=>setTimeout(res, 800*a));
    const {error} = await supabaseClient.from(table).upsert(batch, {onConflict});
    if(!error) return null;
    lastErr = error;
  }
  return lastErr;
}
async function upsertBisect(table, batch, onConflict, badRows){
  const err = await upsertWithRetry(table, batch, onConflict, 3);
  if(!err) return;
  if(batch.length===1){ badRows.push({row:batch[0], error:err}); return; }
  // una fila con datos raros puede tumbar toda la tanda — se parte a la mitad hasta aislar
  // exactamente cuál fila falla, en vez de perder las 1000 de la tanda entera.
  const mid = Math.ceil(batch.length/2);
  await upsertBisect(table, batch.slice(0,mid), onConflict, badRows);
  await upsertBisect(table, batch.slice(mid), onConflict, badRows);
}
async function upsertInBatches(table, rows, onConflict, onProgress){
  const badRows = [];
  for(let i=0;i<rows.length;i+=SYNC_BATCH_SIZE){
    const batch = rows.slice(i, i+SYNC_BATCH_SIZE);
    await upsertBisect(table, batch, onConflict, badRows);
    if(onProgress) onProgress(Math.min(i+SYNC_BATCH_SIZE, rows.length), rows.length);
  }
  if(badRows.length){
    const sample = badRows.slice(0,5).map(b=>{
      const label = b.row.id || b.row.legajo || JSON.stringify(b.row).slice(0,60);
      return label+": "+(b.error && b.error.message ? b.error.message : String(b.error));
    }).join(" | ");
    const msg = badRows.length+" de "+rows.length+" filas no se pudieron guardar en el servidor. "+
      "Detalle: "+sample+(badRows.length>5 ? " (+"+(badRows.length-5)+" más)" : "")+". "+
      "El resto sí se guardó. Revisá esas filas en el Excel y volvé a subir el archivo para reintentar solo lo que falta.";
    const err = new Error(msg);
    err.badRows = badRows;
    throw err;
  }
}
function tsToISODate(ts){ const d = new Date(ts); return d.getUTCFullYear()+"-"+pad2(d.getUTCMonth()+1)+"-"+pad2(d.getUTCDate()); }
function isoDateToTs(s){ if(!s) return null; const [y,m,d] = s.split("-").map(Number); return Date.UTC(y,m-1,d); }

function ausRecordToRow(r){
  return {
    id: (r.legajo||"").toUpperCase()+"|"+r.dateKey,
    legajo: r.legajo||"", fecha: r.anio+"-"+pad2(r.mes)+"-"+pad2(r.dia), anio: r.anio, mes: r.mes, dia: r.dia,
    agrup: r.agrup||"", unidad: r.unidad||"", sector: r.sector||"", gerencia: r.gerencia||"",
    departamento: r.departamento||"", empresa: r.empresa||"", nombre: r.nombre||"",
    id_motivo: r.idMotivo||"", motivo: r.motivo||"", estado: r.estado||"", razon: r.razon||"",
    puesto: r.puesto||"", jefe: r.jefe||"", presidencia: r.presidencia||"", sindicato: r.sindicato||"",
    tipo_contrat: r.tipoContrat||"",
    updated_at: new Date().toISOString()
  };
}
function ausRowToRecord(row){
  const ts = Date.UTC(row.anio, row.mes-1, row.dia);
  const monthKey = row.anio+"-"+pad2(row.mes);
  const dateKey = monthKey+"-"+pad2(row.dia);
  return {legajo:row.legajo||"", agrup:row.agrup||"", cat:row.agrup||"F", unidad:row.unidad||"", sector:row.sector||"",
    gerencia:row.gerencia||"", departamento:row.departamento||"", empresa:row.empresa||"", nombre:row.nombre||"",
    idMotivo:row.id_motivo||"", motivo:row.motivo||"", estado:row.estado||"", razon:row.razon||"", puesto:row.puesto||"",
    jefe:row.jefe||"", presidencia:row.presidencia||"", sindicato:row.sindicato||"", tipoContrat:row.tipo_contrat||"",
    valid:true, dia:row.dia, mes:row.mes, anio:row.anio, ts, monthKey, dateKey};
}
function plantelRecordToRow(p){
  return {
    legajo: p.legajo, nombre: p.nombre||"", fecha_alta: tsToISODate(p.altaTs),
    fecha_baja: p.bajaTs!=null ? tsToISODate(p.bajaTs) : null,
    fecha_nacimiento: p.nacimientoTs!=null ? tsToISODate(p.nacimientoTs) : null,
    estado: p.estado||"", unidad: p.unidad||"", sector: p.sector||"", gerencia: p.gerencia||"",
    departamento: p.departamento||"", empresa: p.empresa||"", grupo: p.grupo||"",
    puesto: p.puesto||"", jefe: p.jefe||"", celular: p.celular||"",
    updated_at: new Date().toISOString()
  };
}
function plantelRowToRecord(row){
  return {legajo:row.legajo, nombre:row.nombre||"", altaTs: isoDateToTs(row.fecha_alta), bajaTs: isoDateToTs(row.fecha_baja),
    nacimientoTs: isoDateToTs(row.fecha_nacimiento), estado:row.estado||"", unidad:row.unidad||"", sector:row.sector||"",
    gerencia:row.gerencia||"", departamento:row.departamento||"", empresa:row.empresa||"", grupo:row.grupo||"",
    puesto:row.puesto||"", jefe:row.jefe||"", celular:row.celular||""};
}

function LoginForm({onSignedIn}){
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function handleSubmit(e){
    e.preventDefault();
    setError(""); setLoading(true);
    const {data, error} = await supabaseClient.auth.signInWithPassword({email, password});
    setLoading(false);
    if(error){ setError(error.message==="Invalid login credentials" ? "Email o password incorrectos." : error.message); return; }
    onSignedIn(data.session);
  }
  return (
    <div style={{minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center"}}>
      <form onSubmit={handleSubmit} className="card login-form" style={{width:320, padding:28}}>
        <h2 style={{margin:"0 0 4px"}}>Indicador de Ausentismo</h2>
        <p className="desc" style={{margin:"0 0 18px"}}>Login para continuar.</p>
        <div style={{display:"flex", flexDirection:"column", gap:10}}>
          <input type="email" required autoComplete="username" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} />
          <input type="password" required autoComplete="current-password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} />
          {error && <div style={{color:"var(--cat-anp,#f0605d)", fontSize:12.5}}>{error}</div>}
          <button type="submit" className="btn" disabled={loading} style={{marginTop:4}}>{loading?"Ingresando...":"Ingresar"}</button>
          <InstallButton />
        </div>
      </form>
    </div>
  );
}

function InstallButton({style}){
  const [evt, setEvt] = useState(window.__installEvt);
  useEffect(()=>{
    const h = ()=> setEvt(window.__installEvt);
    window.addEventListener("installready", h);
    return ()=> window.removeEventListener("installready", h);
  }, []);
  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone===true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if(standalone || (!evt && !isIOS)) return null;
  async function onClick(){
    if(evt){
      evt.prompt();
      try{ await evt.userChoice; }catch(e){}
      window.__installEvt = null;
      setEvt(null);
    } else {
      alert("En iPhone/iPad: tocá el botón Compartir de Safari y elegí \"Añadir a pantalla de inicio\".");
    }
  }
  return <button type="button" className="btn secondary no-print" style={style} onClick={onClick}>Instalar app</button>;
}

// Cada usuario cambia su propia contraseña: se pide la actual (se verifica iniciando sesión de nuevo) y la nueva dos veces.
// Las contraseñas nunca se guardan ni se muestran en la app: Supabase solo conserva una versión cifrada.
function ChangePasswordButton({userEmail}){
  const [open, setOpen] = useState(false);
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [repetir, setRepetir] = useState("");
  const [ver, setVer] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  function cerrar(){ setOpen(false); setActual(""); setNueva(""); setRepetir(""); setVer(false); setError(""); setOk(false); }
  async function guardar(e){
    e.preventDefault();
    setError("");
    if(nueva.length<8){ setError("La contraseña nueva debe tener al menos 8 caracteres."); return; }
    if(nueva!==repetir){ setError("La contraseña nueva y su repetición no coinciden."); return; }
    if(nueva===actual){ setError("La contraseña nueva tiene que ser distinta de la actual."); return; }
    setBusy(true);
    try{
      const {error:errLogin} = await supabaseClient.auth.signInWithPassword({email:userEmail, password:actual});
      if(errLogin){ setError(errLogin.message==="Invalid login credentials" ? "La contraseña actual no es correcta." : errLogin.message); setBusy(false); return; }
      const {error:errUpd} = await supabaseClient.auth.updateUser({password:nueva});
      if(errUpd){ setError("No se pudo cambiar la contraseña: "+errUpd.message); setBusy(false); return; }
      setBusy(false); setOk(true); setActual(""); setNueva(""); setRepetir("");
      setTimeout(cerrar, 2200);
    }catch(err){
      setBusy(false);
      setError("No se pudo cambiar la contraseña: "+((err && err.message) ? err.message : String(err)));
    }
  }
  return (
    <React.Fragment>
      <button type="button" className="btn secondary no-print" onClick={()=>setOpen(true)}>Cambiar contraseña</button>
      {open && (
        <div className="modal-backdrop no-print" onClick={busy ? undefined : cerrar}>
          <div className="modal-panel" style={{maxWidth:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-head">
              <h3>Cambiar mi contraseña</h3>
              <button type="button" className="btn secondary small" onClick={cerrar} disabled={busy}>Cerrar</button>
            </div>
            {ok ? (
              <p className="desc" style={{margin:0, color:"var(--good)", fontWeight:700}}>Contraseña actualizada. Desde ahora usá la nueva para entrar.</p>
            ) : (
              <form onSubmit={guardar} style={{display:"flex", flexDirection:"column", gap:12}}>
                <p className="hint" style={{margin:0}}>Usuario: <b>{userEmail}</b></p>
                <div className="field"><label>Contraseña actual</label>
                  <input type={ver?"text":"password"} autoComplete="current-password" value={actual} onChange={e=>setActual(e.target.value)} required autoFocus /></div>
                <div className="field"><label>Contraseña nueva (mínimo 8 caracteres)</label>
                  <input type={ver?"text":"password"} autoComplete="new-password" value={nueva} onChange={e=>setNueva(e.target.value)} required minLength={8} /></div>
                <div className="field"><label>Repetir contraseña nueva</label>
                  <input type={ver?"text":"password"} autoComplete="new-password" value={repetir} onChange={e=>setRepetir(e.target.value)} required minLength={8} /></div>
                <label className="motivo-check" style={{cursor:"pointer"}}>
                  <input type="checkbox" checked={ver} onChange={e=>setVer(e.target.checked)} /> Mostrar lo que escribo
                </label>
                {error && <div className="warn-banner">{error}</div>}
                <div style={{display:"flex", gap:10}}>
                  <button type="submit" className="btn" disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button>
                  <button type="button" className="btn secondary" onClick={cerrar} disabled={busy}>Cancelar</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </React.Fragment>
  );
}

function AuthGate(){
  const [session, setSession] = useState(undefined); // undefined=cargando, null=sin sesion, obj=logueado
  useEffect(()=>{
    supabaseClient.auth.getSession().then(({data})=> setSession(data.session||null));
    const {data:sub} = supabaseClient.auth.onAuthStateChange((_event, sess)=> setSession(sess||null));
    return ()=> sub.subscription.unsubscribe();
  }, []);
  if(session===undefined) return <div style={{padding:60, textAlign:"center"}} className="hint">Cargando...</div>;
  if(!session) return <LoginForm onSignedIn={setSession} />;
  return <RoleGate userId={session.user.id} userEmail={session.user.email} onSignOut={()=>supabaseClient.auth.signOut()} />;
}

/* ===================== perfiles y permisos ===================== */
// Qué puede ver y hacer cada perfil. El perfil de cada usuario está en la tabla `perfiles` de Supabase (supabase-permisos-roles.sql);
// ahí mismo las reglas de acceso (RLS) impiden en el servidor lo que el perfil no permite: esta tabla solo ordena lo que se muestra en pantalla.
const TABS_DE_ANALISIS = ["resumen","resumen_gerencia","cuadro_diario","evolucion","tipos","cronicos","medicina_laboral","ranking","detalle_empleados","plantel"];
const ROLES = {
  admin: {label:"Administrador", desc:"Acceso total: todos los menús, cargas, reemplazo de archivos, Crónicos editable y gestión de usuarios.",
    tabs:[...TABS_DE_ANALISIS, "usuarios"], filtros:true, cargar:true, reemplazar:true, objetivo:true, cronicosEditar:true, plantelCompleto:true, medicinaEditar:true, citar:true},
  rrhh: {label:"RRHH", desc:"Actualiza la base de ausentismo y el plantel (sin reemplazar ni borrar). Lee todos los menús con sus filtros; imprime Detalle de empleados y Crónicos. Puede citar a Medicina Laboral desde Crónicos (y ver ese menú, sin anotar). Gestión de Plantel solo con la carga.",
    tabs:TABS_DE_ANALISIS, filtros:true, cargar:true, reemplazar:false, objetivo:true, cronicosEditar:false, plantelCompleto:false, medicinaEditar:false, citar:true},
  medico: {label:"Servicio médico", desc:"Medicina Laboral (atiende, anota, cita e imprime el reporte de la jornada), Crónicos (editable), Ranking y Detalle de empleados, con sus filtros e impresión. Ve solo la empresa Propios y los motivos por defecto.",
    tabs:["medicina_laboral","cronicos","ranking","detalle_empleados"], filtros:true, cargar:false, reemplazar:false, objetivo:false, cronicosEditar:true, plantelCompleto:false, medicinaEditar:true, citar:true,
    // vista simplificada: solo empresa "Propios" y los filtros de motivo ya resueltos por defecto, sin mostrar esas opciones
    soloPropios:true, motivosPorDefecto:true},
  gerencias: {label:"Gerencias", desc:"Resumen (gráficos y detalles, sin filtros), Resumen por Gerencia (gráfico y cumplimiento del objetivo), Cuadro Diario, Evolución mensual y Tipos de ausencia (AP vs ANP y Motivo).",
    tabs:["resumen","resumen_gerencia","cuadro_diario","evolucion","tipos"], filtros:false, cargar:false, reemplazar:false, objetivo:false, cronicosEditar:false, plantelCompleto:false, medicinaEditar:false, citar:false}
};

function RoleGate({userId, userEmail, onSignOut}){
  const [perfil, setPerfil] = useState(undefined); // undefined=cargando | {rol} | {rol,legacy} | null=sin perfil | {error}
  const load = useCallback(async ()=>{
    setPerfil(undefined);
    try{
      const {data, error} = await supabaseClient.from("perfiles").select("rol,email").eq("user_id", userId).maybeSingle();
      if(error){
        const txt = (error.message||"")+" "+(error.code||"");
        // todavía no se creó la tabla de perfiles (no se corrió el SQL de permisos): se sigue como hasta ahora, con aviso
        if(/PGRST205|42P01|does not exist|schema cache/i.test(txt)) setPerfil({rol:"admin", legacy:true});
        else setPerfil({error: error.message||"Error desconocido"});
        return;
      }
      setPerfil(data && ROLES[data.rol] ? data : null);
    }catch(err){
      setPerfil({error: (err && err.message) ? err.message : String(err)});
    }
  }, [userId]);
  useEffect(()=>{ load(); }, [load]);
  if(perfil===undefined) return <div style={{padding:60, textAlign:"center"}} className="hint">Cargando permisos...</div>;
  if(perfil===null || perfil.error){
    return (
      <div className="app" style={{maxWidth:560}}>
        <div className="card" style={{padding:"24px 26px", display:"flex", flexDirection:"column", gap:12}}>
          <h2 style={{margin:0, fontSize:18}}>{perfil===null ? "Tu usuario no tiene un perfil asignado" : "No se pudieron verificar tus permisos"}</h2>
          <p className="desc" style={{margin:0}}>
            {perfil===null
              ? <React.Fragment>Iniciaste sesión como <b>{userEmail}</b>, pero todavía no tiene un perfil. Pedile al administrador que te asigne uno.</React.Fragment>
              : <React.Fragment>No se pudo leer tu perfil ({perfil.error}). Probá de nuevo; si sigue igual, avisale al administrador.</React.Fragment>}
          </p>
          <div style={{display:"flex", gap:10}}>
            <button type="button" className="btn" onClick={load}>Reintentar</button>
            <button type="button" className="btn secondary" onClick={onSignOut}>Cerrar sesion</button>
          </div>
        </div>
      </div>
    );
  }
  return <App userEmail={userEmail} userId={userId} rol={perfil.rol} permisosSinActivar={!!perfil.legacy} onSignOut={onSignOut} />;
}

// Administración de perfiles (solo Administrador). Los usuarios nuevos se crean en Supabase (Authentication → Users) y nacen como "Gerencias".
function UsuariosTab({userId}){
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(async ()=>{
    const {data, error} = await supabaseClient.from("perfiles").select("user_id,email,rol,created_at").order("email");
    if(error){ setError(error.message); return; }
    setError(null); setRows(data||[]);
  }, []);
  useEffect(()=>{ load(); }, [load]);
  const sort = useTableSort(rows||[], {email:{get:r=>r.email, type:"text"}, rol:{get:r=>(ROLES[r.rol]||{}).label||r.rol, type:"text"}});
  async function cambiarRol(row, rol){
    if(row.user_id===userId || !ROLES[rol]) return;
    setMsg("Guardando...");
    const {error} = await supabaseClient.from("perfiles").update({rol}).eq("user_id", row.user_id);
    if(error){ setMsg("Error al guardar: "+error.message); return; }
    setRows(rs=>rs.map(r=> r.user_id===row.user_id ? {...r, rol} : r));
    setMsg("Guardado: "+row.email+" → "+ROLES[rol].label);
  }
  return (
    <div className="tabpanel">
      <div className="card table-card">
        <h3>Usuarios y permisos</h3>
        <div className="caption">Elegí el perfil de cada usuario. Los cambios se aplican la próxima vez que esa persona abra o recargue la app. Tu propio perfil no se puede cambiar desde acá, para no quedarte sin acceso.</div>
        {error && <div className="warn-banner">No se pudo leer la lista de usuarios: {error}</div>}
        {rows && (
          <div className="overflow-x">
            <table>
              <thead><tr>
                <SortTh k="email" label="Usuario (correo)" sort={sort.sort} toggle={sort.toggle} />
                <SortTh k="rol" label="Perfil" sort={sort.sort} toggle={sort.toggle} />
              </tr></thead>
              <tbody>
                {!rows.length && <tr><td colSpan="2" style={{textAlign:"center",color:"var(--muted)",padding:"18px 0"}}>Sin usuarios.</td></tr>}
                {sort.sorted.map(r=>(
                  <tr key={r.user_id}>
                    <td>{r.email}{r.user_id===userId ? " (vos)" : ""}</td>
                    <td>
                      <select value={r.rol} disabled={r.user_id===userId} onChange={e=>cambiarRol(r, e.target.value)}>
                        {Object.keys(ROLES).map(k=>(<option key={k} value={k}>{ROLES[k].label}</option>))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {msg && <p className="hint" style={{margin:0}}>{msg}</p>}
        <p className="hint" style={{margin:0}}>Para dar de alta a una persona nueva: en Supabase → Authentication → Users → Add user. Entra con el perfil <b>Gerencias</b> (el más acotado) y desde acá se lo cambiás.</p>
      </div>
      <div className="card table-card">
        <h3>Qué puede hacer cada perfil</h3>
        <div className="overflow-x">
          <table>
            <thead><tr><th>Perfil</th><th>Permisos</th></tr></thead>
            <tbody>
              {Object.keys(ROLES).map(k=>(<tr key={k}><td style={{whiteSpace:"nowrap"}}><b>{ROLES[k].label}</b></td><td>{ROLES[k].desc}</td></tr>))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const MESES_CORTOS = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const REQUIRED_COLS = ["Legajo","Agrupador cuadro presentismo","Entrada"];
const OPTIONAL_COLS = {unidad:"Unidad de Negocio", sector:"Sector", gerencia:"Gerencia", departamento:"Departamento", empresa:"Empresa", nombre:"Empleado", idMotivo:"Id Motivo", motivo:"Motivo",
  estado:"Estado", razon:"Razon", puesto:"Puesto", jefe:"Jefe directo", presidencia:"Agrupador cuadro presidencia", sindicato:"Sindicato", tipoContrat:"Agrup. tipo contratacion"};

/* ===================== Cuadro Diario (constantes editables) ===================== */
// Empresa subcontratada -> unidad de negocio donde se cuenta en la columna Sub-Cont (se compara sin mayúsculas ni acentos).
const EMPRESA_SERVICIO = {"VIETA FACUNDO":"Servicios Electricos","DELFINO CLAUDIO":"Servicios Electricos","REDELED":"Servicios Electricos"};
// Etiqueta con que se muestra cada unidad en el Cuadro Diario.
const CUADRO_UNIT_LABEL = {"Operaciones Comerciales":"AySA Medidores","Indirectos":"A Repartir"};

/* ===================== plantel de activos ===================== */
const PLANTEL_FIELD_ALIASES = {
  legajo: ["Legajo","Nro Legajo","N° Legajo","Legajo Nro"],
  nombre: ["Apellido y Nombre","Empleado","Nombre","Apellido Nombre"],
  fechaAlta: ["Fecha cálculo vacaciones","Fecha calculo vacaciones","Fecha de Alta","Fecha Alta","F. Alta","Alta","Fecha de Ingreso","Fecha Ingreso"],
  fechaBaja: ["Fecha de Baja","Fecha Baja","F. Baja","Baja","Fecha de egreso","Fecha Egreso","Fecha de Egreso"],
  fechaNacimiento: ["Fecha de Nacimiento","Fecha de nacimiento","Fecha Nacimiento","F. Nacimiento","Nacimiento"],
  estado: ["Estado","Estado Empleado"],
  unidad: ["Unidad de Negocio","UN","Unidad"],
  sector: ["Sector"],
  gerencia: ["Gerencia"],
  departamento: ["Departamento"],
  empresa: ["Empresa"],
  grupo: ["Grupo"],
  puesto: ["Puesto"],
  jefe: ["Responsable","Jefe directo","Jefe Directo","Jefe"],
  celular: ["Celular","Teléfono","Telefono","Teléfono celular","Telefono celular","Tel. Celular","Tel","Tel.","Móvil","Movil"]
};
const PLANTEL_REQUIRED_FIELDS = ["legajo","fechaAlta"];
const PLANTEL_FIELD_LABELS = {legajo:"Legajo", nombre:"Apellido y Nombre", fechaAlta:"Fecha de Alta", fechaBaja:"Fecha de Baja",
  fechaNacimiento:"Fecha de Nacimiento", estado:"Estado", unidad:"Unidad de Negocio", sector:"Sector", gerencia:"Gerencia", departamento:"Departamento", empresa:"Empresa", grupo:"Grupo", puesto:"Puesto", jefe:"Jefe directo (Responsable)", celular:"Celular (Teléfono)"};
const PLANTEL_FIELD_ORDER = ["legajo","nombre","fechaAlta","fechaBaja","fechaNacimiento","estado","unidad","sector","gerencia","departamento","empresa","grupo","puesto","jefe","celular"];
function findColByAliases(headerRow, aliases){
  for(let a=0;a<aliases.length;a++){
    const idx = findColIndex(headerRow, aliases[a]);
    if(idx!==-1) return idx;
  }
  return -1;
}
const RANKING_DEFAULT_PRESIDENCIA_INCLUDE = new Set(["ENF","NO JUST"]);
const UNIT_ORDER = ["Distribucion y Logistica","Operaciones Comerciales","Servicios Electricos","Lectura","Interior","Indirectos"];
function unitOrderIndex(name){ const i = UNIT_ORDER.indexOf(name); return i===-1 ? UNIT_ORDER.length : i; }
const DEFAULT_MOTIVO_TABLE = [
  {key:"AT", refLabel:"Accidente de trabajo", incluir:true},
  {key:"CA", refLabel:"Con aviso", incluir:true},
  {key:"SA", refLabel:"Sin aviso", incluir:true},
  {key:"CE", refLabel:"Cesante", incluir:false},
  {key:"BA", refLabel:"Baja", incluir:false},
  {key:"CJ", refLabel:"Citacion judicial", incluir:true},
  {key:"DAC", refLabel:"Dia a compensar", incluir:true},
  {key:"DC", refLabel:"Dia compensado", incluir:false},
  {key:"DS", refLabel:"Donacion de sangre", incluir:true},
  {key:"EN", refLabel:"Enfermedad", incluir:true},
  {key:"EFS", refLabel:"Enf Fam Sgbatos", incluir:true},
  {key:"ET", refLabel:"Enfermedad (ART)", incluir:true},
  {key:"CAE", refLabel:"CAE (ausencia por salud)", incluir:true},
  {key:"EX", refLabel:"Examen", incluir:true},
  {key:"ED", refLabel:"Excedencia", incluir:true},
  {key:"FA", refLabel:"Fallecimiento", incluir:true},
  {key:"FER", refLabel:"Feriado", incluir:false},
  {key:"JDL", refLabel:"Jornada de Lluvia", incluir:false},
  {key:"LSP", refLabel:"Lic Sanitaria Preventiva (S9)", incluir:true},
  {key:"MT", refLabel:"Maternidad", incluir:true},
  {key:"LVC", refLabel:"Licencia por Vacuna contra Covid", incluir:true},
  {key:"LSS", refLabel:"Licencia sin goce de sueldo", incluir:true},
  {key:"MA", refLabel:"Matrimonio", incluir:true},
  {key:"MU", refLabel:"Mudanza", incluir:true},
  {key:"NAC", refLabel:"Nacimiento", incluir:true},
  {key:"PH", refLabel:"Paro / huelga", incluir:true},
  {key:"PSI", refLabel:"P. Sindical", incluir:false},
  {key:"PCG", refLabel:"Permiso con Goce", incluir:false},
  {key:"JRP", refLabel:"Jornada reducida - Permiso", incluir:true},
  {key:"PHO", refLabel:"Pres Home Office (S3)", incluir:false},
  {key:"PCT", refLabel:"Presente Contratista", incluir:false},
  {key:"PRD", refLabel:"Proceso Desvinculacion", incluir:false},
  {key:"RP", refLabel:"Reserva de puesto", incluir:true},
  {key:"SFT", refLabel:"Suspension falta de trabajo", incluir:false},
  {key:"SUS", refLabel:"Suspension", incluir:false},
  {key:"SP", refLabel:"Susp. prev. Art. 224 LCT", incluir:false},
  {key:"PG", refLabel:"Permiso gremial", incluir:false},
  {key:"VAC", refLabel:"Vacaciones", incluir:true},
  {key:"VAP", refLabel:"Vacaciones (Pagas)", incluir:false}
];
const DEFAULT_MOTIVO_INCLUDE_KEYS = new Set(DEFAULT_MOTIVO_TABLE.filter(m=>m.incluir).map(m=>m.key));
function isDefaultIncludedMotivoCode(code){ return DEFAULT_MOTIVO_INCLUDE_KEYS.has((code||"").toUpperCase()); }
const PERIODO_OPTIONS = [
  {value:"1", label:"Enero", months:[1]}, {value:"2", label:"Febrero", months:[2]}, {value:"3", label:"Marzo", months:[3]},
  {value:"4", label:"Abril", months:[4]}, {value:"5", label:"Mayo", months:[5]}, {value:"6", label:"Junio", months:[6]},
  {value:"7", label:"Julio", months:[7]}, {value:"8", label:"Agosto", months:[8]}, {value:"9", label:"Septiembre", months:[9]},
  {value:"10", label:"Octubre", months:[10]}, {value:"11", label:"Noviembre", months:[11]}, {value:"12", label:"Diciembre", months:[12]},
  {value:"cuatri1", label:"1º Cuatrimestre (Ene-Abr)", months:[1,2,3,4]},
  {value:"cuatri2", label:"2º Cuatrimestre (May-Ago)", months:[5,6,7,8]},
  {value:"cuatri3", label:"3º Cuatrimestre (Sep-Dic)", months:[9,10,11,12]},
  {value:"todos", label:"Todos", months:[1,2,3,4,5,6,7,8,9,10,11,12]},
  {value:"personalizado", label:"Personalizado", months:null}
];
const CUATRI_OPTIONS = [
  {value:"", label:"Todos", months:[1,2,3,4,5,6,7,8,9,10,11,12]},
  {value:"1", label:"1º Cuatrimestre (Ene-Abr)", months:[1,2,3,4]},
  {value:"2", label:"2º Cuatrimestre (May-Ago)", months:[5,6,7,8]},
  {value:"3", label:"3º Cuatrimestre (Sep-Dic)", months:[9,10,11,12]}
];
const REF_ROWS = 195699;
const REF_MONTHS = {1:21452,2:20322,3:22694,4:22802,5:22778,6:23430,7:23579,8:22299,9:16343};
const CAT_COLOR = {P:"var(--cat-p)",AP:"var(--cat-ap)",ANP:"var(--cat-anp)",V:"var(--cat-v)",CE:"var(--cat-ce)",BAJA:"var(--cat-baja)"};
const CAT_LABEL = {P:"Presentes",AP:"Ausente pago",ANP:"Ausente no pago",V:"Vacaciones",CE:"Cesante",BAJA:"Baja",F:"Franco"};
const SERIES_COLOR = ["var(--s1)","var(--s2)","var(--s3)","var(--s4)","var(--s5)","var(--s6)"];
const ENTRADA_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const DAYS_IN_MONTH = [31,28,31,30,31,30,31,31,30,31,30,31];

function fmt(n){ return Math.round(n||0).toLocaleString("es-AR"); }
function fmtPct(n,d){ d = d==null?1:d; return (n||0).toLocaleString('es-AR',{minimumFractionDigits:d,maximumFractionDigits:d})+"%"; }
function pad2(n){ return String(n).padStart(2,"0"); }
function fmtDate(d,m,y){ return pad2(d)+"/"+pad2(m)+"/"+y; }
function isLeap(y){ return (y%4===0 && y%100!==0) || y%400===0; }
function daysInMonth(m,y){ return m===2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m-1]; }
function monthLabel(mk){ const [y,m]=mk.split("-"); return MESES_CORTOS[+m-1]+" "+y.slice(2); }
function isCountedCat(cat){ return cat==="AP"||cat==="ANP"; }
function isExcludedCat(cat){ return cat==="CE"||cat==="BAJA"; }
function normTxt(s){ return (s||"").toString().trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,""); }
function motivoKeyOf(r){ return r.idMotivo ? r.idMotivo.toUpperCase() : ("TXT:"+normTxt(r.motivo||"sin especificar")); }
function motivoLabelOf(r){ return r.idMotivo ? (r.idMotivo+" — "+(r.motivo||r.idMotivo)) : (r.motivo||"Sin especificar"); }
const DEFAULT_EXCLUDED_MOTIVO_CODES = ["BA","CE","SUS","SFT","RP","PRD"];
const DEFAULT_EXCLUDED_MOTIVO_TEXT = ["baja","cesante","suspension","suspension falta de trabajo","reserva de puesto","proceso desvinculacion"];
function isDefaultExcludedMotivoKey(key){
  if(key.indexOf("TXT:")===0) return DEFAULT_EXCLUDED_MOTIVO_TEXT.includes(key.slice(4));
  return !isDefaultIncludedMotivoCode(key);
}

function parseEntrada(raw){
  if(typeof raw === "number" && isFinite(raw)){
    const ms = Date.UTC(1899,11,30) + raw*86400000;
    const dt = new Date(ms);
    return {valid:true, dia:dt.getUTCDate(), mes:dt.getUTCMonth()+1, anio:dt.getUTCFullYear()};
  }
  const s = String(raw==null ? "" : raw).trim();
  const m = ENTRADA_RE.exec(s);
  if(!m) return {valid:false};
  const dia = parseInt(m[1],10), mes = parseInt(m[2],10), anio = parseInt(m[3],10);
  if(mes < 1 || mes > 12) return {valid:false};
  if(dia < 1 || dia > daysInMonth(mes,anio)) return {valid:false};
  return {valid:true, dia, mes, anio};
}

function findColIndex(headerRow, target){
  for(let i=0;i<headerRow.length;i++){
    if(String(headerRow[i]==null?"":headerRow[i]).trim() === target) return i;
  }
  return -1;
}
function cellStr(row, idx){ return idx===-1 ? "" : String(row[idx]==null?"":row[idx]).trim(); }
function stripLegajoPrefix(nombre, legajo){
  if(!nombre || !legajo) return nombre||"";
  const esc = legajo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return nombre.replace(new RegExp("^"+esc+"\\s+"), "").trim();
}

/* ---- ausentismo: parseo, agregados y fusión reutilizables (carga inicial y "Actualizar archivo") ---- */
function parseAusentismoRows(rows2d){
  const header = rows2d[0] || [];
  const idxLegajo = findColIndex(header, "Legajo");
  const idxAgrup = findColIndex(header, "Agrupador cuadro presentismo");
  const idxEntrada = findColIndex(header, "Entrada");
  const missing = [];
  if(idxLegajo === -1) missing.push("Legajo");
  if(idxAgrup === -1) missing.push("Agrupador cuadro presentismo");
  if(idxEntrada === -1) missing.push("Entrada");
  if(missing.length){
    return {error: "Falta" + (missing.length>1?"n":"") + " la" + (missing.length>1?"s":"") + " columna" + (missing.length>1?"s":"") + " " + missing.map(m=>'"'+m+'"').join(" y ") + " en el archivo. Verificá que la hoja 'Sheet1' tenga esos encabezados exactos en la fila 1."};
  }
  const idxUnidad = findColIndex(header, OPTIONAL_COLS.unidad);
  const idxSector = findColIndex(header, OPTIONAL_COLS.sector);
  const idxGerencia = findColIndex(header, OPTIONAL_COLS.gerencia);
  const idxDepartamento = findColIndex(header, OPTIONAL_COLS.departamento);
  const idxEmpresa = findColIndex(header, OPTIONAL_COLS.empresa);
  const idxNombre = findColIndex(header, OPTIONAL_COLS.nombre);
  const idxIdMotivo = findColIndex(header, OPTIONAL_COLS.idMotivo);
  const idxMotivo = findColIndex(header, OPTIONAL_COLS.motivo);
  const idxEstado = findColIndex(header, OPTIONAL_COLS.estado);
  const idxRazon = findColIndex(header, OPTIONAL_COLS.razon);
  const idxPuesto = findColIndex(header, OPTIONAL_COLS.puesto);
  const idxJefe = findColIndex(header, OPTIONAL_COLS.jefe);
  const idxPresidencia = findColIndex(header, OPTIONAL_COLS.presidencia);
  const idxSindicato = findColIndex(header, OPTIONAL_COLS.sindicato);
  const idxTipoContrat = findColIndex(header, OPTIONAL_COLS.tipoContrat);

  const dataRows = rows2d.slice(1);
  const records = [];
  let invalidCount = 0;
  dataRows.forEach(row => {
    const legajoRaw = row[idxLegajo];
    const legajo = String(legajoRaw==null?"":legajoRaw).trim();
    const agrupRaw = row[idxAgrup];
    const agrup = String(agrupRaw==null?"":agrupRaw).trim().toUpperCase();
    const entradaRaw = row[idxEntrada];
    const d = parseEntrada(entradaRaw);
    const unidad = cellStr(row, idxUnidad);
    const sector = cellStr(row, idxSector);
    const gerencia = cellStr(row, idxGerencia);
    const departamento = cellStr(row, idxDepartamento);
    const empresa = cellStr(row, idxEmpresa);
    const nombre = stripLegajoPrefix(cellStr(row, idxNombre), legajo);
    const idMotivo = cellStr(row, idxIdMotivo);
    const motivo = cellStr(row, idxMotivo);
    const estado = cellStr(row, idxEstado);
    const razon = cellStr(row, idxRazon);
    const puesto = cellStr(row, idxPuesto);
    const jefe = cellStr(row, idxJefe);
    const presidencia = cellStr(row, idxPresidencia).toUpperCase();
    const sindicato = cellStr(row, idxSindicato);
    const tipoContrat = cellStr(row, idxTipoContrat);
    if(!d.valid){
      invalidCount++;
      records.push({legajo, agrup, cat:agrup||"F", unidad, sector, gerencia, departamento, empresa, nombre, idMotivo, motivo, estado, razon, puesto, jefe, presidencia, sindicato, tipoContrat, valid:false});
      return;
    }
    const ts = Date.UTC(d.anio, d.mes-1, d.dia);
    const monthKey = d.anio+"-"+pad2(d.mes);
    const dateKey = monthKey+"-"+pad2(d.dia);
    records.push({legajo, agrup, cat:agrup||"F", unidad, sector, gerencia, departamento, empresa, nombre, idMotivo, motivo, estado, razon, puesto, jefe, presidencia, sindicato, tipoContrat,
      valid:true, dia:d.dia, mes:d.mes, anio:d.anio, ts, monthKey, dateKey});
  });
  return {error:null, records, invalidCount, hasMotivoCol: idxIdMotivo!==-1 || idxMotivo!==-1,
    missingTipoContrat: idxTipoContrat===-1 ? "Falta la columna '"+OPTIONAL_COLS.tipoContrat+"': el Cuadro Diario no podrá separar Propios / Contratados." : null};
}

function buildParsedAggregates(records, fileName, hasMotivo){
  const legajosSet = new Set();
  let minTs=null, maxTs=null;
  const unidadesSet=new Set(), sectoresSet=new Set(), gerenciasSet=new Set(), departamentosSet=new Set(), empresasSet=new Set();
  let invalidCount = 0;
  records.forEach(r=>{
    if(r.legajo) legajosSet.add(r.legajo.toUpperCase());
    if(r.unidad) unidadesSet.add(r.unidad);
    if(r.sector) sectoresSet.add(r.sector);
    if(r.gerencia) gerenciasSet.add(r.gerencia);
    if(r.departamento) departamentosSet.add(r.departamento);
    if(r.empresa) empresasSet.add(r.empresa);
    if(!r.valid){ invalidCount++; return; }
    if(minTs===null || r.ts<minTs) minTs=r.ts;
    if(maxTs===null || r.ts>maxTs) maxTs=r.ts;
  });

  const categoriesSet = new Set();
  records.forEach(r => { if(r.agrup !== "") categoriesSet.add(r.agrup); });
  const categories = Array.from(categoriesSet).sort();

  const motivoUniverseMap = new Map();
  records.forEach(r => {
    if(!r.valid || !isCountedCat(r.cat)) return;
    const k = motivoKeyOf(r);
    if(!motivoUniverseMap.has(k)) motivoUniverseMap.set(k, {key:k, label: motivoLabelOf(r), count:0, ap:0, anp:0});
    const mu = motivoUniverseMap.get(k);
    mu.count++;
    if(r.cat==="AP") mu.ap++; else mu.anp++;
  });
  const motivoUniverse = Array.from(motivoUniverseMap.values()).sort((a,b)=>b.count-a.count);

  const idMotivoUniverseMap = new Map();
  records.forEach(r => {
    if(!r.idMotivo) return;
    const k = r.idMotivo.toUpperCase();
    if(!idMotivoUniverseMap.has(k)) idMotivoUniverseMap.set(k, {key:k, label:k+" — "+(r.motivo||k), ap:0, anp:0});
    // cuántas filas AP / ANP tiene cada Id Motivo: sirve para la selección rápida "AP" / "ANP" de los filtros
    if(r.valid){ const m = idMotivoUniverseMap.get(k); if(r.cat==="AP") m.ap++; else if(r.cat==="ANP") m.anp++; }
  });
  const idMotivoUniverse = Array.from(idMotivoUniverseMap.values()).sort((a,b)=>a.key.localeCompare(b.key));

  const presidenciaUniverseSet = new Set();
  const presidenciaCats = {}; // valor -> {ap, anp}
  records.forEach(r => {
    if(!r.presidencia) return;
    presidenciaUniverseSet.add(r.presidencia);
    if(!presidenciaCats[r.presidencia]) presidenciaCats[r.presidencia] = {ap:0, anp:0};
    if(r.valid){ if(r.cat==="AP") presidenciaCats[r.presidencia].ap++; else if(r.cat==="ANP") presidenciaCats[r.presidencia].anp++; }
  });
  const presidenciaUniverse = Array.from(presidenciaUniverseSet).sort();

  const monthMap = new Map();
  records.forEach(r => {
    if(!r.valid) return;
    const key = r.anio + "-" + pad2(r.mes);
    monthMap.set(key, (monthMap.get(key)||0)+1);
  });
  const monthKeys = Array.from(monthMap.keys()).sort();

  return {
    fileName,
    totalRows: records.length,
    records,
    categories,
    invalidCount,
    empleadosTotal: legajosSet.size,
    minTs, maxTs,
    monthMap, monthKeys,
    unidades: Array.from(unidadesSet).sort(),
    sectores: Array.from(sectoresSet).sort(),
    gerencias: Array.from(gerenciasSet).sort(),
    departamentos: Array.from(departamentosSet).sort(),
    empresas: Array.from(empresasSet).sort(),
    hasUnidad: unidadesSet.size>0,
    hasMotivo,
    motivoUniverse,
    idMotivoUniverse,
    presidenciaUniverse, presidenciaCats
  };
}

/* ---- nombre de empresa: el del PLANTEL manda ----
   En el ausentismo una misma empresa puede venir con otra escritura ("DELFINO CLAUDIO" / "Delfino Claudio"). Se unifican
   (sin importar mayúsculas, acentos ni espacios sobrantes) y se muestra siempre como figura en el plantel; si la empresa no
   está en el plantel, se usa la escritura más frecuente en el ausentismo. */
function buildEmpresaCanon(plantel, parsedRaw){
  const canon = new Map(); // clave normalizada -> nombre que se muestra
  const pCount = new Map();
  (plantel||[]).forEach(p=>{
    if(!p.empresa) return;
    const k = normTxt(p.empresa);
    if(!pCount.has(k)) pCount.set(k, new Map());
    const m = pCount.get(k);
    m.set(p.empresa, (m.get(p.empresa)||0)+1);
  });
  pCount.forEach((m,k)=>{
    let best = null, bestN = -1;
    m.forEach((n,name)=>{ if(n>bestN){ best = name; bestN = n; } });
    canon.set(k, best);
  });
  const variants = new Map(); // empresas que no están en el plantel pero vienen con más de una escritura
  (parsedRaw.empresas||[]).forEach(name=>{
    const k = normTxt(name);
    if(canon.has(k)) return;
    if(!variants.has(k)) variants.set(k, []);
    variants.get(k).push(name);
  });
  const multi = Array.from(variants.entries()).filter(([k,arr])=>arr.length>1);
  if(multi.length){
    const counts = new Map();
    parsedRaw.records.forEach(r=>{ if(r.empresa) counts.set(r.empresa, (counts.get(r.empresa)||0)+1); });
    multi.forEach(([k,arr])=>{ arr.sort((a,b)=>(counts.get(b)||0)-(counts.get(a)||0)); canon.set(k, arr[0]); });
  }
  return canon;
}
function withCanonEmpresa(parsedRaw, plantel){
  if(!parsedRaw) return parsedRaw;
  const canon = buildEmpresaCanon(plantel, parsedRaw);
  const nameOf = n => canon.get(normTxt(n)) || n;
  const empresas = Array.from(new Set(parsedRaw.empresas.map(nameOf))).sort();
  const needsFix = empresas.length!==parsedRaw.empresas.length || parsedRaw.empresas.some(n=>nameOf(n)!==n);
  if(!needsFix) return parsedRaw;
  const records = parsedRaw.records.map(r=>{
    if(!r.empresa) return r;
    const c = nameOf(r.empresa);
    return c===r.empresa ? r : {...r, empresa:c};
  });
  return {...parsedRaw, records, empresas};
}

const AUS_UPDATE_CMP_FIELDS =["agrup","unidad","sector","gerencia","departamento","empresa","nombre","idMotivo","motivo","estado","razon","puesto","jefe","presidencia","sindicato","tipoContrat"];
function mergeAusentismoRecords(existingRecords, newRecords){
  const validExisting = existingRecords.filter(r=>r.valid);
  const invalidExisting = existingRecords.filter(r=>!r.valid);
  const validNew = newRecords.filter(r=>r.valid);
  const invalidNew = newRecords.filter(r=>!r.valid);

  const map = new Map();
  const order = [];
  validExisting.forEach(r=>{
    const key = (r.legajo||"").toUpperCase()+"|"+r.dateKey;
    map.set(key, r);
    order.push(key);
  });
  let nuevos=0, modificados=0, sinCambios=0;
  const changedRows = [];
  validNew.forEach(r=>{
    const key = (r.legajo||"").toUpperCase()+"|"+r.dateKey;
    if(map.has(key)){
      const prev = map.get(key);
      // si la carga nueva trae una columna opcional vacía, no borra el valor ya cargado para esa fila
      const mergedRow = {...r};
      AUS_UPDATE_CMP_FIELDS.forEach(f=>{ if(!mergedRow[f] && prev[f]) mergedRow[f] = prev[f]; });
      // la empresa se compara sin mayúsculas: escribirla distinto no es un cambio real
      const changed = AUS_UPDATE_CMP_FIELDS.some(f=> f==="empresa" ? normTxt(prev[f])!==normTxt(mergedRow[f]) : (prev[f]||"")!==(mergedRow[f]||""));
      map.set(key, mergedRow);
      if(changed){ modificados++; changedRows.push(mergedRow); } else sinCambios++;
    } else {
      map.set(key, r);
      order.push(key);
      nuevos++;
      changedRows.push(r);
    }
  });
  const merged = order.map(k=>map.get(k)).concat(invalidExisting).concat(invalidNew);
  return {merged, nuevos, modificados, sinCambios, nuevosInvalidos: invalidNew.length, changedRows};
}

function buildCategoryRows(records, categories){
  const counts = {};
  categories.forEach(c => counts[c]=0);
  let blank = 0;
  records.forEach(r => { if(r.agrup==="") blank++; else counts[r.agrup] = (counts[r.agrup]||0)+1; });
  const rows = categories.map(c => ({key:c, label:c, n:counts[c]||0}));
  rows.push({key:"__blank", label:"(vacío)", n:blank});
  const total = rows.reduce((a,r)=>a+r.n,0);
  return {rows, total};
}

function passesFilters(r, FILTERS, empresaIncluded, includeMes){
  if(FILTERS.departamento && r.departamento && !FILTERS.departamento.has(r.departamento)) return false;
  if(FILTERS.gerencia && r.gerencia && !FILTERS.gerencia.has(r.gerencia)) return false;
  if(FILTERS.sector && r.sector && !FILTERS.sector.has(r.sector)) return false;
  if(includeMes && FILTERS.mes && r.monthKey && !FILTERS.mes.has(r.monthKey)) return false;
  if(empresaIncluded && r.empresa && !empresaIncluded.has(r.empresa)) return false;
  return true;
}
function buildUnitsMap(rows){
  const map = new Map();
  rows.forEach(r=>{
    const key = r.unidad || "(Sin unidad)";
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  });
  return map;
}
function buildGroupMap(rows, field){
  const map = new Map();
  rows.forEach(r=>{
    const key = r[field] || "(Sin "+field+")";
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  });
  return map;
}
function unitStats(rows, excludedMotivos){
  const exMot = excludedMotivos || new Set();
  const dotSet = new Set(), daySet = new Set();
  let presentes=0, ausencias=0, excluded=0, vac=0, franco=0, ap=0, anp=0, baja=0, ce=0, apContado=0, anpContado=0;
  rows.forEach(r=>{
    if(r.legajo) dotSet.add(r.legajo.toUpperCase());
    daySet.add(r.dateKey);
    if(r.cat==="P") presentes++;
    else if(r.cat==="V") vac++;
    else if(r.cat==="F") franco++;
    else if(isCountedCat(r.cat)){
      if(r.cat==="AP") ap++; else anp++;
      if(exMot.has(motivoKeyOf(r))) excluded++;
      else { ausencias++; if(r.cat==="AP") apContado++; else anpContado++; }
    }
    else if(isExcludedCat(r.cat)){ excluded++; if(r.cat==="BAJA") baja++; else ce++; }
  });
  const total = rows.length;
  const base = total - excluded;
  const pct = base>0 ? ausencias/base*100 : 0;
  return {dotacion:dotSet.size, presentes, ausencias, excluded, vac, franco, ap, anp, apContado, anpContado, baja, ce, base, total, dias:daySet.size, pct};
}
/* ---- plantel: días activos / jornales de dotación ---- */
// cutoffTs = último día con datos cargados: el mes en curso se cuenta solo hasta esa fecha (no el mes completo).
function monthLastTs(year, month, cutoffTs){
  const last = Date.UTC(year, month-1, daysInMonth(month, year));
  return cutoffTs!=null && cutoffTs<last ? cutoffTs : last;
}
function activeDaysInMonth(altaTs, bajaTs, year, month, cutoffTs){
  const first = Date.UTC(year, month-1, 1);
  const last = monthLastTs(year, month, cutoffTs);
  const start = Math.max(altaTs, first);
  const end = bajaTs!=null ? Math.min(bajaTs, last) : last;
  if(end < start) return 0;
  return Math.round((end-start)/86400000) + 1;
}
function monthKeyParts(mk){ const [y,m] = mk.split("-"); return {year:+y, month:+m}; }
function plantelScopeStats(employees, monthKeys, cutoffTs){
  let jornalesDotacion = 0, diasPeriodo = 0, empleadosConsiderados = 0;
  const months = (monthKeys||[]).map(monthKeyParts);
  months.forEach(({year,month}) => {
    const first = Date.UTC(year, month-1, 1), last = monthLastTs(year, month, cutoffTs);
    if(last >= first) diasPeriodo += Math.round((last-first)/86400000) + 1;
  });
  employees.forEach(p => {
    let dias = 0;
    months.forEach(({year,month}) => { dias += activeDaysInMonth(p.altaTs, p.bajaTs, year, month, cutoffTs); });
    if(dias>0) empleadosConsiderados++;
    jornalesDotacion += dias;
  });
  const dotacionEquivalente = diasPeriodo>0 ? jornalesDotacion/diasPeriodo : 0;
  return {empleados: employees.length, empleadosConsiderados, diasPeriodo, jornalesDotacion, dotacionEquivalente};
}
function passesPlantelFilters(p, FILTERS, empresaIncluded){
  if(FILTERS.departamento && p.departamento && !FILTERS.departamento.has(p.departamento)) return false;
  if(FILTERS.gerencia && p.gerencia && !FILTERS.gerencia.has(p.gerencia)) return false;
  if(FILTERS.sector && p.sector && !FILTERS.sector.has(p.sector)) return false;
  if(empresaIncluded && p.empresa && !empresaIncluded.has(p.empresa)) return false;
  return true;
}
function semaforo(pct, objetivo){
  if(pct<=objetivo) return {level:"good", label:"En objetivo"};
  if(pct<=objetivo*1.15) return {level:"warn", label:"Alerta"};
  return {level:"bad", label:"Fuera de objetivo"};
}
function SemChip({pct, objetivo}){
  const sem = semaforo(pct, objetivo);
  return <span className={"schip "+sem.level}><span className="dot"></span>{sem.label}</span>;
}

const CATEGORY_SORT_COLS = {label:{get:r=>r.label, type:"text"}, n:{get:r=>r.n, type:"num"}};
function CategoryTable({title, caption, rows: rowsIn, total}){
  const {sorted: rows, sort, toggle} = useTableSort(rowsIn, CATEGORY_SORT_COLS);
  return (
    <div className="card table-card">
      <h3>{title}</h3>
      {caption && <div className="caption">{caption}</div>}
      <div className="overflow-x">
        <table>
          <thead>
            <tr><SortTh k="label" label="Agrupador cuadro presentismo" sort={sort} toggle={toggle} /><SortTh k="n" label="Cantidad" className="num" sort={sort} toggle={toggle} /></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td>
                  <span className="cat">
                    <span className="dot" style={{background: CAT_COLOR[r.key] || "var(--cat-blank)"}}></span>
                    {r.label}
                  </span>
                </td>
                <td className="num">{fmt(r.n)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Total</td>
              <td className="num">{fmt(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiTile({label, value, month}){
  return (
    <div className={"card kpi-tile" + (month ? " month" : "")}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{fmt(value)}</div>
    </div>
  );
}
function KTile({label, value}){
  return (
    <div className="ktile">
      <span className="kt-label">{label}</span>
      <span className="kt-value">{value}</span>
    </div>
  );
}
// incidencia de AP, ANP y Vacaciones sobre el mismo denominador que la tasa de ausentismo
function incidenciaStats(agg, plantelStats){
  const denom = plantelStats && plantelStats.jornalesDotacion>0 ? plantelStats.jornalesDotacion : agg.base;
  const pc = v => denom>0 ? v/denom*100 : 0;
  return {pctAp: pc(agg.apContado), pctAnp: pc(agg.anpContado), pctVac: pc(agg.vac)};
}
function KpiGroups({plantelActive, dotacion, plantelStats, agg}){
  const inc = incidenciaStats(agg, plantelActive ? plantelStats : null);
  return (
    <div className="kgroups no-print">
      <div className="kgroup">
        <div className="kgroup-head">Distribución Empleados</div>
        <div className="kgroup-tiles">
          <KTile label={plantelActive ? "Dotación equiv." : "Dotación"} value={fmt(dotacion)} />
          <KTile label="Jornales" value={fmt(plantelActive && plantelStats ? plantelStats.jornalesDotacion : 0)} />
        </div>
      </div>
      <div className="kgroup xwide">
        <div className="kgroup-head">Ausentismo</div>
        <div className="kgroup-tiles">
          <KTile label="Tasa de ausentismo" value={fmtPct(agg.pct,2)} />
          <KTile label="Total ausentes" value={fmt(agg.ausencias)} />
        </div>
        <div className="kgroup-tiles kt-detail">
          <KTile label="AP" value={fmt(agg.apContado)} />
          <KTile label="% AP" value={fmtPct(inc.pctAp,2)} />
          <KTile label="ANP" value={fmt(agg.anpContado)} />
          <KTile label="% ANP" value={fmtPct(inc.pctAnp,2)} />
        </div>
      </div>
      <div className="kgroup">
        <div className="kgroup-head">Tasa de Vacaciones</div>
        <div className="kgroup-tiles">
          <KTile label="Vacaciones" value={fmt(agg.vac)} />
          <KTile label="% s/ jornales" value={fmtPct(inc.pctVac,2)} />
        </div>
      </div>
    </div>
  );
}

/* ===================== multi-select filter ===================== */
function MultiSelect({label, options, selected, onChange, allLabel}){
  const [open,setOpen] = useState(false);
  const [search,setSearch] = useState("");
  const ref = useRef(null);
  useEffect(()=>{
    function onDoc(e){ if(ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("click", onDoc);
    return ()=>document.removeEventListener("click", onDoc);
  },[]);
  if(!options.length) return null;
  const total = options.length;
  const selSet = selected || new Set(options.map(o=>o.value));
  let toggleText;
  if(selSet.size===0) toggleText = "Ninguno";
  else if(selSet.size===total) toggleText = allLabel;
  else if(selSet.size<=2) toggleText = options.filter(o=>selSet.has(o.value)).map(o=>o.label).join(", ");
  else toggleText = fmt(selSet.size)+" seleccionados";
  const filtered = options.filter(o=> o.label.toLowerCase().includes(search.toLowerCase()));
  function toggleVal(v){
    const next = new Set(selSet);
    if(next.has(v)) next.delete(v); else next.add(v);
    onChange(next.size===total ? null : next);
  }
  return (
    <div className="msel" ref={ref}>
      <span className="msel-label">{label}</span>
      <button type="button" className="msel-toggle" onClick={()=>setOpen(o=>!o)}>{toggleText}</button>
      {open && (
        <div className="msel-menu">
          <input className="msel-search" placeholder="Buscar…" value={search} onChange={e=>setSearch(e.target.value)} />
          <div className="msel-menu-actions">
            <button type="button" onClick={()=>onChange(null)}>Todos</button>
            <button type="button" onClick={()=>onChange(new Set())}>Ninguno</button>
          </div>
          <div className="msel-options">
            {filtered.map(o=>(
              <label key={o.value} className="msel-opt">
                <input type="checkbox" checked={selSet.has(o.value)} onChange={()=>toggleVal(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
// Barra de "Selección rápida" de los cuadros de filtros: Todos · Ninguno · AP · ANP · Por defecto.
// all: todas las claves; apKeys/anpKeys: claves de categoría predominante AP / ANP (si no se pasan, no se muestran esos botones);
// defaultKeys: selección recomendada (si no se pasa, o es igual a "Todos", no se muestra); selected: Set de claves incluidas.
function QuickSelectBar({all, apKeys, anpKeys, defaultKeys, selected, onChange}){
  const sameAs = keys => keys.length===selected.size && keys.every(k=>selected.has(k));
  const presets = [{label:"Todos", title:"Incluir todos", keys:all}, {label:"Ninguno", title:"No incluir ninguno", keys:[]}];
  if(apKeys) presets.push({label:"AP", title:"Solo los de Ausente Pago", keys:apKeys});
  if(anpKeys) presets.push({label:"ANP", title:"Solo los de Ausente No Pago", keys:anpKeys});
  if(defaultKeys && !(defaultKeys.length===all.length)) presets.push({label:"Por defecto", title:"Selección recomendada", keys:defaultKeys});
  return (
    <div className="msel-menu-actions" style={{marginBottom:4, display:"flex", gap:8, flexWrap:"wrap", alignItems:"center"}}>
      <span className="hint" style={{margin:0}}>Selección rápida:</span>
      {presets.map(p=>(
        <button key={p.label} type="button" title={p.title} className="btn secondary"
          style={sameAs(p.keys) ? {padding:"5px 12px", fontSize:12.5, background:"var(--accent)", color:"var(--accent-ink)", borderColor:"var(--accent)"} : {padding:"5px 12px", fontSize:12.5}}
          onClick={()=>onChange(new Set(p.keys))}>{p.label}</button>
      ))}
      <span className="hint" style={{margin:0}}>{selected.size} de {all.length} incluidos</span>
    </div>
  );
}
// categoría predominante: AP si tiene más (o igual) días AP que ANP; ANP si tiene más ANP; sin ausencias no es ninguna
const isApItem = it => (it.ap||0)>0 && (it.ap||0)>=(it.anp||0);
const isAnpItem = it => (it.anp||0)>0 && (it.anp||0)>(it.ap||0);

// Cabecera de los cuadros de filtros: tocándola se expanden o se retraen. Arrancan retraídos (con un resumen de lo elegido) para
// no ocupar pantalla; solo se abren cuando hace falta filtrar. El estado abierto/cerrado se conserva al cambiar de menú.
function FilterCardHead({title, open, onToggle, summary}){
  return (
    <div role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
      onKeyDown={e=>{ if(e.key==="Enter" || e.key===" "){ e.preventDefault(); onToggle(); } }}
      style={{display:"flex", alignItems:"center", gap:10, cursor:"pointer", userSelect:"none", flexWrap:"wrap"}}>
      <h3 style={{margin:0}}>{title}</h3>
      {summary && <span className="hint" style={{margin:0}}>{summary}</span>}
      <span className="hint" style={{marginLeft:"auto", margin:"0 0 0 auto", fontWeight:700, color:"var(--accent)"}}>{open ? "▾ Retraer" : "▸ Expandir"}</span>
    </div>
  );
}

function EmpresaChecklist({options, included, onChange}){
  const [open, setOpen] = useKeptState("fc.open|Empresa", false);
  if(!options.length) return null;
  const inc = included || new Set(options);
  return (
    <div className="card motivo-settings">
      <FilterCardHead title="Empresa" open={open} onToggle={()=>setOpen(o=>!o)} summary={options.filter(n=>inc.has(n)).length+" de "+options.length+" incluidas"} />
      {open && (
        <React.Fragment>
          <QuickSelectBar all={options} selected={inc} onChange={next=>onChange(next.size===options.length ? null : next)} />
          <p className="hint">Incluí o excluí legajos según la empresa que los emplea (propios, contratistas). Se aplica a toda la base. Tildada = incluida.</p>
          <div className="motivo-checklist">
            {options.map(name=>(
              <label key={name} className="motivo-check">
                <input type="checkbox" checked={inc.has(name)} onChange={()=>{
                  const next = new Set(inc);
                  if(next.has(name)) next.delete(name); else next.add(name);
                  onChange(next.size===options.length ? null : next);
                }} />
                {name}
              </label>
            ))}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

/* ===================== charts ===================== */
function RankingChart({units, objetivo}){
  if(!units.length) return <div className="hint">Sin datos para mostrar con estos filtros.</div>;
  const rowH=40, topPad=14, chartW=640;
  const maxVal = Math.max(objetivo*1.3, ...units.map(u=>u.pct))*1.08 || 1;
  const H = topPad*2 + rowH*units.length + 22;
  const labelW=170, barX0=labelW, barMaxW=chartW-labelW-70;
  const steps=4, gridLines=[];
  for(let i=0;i<=steps;i++){ const v=maxVal*i/steps; gridLines.push({x:barX0+barMaxW*v/maxVal, v}); }
  const tx = barX0 + barMaxW*objetivo/maxVal;
  return (
    <svg className="chart" viewBox={"0 0 "+chartW+" "+H}>
      {gridLines.map((g,i)=>(
        <g key={i}>
          <line x1={g.x} x2={g.x} y1={topPad-4} y2={H-18} stroke="var(--grid)" strokeWidth="1" />
          <text x={g.x} y={H-6} fontSize="10" textAnchor="middle" fill="var(--muted)">{g.v.toFixed(0)}%</text>
        </g>
      ))}
      <line x1={tx} x2={tx} y1={topPad-4} y2={H-18} stroke="var(--critical)" strokeWidth="1.5" strokeDasharray="3,3" />
      <text x={tx} y={topPad-4} fontSize="10" textAnchor="middle" fill="var(--critical)">Objetivo {fmtPct(objetivo,1)}</text>
      {units.map((u,i)=>{
        const y = topPad + 6 + i*rowH, barH=16;
        const w = Math.max(2, barMaxW*u.pct/maxVal);
        const sem = semaforo(u.pct, objetivo);
        const color = sem.level==="good"?"var(--good)":sem.level==="warn"?"var(--warning)":"var(--critical)";
        return (
          <g key={u.name}>
            <text x={labelW-10} y={y+barH/2+4} fontSize="12" textAnchor="end" fill="var(--ink)">{u.name.length>22?u.name.slice(0,21)+"…":u.name}</text>
            <rect x={barX0} y={y} width={barMaxW} height={barH} rx="4" fill="var(--plane)" />
            <rect x={barX0} y={y} width={w} height={barH} rx="4" fill={color}>
              <title>{u.name}: {fmtPct(u.pct,1)} — Dotación {fmt(u.dotacionEquivalente!=null ? u.dotacionEquivalente : u.dotacion)}, Ausencias {fmt(u.ausencias)}</title>
            </rect>
            <text x={barX0+w+8} y={y+barH/2+4} fontSize="12" fontWeight="700" fill="var(--ink)">{fmtPct(u.pct,1)}</text>
          </g>
        );
      })}
    </svg>
  );
}
function EvolutionChart({months, series, objetivo}){
  if(!months.length || !series.length) return <div className="hint">Sin datos para mostrar con estos filtros.</div>;
  const chartW=640,chartH=300,padL=44,padR=16,padT=16,padB=32;
  const plotW=chartW-padL-padR, plotH=chartH-padT-padB;
  const allVals = series.flatMap(s=>s.pts);
  const maxVal = Math.max(objetivo*1.3, ...allVals, 0.001)*1.1;
  const steps=4, gridLines=[];
  for(let i=0;i<=steps;i++){ const v=maxVal*i/steps; gridLines.push({y:padT+plotH-plotH*v/maxVal, v}); }
  const ty = padT+plotH-plotH*objetivo/maxVal;
  function xAt(i){ return padL + plotW*(months.length===1?0.5:i/(months.length-1)); }
  return (
    <svg className="chart" viewBox={"0 0 "+chartW+" "+chartH}>
      {gridLines.map((g,i)=>(
        <g key={i}>
          <line x1={padL} x2={chartW-padR} y1={g.y} y2={g.y} stroke="var(--grid)" strokeWidth="1" />
          <text x={padL-8} y={g.y+3} fontSize="10" textAnchor="end" fill="var(--muted)">{g.v.toFixed(0)}%</text>
        </g>
      ))}
      {months.map((mk,i)=>(<text key={mk} x={xAt(i)} y={chartH-10} fontSize="10" textAnchor="middle" fill="var(--muted)">{monthLabel(mk)}</text>))}
      <line x1={padL} x2={chartW-padR} y1={ty} y2={ty} stroke="var(--critical)" strokeWidth="1.5" strokeDasharray="3,3" />
      {series.map(s=>{
        const d = s.pts.map((v,i)=>(i===0?"M":"L")+xAt(i).toFixed(1)+","+(padT+plotH-plotH*v/maxVal).toFixed(1)).join(" ");
        const lastY = padT+plotH-plotH*s.pts[s.pts.length-1]/maxVal;
        return (
          <g key={s.name}>
            <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            {s.pts.map((v,i)=>(
              <circle key={i} cx={xAt(i)} cy={padT+plotH-plotH*v/maxVal} r="3.5" fill={s.color}>
                <title>{s.name} — {monthLabel(months[i])}: {fmtPct(v,1)}</title>
              </circle>
            ))}
            <text x={xAt(s.pts.length-1)+6} y={lastY+3} fontSize="10" fontWeight="700" fill="var(--ink)">{fmtPct(s.pts[s.pts.length-1],1)}</text>
          </g>
        );
      })}
    </svg>
  );
}
const COMPOSITION_CATS = [
  {key:"ausC", label:"Ausencia (contabilizada)", color:"var(--critical)"},
  {key:"ausX", label:"Ausencia (excluida)", color:"var(--muted)"}
];
const AP_ANP_CATS = [
  {key:"ap", label:"AP (Ausente pago)", color:"var(--cat-ap)"},
  {key:"anp", label:"ANP (Ausente no pago)", color:"var(--cat-anp)"}
];
function CompositionChart({units, cats}){
  const CATS = cats || COMPOSITION_CATS;
  if(!units.length) return <div className="hint">Sin datos para mostrar con estos filtros.</div>;
  const chartW=640, rowH=34, topPad=8;
  const H = topPad*2+rowH*units.length;
  const labelW=160, barX0=labelW, barW=chartW-labelW-16;
  return (
    <React.Fragment>
      <svg className="chart" viewBox={"0 0 "+chartW+" "+H}>
        {units.map((u,i)=>{
          const y = topPad+i*rowH;
          const total = CATS.reduce((a,cat)=>a+(u[cat.key]||0),0) || 1;
          let x = barX0;
          const segs = [];
          CATS.forEach(cat=>{
            const v = u[cat.key]||0;
            const w = Math.max(0, barW*v/total - 2);
            if(w>0){
              segs.push(<rect key={cat.key} x={x} y={y+7} width={w} height={20} rx="3" fill={cat.color}><title>{u.name} — {cat.label}: {fmt(v)} ({fmtPct(v/total*100,1)})</title></rect>);
              x += w+2;
            }
          });
          return (
            <g key={u.name}>
              <text x={labelW-10} y={y+rowH/2+4} fontSize="12" textAnchor="end" fill="var(--ink)">{u.name.length>20?u.name.slice(0,19)+"…":u.name}</text>
              {segs}
            </g>
          );
        })}
      </svg>
      <div className="legend">
        {CATS.map(c=>(<div key={c.key} className="item"><span className="swatch" style={{background:c.color}}></span>{c.label}</div>))}
      </div>
    </React.Fragment>
  );
}
function MotivoChart({entries}){
  if(!entries.length) return <div className="hint">No hay ausencias contabilizadas (AP/ANP) con los filtros actuales.</div>;
  const total = entries.reduce((a,e)=>a+e.count,0);
  const chartW=640, rowH=30, topPad=8;
  const H = topPad*2+rowH*entries.length;
  const labelW=200, barX0=labelW, barMaxW=chartW-labelW-70;
  const maxCount = Math.max(...entries.map(e=>e.count));
  return (
    <svg className="chart" viewBox={"0 0 "+chartW+" "+H}>
      {entries.map((e,i)=>{
        const y=topPad+i*rowH, barY=y+6, barH=14;
        const w = Math.max(2, barMaxW*e.count/maxCount);
        return (
          <g key={e.label}>
            <text x={labelW-10} y={barY+barH/2+4} fontSize="12" textAnchor="end" fill="var(--ink)">{e.label.length>30?e.label.slice(0,29)+"…":e.label}</text>
            <rect x={barX0} y={barY} width={w} height={barH} rx="3" fill="var(--accent)"><title>{e.label}: {fmt(e.count)} ({fmtPct(e.count/total*100,1)})</title></rect>
            <text x={barX0+w+8} y={barY+barH/2+4} fontSize="11" fill="var(--ink)">{fmtPct(e.count/total*100,1)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ===================== auditor de tablas ===================== */
const AUDIT_COLS = ["Legajo","Empleado","Unidad","Departamento","Gerencia","Sector","Empresa","Fecha","Agrupador","Id Motivo","Motivo"];
function auditRowArr(r){
  return [r.legajo, r.nombre, r.unidad, r.departamento, r.gerencia, r.sector, r.empresa,
    fmtDate(r.dia,r.mes,r.anio), (r.agrup||"(vacío)"), r.idMotivo, r.motivo];
}
function fmtDateFromTs(ts){ const d = new Date(ts); return fmtDate(d.getUTCDate(), d.getUTCMonth()+1, d.getUTCFullYear()); }
function calcEdad(birthTs){
  if(birthTs==null) return null;
  const birth = new Date(birthTs);
  const now = new Date();
  let age = now.getFullYear() - birth.getUTCFullYear();
  const beforeBirthdayThisYear = (now.getMonth()+1 < birth.getUTCMonth()+1) || (now.getMonth()+1===birth.getUTCMonth()+1 && now.getDate()<birth.getUTCDate());
  if(beforeBirthdayThisYear) age--;
  return age;
}

/* ===================== feriados argentina (para no cortar rachas de crónicos) ===================== */
// Cubre feriados nacionales fijos + móviles calculados por ley (Pascua, tercer lunes de agosto, etc.).
// No incluye "feriados puente" decretados año a año sin regla fija — si hace falta, se pueden sumar
// fechas puntuales a mano en EXTRA_FERIADOS más abajo.
const EXTRA_FERIADOS = new Set([
  // "2026-05-22", // ejemplo: agregar acá un feriado puente puntual como "YYYY-MM-DD"
]);
function easterSundayUTC(year){
  const a = year % 19, b = Math.floor(year/100), c = year % 100;
  const d = Math.floor(b/4), e = b % 4, f = Math.floor((b+8)/25);
  const g = Math.floor((b-f+1)/3), h = (19*a+b-d-g+15) % 30;
  const i = Math.floor(c/4), k = c % 4, l = (32+2*e+2*i-h-k) % 7;
  const m = Math.floor((a+11*h+22*l)/451);
  const month = Math.floor((h+l-7*m+114)/31);
  const day = ((h+l-7*m+114) % 31) + 1;
  return Date.UTC(year, month-1, day);
}
function movableToMondayUTC(year, month, day){
  const ts = Date.UTC(year, month-1, day);
  const dow = new Date(ts).getUTCDay(); // 0=domingo..6=sabado
  let offsetDays;
  if(dow===1) offsetDays = 0;
  else if(dow>=2 && dow<=4) offsetDays = -(dow-1);
  else offsetDays = (8-dow)%7;
  return ts + offsetDays*86400000;
}
function tsToYmd(ts){ const d = new Date(ts); return d.getUTCFullYear()+"-"+pad2(d.getUTCMonth()+1)+"-"+pad2(d.getUTCDate()); }
const feriadosCache = new Map();
function computeArgFeriados(year){
  if(feriadosCache.has(year)) return feriadosCache.get(year);
  const set = new Set();
  const addFixed = (m,d)=> set.add(tsToYmd(Date.UTC(year,m-1,d)));
  addFixed(1,1); addFixed(5,1); addFixed(5,25); addFixed(6,20); addFixed(7,9);
  addFixed(12,8); addFixed(12,25); addFixed(4,2); addFixed(6,17);
  const easter = easterSundayUTC(year);
  set.add(tsToYmd(easter - 48*86400000)); // lunes de carnaval
  set.add(tsToYmd(easter - 47*86400000)); // martes de carnaval
  set.add(tsToYmd(easter - 2*86400000));  // viernes santo
  // San Martín: tercer lunes de agosto
  let mondays = 0;
  for(let day=1; day<=31; day++){
    const ts = Date.UTC(year,7,day);
    if(new Date(ts).getUTCMonth()!==7) break;
    if(new Date(ts).getUTCDay()===1){ mondays++; if(mondays===3){ set.add(tsToYmd(ts)); break; } }
  }
  set.add(tsToYmd(movableToMondayUTC(year,10,12))); // diversidad cultural
  set.add(tsToYmd(movableToMondayUTC(year,11,20))); // soberanía nacional
  feriadosCache.set(year, set);
  return set;
}
function isArgFeriado(ts){
  if(EXTRA_FERIADOS.has(tsToYmd(ts))) return true;
  return computeArgFeriados(new Date(ts).getUTCFullYear()).has(tsToYmd(ts));
}
function isNonWorkingGapDay(ts){
  const dow = new Date(ts).getUTCDay();
  if(dow===0 || dow===6) return true;
  return isArgFeriado(ts);
}
function gapIsBridgeable(prevTs, curTs){
  for(let t=prevTs+86400000; t<curTs; t+=86400000){
    if(!isNonWorkingGapDay(t)) return false;
  }
  return true;
}

/* ===================== crónicos ===================== */
// Selección "Por defecto" de los motivos que generan un caso crónico (la selección vigente al 13/10/2026).
const CRONICOS_DEFAULT_MOTIVOS = new Set(["AT","CA","CAE","CJ","DS","EFS","EN","ET","EX","FA","LSS","MA","MT","MU","NAC","PH","PRD","RP","SA","SUS"]);
const CRONICO_TIPOS =["", "ACTUAL", "CRONICO", "RES PTO", "PROC BAJA"];
const CRONICO_TIPO_ORDEN = ["RES PTO", "CRONICO", "ACTUAL", "PROC BAJA"];
function sanitizeIdSeg(s){ const c = (s||"").toString().toUpperCase().replace(/[^A-Z0-9_\-.~:@+]/g,""); return c || "X"; }
function cronicoCaseId(legajo, motivoKey, anio){ return sanitizeIdSeg(legajo)+"-"+sanitizeIdSeg(motivoKey)+"-"+sanitizeIdSeg(anio); }
function cronicoTipoAuto(c){
  const mk = (c.codpla||"").toUpperCase();
  if(mk==="RP") return "RES PTO";
  if(mk==="PRD") return "PROC BAJA";
  if(cronicoDias(c.inicioTs) > 10) return "CRONICO";
  return "ACTUAL";
}
// Estado de alerta de la fila según la fecha de "Notificar Res. Puesto" (c.notificar, "YYYY-MM-DD"):
// "alert" (rojo) el día de la notificación o después; "warn" (naranja) durante la semana previa; si no, null.
function cronicoNotificarStatus(c){
  const ts = isoDateToTs(c.notificar);
  if(ts==null) return null;
  const now = new Date();
  const todayTs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if(todayTs >= ts) return "alert";
  if(todayTs >= ts - 7*86400000) return "warn";
  return null;
}
function cronicoDias(inicioTs){
  const now = new Date();
  const todayTs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((todayTs-inicioTs)/86400000) + 1;
}
// agrupa los días de una racha en tramos consecutivos con la misma categoría y motivo (para la historia clínica)
function groupStreakTramos(rows){
  const tramos = [];
  rows.forEach(r=>{
    const label = motivoLabelOf(r), cat = r.cat;
    const last = tramos[tramos.length-1];
    if(last && last.label===label && last.cat===cat){ last.hastaTs = r.ts; last.dias++; }
    else tramos.push({desdeTs:r.ts, hastaTs:r.ts, label, cat, dias:1});
  });
  return tramos;
}
function buildCronicoCases(records, plantel, motivoIncluded){
  if(!motivoIncluded || !motivoIncluded.size) return [];
  // Fila que puede formar un caso: una ausencia (AP/ANP) o cualquier día cuyo Id Motivo esté tildado en el filtro (ej. VAC, que no es AP/ANP).
  const esCaso = r => r.cat==="AP" || r.cat==="ANP" || (!!r.idMotivo && motivoIncluded.has(motivoKeyOf(r)));
  const byLegajo = new Map();
  records.forEach(r=>{
    if(!r.valid || !r.legajo) return;
    if(!esCaso(r)) return;
    const k = r.legajo.toUpperCase();
    if(!byLegajo.has(k)) byLegajo.set(k, []);
    byLegajo.get(k).push(r);
  });
  const plantelByLegajo = new Map((plantel||[]).map(p=>[(p.legajo||"").toUpperCase(), p]));
  const lastRecordByLegajo = new Map();
  records.forEach(r=>{
    if(!r.valid || !r.legajo) return;
    const k = r.legajo.toUpperCase();
    const prev = lastRecordByLegajo.get(k);
    if(!prev || r.ts>prev.ts) lastRecordByLegajo.set(k, r);
  });

  const cases = [];
  byLegajo.forEach((rowsIn, legU)=>{
    const rows = rowsIn.slice().sort((a,b)=>a.ts-b.ts);
    // Arma "rachas" continuas: toleran huecos de fin de semana/feriado (sin corte) y días
    // marcados "CA — Con aviso" (no cortan ni cambian el motivo de la racha, en cualquier sentido).
    // Cualquier otro cambio de motivo, o un hueco que incluya un día hábil sin registrar, corta la racha.
    const streaks = [];
    let streakStart=null, streakMotivoKey=null, streakRows=[], prevTs=null;
    rows.forEach(r=>{
      const mk = motivoKeyOf(r);
      const isCA = mk==="CA";
      if(streakStart===null){
        streakStart=r.ts; streakMotivoKey=mk; streakRows=[r]; prevTs=r.ts;
        return;
      }
      const contiguous = r.ts===prevTs || gapIsBridgeable(prevTs, r.ts);
      const sameMotivo = isCA || streakMotivoKey==="CA" || mk===streakMotivoKey;
      if(contiguous && sameMotivo){
        streakRows.push(r);
        if(!isCA) streakMotivoKey = mk;
        prevTs = r.ts;
      } else {
        streaks.push({start:streakStart, motivoKey:streakMotivoKey, rows:streakRows});
        streakStart=r.ts; streakMotivoKey=mk; streakRows=[r]; prevTs=r.ts;
      }
    });
    if(streakStart!==null) streaks.push({start:streakStart, motivoKey:streakMotivoKey, rows:streakRows});

    // sólo la racha más reciente puede ser un caso activo
    const lastStreak = streaks[streaks.length-1];
    if(!lastStreak) return;
    if(!motivoIncluded.has(lastStreak.motivoKey)) return;

    const first = lastStreak.rows[0], last = lastStreak.rows[lastStreak.rows.length-1];
    const p = plantelByLegajo.get(legU);
    // sólo casos que siguen vigentes: el último registro cargado de ese legajo (de todo el archivo)
    // todavía es parte de esta racha — si ya volvió a "P" o cambió de motivo, el caso se cerró.
    const lastRec = lastRecordByLegajo.get(legU);
    const continua = lastRec && esCaso(lastRec) && lastRec.ts===last.ts;
    if(!continua) return;
    // sólo empleados activos: con plantel, sin fecha de baja; sin plantel, que su último registro no sea CE/BAJA.
    const activo = p ? (p.bajaTs==null) : (lastRec.cat!=="CE" && lastRec.cat!=="BAJA");
    if(!activo) return;
    // para mostrar el motivo/diagnóstico, preferir una fila real (no CA) dentro de la racha
    const motivoRow = lastStreak.rows.slice().reverse().find(r=>motivoKeyOf(r)!=="CA") || last;
    // "Motivo - Razón": la razón es la que figura en la fila más reciente de la racha que la tenga cargada
    const razonRow = lastStreak.rows.slice().reverse().find(r=>motivoKeyOf(r)!=="CA" && r.razon) || lastStreak.rows.slice().reverse().find(r=>r.razon);
    const razon = razonRow ? razonRow.razon : "";
    cases.push({
      id: cronicoCaseId(first.legajo, lastStreak.motivoKey, first.anio),
      legajo: first.legajo,
      anio: first.anio,
      nombre: last.nombre || first.nombre || (p ? p.nombre : "") || "",
      grupo: last.departamento || first.departamento || "",
      sindicato: last.sindicato || first.sindicato || "",
      gerencia: last.gerencia || first.gerencia || "",
      codpla: (motivoRow.idMotivo || first.idMotivo || "").toUpperCase(),
      motivoLabel: motivoLabelOf(motivoRow) + (razon ? " - " + razon : ""),
      razon,
      // unidad de negocio actual: la del plantel; si el legajo no está, la de sus registros de ausentismo
      unidad: (p && p.unidad) || last.unidad || first.unidad || "",
      inicioTs: first.ts,
      ultimaTs: last.ts,
      filas: lastStreak.rows.length,
      fechaIngresoTs: p ? p.altaTs : null,
      tramos: groupStreakTramos(lastStreak.rows)
    });
  });
  return cases.sort((a,b)=> b.inicioTs-a.inicioTs);
}
const AUDIT_COLS_PLANTEL = ["Legajo","Nombre","Unidad","Sector","Gerencia","Departamento","Empresa","Fecha Alta","Fecha Baja","Días activos en el período"];
function auditPlantelRowArr(p){
  return [p.legajo, p.nombre, p.unidad, p.sector, p.gerencia, p.departamento, p.empresa,
    p.altaTs!=null ? fmtDateFromTs(p.altaTs) : "—",
    p.bajaTs!=null ? fmtDateFromTs(p.bajaTs) : "—",
    fmt(p._diasActivos||0)];
}
/* ---- orden de tablas: clic en el encabezado ordena (números y fechas de mayor a menor primero; texto de la A a la Z primero) ---- */
// Convierte un valor mostrado ("1.234", "12,5%", "04/10/2026") en número para poder ordenarlo; null si es texto.
function sortNumOf(v){
  if(typeof v==="number") return isNaN(v) ? null : v;
  const s = String(v==null?"":v).trim();
  const d = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if(d) return (+d[3])*10000 + (+d[2])*100 + (+d[1]);
  if(/^-?\d{1,3}(\.\d{3})+(,\d+)?%?$/.test(s) || /^-?\d+(,\d+)?%?$/.test(s) || /^-?\d+\.\d+%?$/.test(s)) return parseFloat(s.replace(/\./g,"").replace(",",".").replace("%",""));
  return null;
}
function smartCompare(x, y){
  const nx = sortNumOf(x), ny = sortNumOf(y);
  if(nx!=null && ny!=null) return nx-ny;
  return String(x==null?"":x).localeCompare(String(y==null?"":y), "es", {sensitivity:"base", numeric:true});
}
// cols: {clave: {get: fila=>valor, type:"num"|"text"}}. Devuelve las filas ordenadas, el estado y el alternador.
function useTableSort(rows, cols, initial){
  const [sort, setSort] = useState(initial||null);
  let sorted = rows;
  if(sort && cols[sort.key]){
    const col = cols[sort.key], dir = sort.dir==="asc" ? 1 : -1;
    sorted = rows.slice().sort((a,b)=>{
      const va = col.get(a), vb = col.get(b);
      return (col.type==="num" ? ((va||0)-(vb||0)) : smartCompare(va, vb)) * dir;
    });
  }
  function toggle(key){
    setSort(prev => (prev && prev.key===key)
      ? {key, dir: prev.dir==="asc" ? "desc" : "asc"}
      : {key, dir: (cols[key] && cols[key].type==="num") ? "desc" : "asc"});
  }
  return {sorted, sort, toggle};
}
function SortTh({label, k, sort, toggle, className, style}){
  const active = !!sort && sort.key===k;
  return (
    <th className={className} title="Ordenar" aria-sort={active ? (sort.dir==="asc" ? "ascending" : "descending") : "none"}
      style={{cursor:"pointer", userSelect:"none", whiteSpace:"nowrap", ...style}} onClick={()=>toggle(k)}>
      {label}{active ? (sort.dir==="asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

function AuditModal({title, rows, onClose, cols, rowToArr}){
  const columns = cols || AUDIT_COLS;
  const toArr = rowToArr || auditRowArr;
  const [copied, setCopied] = useState("idle");
  const [sort, setSort] = useState(null); // {i: índice de columna, dir}
  const prepared = useMemo(()=> rows.map(r=>({r, a: toArr(r)})), [rows]);
  const sortedPrepared = useMemo(()=>{
    if(!sort) return prepared;
    const dir = sort.dir==="asc" ? 1 : -1;
    return prepared.slice().sort((p,q)=> smartCompare(p.a[sort.i], q.a[sort.i]) * dir);
  }, [prepared, sort]);
  function toggleSort(i){
    setSort(prev=>{
      if(prev && prev.i===i) return {i, dir: prev.dir==="asc" ? "desc" : "asc"};
      const sample = prepared.find(p=>p.a[i]!=null && String(p.a[i]).trim()!=="" && String(p.a[i]).trim()!=="—");
      return {i, dir: sample && sortNumOf(sample.a[i])!=null ? "desc" : "asc"};
    });
  }
  function toCsv(){
    const lines = [columns.join(";")];
    sortedPrepared.forEach(p => lines.push(p.a.map(v=>String(v==null?"":v).replace(/;/g,",")).join(";")));
    return lines.join("\n");
  }
  async function handleCopy(){
    const csv = toCsv();
    try{
      await navigator.clipboard.writeText(csv);
      setCopied("ok");
    }catch(e){
      try{
        const ta = document.createElement("textarea");
        ta.value = csv; ta.style.position="fixed"; ta.style.opacity="0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied("ok");
      }catch(e2){ setCopied("err"); }
    }
    setTimeout(()=>setCopied("idle"), 2500);
  }
  const preview = sortedPrepared.slice(0,200);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={e=>e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="btn secondary small" onClick={onClose}>Cerrar</button>
        </div>
        <p className="hint">{fmt(rows.length)} fila{rows.length===1?"":"s"} encontrada{rows.length===1?"":"s"}{rows.length>200 ? " — mostrando las primeras 200 en pantalla" : ""}. Los enlaces de descarga no funcionan dentro de este artifact, así que copiá el detalle completo y pegalo en Excel.</p>
        <button type="button" className="btn small" onClick={handleCopy} disabled={!rows.length}>
          {copied==="ok" ? "Copiado ✓" : copied==="err" ? "No se pudo copiar" : "Copiar detalle (CSV)"}
        </button>
        <div className="overflow-x modal-table-wrap">
          <table>
            <thead><tr>{columns.map((c,i)=>(
              <th key={c} title="Ordenar" aria-sort={sort && sort.i===i ? (sort.dir==="asc" ? "ascending" : "descending") : "none"}
                style={{cursor:"pointer", userSelect:"none", whiteSpace:"nowrap"}} onClick={()=>toggleSort(i)}>
                {c}{sort && sort.i===i ? (sort.dir==="asc" ? " ▲" : " ▼") : ""}
              </th>
            ))}</tr></thead>
            <tbody>
              {!preview.length && <tr><td colSpan={columns.length} style={{textAlign:"center",color:"var(--muted)",padding:"14px 0"}}>Sin filas.</td></tr>}
              {preview.map((p,i)=>(<tr key={i}>{p.a.map((v,j)=><td key={j}>{v}</td>)}</tr>))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
function CellLink({onClick, children}){
  return <button type="button" className="cell-link" onClick={onClick}>{children}</button>;
}

// Los motivos tildados son los que CUENTAN como ausentismo. Internamente se sigue guardando el conjunto de
// motivos NO incluidos ("excluded"), por eso tildar = sacarlo de ese conjunto.
function MotivoChecklist({motivoUniverse, excluded, onChange, onAudit}){
  const [open, setOpen] = useKeptState("fc.open|Motivos de Ausencia (AP/ANP) incluidos en el cálculo", false);
  if(!motivoUniverse.length) return null;
  const isAp = m => (m.ap||0) >= (m.anp||0); // categoría predominante del motivo
  const presets = [
    {label:"Todos", title:"Cuentan todos los motivos", excludedKeys: []},
    {label:"Ninguno", title:"No cuenta ningún motivo", excludedKeys: motivoUniverse.map(m=>m.key)},
    {label:"AP", title:"Solo los motivos de Ausente Pago", excludedKeys: motivoUniverse.filter(m=>!isAp(m)).map(m=>m.key)},
    {label:"ANP", title:"Solo los motivos de Ausente No Pago", excludedKeys: motivoUniverse.filter(m=>isAp(m)).map(m=>m.key)},
    {label:"Por defecto", title:"Selección recomendada de la tabla fija de motivos", excludedKeys: motivoUniverse.filter(m=>isDefaultExcludedMotivoKey(m.key)).map(m=>m.key)}
  ];
  const sameAs = keys => keys.length===excluded.size && keys.every(k=>excluded.has(k));
  const incluidos = motivoUniverse.filter(m=>!excluded.has(m.key)).length;
  return (
    <div className="card motivo-settings">
      <FilterCardHead title="Motivos de Ausencia (AP/ANP) incluidos en el cálculo" open={open} onToggle={()=>setOpen(o=>!o)} summary={incluidos+" de "+motivoUniverse.length+" motivos incluidos"} />
      {open && (
      <React.Fragment>
      <p className="hint">Tildá los motivos que querés que cuenten como ausentismo. Aunque el Agrupador los marque AP/ANP, los que dejes sin tildar no cuentan (bajas, suspensiones, licencias especiales, etc.). Se recalcula todo al instante, en todas las pestañas. La selección rápida AP / ANP elige los motivos según su categoría predominante. Hacé clic en la cantidad para ver y copiar el detalle.</p>
      <div className="msel-menu-actions" style={{marginBottom:10, display:"flex", gap:8, flexWrap:"wrap", alignItems:"center"}}>
        <span className="hint" style={{margin:0}}>Selección rápida:</span>
        {presets.map(p=>(
          <button key={p.label} type="button" title={p.title} className="btn secondary"
            style={sameAs(p.excludedKeys) ? {padding:"5px 12px", fontSize:12.5, background:"var(--accent)", color:"var(--accent-ink)", borderColor:"var(--accent)"} : {padding:"5px 12px", fontSize:12.5}}
            onClick={()=>onChange(new Set(p.excludedKeys))}>{p.label}</button>
        ))}
        <span className="hint" style={{margin:0}}>{incluidos} de {motivoUniverse.length} motivos incluidos</span>
      </div>
      <div className="motivo-checklist">
        {motivoUniverse.map(m=>(
          <label key={m.key} className="motivo-check">
            <input type="checkbox" checked={!excluded.has(m.key)} onChange={()=>{
              const next = new Set(excluded);
              if(next.has(m.key)) next.delete(m.key); else next.add(m.key);
              onChange(next);
            }} />
            {m.label} (<CellLink onClick={(e)=>{ e.preventDefault(); e.stopPropagation(); onAudit(m); }}>{fmt(m.count)}</CellLink>)
          </label>
        ))}
      </div>
      </React.Fragment>
      )}
    </div>
  );
}

const MOTIVO_REF_SORT_COLS = {key:{get:m=>m.key, type:"text"}, label:{get:m=>m.refLabel, type:"text"}, incluir:{get:m=>m.incluir?1:0, type:"num"}};
function DefaultMotivoRefTable(){
  const {sorted, sort, toggle} = useTableSort(DEFAULT_MOTIVO_TABLE, MOTIVO_REF_SORT_COLS);
  return (
    <div className="card table-card">
      <h3>Tabla fija — Motivos de Ausencia por defecto</h3>
      <p className="caption">Referencia fija usada como preselección en "Motivos de Ausencia incluidos" (Resumen) y en "Id Motivo a incluir" (Ranking). Se puede editar libremente en esas pestañas — esta tabla no cambia.</p>
      <div className="overflow-x">
        <table>
          <thead><tr><SortTh k="key" label="Código" sort={sort} toggle={toggle} /><SortTh k="label" label="Motivo" sort={sort} toggle={toggle} /><SortTh k="incluir" label="Incluir" sort={sort} toggle={toggle} /></tr></thead>
          <tbody>
            {sorted.map(m=>(
              <tr key={m.key}>
                <td>{m.key}</td>
                <td>{m.refLabel}</td>
                <td><span className={"toggle-pill "+(m.incluir?"yes":"no")}>{m.incluir?"SÍ":"NO"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ===================== gestión de plantel ===================== */
// cutoffTs: primer día del primer mes con datos de ausentismo. Los empleados con baja anterior a esa fecha no aportan
// ningún día a la dotación ni a los jornales, así que no se cargan (se pueden subir los archivos completos sin recortarlos a mano).
function buildPlantelPreview(rows2d, mapping, existingPlantel, cutoffTs){
  const header = rows2d[0] || [];
  const dataRows = rows2d.slice(1);
  const idxIngreso = findColByAliases(header, ["Fecha de Ingreso","Fecha Ingreso"]);
  const existingByLegajo = new Map(existingPlantel.map(p=>[p.legajo, p]));
  const seen = new Set();
  const records = [];
  const changedRecords = [];
  const errors = [];
  let nuevos = 0, modificados = 0, sinCambios = 0, descartados = 0;
  const FIELD_KEYS = ["unidad","sector","gerencia","departamento","empresa","grupo","estado","nombre","puesto","jefe","celular"];
  dataRows.forEach((row, i) => {
    const excelRow = i + 2 + (rows2d.headerOffset||0);   // número de fila real del Excel (si hay títulos arriba de los encabezados)
    const legajo = cellStr(row, mapping.legajo).trim();
    if(legajo===""){ errors.push({row:excelRow, legajo:"(vacío)", problem:"Legajo vacío"}); return; }
    const legajoKey = legajo.toUpperCase();
    if(seen.has(legajoKey)){ errors.push({row:excelRow, legajo, problem:"Legajo duplicado dentro del archivo"}); return; }
    // Baja anterior al primer mes con datos: no aporta días, se descarta aunque le falte la fecha de alta (no cuenta como error).
    if(cutoffTs!=null && mapping.fechaBaja!==-1){
      const bajaPre = String(row[mapping.fechaBaja]==null?"":row[mapping.fechaBaja]).trim();
      if(bajaPre!==""){
        const bp = parseEntrada(row[mapping.fechaBaja]);
        if(bp.valid && Date.UTC(bp.anio, bp.mes-1, bp.dia) < cutoffTs){ seen.add(legajoKey); descartados++; return; }
      }
    }
    let altaRaw = mapping.fechaAlta!==-1 ? row[mapping.fechaAlta] : "";
    // Si la columna elegida para el alta (p. ej. "Fecha cálculo vacaciones") viene vacía en esa fila, se usa la Fecha de Ingreso.
    if(String(altaRaw==null?"":altaRaw).trim()==="" && idxIngreso!==-1) altaRaw = row[idxIngreso];
    const altaParsed = parseEntrada(altaRaw);
    if(!altaParsed.valid){ errors.push({row:excelRow, legajo, problem:"Fecha de alta inválida o vacía"}); return; }
    const altaTs = Date.UTC(altaParsed.anio, altaParsed.mes-1, altaParsed.dia);
    const bajaRaw = mapping.fechaBaja!==-1 ? row[mapping.fechaBaja] : "";
    const bajaStr = String(bajaRaw==null?"":bajaRaw).trim();
    let bajaTs = null;
    if(bajaStr!==""){
      const bajaParsed = parseEntrada(bajaRaw);
      if(!bajaParsed.valid){ errors.push({row:excelRow, legajo, problem:"Fecha de baja inválida"}); return; }
      bajaTs = Date.UTC(bajaParsed.anio, bajaParsed.mes-1, bajaParsed.dia);
      if(bajaTs < altaTs){ errors.push({row:excelRow, legajo, problem:"Fecha de baja anterior a la fecha de alta"}); return; }
      if(cutoffTs!=null && bajaTs < cutoffTs){ seen.add(legajoKey); descartados++; return; }
    }
    const nacRaw = mapping.fechaNacimiento!==-1 ? row[mapping.fechaNacimiento] : "";
    const nacStr = String(nacRaw==null?"":nacRaw).trim();
    let nacimientoTs = null;
    if(nacStr!==""){
      const nacParsed = parseEntrada(nacRaw);
      if(nacParsed.valid) nacimientoTs = Date.UTC(nacParsed.anio, nacParsed.mes-1, nacParsed.dia);
    }
    const rec = {
      legajo, altaTs, bajaTs, nacimientoTs,
      nombre: cellStr(row, mapping.nombre),
      estado: cellStr(row, mapping.estado),
      unidad: cellStr(row, mapping.unidad),
      sector: cellStr(row, mapping.sector),
      gerencia: cellStr(row, mapping.gerencia),
      departamento: cellStr(row, mapping.departamento),
      empresa: cellStr(row, mapping.empresa),
      grupo: cellStr(row, mapping.grupo),
      puesto: cellStr(row, mapping.puesto),
      jefe: cellStr(row, mapping.jefe),
      celular: cellStr(row, mapping.celular)
    };
    seen.add(legajoKey);
    const prev = existingByLegajo.get(legajo);
    if(!prev){ nuevos++; changedRecords.push(rec); }
    else {
      const changed = prev.altaTs!==rec.altaTs || prev.bajaTs!==rec.bajaTs || prev.nacimientoTs!==rec.nacimientoTs || FIELD_KEYS.some(k=>(prev[k]||"")!==(rec[k]||""));
      if(changed){ modificados++; changedRecords.push(rec); } else sinCambios++;
    }
    records.push(rec);
  });
  const noIncluidos = existingPlantel.filter(p=>!seen.has(p.legajo.toUpperCase())).length;
  return {
    totalEncontrados: dataRows.length,
    nuevos, modificados, sinCambios, noIncluidos, descartados, cutoffTs,
    errores: errors,
    records,
    changedRecords
  };
}
function PlantelUploadForm({onFile, label, loading}){
  const inputId = "plantelFile_"+label.replace(/\s+/g,"");
  return (
    <React.Fragment>
      <label className="btn" htmlFor={inputId}>{loading ? "Leyendo…" : label}</label>
      <input id={inputId} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={e=>{ const f=e.target.files && e.target.files[0]; if(f) onFile(f); e.target.value=""; }} />
    </React.Fragment>
  );
}
/* ---- estado del espacio de la base de datos (Supabase) ---- */
const MB = 1048576;
function dbUsagePct(usage){ return usage ? usage.db_bytes/MB/DB_LIMIT_MB*100 : 0; }
function dbUsageLevel(pct){ return pct>=DB_ALERT_PCT ? "bad" : pct>=DB_WARN_PCT ? "warn" : "good"; }
// Cantidad típica de filas de ausentismo que se agregan por mes (promedio de los meses completos ya cargados).
function rowsPerMonthOf(parsed){
  if(!parsed || !parsed.monthMap || !parsed.monthKeys.length) return 0;
  const keys = parsed.monthKeys.length>2 ? parsed.monthKeys.slice(0,-1) : parsed.monthKeys; // el último mes puede estar incompleto
  return keys.reduce((a,k)=>a+(parsed.monthMap.get(k)||0),0)/keys.length;
}
function DbUsageCard({usage, error, checking, onCheck, rowsPerMonth}){
  const used = usage ? usage.db_bytes/MB : 0;
  const pct = dbUsagePct(usage), level = dbUsageLevel(pct);
  const color = level==="bad" ? "var(--critical)" : level==="warn" ? "var(--warning)" : "var(--good)";
  const bytesPerRow = usage && usage.aus_filas>0 ? usage.aus_bytes/usage.aus_filas : 0;
  const mbPerMonth = rowsPerMonth>0 && bytesPerRow>0 ? rowsPerMonth*bytesPerRow/MB : 0;
  const monthsLeft = mbPerMonth>0 ? Math.max(0, (DB_LIMIT_MB-used)/mbPerMonth) : null;
  const limitDate = monthsLeft!=null ? new Date(Date.now()+monthsLeft*30.4*86400000) : null;
  const tables = usage ? [
    {name:"Ausentismo (registros diarios)", filas:usage.aus_filas, bytes:usage.aus_bytes},
    {name:"Plantel", filas:usage.plantel_filas, bytes:usage.plantel_bytes},
    {name:"Crónicos (casos y observaciones)", filas:usage.cronicos_filas, bytes:usage.cronicos_bytes}
  ] : [];
  return (
    <div className="card table-card">
      <h3>Estado de la base de datos</h3>
      {error && <div className="warn-banner">{error}</div>}
      {usage && (
        <React.Fragment>
          <div style={{display:"flex", alignItems:"baseline", gap:10, flexWrap:"wrap"}}>
            <b style={{fontSize:20, color}}>{fmt(used)} MB</b>
            <span className="hint">de {fmt(DB_LIMIT_MB)} MB del plan · {fmtPct(pct,0)} usado</span>
          </div>
          <div style={{height:10, borderRadius:6, background:"var(--border)", overflow:"hidden"}} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin="0" aria-valuemax="100">
            <div style={{width:Math.min(100,pct)+"%", height:"100%", background:color}}></div>
          </div>
          <div className="overflow-x">
            <table>
              <thead><tr><th>Tabla</th><th className="num">Filas</th><th className="num">Tamaño</th></tr></thead>
              <tbody>
                {tables.map(t=>(<tr key={t.name}><td>{t.name}</td><td className="num">{fmt(t.filas)}</td><td className="num">{t.bytes/MB>=10 ? fmt(t.bytes/MB) : (t.bytes/MB).toLocaleString("es-AR",{maximumFractionDigits:1})} MB</td></tr>))}
              </tbody>
            </table>
          </div>
          {monthsLeft!=null && (
            <p className="caption" style={{margin:0}}>
              Ritmo estimado: ~{mbPerMonth.toLocaleString("es-AR",{maximumFractionDigits:1})} MB por mes (≈ {fmt(rowsPerMonth)} filas por mes × {(bytesPerRow/1024).toLocaleString("es-AR",{maximumFractionDigits:2})} KB por fila).
              {level==="bad" || monthsLeft<=0
                ? " Estás muy cerca del límite."
                : " A este ritmo se llegaría al límite en ~"+fmt(Math.round(monthsLeft))+" meses (aprox. "+MESES[limitDate.getMonth()]+" "+limitDate.getFullYear()+")."}
            </p>
          )}
          {level!=="good" && (
            <p className="caption" style={{margin:0, color}}>
              Conviene liberar espacio (archivar un año anterior y borrarlo de la base) o pasar al plan Pro antes de llegar al límite: al superarlo, la base queda en solo lectura y no se pueden guardar cargas nuevas.
            </p>
          )}
        </React.Fragment>
      )}
      <div style={{display:"flex", gap:10, alignItems:"center", flexWrap:"wrap"}}>
        <button type="button" className="btn secondary small" onClick={onCheck} disabled={checking}>{checking ? "Verificando…" : "Verificar ahora"}</button>
        <span className="hint">Se verifica sola al abrir la app y al terminar cada carga. Avisa con una marca arriba desde el {DB_WARN_PCT} %.</span>
      </div>
    </div>
  );
}

function PlantelTab({plantel, setPlantel, plantelHistorial, setPlantelHistorial, plantelUpdatedAt, setPlantelUpdatedAt, plantelActive, globalPlantelStats, scopeMonthKeys, diasPeriodoLabel, dbUsage, dbUsageError, dbChecking, onCheckDb, dbRowsPerMonth, dataStartTs, soloCarga}){
  const [stage, setStage] = useState("idle");
  const [rawRows, setRawRows] = useState(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errAudit, setErrAudit] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);

  const indicadorRows = globalPlantelStats ? [
    {name:"Empleados considerados", v:globalPlantelStats.empleadosConsiderados},
    {name:"Días del período", v:globalPlantelStats.diasPeriodo},
    {name:"Jornales de dotación", v:globalPlantelStats.jornalesDotacion},
    {name:"Dotación equivalente", v:globalPlantelStats.dotacionEquivalente},
    {name:"AP", v:globalPlantelStats.ap},
    {name:"ANP", v:globalPlantelStats.anp},
    {name:"AP + ANP", v:globalPlantelStats.ap+globalPlantelStats.anp}
  ] : [];
  const indSort = useTableSort(indicadorRows, {name:{get:r=>r.name, type:"text"}, v:{get:r=>r.v, type:"num"}});
  const histSort = useTableSort(plantelHistorial, {
    fecha:{get:h=>h.fecha.getTime(), type:"num"}, archivo:{get:h=>h.archivo, type:"text"},
    encontrados:{get:h=>h.encontrados, type:"num"}, nuevos:{get:h=>h.nuevos, type:"num"},
    modificados:{get:h=>h.modificados, type:"num"}, errores:{get:h=>h.errores, type:"num"}
  });

  function onFile(file){
    setError(null);
    setLoading(true);
    setFileName(file.name);
    const isCsv = /\.csv$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        const wb = isCsv ? XLSX.read(e.target.result, {type:"string", raw:true, cellDates:false}) : XLSX.read(new Uint8Array(e.target.result), {type:"array", cellDates:false});
        const ws = wb.Sheets[wb.SheetNames[0]];
        let rows2d = XLSX.utils.sheet_to_json(ws, {header:1, defval:"", raw:true});
        // Algunos listados traen títulos arriba ("Listado de Legajos", usuario y fecha de emisión…): la fila de encabezados es la primera
        // (de las 20 primeras) que tiene las columnas Legajo y Fecha de Alta/Ingreso; todo lo de arriba se ignora.
        let hIdx = 0;
        for(let i=0; i<Math.min(rows2d.length, 20); i++){
          if(findColByAliases(rows2d[i], PLANTEL_FIELD_ALIASES.legajo)!==-1 && findColByAliases(rows2d[i], PLANTEL_FIELD_ALIASES.fechaAlta)!==-1){ hIdx = i; break; }
        }
        if(hIdx>0){ const off = hIdx; rows2d = rows2d.slice(hIdx); rows2d.headerOffset = off; }
        if(!rows2d.length || !rows2d[0].length){ setError("El archivo está vacío o no tiene encabezados."); setLoading(false); return; }
        const header = rows2d[0];
        const autoMap = {};
        PLANTEL_FIELD_ORDER.forEach(f => { autoMap[f] = findColByAliases(header, PLANTEL_FIELD_ALIASES[f]); });
        setRawRows(rows2d);
        setMapping(autoMap);
        setStage("mapping");
      }catch(err){
        setError("No se pudo leer el archivo: " + (err && err.message ? err.message : String(err)));
      }
      setLoading(false);
    };
    reader.onerror = () => { setError("No se pudo leer el archivo."); setLoading(false); };
    if(isCsv) reader.readAsText(file, "utf-8"); else reader.readAsArrayBuffer(file);
  }

  const header = rawRows ? rawRows[0] : [];
  const missingRequired = PLANTEL_REQUIRED_FIELDS.filter(f => mapping[f]==null || mapping[f]===-1);

  const preview = useMemo(() => {
    if(stage!=="preview" || !rawRows) return null;
    // primer día del primer mes con datos de ausentismo cargados (si todavía no hay datos, no se descarta a nadie)
    const dataStart = dataStartTs!=null ? new Date(dataStartTs) : null;
    const cutoffTs = dataStart ? Date.UTC(dataStart.getUTCFullYear(), dataStart.getUTCMonth(), 1) : null;
    return buildPlantelPreview(rawRows, mapping, plantel, cutoffTs);
  }, [stage, rawRows, mapping, plantel, dataStartTs]);

  function confirmar(){
    if(!preview) return;
    const byLegajo = new Map(plantel.map(p=>[p.legajo, p]));
    preview.records.forEach(r => byLegajo.set(r.legajo, r));
    setPlantel(Array.from(byLegajo.values()));
    setPlantelUpdatedAt(new Date());
    setPlantelHistorial(h => [{
      fecha: new Date(), archivo: fileName, encontrados: preview.totalEncontrados,
      nuevos: preview.nuevos, modificados: preview.modificados, errores: preview.errores.length
    }, ...h]);
    // solo se suben los legajos nuevos o modificados: los que no cambiaron no se re-envían ni obligan a los demás usuarios a re-bajarlos.
    const rowsToSync = preview.changedRecords.map(plantelRecordToRow);
    const doneFileName = fileName;
    setStage("idle"); setRawRows(null); setMapping({}); setFileName("");
    if(rowsToSync.length){
      setSyncStatus({done:0, total:rowsToSync.length});
      upsertInBatches(PLANTEL_TABLE, rowsToSync, "legajo", (done,total)=>setSyncStatus({done,total}))
        .then(()=> setSyncStatus(null))
        .catch(err=>{ setSyncStatus(null); setError("No se pudo guardar el plantel (\""+doneFileName+"\") en el servidor: " + (err && err.message ? err.message : String(err))); });
    }
  }
  function cancelar(){ setStage("idle"); setRawRows(null); setMapping({}); setFileName(""); setError(null); }

  return (
    <div className="tabpanel">
      <div className="card motivo-settings">
        <h3>Gestión de Plantel</h3>
        <p className="hint">
          {plantelActive
            ? <React.Fragment>Plantel cargado: <b>{fmt(plantel.length)}</b> legajos · Última actualización: <b>{plantelUpdatedAt ? plantelUpdatedAt.toLocaleString("es-AR") : "—"}</b>. La dotación y los jornales del resto de la herramienta se calculan a partir de este plantel (alta/baja), no contando filas.</React.Fragment>
            : <React.Fragment>Sin plantel cargado — la dotación y el ausentismo se siguen calculando contando filas del Excel de ausentismo, como hasta ahora. Subí un plantel (Legajo, Fecha de Alta, Fecha de Baja y, si querés, UN/Sector/Gerencia/Departamento/Empresa) para pasar al cálculo por días activos.</React.Fragment>}
        </p>
        {stage==="idle" && (
          <div style={{display:"flex", gap:10, flexWrap:"wrap"}}>
            <PlantelUploadForm onFile={onFile} label={plantelActive ? "Actualizar plantel" : "Subir plantel"} loading={loading} />
            <span className="hint">Acepta .xlsx o .csv. Se reconocen encabezados como "Legajo", "Fecha de Alta"/"Fecha cálculo vacaciones"/"Fecha de Ingreso", "Fecha de Baja"/"Fecha de egreso", "Unidad de Negocio", "Sector", etc.</span>
          </div>
        )}
        {syncStatus && <p className="hint">Guardando en el servidor… {fmt(syncStatus.done)}/{fmt(syncStatus.total)}</p>}
        {error && <div className="warn-banner">{error}</div>}
      </div>

      {stage==="mapping" && (
        <div className="card table-card">
          <h3>Confirmá las columnas — {fileName}</h3>
          <p className="caption">Elegí qué columna del archivo corresponde a cada campo. Legajo y Fecha de Alta son obligatorios.</p>
          <div className="toggle-grid">
            {PLANTEL_FIELD_ORDER.map(f => (
              <div key={f} className="field">
                <label>{PLANTEL_FIELD_LABELS[f]}{PLANTEL_REQUIRED_FIELDS.includes(f) ? " *" : ""}</label>
                <select value={mapping[f]==null?-1:mapping[f]} onChange={e=>setMapping(m=>({...m, [f]: parseInt(e.target.value,10)}))}>
                  <option value={-1}>— No usar —</option>
                  {header.map((h,i)=>(<option key={i} value={i}>{String(h||"(columna "+(i+1)+")")}</option>))}
                </select>
              </div>
            ))}
          </div>
          {missingRequired.length>0 && <div className="warn-banner">Faltan mapear campos obligatorios: {missingRequired.map(f=>PLANTEL_FIELD_LABELS[f]).join(", ")}.</div>}
          <div style={{display:"flex", gap:10}}>
            <button className="btn" disabled={missingRequired.length>0} onClick={()=>setStage("preview")}>Continuar</button>
            <button className="btn secondary" onClick={cancelar}>Cancelar</button>
          </div>
        </div>
      )}

      {stage==="preview" && preview && (
        <div className="card table-card">
          <h3>Resumen de la carga — {fileName}</h3>
          <div className="kpi-grid">
            <KpiTile label="Registros encontrados" value={preview.totalEncontrados} />
            <KpiTile label="Registros nuevos" value={preview.nuevos} />
            <KpiTile label="Registros modificados" value={preview.modificados} />
            <KpiTile label="Registros con errores" value={preview.errores.length} />
          </div>
          {preview.descartados>0 && <p className="hint">Se descartaron <b>{fmt(preview.descartados)}</b> legajo(s) con baja anterior al <b>{fmtDateFromTs(preview.cutoffTs)}</b> (primer mes con datos de ausentismo): no aportan días a la dotación ni a los jornales, así que no se cargan ni ocupan espacio en la base.</p>}
          {preview.noIncluidos>0 && <p className="hint">Hay <b>{fmt(preview.noIncluidos)}</b> legajo(s) del plantel actual que no aparecen en este archivo — se conservan sin cambios (no se borran automáticamente).</p>}
          {preview.errores.length>0 && (
            <React.Fragment>
              <button type="button" className="btn secondary small" onClick={()=>setErrAudit(true)}>Ver detalle de errores</button>
              {errAudit && (
                <AuditModal
                  title="Filas con errores"
                  rows={preview.errores}
                  onClose={()=>setErrAudit(false)}
                  cols={["Fila","Legajo","Problema"]}
                  rowToArr={r=>[r.row, r.legajo, r.problem]}
                />
              )}
            </React.Fragment>
          )}
          <div style={{display:"flex", gap:10, marginTop:6}}>
            <button className="btn" onClick={confirmar}>Confirmar carga</button>
            <button className="btn secondary" onClick={cancelar}>Cancelar</button>
          </div>
        </div>
      )}

      {!soloCarga && plantelActive && globalPlantelStats && (
        <div className="card table-card">
          <h3>Control de consistencia</h3>
          <p className="caption">Alcance actual (mismos filtros que Resumen) · Período: {diasPeriodoLabel}</p>
          <div className="overflow-x">
            <table>
              <thead><tr><SortTh k="name" label="Indicador" sort={indSort.sort} toggle={indSort.toggle} /><SortTh k="v" label="Valor" className="num" sort={indSort.sort} toggle={indSort.toggle} /></tr></thead>
              <tbody>
                {indSort.sorted.map(r=>(<tr key={r.name}><td>{r.name}</td><td className="num">{fmt(r.v)}</td></tr>))}
                <tr className="total-row"><td>Desvío</td><td className="num">{fmtPct(globalPlantelStats.pct,2)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {plantelHistorial.length>0 && (
        <div className="card table-card">
          <h3>Historial de cargas (esta sesión)</h3>
          <div className="overflow-x">
            <table>
              <thead><tr>
                <SortTh k="fecha" label="Fecha y hora" sort={histSort.sort} toggle={histSort.toggle} />
                <SortTh k="archivo" label="Archivo" sort={histSort.sort} toggle={histSort.toggle} />
                <SortTh k="encontrados" label="Encontrados" className="num" sort={histSort.sort} toggle={histSort.toggle} />
                <SortTh k="nuevos" label="Nuevos" className="num" sort={histSort.sort} toggle={histSort.toggle} />
                <SortTh k="modificados" label="Modificados" className="num" sort={histSort.sort} toggle={histSort.toggle} />
                <SortTh k="errores" label="Errores" className="num" sort={histSort.sort} toggle={histSort.toggle} />
              </tr></thead>
              <tbody>
                {histSort.sorted.map((h,i)=>(
                  <tr key={i}>
                    <td>{h.fecha.toLocaleString("es-AR")}</td>
                    <td>{h.archivo}</td>
                    <td className="num">{fmt(h.encontrados)}</td>
                    <td className="num">{fmt(h.nuevos)}</td>
                    <td className="num">{fmt(h.modificados)}</td>
                    <td className="num">{fmt(h.errores)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!soloCarga && <DbUsageCard usage={dbUsage} error={dbUsageError} checking={dbChecking} onCheck={onCheckDb} rowsPerMonth={dbRowsPerMonth} />}
    </div>
  );
}

/* ===================== tabs ===================== */
function ResumenTab({rankingUnits, objetivo, scopeUnitsMap, excludedMotivos, setExcludedMotivos, motivoUniverse, scopeEmpleados, scopeAgg, plantelActive, scopePlantel, scopeMonthKeys, dotacionTotal, jornalesTotal, cutoffTs, verFiltros}){
  const [audit, setAudit] = useState(null);
  const unitSort = useTableSort(rankingUnits, {
    name:{get:u=>u.name, type:"text"},
    dot:{get:u=>plantelActive ? u.dotacionEquivalente : u.dotacion, type:"num"},
    jor:{get:u=>plantelActive ? u.jornalesDotacion : 0, type:"num"},
    aus:{get:u=>u.ausencias, type:"num"},
    pct:{get:u=>u.pct, type:"num"},
    est:{get:u=>u.pct, type:"num"}
  });
  function openAudit(title, rows, cols, rowToArr){ setAudit({title, rows, cols, rowToArr}); }
  function auditAusencias(u){ openAudit('Ausencias contabilizadas — '+u.name, (scopeUnitsMap.get(u.name)||[]).filter(r=>isCountedCat(r.cat) && !excludedMotivos.has(motivoKeyOf(r)))); }
  function auditDotacion(u){
    if(plantelActive){
      const roster = (scopePlantel||[]).filter(p => (p.unidad||"(Sin unidad)")===u.name).map(p => {
        let dias = 0;
        scopeMonthKeys.forEach(mk => { const {year,month} = monthKeyParts(mk); dias += activeDaysInMonth(p.altaTs, p.bajaTs, year, month, cutoffTs); });
        return {...p, _diasActivos: dias};
      });
      openAudit('Dotación (plantel) — '+u.name, roster, AUDIT_COLS_PLANTEL, auditPlantelRowArr);
      return;
    }
    const rows = scopeUnitsMap.get(u.name)||[];
    const seen = new Set(); const roster=[];
    rows.forEach(r=>{ const k=(r.legajo||"").toUpperCase(); if(k && !seen.has(k)){ seen.add(k); roster.push(r); } });
    openAudit('Dotación (legajos únicos) — '+u.name, roster);
  }
  const allScopeRows = useMemo(()=> Array.from(scopeUnitsMap.values()).flat(), [scopeUnitsMap]);
  function auditMotivo(m){
    openAudit('Ausencias — '+m.label, allScopeRows.filter(r=>isCountedCat(r.cat) && motivoKeyOf(r)===m.key));
  }
  const peor = rankingUnits.length ? rankingUnits.reduce((a,b)=> b.pct>a.pct ? b : a) : null;
  let objetivoNote = null;
  if(peor){
    if(peor.pct>objetivo){
      const denomPeor = plantelActive ? peor.jornalesDotacion : peor.base;
      const ausenciasObjetivo = Math.floor(denomPeor*objetivo/100);
      const bajar = Math.max(0, peor.ausencias-ausenciasObjetivo);
      objetivoNote = <React.Fragment>
        <b>{peor.name}</b> es la unidad más alejada del objetivo: hoy está en <b>{fmtPct(peor.pct,1)}</b> ({fmt(peor.ausencias)} ausencias ÷ {fmt(denomPeor)} {plantelActive ? "jornales de dotación" : "filas activas"} × 100).
        Manteniendo la dotación y el resto de filas igual, necesitaría bajar a <b>{fmt(ausenciasObjetivo)}</b> ausencias (<b>-{fmt(bajar)}</b>) para llegar al objetivo de {fmtPct(objetivo,1)}.
      </React.Fragment>;
    } else {
      objetivoNote = <React.Fragment>Todas las unidades están dentro del objetivo de {fmtPct(objetivo,1)} con los filtros actuales.</React.Fragment>;
    }
  }
  return (
    <div className="tabpanel">
      <div className="card chart-card">
        <h3>Ranking de unidades de negocio</h3>
        <p className="desc">Ausentismo (AP+ANP ÷ {plantelActive ? "jornales de dotación del plantel" : "filas activas"}) por unidad, en orden fijo. La línea punteada marca el objetivo.</p>
        <RankingChart units={rankingUnits} objetivo={objetivo} />
      </div>
      <div className="card table-card">
        <h3>Cumplimiento del objetivo</h3>
        <div className="caption">Hacé clic en Dotación, Jornales o Ausencias para ver y copiar el detalle de esas filas.</div>
        <div className="overflow-x">
          <table>
            <thead><tr>
              <SortTh k="name" label="Unidad" sort={unitSort.sort} toggle={unitSort.toggle} />
              <SortTh k="dot" label={plantelActive ? "Dotación equiv." : "Dotación"} className="num" sort={unitSort.sort} toggle={unitSort.toggle} />
              <SortTh k="jor" label="Jornales" className="num" sort={unitSort.sort} toggle={unitSort.toggle} />
              <SortTh k="aus" label="Ausencias" className="num" sort={unitSort.sort} toggle={unitSort.toggle} />
              <SortTh k="pct" label="Ausentismo" className="num" sort={unitSort.sort} toggle={unitSort.toggle} />
              <SortTh k="est" label="Estado" sort={unitSort.sort} toggle={unitSort.toggle} />
            </tr></thead>
            <tbody>
              {unitSort.sorted.map(u=>(
                <tr key={u.name}>
                  <td>{u.name}</td>
                  <td className="num"><CellLink onClick={()=>auditDotacion(u)}>{fmt(plantelActive ? u.dotacionEquivalente : u.dotacion)}</CellLink></td>
                  <td className="num"><CellLink onClick={()=>auditDotacion(u)}>{fmt(plantelActive ? u.jornalesDotacion : 0)}</CellLink></td>
                  <td className="num"><CellLink onClick={()=>auditAusencias(u)}>{fmt(u.ausencias)}</CellLink></td>
                  <td className="num">{fmtPct(u.pct,1)}</td>
                  <td><SemChip pct={u.pct} objetivo={objetivo} /></td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="num">{fmt(plantelActive ? dotacionTotal : scopeEmpleados)}</td>
                <td className="num">{fmt(plantelActive ? jornalesTotal : 0)}</td>
                <td className="num">{fmt(scopeAgg.ausencias)}</td>
                <td className="num">{fmtPct(scopeAgg.pct,1)}</td>
                <td><SemChip pct={scopeAgg.pct} objetivo={objetivo} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        {objetivoNote && <p className="caption" style={{marginTop:4}}>{objetivoNote}</p>}
      </div>
      {verFiltros && <MotivoChecklist motivoUniverse={motivoUniverse} excluded={excludedMotivos} onChange={setExcludedMotivos} onAudit={auditMotivo} />}
      {audit && <AuditModal title={audit.title} rows={audit.rows} onClose={()=>setAudit(null)} cols={audit.cols} rowToArr={audit.rowToArr} />}
    </div>
  );
}
function ResumenGerenciaTab({parsed, plantel, objetivo, mesFilter, empresaIncluded, excludedMotivos, setExcludedMotivos, scopeMonthKeys, verFiltros}){
  const gerencias = parsed.gerencias || [];
  const [gerenciaSel, setGerenciaSel] = useState(gerencias[0] || "");
  useEffect(()=>{ if((!gerenciaSel || !gerencias.includes(gerenciaSel)) && gerencias.length) setGerenciaSel(gerencias[0]); }, [gerencias.join("|")]);
  const [audit, setAudit] = useState(null);

  const baseRecords = useMemo(()=>{
    if(!gerenciaSel) return [];
    return parsed.records.filter(r=> r.valid
      && r.gerencia===gerenciaSel
      && (!mesFilter || (r.monthKey && mesFilter.has(r.monthKey)))
      && (!empresaIncluded || !r.empresa || empresaIncluded.has(r.empresa)));
  }, [parsed, gerenciaSel, mesFilter, empresaIncluded]);

  const motivoUniverseLocal = useMemo(() => {
    if(!parsed.hasMotivo) return [];
    const counts = new Map();
    baseRecords.forEach(r => {
      if(!isCountedCat(r.cat)) return;
      const k = motivoKeyOf(r);
      counts.set(k, (counts.get(k)||0)+1);
    });
    return parsed.motivoUniverse.map(m => ({...m, count: counts.get(m.key)||0}));
  }, [parsed, baseRecords]);
  function auditMotivo(m){
    openAudit('Ausencias — '+m.label, baseRecords.filter(r=>isCountedCat(r.cat) && motivoKeyOf(r)===m.key));
  }

  const deptUnitsMap = useMemo(()=> buildGroupMap(baseRecords, "departamento"), [baseRecords]);

  const plantelDept = useMemo(()=>{
    if(!plantel || !plantel.length || !gerenciaSel) return [];
    return plantel.filter(p=> p.gerencia===gerenciaSel && (!empresaIncluded || !p.empresa || empresaIncluded.has(p.empresa)));
  }, [plantel, gerenciaSel, empresaIncluded]);
  const plantelActive = plantelDept.length>0;

  const deptRanking = useMemo(()=>{
    const base = Array.from(deptUnitsMap.entries()).map(([name,rows])=>({name, ...unitStats(rows, excludedMotivos)}));
    if(plantelActive){
      base.forEach(u=>{
        const employees = plantelDept.filter(p=> (p.departamento||"(Sin departamento)")===u.name);
        const st = plantelScopeStats(employees, scopeMonthKeys, parsed.maxTs);
        u.jornalesDotacion = st.jornalesDotacion;
        u.dotacionEquivalente = st.dotacionEquivalente;
        u.pct = st.jornalesDotacion>0 ? u.ausencias/st.jornalesDotacion*100 : 0;
      });
    }
    return base.sort((a,b)=>b.pct-a.pct);
  }, [deptUnitsMap, excludedMotivos, plantelActive, plantelDept, scopeMonthKeys, parsed.maxTs]);

  const totalDotacion = plantelActive ? deptRanking.reduce((a,u)=>a+(u.dotacionEquivalente||0),0) : new Set(baseRecords.map(r=>r.legajo.toUpperCase())).size;
  const totalJornales = plantelActive ? deptRanking.reduce((a,u)=>a+(u.jornalesDotacion||0),0) : 0;
  const totalAusencias = deptRanking.reduce((a,u)=>a+u.ausencias,0);
  const totalBase = deptRanking.reduce((a,u)=>a+u.base,0);
  const totalPct = plantelActive ? (totalJornales>0 ? totalAusencias/totalJornales*100 : 0) : (totalBase>0 ? totalAusencias/totalBase*100 : 0);

  const deptSort = useTableSort(deptRanking, {
    name:{get:u=>u.name, type:"text"},
    dot:{get:u=>plantelActive ? u.dotacionEquivalente : u.dotacion, type:"num"},
    jor:{get:u=>plantelActive ? u.jornalesDotacion : 0, type:"num"},
    aus:{get:u=>u.ausencias, type:"num"},
    pct:{get:u=>u.pct, type:"num"},
    est:{get:u=>u.pct, type:"num"}
  });

  function openAudit(title, rows){ setAudit({title, rows}); }

  return (
    <div className="tabpanel">
      <div className="card controls">
        <div className="field">
          <label>Gerencia</label>
          <select value={gerenciaSel} onChange={e=>setGerenciaSel(e.target.value)}>
            {gerencias.map(g=>(<option key={g} value={g}>{g}</option>))}
          </select>
        </div>
      </div>
      {!gerencias.length && <div className="hint">No hay gerencias detectadas en el archivo.</div>}
      {gerenciaSel && (
        <React.Fragment>
          <div className="card chart-card">
            <h3>Ranking de departamentos — {gerenciaSel}</h3>
            <p className="desc">Ausentismo (AP+ANP ÷ {plantelActive ? "jornales de dotación del plantel" : "filas activas"}) por departamento, dentro de {gerenciaSel}. La línea punteada marca el objetivo.</p>
            <RankingChart units={deptRanking} objetivo={objetivo} />
          </div>
          <div className="card table-card">
            <h3>Cumplimiento del objetivo — {gerenciaSel}</h3>
            <div className="caption">Hacé clic en Dotación o Ausencias para ver y copiar el detalle de esas filas.</div>
            <div className="overflow-x">
              <table>
                <thead><tr>
                  <SortTh k="name" label="Departamento" sort={deptSort.sort} toggle={deptSort.toggle} />
                  <SortTh k="dot" label={plantelActive ? "Dotación equiv." : "Dotación"} className="num" sort={deptSort.sort} toggle={deptSort.toggle} />
                  <SortTh k="jor" label="Jornales" className="num" sort={deptSort.sort} toggle={deptSort.toggle} />
                  <SortTh k="aus" label="Ausencias" className="num" sort={deptSort.sort} toggle={deptSort.toggle} />
                  <SortTh k="pct" label="Ausentismo" className="num" sort={deptSort.sort} toggle={deptSort.toggle} />
                  <SortTh k="est" label="Estado" sort={deptSort.sort} toggle={deptSort.toggle} />
                </tr></thead>
                <tbody>
                  {!deptRanking.length && <tr><td colSpan="6" style={{textAlign:"center",color:"var(--muted)",padding:"18px 0"}}>Sin datos para esta gerencia con los filtros actuales.</td></tr>}
                  {deptSort.sorted.map(u=>(
                    <tr key={u.name}>
                      <td>{u.name}</td>
                      <td className="num"><CellLink onClick={()=>openAudit('Dotación — '+u.name, deptUnitsMap.get(u.name)||[])}>{fmt(plantelActive ? u.dotacionEquivalente : u.dotacion)}</CellLink></td>
                      <td className="num">{fmt(plantelActive ? u.jornalesDotacion : 0)}</td>
                      <td className="num"><CellLink onClick={()=>openAudit('Ausencias — '+u.name, (deptUnitsMap.get(u.name)||[]).filter(r=>isCountedCat(r.cat) && !excludedMotivos.has(motivoKeyOf(r))))}>{fmt(u.ausencias)}</CellLink></td>
                      <td className="num">{fmtPct(u.pct,1)}</td>
                      <td><SemChip pct={u.pct} objetivo={objetivo} /></td>
                    </tr>
                  ))}
                  {deptRanking.length>0 && (
                    <tr className="total-row">
                      <td>Total</td>
                      <td className="num">{fmt(totalDotacion)}</td>
                      <td className="num">{fmt(totalJornales)}</td>
                      <td className="num">{fmt(totalAusencias)}</td>
                      <td className="num">{fmtPct(totalPct,1)}</td>
                      <td><SemChip pct={totalPct} objetivo={objetivo} /></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </React.Fragment>
      )}
      {verFiltros && <MotivoChecklist motivoUniverse={motivoUniverseLocal} excluded={excludedMotivos} onChange={setExcludedMotivos} onAudit={auditMotivo} />}
      {audit && <AuditModal title={audit.title} rows={audit.rows} onClose={()=>setAudit(null)} />}
    </div>
  );
}
/* ===================== Cuadro Diario ===================== */
const CUADRO_COLS = [
  {key:"presProp",  label:"Presentes Propios",       cat:"P"},
  {key:"presContr", label:"Presentes Contratados",   cat:"P"},
  {key:"ap",        label:"Ausentes (Pagos)",        cat:"AP"},
  {key:"anp",       label:"Ausentes (No Pagos)",     cat:"ANP"},
  {key:"ce",        label:"Sin Tareas (No Pagos)",   cat:"CE"},
  {key:"vac",       label:"Vacaciones",              cat:"V"},
  {key:"total",     label:"Total Activos"},
  {key:"sub",       label:"Sub-Cont"}
];
const CUADRO_ACTIVOS = ["presProp","presContr","ap","anp","ce","vac"];
const CUADRO_SORT_COLS = {__unit:{get:row=>row.label, type:"text"}};
CUADRO_COLS.forEach(c=>{ CUADRO_SORT_COLS[c.key] = {get:row=>row.recs[c.key].length, type:"num"}; });
const CUADRO_AUDIT_COLS = ["Legajo","Nombre","Empresa","Tipo contratación","Estado","Id Motivo","Motivo"];
function cuadroAuditRow(r){ return [r.legajo, r.nombre, r.empresa, r.tipoContrat||"", r.estado, r.idMotivo, r.motivo]; }
function dateKeyToLabel(dk){ const p = (dk||"").split("-"); return p.length===3 ? p[2]+"/"+p[1]+"/"+p[0] : (dk||""); }

function CuadroDiarioTab({parsed}){
  // Sin filtros globales (mes, gerencia, empresa, motivos): el cuadro es la foto de UN día completo.
  const base = useMemo(()=> parsed.records.filter(r=>r.valid && r.cat!=="BAJA"), [parsed]);
  const dateKeys = useMemo(()=> Array.from(new Set(base.map(r=>r.dateKey))).sort().reverse(), [base]);
  const [fechaSel, setFechaSel] = useKeptState("cd.fecha", null);
  const fecha = dateKeys.includes(fechaSel) ? fechaSel : (dateKeys[0] || "");
  const [audit, setAudit] = useState(null);
  const [copied, setCopied] = useState("idle");

  const dayRecords = useMemo(()=> base.filter(r=>r.dateKey===fecha), [base, fecha]);

  const model = useMemo(()=>{
    const servicioMap = new Map(Object.keys(EMPRESA_SERVICIO).map(k=>[normTxt(k), EMPRESA_SERVICIO[k]]));
    const cells = new Map(); // unidad -> {col: [registros]}
    const unmapped = new Set();
    let sinTipo = 0;
    const cellOf = (unit, col) => {
      if(!cells.has(unit)) cells.set(unit, {});
      const o = cells.get(unit);
      if(!o[col]) o[col] = [];
      return o[col];
    };
    UNIT_ORDER.forEach(u=>cells.set(u, {}));
    dayRecords.forEach(r=>{
      if(!r.tipoContrat) sinTipo++;
      const propio = normTxt(r.empresa)==="propios";
      const eventual = normTxt(r.tipoContrat)==="eventual"; // vacío o cualquier otro valor se trata como Propios
      if(propio){
        const unit = r.unidad || "(Sin unidad)";
        if(r.cat==="P") cellOf(unit, eventual ? "presContr" : "presProp").push(r);
        else if(r.cat==="AP") cellOf(unit, "ap").push(r);
        else if(r.cat==="ANP") cellOf(unit, "anp").push(r);
        else if(r.cat==="CE") cellOf(unit, "ce").push(r);
        else if(r.cat==="V") cellOf(unit, "vac").push(r);
      } else if(r.cat==="P"){
        const mapped = servicioMap.get(normTxt(r.empresa));
        if(!mapped) unmapped.add(r.empresa || "(vacía)");
        cellOf(mapped || r.unidad || "(Sin unidad)", "sub").push(r);
      }
    });
    const extra = Array.from(cells.keys()).filter(u=>!UNIT_ORDER.includes(u)).sort();
    const units = UNIT_ORDER.concat(extra);
    const rows = units.map(u=>{
      const c = cells.get(u) || {};
      const get = k => c[k] || [];
      const total = CUADRO_ACTIVOS.reduce((a,k)=>a.concat(get(k)), []);
      return {unit:u, label:CUADRO_UNIT_LABEL[u]||u, recs:{presProp:get("presProp"), presContr:get("presContr"), ap:get("ap"), anp:get("anp"), ce:get("ce"), vac:get("vac"), total, sub:get("sub")}};
    });
    const totalRecs = {};
    CUADRO_COLS.forEach(col=>{ totalRecs[col.key] = rows.reduce((a,row)=>a.concat(row.recs[col.key]), []); });
    // Total Plantel Contratados: todos los propios con tipo "Eventual" (P+AP+ANP+CE+V), cualquiera sea su estado del día
    const contratados = totalRecs.total.filter(r=>normTxt(r.tipoContrat)==="eventual");
    return {rows, totalRecs, contratados, unmapped:Array.from(unmapped), sinTipo};
  }, [dayRecords]);

  const rowSort = useTableSort(model.rows, CUADRO_SORT_COLS);

  const fechaLabel = dateKeyToLabel(fecha);
  function openAudit(colLabel, unitLabel, recs){ setAudit({title: colLabel+" · "+unitLabel+" · "+fechaLabel, rows:recs}); }
  function numCell(recs, colLabel, unitLabel){
    return recs.length ? <CellLink onClick={()=>openAudit(colLabel, unitLabel, recs)}>{fmt(recs.length)}</CellLink> : "-";
  }

  async function copyTable(){
    const lines = [["Unidad"].concat(CUADRO_COLS.map(c=>c.label)).join("\t")];
    model.rows.forEach(row=> lines.push([row.label].concat(CUADRO_COLS.map(c=>row.recs[c.key].length)).join("\t")));
    lines.push(["Total"].concat(CUADRO_COLS.map(c=>model.totalRecs[c.key].length)).join("\t"));
    const text = lines.join("\n");
    try{
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    }catch(e){
      try{
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position="fixed"; ta.style.opacity="0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied("ok");
      }catch(e2){ setCopied("err"); }
    }
    setTimeout(()=>setCopied("idle"), 2500);
  }

  const totalActivos = model.totalRecs.total.length;
  const totalSub = model.totalRecs.sub.length;

  return (
    <div className="tabpanel">
      <div className="print-header">
        <h2>Cuadro Diario</h2>
        <p className="sub">Fecha: {fechaLabel || "—"}</p>
      </div>
      <div className="card table-card">
        <h3>Cuadro Diario</h3>
        <div className="caption">Foto de un día completo, sin filtros globales. Hacé clic en un número para ver y copiar los registros que lo componen.</div>
        <div className="filters-bar no-print">
          <div className="field">
            <label>Fecha</label>
            <select value={fecha} onChange={e=>setFechaSel(e.target.value)}>
              {dateKeys.map(dk=>(<option key={dk} value={dk}>{dateKeyToLabel(dk)}</option>))}
            </select>
          </div>
          <div className="field">
            <label>Registros del día</label>
            <span style={{fontWeight:700,fontSize:15,padding:"6px 0"}}>{fmt(dayRecords.length)}</span>
          </div>
          <button type="button" className="btn small" onClick={copyTable} disabled={!dayRecords.length}>
            {copied==="ok" ? "Copiado ✓" : copied==="err" ? "No se pudo copiar" : "Copiar tabla"}
          </button>
        </div>

        {!dayRecords.length && <div className="warn-banner">Sin datos para la fecha</div>}
        {dayRecords.length>0 && model.sinTipo>0 && (
          <div className="warn-banner">{fmt(model.sinTipo)} registro{model.sinTipo===1?"":"s"} de esta fecha sin "Agrup. tipo contratación": se tratan como Propios. Volvé a subir el archivo anual para completar el dato.</div>
        )}
        {model.unmapped.length>0 && (
          <div className="warn-banner">Empresa sin mapear: {model.unmapped.join(", ")}</div>
        )}

        <div className="overflow-x">
          <table>
            <thead>
              <tr>
                <SortTh k="__unit" label="Unidad de negocio" sort={rowSort.sort} toggle={rowSort.toggle} />
                {CUADRO_COLS.map(c=>(
                  <SortTh key={c.key} k={c.key} label={c.label} className="num" sort={rowSort.sort} toggle={rowSort.toggle}
                    style={c.cat ? {color:CAT_COLOR[c.cat], borderBottom:"3px solid "+CAT_COLOR[c.cat]} : undefined} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rowSort.sorted.map(row=>(
                <tr key={row.unit}>
                  <td>{row.label}</td>
                  {CUADRO_COLS.map(c=>(<td key={c.key} className="num">{numCell(row.recs[c.key], c.label, row.label)}</td>))}
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                {CUADRO_COLS.map(c=>(<td key={c.key} className="num">{numCell(model.totalRecs[c.key], c.label, "Total")}</td>))}
              </tr>
            </tbody>
          </table>
        </div>

        <div className="kpi-grid">
          <KpiTile label="Total Plantel Propios" value={totalActivos} />
          <KpiTile label="Total Plantel Contratados" value={model.contratados.length} />
          <KpiTile label="Total Sub-Contratados" value={totalSub} />
          <KpiTile label="Total General del día" value={totalActivos + totalSub} month />
        </div>
      </div>
      {audit && <AuditModal title={audit.title} rows={audit.rows} onClose={()=>setAudit(null)} cols={CUADRO_AUDIT_COLS} rowToArr={cuadroAuditRow} />}
    </div>
  );
}
function EvolucionTab({evoMonths, evoSeries, objetivo}){
  return (
    <div className="tabpanel">
      <div className="card chart-card">
        <h3>Evolución mensual del ausentismo</h3>
        <p className="desc">Una línea por unidad de negocio, contando filas reales mes a mes (no depende del filtro de Mes). La línea punteada marca el objetivo.</p>
        <EvolutionChart months={evoMonths} series={evoSeries} objetivo={objetivo} />
        <div className="legend">
          {evoSeries.map(s=>(<div key={s.name} className="item"><span className="line" style={{background:s.color}}></span>{s.name}</div>))}
        </div>
      </div>
    </div>
  );
}
function TiposTab({compositionData, apAnpData, motivoEntries, hasMotivo, soloApAnpYMotivo}){
  return (
    <div className="tabpanel">
      {!soloApAnpYMotivo && (
        <div className="card chart-card">
          <h3>Composición de ausencias por unidad</h3>
          <p className="desc">Ausencia (contabilizada: AP+ANP no excluidas por motivo) vs. Ausencia (excluida: CE+BAJA + motivos sin tildar abajo en Resumen) — no incluye Presente/Franco/Vacaciones.</p>
          <CompositionChart units={compositionData} />
        </div>
      )}
      <div className="card chart-card">
        <h3>AP vs ANP por unidad</h3>
        <p className="desc">Ausente pago vs. ausente no pago, entre las ausencias contabilizadas (no excluidas por motivo) de cada unidad.</p>
        <CompositionChart units={apAnpData} cats={AP_ANP_CATS} />
      </div>
      {hasMotivo && (
        <div className="card chart-card">
          <h3>Motivo de las ausencias contabilizadas</h3>
          <p className="desc">Distribución de motivos entre las filas AP/ANP que sí cuentan para el cálculo, con los filtros actuales.</p>
          <MotivoChart entries={motivoEntries} />
        </div>
      )}
    </div>
  );
}
// Cuadro de filtro SÍ/NO, compacto en columnas (2-3 según el ancho), con el mismo título y la misma "Selección rápida" que el resto.
// items: {key, label, ap?, anp?}. defaultKeys (opcional): selección que activa el botón "Por defecto".
function ToggleList({title, items, included, onChange, columns, defaultKeys}){
  const [open, setOpen] = useKeptState("fc.open|"+title, false); // retraído hasta que haga falta filtrar
  if(!items.length) return null;
  function toggle(key){
    const next = new Set(included);
    if(next.has(key)) next.delete(key); else next.add(key);
    onChange(next);
  }
  const hasCats = items.some(it=>it.ap!=null || it.anp!=null);
  const n = columns || 3;
  return (
    <div className="card motivo-settings">
      <FilterCardHead title={title} open={open} onToggle={()=>setOpen(o=>!o)} summary={items.filter(i=>included.has(i.key)).length+" de "+items.length+" incluidos"} />
      {open && (
        <React.Fragment>
          <QuickSelectBar all={items.map(i=>i.key)}
            apKeys={hasCats ? items.filter(isApItem).map(i=>i.key) : null}
            anpKeys={hasCats ? items.filter(isAnpItem).map(i=>i.key) : null}
            defaultKeys={defaultKeys} selected={included} onChange={onChange} />
          <div className="toggle-list-rows toggle-list-cols" style={{columnCount:n, columnGap:28, maxHeight:"none", overflowY:"visible", borderTop:"1px solid var(--border)"}}>
            {items.map(it=>(
              <div key={it.key} className="toggle-row" style={{padding:"5px 4px"}} onClick={()=>toggle(it.key)}>
                <span>{it.label}</span>
                <span className={"toggle-pill "+(included.has(it.key)?"yes":"no")}>{included.has(it.key)?"SÍ":"NO"}</span>
              </div>
            ))}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

/* ===================== Comité de ausentismo (dentro de Ranking) =====================
   Por empleado y en una ventana de meses (por defecto los últimos 12 cargados): días ausentes AP, ANP y ENF, en qué meses faltó,
   y detección de MICROAUSENTISMO: empleados que faltan en casi todos los meses con episodios cortos y repetidos. En un ranking por
   días no aparecen, porque otros empleados suman más días en un solo período; acá se los detecta por la repetición mes a mes y se
   muestra el patrón de motivo / razón de sus episodios. Una "ausencia" es una fila AP/ANP cuyo motivo cuenta para el cálculo
   (mismos motivos tildados/destildados en Resumen). Un "episodio" es una racha de días ausentes seguidos (con fines de semana y
   feriados en el medio). "ENF" = días con Agrupador cuadro presidencia "ENF". */
function analizarComite(records, monthKeys, excludedMotivos){
  const mset = new Set(monthKeys);
  const exMot = excludedMotivos || new Set();
  const by = new Map();
  records.forEach(r=>{
    if(!r.valid || !r.legajo || !isCountedCat(r.cat) || !mset.has(r.monthKey) || exMot.has(motivoKeyOf(r))) return;
    const k = r.legajo.toUpperCase();
    if(!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  });
  const out = [];
  by.forEach((rowsIn, k)=>{
    const rows = rowsIn.slice().sort((a,b)=>a.ts-b.ts);
    const dias = []; // un registro por día (si hubiera dos filas el mismo día, cuenta una)
    rows.forEach(r=>{ if(!dias.length || dias[dias.length-1].ts!==r.ts) dias.push(r); });
    const episodios = [];
    dias.forEach(r=>{
      const ep = episodios[episodios.length-1];
      if(ep && gapIsBridgeable(ep.finTs, r.ts)){ ep.finTs = r.ts; ep.rows.push(r); }
      else episodios.push({inicioTs:r.ts, finTs:r.ts, rows:[r]});
    });
    const porMes = {};
    let ap=0, anp=0, enf=0;
    dias.forEach(r=>{
      const m = porMes[r.monthKey] || (porMes[r.monthKey] = {dias:0, inicios:0});
      m.dias++;
      if(r.cat==="AP") ap++; else anp++;
      if(r.presidencia==="ENF") enf++;
    });
    const motivoCnt = new Map(), razonCnt = new Map();
    episodios.forEach(ep=>{
      ep.dias = ep.rows.length;
      const base = ep.rows.find(r=>motivoKeyOf(r)!=="CA") || ep.rows[0];
      ep.motivo = motivoLabelOf(base);
      ep.motivoKey = motivoKeyOf(base);
      const rz = (ep.rows.find(r=>r.razon) || {}).razon || "";
      ep.razon = rz;
      ep.presidencia = base.presidencia || "";
      const mk = ep.rows[0].monthKey;
      porMes[mk].inicios++;
      motivoCnt.set(ep.motivo, (motivoCnt.get(ep.motivo)||0)+1);
      if(rz){ const nk = normTxt(rz); const cur = razonCnt.get(nk) || {texto:rz, n:0}; cur.n++; razonCnt.set(nk, cur); }
    });
    const topMotivo = Array.from(motivoCnt.entries()).sort((a,b)=>b[1]-a[1])[0] || ["", 0];
    const razonesArr = Array.from(razonCnt.values()).sort((a,b)=>b.n-a.n);
    const conRazon = episodios.filter(ep=>ep.razon).length;
    const last = dias[dias.length-1];
    out.push({
      key:k, legajo:last.legajo, nombre:last.nombre||("Legajo "+last.legajo), unidad:last.unidad||"", departamento:last.departamento||"", sector:last.sector||"",
      ap, anp, enf, total:dias.length, episodios, nEpisodios:episodios.length, porMes,
      mesesConFaltas: Object.keys(porMes).length,
      mesesConInicio: Object.values(porMes).filter(m=>m.inicios>0).length,
      topMotivo:{label:topMotivo[0], n:topMotivo[1]},
      topRazon: razonesArr[0] ? {texto:razonesArr[0].texto, n:razonesArr[0].n} : null,
      conRazon
    });
  });
  return out;
}
function patronMotivoTexto(e){
  const t = e.topMotivo;
  const mismo = e.nEpisodios>=3 && t.n/e.nEpisodios >= 0.7;
  let txt = t.label+" — "+t.n+" de "+e.nEpisodios+" episodio"+(e.nEpisodios===1?"":"s");
  if(e.topRazon) txt += " · Razón más repetida: «"+e.topRazon.texto+"» ("+e.topRazon.n+" de "+e.conRazon+" con razón)";
  return {txt, mismo};
}

function ComiteAusentismo({comiteRecords, monthKeys, excludedMotivos, plantel}){
  const [ventana, setVentana] = useKeptState("cm.ventana", 12);
  const [minSel, setMinSel] = useKeptState("cm.min", null);       // null = automático (2/3 de los meses de la ventana)
  const [soloVig, setSoloVig] = useKeptState("cm.vigentes", true);
  const [verTodos, setVerTodos] = useKeptState("cm.todos", false);
  const [abierto, setAbierto] = useState(null);
  const [search, setSearch] = useState("");
  const hasPlantel = !!(plantel && plantel.length);
  const plantelBy = useMemo(()=> new Map((plantel||[]).map(p=>[(p.legajo||"").toUpperCase(), p])), [plantel]);
  const monthsWin = useMemo(()=> monthKeys.slice(-Math.min(ventana, monthKeys.length)), [monthKeys, ventana]);
  const N = monthsWin.length;
  const minAuto = Math.max(1, Math.ceil(N*2/3));
  const minMeses = Math.min(Math.max(1, N), Math.max(1, minSel!=null ? minSel : minAuto));

  const todos = useMemo(()=>{
    let list = analizarComite(comiteRecords, monthsWin, excludedMotivos).map(e=>{
      const p = plantelBy.get(e.key);
      return {...e, estado:(p&&p.estado)||"", unidad:(p&&p.unidad)||e.unidad,
        deptSector:[(p&&p.departamento)||e.departamento, (p&&p.sector)||e.sector].filter(Boolean).join(" - ")};
    });
    if(hasPlantel && soloVig) list = list.filter(e=>e.estado==="Vigente");
    // puesto en el ranking por días (para ver que el microausentismo no se detecta con ese ranking)
    const porDias = list.slice().sort((a,b)=>b.total-a.total || a.legajo.localeCompare(b.legajo));
    const pos = new Map(porDias.map((e,i)=>[e.key, i+1]));
    return list.map(e=>({...e, puesto:pos.get(e.key), micro: e.mesesConInicio>=minMeses}));
  }, [comiteRecords, monthsWin, excludedMotivos, plantelBy, hasPlantel, soloVig, minMeses]);

  const micro = useMemo(()=> todos.filter(e=>e.micro), [todos]);
  const q = normTxt(search);
  const base = (verTodos ? todos : micro).filter(e=>!q || normTxt(e.legajo).includes(q) || normTxt(e.nombre).includes(q));
  const sortC = useTableSort(base, {
    legajo:{get:e=>e.legajo, type:"text"}, nombre:{get:e=>e.nombre, type:"text"}, unidad:{get:e=>e.unidad, type:"text"}, deptSector:{get:e=>e.deptSector||"", type:"text"},
    ap:{get:e=>e.ap, type:"num"}, anp:{get:e=>e.anp, type:"num"}, enf:{get:e=>e.enf, type:"num"}, total:{get:e=>e.total, type:"num"},
    eps:{get:e=>e.nEpisodios, type:"num"}, meses:{get:e=>e.mesesConInicio, type:"num"}, puesto:{get:e=>e.puesto, type:"num"}, patron:{get:e=>e.topMotivo.label, type:"text"}
  }, {key:"meses", dir:"desc"});
  const sum = (arr, f) => arr.reduce((a,e)=>a+f(e), 0);

  function imprimir(){
    const e = escHtml;
    const filas = sortC.sorted.map(x=>{
      const pt = patronMotivoTexto(x);
      const meses = monthsWin.filter(mk=>x.porMes[mk]).map(mk=>monthLabel(mk)+" ("+x.porMes[mk].dias+")").join(", ");
      return "<tr><td class='id'>"+e(x.legajo)+"</td><td class='id'>"+e(x.nombre)+"</td><td>"+e(x.unidad||"—")+"</td><td>"+e(x.deptSector||"—")+"</td><td class='n'>"+x.ap+"</td><td class='n'>"+x.anp+"</td><td class='n'>"+x.enf+"</td><td class='n'>"+x.total+"</td><td class='n'>"+x.nEpisodios+"</td><td class='n'>"+x.mesesConInicio+" de "+N+"</td><td>"+e(meses)+"</td><td>"+(pt.mismo ? "<b>Mismo motivo.</b> " : "")+e(pt.txt)+"</td></tr>";
    }).join("");
    const css = `
      @page{size:A4 landscape;margin:10mm;}
      *{box-sizing:border-box;} body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#000;margin:0;}
      h2{margin:0 0 4px;font-size:19px;color:#0c2e80;} p{margin:0 0 8px;font-size:11.5px;color:#333;}
      table{width:100%;border-collapse:collapse;font-size:10px;}
      thead{display:table-header-group;}
      th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.03em;color:#555;padding:3px 4px;border:1px solid #9aa4b5;background:#eef3fb;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      td{padding:3px 4px;border:1px solid #9aa4b5;vertical-align:top;} tr{break-inside:avoid;}
      td.id{font-weight:700;font-size:11px;} td.n{text-align:right;}
    `;
    const rango = N ? monthLabel(monthsWin[0])+" a "+monthLabel(monthsWin[N-1]) : "—";
    const html = "<h2>Comité de ausentismo — "+(verTodos ? "Empleados con ausencias" : "Microausentismo")+"</h2>"+
      "<p>Período analizado: últimos "+N+" meses cargados ("+e(rango)+"). Criterio de microausentismo: episodios de ausencia iniciados en al menos "+minMeses+" de los "+N+" meses. "+sortC.sorted.length+" empleado(s) — "+e(new Date().toLocaleDateString("es-AR"))+".</p>"+
      "<table><thead><tr><th>Legajo</th><th>Empleado</th><th>Unidad</th><th>Departamento - Sector</th><th>Días AP</th><th>Días ANP</th><th>Días ENF</th><th>Total días</th><th>Episodios</th><th>Meses con faltas</th><th>Meses (días)</th><th>Motivo / razón de los episodios</th></tr></thead><tbody>"+filas+"</tbody></table>";
    const win = window.open("", "_blank");
    if(!win){ alert("El navegador bloqueó la ventana de impresión. Habilitá las ventanas emergentes para este sitio e intentá de nuevo."); return; }
    win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Comité de ausentismo</title><style>'+css+'</style></head><body>'+html+'</body></html>');
    win.document.close(); win.focus(); setTimeout(()=>{ win.print(); }, 400);
  }

  if(!N) return <div className="card table-card"><p className="desc">Todavía no hay datos de ausentismo cargados.</p></div>;
  const kpiBox = (label, value, hint) => (<div className="card kpi-tile"><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div>{hint && <div className="hint">{hint}</div>}</div>);
  return (
    <React.Fragment>
      <div className="card table-card">
        <h3>Comité de ausentismo</h3>
        <p className="caption">Análisis por empleado de los últimos meses cargados: días ausentes AP, ANP y ENF, en qué meses faltó y detección de <b>microausentismo</b> (empleados que faltan casi todos los meses con episodios cortos y repetidos, y por eso no aparecen arriba en el ranking por días). Se aplican los filtros de arriba (Gerencia, Departamento, Sector y Empresa) menos el de Mes, y los motivos que cuentan en Resumen.</p>
        <div className="filter-row">
          <label className="hint" style={{display:"flex", alignItems:"center", gap:6}}>Período
            <select value={ventana} onChange={e=>{ setVentana(parseInt(e.target.value,10)); setMinSel(null); }}>
              {[3,6,9,12].map(n=>(<option key={n} value={n}>Últimos {n} meses</option>))}
            </select>
          </label>
          <label className="hint" style={{display:"flex", alignItems:"center", gap:6}} title="Cantidad mínima de meses en los que el empleado empezó un episodio de ausencia para considerarlo microausentismo">Microausentismo: faltas en al menos
            <input type="number" min={1} max={N} value={minMeses} onChange={e=>{ const v=parseInt(e.target.value,10); setMinSel(isNaN(v)?null:Math.min(N,Math.max(1,v))); }} style={{width:64}} /> de {N} meses
          </label>
          {minSel!=null && <button type="button" className="btn secondary small" onClick={()=>setMinSel(null)}>Automático ({minAuto})</button>}
          {hasPlantel && (
            <label className="motivo-check" style={{cursor:"pointer"}}>
              <input type="checkbox" checked={soloVig} onChange={e=>setSoloVig(e.target.checked)} /> Solo empleados vigentes
            </label>
          )}
          <label className="motivo-check" style={{cursor:"pointer"}}>
            <input type="checkbox" checked={verTodos} onChange={e=>setVerTodos(e.target.checked)} /> Ver todos los empleados con ausencias
          </label>
          <input type="text" placeholder="Buscar legajo o nombre…" value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:220}} />
          <button type="button" className="btn secondary print-btn" onClick={imprimir} disabled={!sortC.sorted.length}>Imprimir</button>
        </div>
        <div className="kpi-grid">
          {kpiBox("Con ausencias en el período", fmt(todos.length), N+" meses: "+monthLabel(monthsWin[0])+" a "+monthLabel(monthsWin[N-1]))}
          {kpiBox("Con microausentismo", fmt(micro.length), todos.length ? fmtPct(micro.length/todos.length*100,1)+" de los que faltaron" : "")}
          {kpiBox("Días AP / ANP (microausentismo)", fmt(sum(micro,e=>e.ap))+" / "+fmt(sum(micro,e=>e.anp)), "ENF: "+fmt(sum(micro,e=>e.enf))+" días")}
          {kpiBox("Días AP / ANP (todos)", fmt(sum(todos,e=>e.ap))+" / "+fmt(sum(todos,e=>e.anp)), "ENF: "+fmt(sum(todos,e=>e.enf))+" días")}
        </div>
        <div className="caption" style={{display:"flex", gap:14, flexWrap:"wrap", alignItems:"center"}}>
          <span>Meses con faltas:</span>
          <span style={{display:"inline-flex", alignItems:"center", gap:5}}><span style={{width:11, height:16, borderRadius:3, background:"var(--accent)"}}></span> empezó un episodio ese mes</span>
          <span style={{display:"inline-flex", alignItems:"center", gap:5}}><span style={{width:11, height:16, borderRadius:3, background:"color-mix(in srgb, var(--accent) 35%, var(--surface))"}}></span> solo continuó una ausencia anterior</span>
          <span style={{display:"inline-flex", alignItems:"center", gap:5}}><span style={{width:11, height:16, borderRadius:3, background:"var(--border)"}}></span> sin faltas</span>
        </div>
        <div className="overflow-x">
          <table>
            <thead><tr>
              <SortTh k="legajo" label="Legajo" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="nombre" label="Empleado" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="unidad" label="Unidad" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="deptSector" label="Departamento - Sector" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="ap" label="Días AP" className="num" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="anp" label="Días ANP" className="num" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="enf" label="Días ENF" className="num" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="total" label="Total días" className="num" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="eps" label="Episodios" className="num" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="meses" label="Meses con episodios" className="num" sort={sortC.sort} toggle={sortC.toggle} />
              <th>Meses</th>
              <SortTh k="puesto" label="Puesto en ranking por días" className="num" sort={sortC.sort} toggle={sortC.toggle} />
              <SortTh k="patron" label="Motivo / razón" sort={sortC.sort} toggle={sortC.toggle} />
              <th></th>
            </tr></thead>
            <tbody>
              {!sortC.sorted.length && <tr><td colSpan="14" style={{textAlign:"center",color:"var(--muted)",padding:"18px 0"}}>{verTodos ? "Sin empleados con ausencias con estos filtros." : "No se detectó microausentismo con este criterio (probá bajando la cantidad mínima de meses)."}</td></tr>}
              {sortC.sorted.map(e=>{
                const pt = patronMotivoTexto(e);
                const abre = abierto===e.key;
                return (
                  <React.Fragment key={e.key}>
                    <tr>
                      <td style={{fontWeight:700}}>{e.legajo}</td>
                      <td style={{fontWeight:700}}>{e.nombre}</td>
                      <td>{e.unidad||"—"}</td>
                      <td>{e.deptSector||"—"}</td>
                      <td className="num">{fmt(e.ap)}</td><td className="num">{fmt(e.anp)}</td><td className="num">{fmt(e.enf)}</td><td className="num">{fmt(e.total)}</td>
                      <td className="num">{fmt(e.nEpisodios)}</td>
                      <td className="num" style={{whiteSpace:"nowrap"}}>{e.mesesConInicio} de {N}{e.micro && <span className="schip bad" style={{marginLeft:6, fontSize:10.5, padding:"2px 7px"}}>Micro</span>}</td>
                      <td>
                        <span style={{display:"inline-flex", gap:2}}>
                          {monthsWin.map(mk=>{ const d = e.porMes[mk];
                            const bg = d && d.inicios ? "var(--accent)" : d ? "color-mix(in srgb, var(--accent) 35%, var(--surface))" : "var(--border)";
                            return <span key={mk} title={monthLabel(mk)+": "+(d ? d.dias+" día(s) ausente(s), "+d.inicios+" episodio(s) iniciado(s)" : "sin faltas")} style={{width:11, height:16, borderRadius:3, background:bg}}></span>; })}
                        </span>
                      </td>
                      <td className="num">{e.puesto}</td>
                      <td style={{minWidth:260}}>{pt.mismo && <span className="schip warn" style={{marginRight:6, fontSize:10.5, padding:"2px 7px"}}>Mismo motivo</span>}{pt.txt}</td>
                      <td><button type="button" className="btn secondary small" onClick={()=>setAbierto(abre ? null : e.key)}>{abre ? "Cerrar" : "Ver episodios"}</button></td>
                    </tr>
                    {abre && (
                      <tr><td colSpan="14" style={{background:"var(--plane)"}}>
                        <div className="hint" style={{fontWeight:700, marginBottom:4}}>Episodios de {e.nombre} — {e.nEpisodios} en {e.mesesConFaltas} mes(es)</div>
                        <table style={{width:"100%"}}>
                          <thead><tr><th>Inicio</th><th>Fin</th><th className="num">Días</th><th>Motivo</th><th>Razón</th><th>Agrupador</th></tr></thead>
                          <tbody>
                            {e.episodios.map((ep,i)=>(<tr key={i}><td>{fmtDateFromTs(ep.inicioTs)}</td><td>{fmtDateFromTs(ep.finTs)}</td><td className="num">{ep.dias}</td><td>{ep.motivo}</td><td>{ep.razon||"—"}</td><td>{ep.presidencia||"—"}</td></tr>))}
                          </tbody>
                        </table>
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </React.Fragment>
  );
}

function RankingTab({scopeUnitsMap, hasUnidad, idMotivoUniverse, presidenciaUniverse, presidenciaCats, idIncluded, setIdIncluded, presIncluded, setPresIncluded, plantel, ocultarFiltrosMotivo, comiteRecords, monthKeys, excludedMotivos}){
  const [vista, setVista] = useKeptState("rk.vista", "ranking"); // "ranking" | "comite"
  const [unitFilter, setUnitFilter] = useState("__all");
  const [soloVigentes, setSoloVigentes] = useState(true);
  const unitNames = useMemo(()=> Array.from(scopeUnitsMap.keys()).sort(), [scopeUnitsMap]);
  const hasPlantel = plantel && plantel.length>0;
  const plantelByLegajo = useMemo(()=> new Map((plantel||[]).map(p=>[(p.legajo||"").toUpperCase(), p])), [plantel]);
  const employees = useMemo(()=>{
    const byLegajo = new Map();
    scopeUnitsMap.forEach((rows, name)=>{
      if(unitFilter!=="__all" && name!==unitFilter) return;
      rows.forEach(r=>{
        if(!r.legajo || !r.idMotivo) return;
        const idKey = r.idMotivo.toUpperCase();
        if(!idIncluded.has(idKey)) return;
        if(r.presidencia && !presIncluded.has(r.presidencia)) return;
        const k = name+"::"+r.legajo;
        if(!byLegajo.has(k)){
          const p = plantelByLegajo.get((r.legajo||"").toUpperCase());
          // Departamento - Sector: se toma del plantel (dato vigente) y, si el legajo no está, de las filas de ausentismo
          const deptSector = [(p&&p.departamento)||r.departamento||"", (p&&p.sector)||r.sector||""].filter(Boolean).join(" - ");
          byLegajo.set(k, {legajo:r.legajo, nombre:r.nombre||("Legajo "+r.legajo), unidad:name, deptSector, sindicato:r.sindicato||"", estado:(p&&p.estado)||"", count:0});
        }
        byLegajo.get(k).count++;
      });
    });
    let list = Array.from(byLegajo.values());
    if(hasPlantel && soloVigentes) list = list.filter(e=>e.estado==="Vigente");
    return list.sort((a,b)=>b.count-a.count).slice(0,20);
  }, [scopeUnitsMap, unitFilter, idIncluded, presIncluded, plantelByLegajo, hasPlantel, soloVigentes]);
  const empSort = useTableSort(employees, {
    legajo:{get:e=>e.legajo, type:"text"}, nombre:{get:e=>e.nombre, type:"text"}, unidad:{get:e=>e.unidad, type:"text"}, deptSector:{get:e=>e.deptSector, type:"text"},
    sindicato:{get:e=>e.sindicato, type:"text"}, estado:{get:e=>e.estado, type:"text"}, count:{get:e=>e.count, type:"num"}
  });

  return (
    <div className="tabpanel">
      <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
        <button type="button" className={"btn"+(vista==="ranking" ? "" : " secondary")} onClick={()=>setVista("ranking")}>Ranking de empleados</button>
        <button type="button" className={"btn"+(vista==="comite" ? "" : " secondary")} onClick={()=>setVista("comite")}>Comité de ausentismo</button>
      </div>
      {vista==="comite" && <ComiteAusentismo comiteRecords={comiteRecords||[]} monthKeys={monthKeys||[]} excludedMotivos={excludedMotivos} plantel={plantel} />}
      {vista==="ranking" && !ocultarFiltrosMotivo && <div className="toggle-grid" style={{gridTemplateColumns:"1fr"}}>
        <ToggleList title="Id Motivo a incluir" items={idMotivoUniverse.map(m=>({key:m.key,label:m.label,ap:m.ap,anp:m.anp}))} included={idIncluded} onChange={setIdIncluded}
          defaultKeys={idMotivoUniverse.filter(m=>isDefaultIncludedMotivoCode(m.key)).map(m=>m.key)} />
        <ToggleList title="Agrupador cuadro presidencia a incluir" items={presidenciaUniverse.map(v=>({key:v,label:v,ap:(presidenciaCats[v]||{}).ap||0,anp:(presidenciaCats[v]||{}).anp||0}))} included={presIncluded} onChange={setPresIncluded}
          defaultKeys={presidenciaUniverse.filter(v=>RANKING_DEFAULT_PRESIDENCIA_INCLUDE.has(v))} />
      </div>}
      {vista==="ranking" && <div className="card table-card">
        <h3>Ranking de empleados</h3>
        <p className="caption">Suma filas cuyo Id Motivo y Agrupador cuadro presidencia estén tildados arriba — independiente del resto de filtros de ausentismo.</p>
        <div className="filter-row">
          {hasUnidad && (
            <select value={unitFilter} onChange={e=>setUnitFilter(e.target.value)}>
              <option value="__all">Todas las unidades</option>
              {unitNames.map(u=>(<option key={u} value={u}>{u}</option>))}
            </select>
          )}
          {hasPlantel && (
            <label className="motivo-check" style={{cursor:"pointer"}}>
              <input type="checkbox" checked={soloVigentes} onChange={e=>setSoloVigentes(e.target.checked)} />
              Solo empleados vigentes
            </label>
          )}
          {!hasPlantel && <span className="hint">Subí el Plantel para ver el Estado y filtrar por vigentes.</span>}
        </div>
        <div className="overflow-x">
          <table>
            <thead><tr>
              <SortTh k="legajo" label="Legajo" sort={empSort.sort} toggle={empSort.toggle} />
              <SortTh k="nombre" label="Empleado" sort={empSort.sort} toggle={empSort.toggle} />
              {hasUnidad && <SortTh k="unidad" label="Unidad" sort={empSort.sort} toggle={empSort.toggle} />}
              <SortTh k="deptSector" label="Departamento - Sector" sort={empSort.sort} toggle={empSort.toggle} />
              <SortTh k="sindicato" label="Sindicato" sort={empSort.sort} toggle={empSort.toggle} />
              {hasPlantel && <SortTh k="estado" label="Estado" sort={empSort.sort} toggle={empSort.toggle} />}
              <SortTh k="count" label="Filas incluidas" className="num" sort={empSort.sort} toggle={empSort.toggle} />
            </tr></thead>
            <tbody>
              {!employees.length && <tr><td colSpan="7" style={{textAlign:"center",color:"var(--muted)",padding:"18px 0"}}>Sin filas con estos filtros.</td></tr>}
              {empSort.sorted.map(e=>(
                <tr key={e.unidad+"::"+e.legajo}>
                  <td>{e.legajo}</td>
                  <td>{e.nombre}</td>
                  {hasUnidad && <td>{e.unidad}</td>}
                  <td>{e.deptSector || "—"}</td>
                  <td>{e.sindicato||"—"}</td>
                  {hasPlantel && <td>{e.estado||"—"}</td>}
                  <td className="num">{fmt(e.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>}
    </div>
  );
}

/* ===================== detalle empleados ===================== */
function SearchSelect({options, value, onChange, placeholder}){
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef(null);
  useEffect(()=>{
    function onDoc(e){ if(ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("click", onDoc);
    return ()=>document.removeEventListener("click", onDoc);
  }, []);
  const selectedOpt = options.find(o=>o.value===value);
  const filtered = search ? options.filter(o=>o.label.toLowerCase().includes(search.toLowerCase())) : options;
  return (
    <div className="msel" ref={ref}>
      <button type="button" className="msel-toggle" style={{width:280}} onClick={()=>setOpen(o=>!o)}>{selectedOpt ? selectedOpt.label : (placeholder||"Elegir…")}</button>
      {open && (
        <div className="msel-menu" style={{width:320}}>
          <input className="msel-search" autoFocus placeholder="Buscar por legajo o nombre…" value={search} onChange={e=>setSearch(e.target.value)} />
          <div className="msel-options">
            {filtered.slice(0,300).map(o=>(
              <div key={o.value} className="msel-opt" style={{cursor:"pointer"}} onClick={()=>{ onChange(o.value); setOpen(false); setSearch(""); }}>
                <span>{o.label}</span>
              </div>
            ))}
            {!filtered.length && <div className="hint" style={{padding:"6px 4px"}}>Sin resultados.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
function EmployeeBarChart({items}){
  const chartW = 520, chartH=220, padB=30, padT=26, gap=20;
  const maxVal = Math.max(1, ...items.map(i=>i.value));
  const barW = (chartW - gap*(items.length+1)) / items.length;
  return (
    <svg className="chart" style={{maxWidth:chartW}} viewBox={"0 0 "+chartW+" "+chartH}>
      {items.map((it,i)=>{
        const x = gap + i*(barW+gap);
        const h = (chartH-padT-padB) * (it.value/maxVal);
        const y = chartH-padB-h;
        return (
          <g key={it.label}>
            <rect x={x} y={y} width={barW} height={Math.max(h,1)} rx="4" fill={it.color} />
            <text x={x+barW/2} y={y-8} fontSize="13" fontWeight="700" textAnchor="middle" fill="var(--ink)">{fmt(it.value)}</text>
            <text x={x+barW/2} y={chartH-10} fontSize="11" textAnchor="middle" fill="var(--muted)">{it.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
// Selección "Por defecto" del filtro Id Motivo de Detalle Empleados (la vigente al 15/10/2026).
const DETALLE_DEFAULT_MOTIVOS = new Set(["AT","CA","CAE","CJ","DS","EFS","EN","ET","EX","FA","JRP","LSS","MA","MT","MU","NAC","SA"]);
// Estilos del calendario anual del Detalle de empleados. Van dentro de la propia tarjeta para que valgan igual en pantalla y en la hoja impresa.
const ANUAL_GRID_CSS = `
.ygrid-wrap{overflow-x:auto;}
.ygrid{width:100%;min-width:820px;border-collapse:collapse;table-layout:fixed;font-size:11px;}
.ygrid th,.ygrid td{border:1px solid #777 !important;padding:0 !important;text-align:center;height:26px;background:#fff;color:#000;font-weight:600;overflow:hidden;}
.ygrid thead th{height:24px;font-size:11px;letter-spacing:0;text-transform:none;background:#e9e9e9;color:#000;}
.ygrid th.ymes{width:92px;text-align:left;padding-left:6px !important;font-size:11px;background:#e9e9e9;}
.ygrid td.g-off,.ygrid-leg i.g-off{background:#d3d3d3;}
.ygrid td.g-ap,.ygrid-leg i.g-ap{background:#ffff00;}
.ygrid td.g-anp,.ygrid-leg i.g-anp{background:#ffb300;}
.ygrid td.g-none{background:repeating-linear-gradient(45deg,#f4f4f4,#f4f4f4 3px,#cfcfcf 3px,#cfcfcf 4px);}
.ygrid-leg{display:flex;gap:22px;flex-wrap:wrap;margin-top:12px;font-size:12px;}
.ygrid-leg span{display:inline-flex;align-items:center;gap:6px;}
.ygrid-leg i{display:inline-block;width:20px;height:14px;border:1px solid #777;}
`;
function DetalleEmpleadosTab({parsed, plantel, motivosPorDefecto}){
  const employeeOptions = useMemo(()=>{
    const map = new Map();
    parsed.records.forEach(r=>{
      if(!r.legajo) return;
      const key = r.legajo.toUpperCase();
      if(!map.has(key)) map.set(key, {legajo:r.legajo, nombre:r.nombre||""});
    });
    return Array.from(map.values())
      .map(e=>({value:e.legajo, nombre:(e.nombre||"").toUpperCase(), label:e.legajo+" "+(e.nombre||"").toUpperCase()}))
      .sort((a,b)=> a.nombre.localeCompare(b.nombre, "es") || a.value.localeCompare(b.value, "es"));
  }, [parsed]);

  const availableYearsAll = useMemo(()=>{
    const ys = new Set();
    parsed.records.forEach(r=>{ if(r.valid) ys.add(r.anio); });
    return Array.from(ys).sort((a,b)=>a-b);
  }, [parsed]);

  const [legajoSel, setLegajoSel] = useKeptState("de.legajo", () => employeeOptions[0] ? employeeOptions[0].value : "");
  const [periodoVal, setPeriodoVal] = useKeptState("de.periodo", "todos");
  const [customMonths, setCustomMonths] = useKeptState("de.meses", () => new Set([1,2,3,4,5,6,7,8,9,10,11,12]));
  const [conCronicos, setConCronicos] = useKeptState("de.conCronicos", false);
  const [agrupar, setAgrupar] = useKeptState("de.agrupar", true);   // días seguidos con el mismo motivo -> un renglón con inicio y fin
  const [anioSel, setAnioSel] = useKeptState("de.anio", () => availableYearsAll.length ? availableYearsAll[availableYearsAll.length-1] : null);
  const motivosSig = parsed.idMotivoUniverse.map(m=>m.key).join(",");
  // El filtro arranca en "Por defecto" (DETALLE_DEFAULT_MOTIVOS)
  const [idMotivoElegido, setIdMotivoIncluded] = useKeptState("de.idMotivo|"+motivosSig, () => new Set(parsed.idMotivoUniverse.filter(m=>DETALLE_DEFAULT_MOTIVOS.has(m.key)).map(m=>m.key)));
  // motivosPorDefecto (Servicio médico): el filtro no se muestra y se usan siempre los Id Motivo "Por defecto"
  const idMotivoIncluded = useMemo(
    ()=> motivosPorDefecto ? new Set(parsed.idMotivoUniverse.filter(m=>DETALLE_DEFAULT_MOTIVOS.has(m.key)).map(m=>m.key)) : idMotivoElegido,
    [motivosPorDefecto, parsed, idMotivoElegido]);

  // si lo guardado ya no existe en los datos actuales (otro archivo, otro año), vuelve al primero disponible
  useEffect(()=>{
    if(employeeOptions.length && !employeeOptions.some(o=>o.value===legajoSel)) setLegajoSel(employeeOptions[0].value);
  }, [employeeOptions, legajoSel]);
  useEffect(()=>{
    if(availableYearsAll.length && !availableYearsAll.includes(anioSel)) setAnioSel(availableYearsAll[availableYearsAll.length-1]);
  }, [availableYearsAll, anioSel]);

  const periodoMonths = periodoVal==="personalizado" ? Array.from(customMonths) : ((PERIODO_OPTIONS.find(p=>p.value===periodoVal)||{}).months || []);
  const periodoLabel = useMemo(()=>{
    const base = periodoVal==="personalizado"
      ? (customMonths.size ? Array.from(customMonths).sort((a,b)=>a-b).map(m=>MESES[m-1]).join(", ") : "Sin meses")
      : ((PERIODO_OPTIONS.find(p=>p.value===periodoVal)||{}).label || "");
    return base + (anioSel ? " " + anioSel : "");
  }, [periodoVal, customMonths, anioSel]);

  const ficha = useMemo(()=> parsed.records.find(r=>r.legajo===legajoSel) || null, [parsed, legajoSel]);
  const plantelFicha = useMemo(()=>{
    if(!legajoSel) return null;
    return (plantel||[]).find(p => (p.legajo||"").toUpperCase()===legajoSel.toUpperCase()) || null;
  }, [plantel, legajoSel]);
  // La ficha toma los datos vigentes del plantel (si el campo está vacío en el plantel, queda vacío: no se mezcla con datos viejos).
  // Solo si el legajo no está en el plantel cae a lo que figura en las filas de ausentismo.
  function fichaDato(campo){
    if(plantelFicha) return plantelFicha[campo]||"";
    return ficha ? (ficha[campo]||"") : "";
  }

  const scopeE = useMemo(()=>{
    if(!legajoSel || anioSel==null) return [];
    const monthsSet = new Set(periodoMonths);
    return parsed.records.filter(r=> r.valid && r.legajo===legajoSel && r.anio===anioSel && monthsSet.has(r.mes));
  }, [parsed, legajoSel, anioSel, periodoVal, customMonths]);

  // Calendario anual: todas las ausencias AP/ANP del legajo en el año elegido (no depende del período ni del filtro de Id Motivo).
  // Clave "mes-día" -> {code, cat, label}; además marca como no laborable ("off-mes-día") los días que el archivo trae como feriado (Id Motivo FER).
  const anualMap = useMemo(()=>{
    const map = new Map();
    if(!legajoSel || anioSel==null) return map;
    parsed.records.forEach(r=>{
      if(!r.valid || r.legajo!==legajoSel || r.anio!==anioSel) return;
      const k = r.mes+"-"+r.dia;
      if(r.cat==="AP" || r.cat==="ANP"){
        if(!map.has(k)) map.set(k, {code:(r.idMotivo||"").toUpperCase(), cat:r.cat, label:(r.motivo||r.idMotivo||"")+(r.razon ? " — "+r.razon : "")});
      } else if((r.idMotivo||"").toUpperCase()==="FER") map.set("off-"+k, true);
    });
    return map;
  }, [parsed, legajoSel, anioSel]);

  const cardVals = useMemo(()=>{
    let presentes=0, vac=0, ap=0, anp=0, sanciones=0;
    scopeE.forEach(r=>{
      if(r.presidencia==="SUSP") sanciones++;
      if(r.cat==="P") presentes++;
      else if(r.cat==="V") vac++;
      else if(r.cat==="AP") ap++;
      else if(r.cat==="ANP" && r.presidencia!=="SUSP") anp++;
    });
    return {presentes, vac, ap, anp, sanciones};
  }, [scopeE]);

  const ausenciaRows = useMemo(()=>{
    // el detalle muestra todos los días del período cuyo Id Motivo está tildado en el filtro (ausencias, vacaciones, etc.),
    // sin importar el "Estado" de la fila: antes solo salían las de estado "A" y las vacaciones tildadas no aparecían.
    return scopeE.filter(r=> r.idMotivo && idMotivoIncluded.has(r.idMotivo.toUpperCase()))
      .slice().sort((a,b)=> a.ts-b.ts);
  }, [scopeE, idMotivoIncluded]);

  function tipoOf(r){
    if(r.presidencia==="SUSP") return "Sanción";
    switch(r.agrup){
      case "V": return "Vacaciones";
      case "AP": return "Ausente Pago";
      case "ANP": return "Ausente No Pago";
      case "CE": return "Cesante";
      case "BAJA": return "Baja";
      default: return r.agrup || "(vacío)";
    }
  }
  const ausSort = useTableSort(ausenciaRows, {
    fecha:{get:r=>r.ts, type:"num"}, estado:{get:r=>r.estado, type:"text"}, idMotivo:{get:r=>r.idMotivo, type:"text"},
    agrup:{get:r=>r.agrup||"(vacío)", type:"text"}, presidencia:{get:r=>r.presidencia||"", type:"text"},
    tipo:{get:r=>tipoOf(r), type:"text"}, motivo:{get:r=>r.motivo, type:"text"}, razon:{get:r=>r.razon, type:"text"}
  });

  // Períodos: días consecutivos con el mismo Id Motivo se juntan en un solo renglón (desde / hasta / días). Los fines de semana y feriados
  // entre dos días no cortan el período; cualquier día hábil sin ese motivo sí.
  const ausGrupos = useMemo(()=>{
    const out = [];
    ausenciaRows.forEach(r=>{
      const key = [r.idMotivo, r.agrup, r.presidencia, tipoOf(r)].join("|");
      const g = out[out.length-1];
      if(g && g.key===key && (r.ts===g.hastaTs || gapIsBridgeable(g.hastaTs, r.ts))){
        if(r.ts!==g.hastaTs) g.dias++;
        g.hastaTs = r.ts;
        if(r.razon && !g.razones.includes(r.razon)) g.razones.push(r.razon);
        if(r.estado && !g.estados.includes(r.estado)) g.estados.push(r.estado);
      } else {
        out.push({key, desdeTs:r.ts, hastaTs:r.ts, dias:1, row:r, razones:r.razon?[r.razon]:[], estados:r.estado?[r.estado]:[]});
      }
    });
    return out;
  }, [ausenciaRows]);
  const grpSort = useTableSort(ausGrupos, {
    desde:{get:g=>g.desdeTs, type:"num"}, hasta:{get:g=>g.hastaTs, type:"num"}, dias:{get:g=>g.dias, type:"num"},
    estado:{get:g=>g.estados.join(" / "), type:"text"}, idMotivo:{get:g=>g.row.idMotivo, type:"text"},
    agrup:{get:g=>g.row.agrup||"(vacío)", type:"text"}, presidencia:{get:g=>g.row.presidencia||"", type:"text"},
    tipo:{get:g=>tipoOf(g.row), type:"text"}, motivo:{get:g=>g.row.motivo, type:"text"}, razon:{get:g=>g.razones.join(" / "), type:"text"}
  });

  // Historial de Crónicos del empleado (últimos 12 meses): lee los casos guardados en Supabase y arma el bloque para la impresión.
  // Incluye observaciones/evolución y acciones registradas en ese lapso (las anteriores no se imprimen).
  async function historialCronicosHtml(){
    const e = escHtml;
    const desdeTs = Date.now() - 365*86400000;
    const {data, error} = await supabaseClient.from(CRONICOS_CASOS_TABLE).select("*").eq("legajo", legajoSel);
    if(error) throw error;
    const motLabel = new Map(parsed.idMotivoUniverse.map(m=>[String(m.key).toUpperCase(), m.label]));
    motLabel.set("MANUAL", "Citación manual a Medicina Laboral");
    const pref = sanitizeIdSeg(legajoSel)+"-";
    // los casos provisorios (empleado citado a mano antes de figurar en Crónicos) van al final: lo ya copiado al caso real no se repite
    const vistas = new Set();
    const casos = (data||[]).slice().sort((a,b)=> (esCasoManualId(a.id)?1:0)-(esCasoManualId(b.id)?1:0)).map(row=>{
      const m = casoRowToManual(row);
      const movs = [
        ...m.observaciones.map(o=>({...o, tipoMov:"Observación"})),
        ...m.acciones.map(o=>({...o, tipoMov:"Acción"}))
      ].filter(o=>o.ts>=desdeTs && !(o.id && vistas.has(o.id))).sort((a,b)=>a.ts-b.ts);
      movs.forEach(o=>{ if(o.id) vistas.add(o.id); });
      let mk = String(row.id||"");
      if(mk.startsWith(pref)) mk = mk.slice(pref.length);
      mk = mk.replace(/-[^-]*$/, "");
      return {row, m, movs, motivo: motLabel.get(mk.toUpperCase()) || mk || "—"};
    }).filter(c=>c.movs.length).sort((a,b)=> b.row.anio-a.row.anio || b.movs[b.movs.length-1].ts-a.movs[a.movs.length-1].ts);
    const titulo = "<h3>Historial de Crónicos — últimos 12 meses</h3><p class='desc'>Registrado desde el "+fmtDateFromTs(Math.floor(desdeTs/86400000)*86400000)+" hasta hoy.</p>";
    if(!casos.length) return "<div class='card table-card cron-hist print-page-break'>"+titulo+"<p class='desc'>Sin registros en Crónicos para este empleado en los últimos 12 meses.</p></div>";
    return "<div class='card table-card cron-hist print-page-break'>"+titulo+casos.map(c=>{
      const datos = [["Tipo", c.m.tipo], ["Opinión médica", c.m.opinionMedica], ["Táctico empleado", c.m.tactoEmpleado], ["Posible alta", c.m.posibleAlta]].filter(x=>x[1])
        .map(x=>"<div><span class='lbl'>"+e(x[0])+"</span><span class='val' style='font-weight:400'>"+e(x[1])+"</span></div>").join("");
      return "<div class='cron-caso'><h4>"+e(c.motivo)+" · "+e(c.row.anio)+"</h4>"+
        (datos ? "<div class='ficha-grid' style='margin-bottom:8px'>"+datos+"</div>" : "")+
        "<table><thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th>Registró</th></tr></thead><tbody>"+
        c.movs.map(o=>"<tr><td style='white-space:nowrap;vertical-align:top'>"+e(new Date(o.ts).toLocaleString("es-AR"))+"</td><td style='vertical-align:top'>"+e(o.tipoMov)+(o.origen==="medicina" ? " · Medicina Laboral" : "")+"</td><td style='white-space:pre-wrap'>"+e(o.texto)+"</td><td style='vertical-align:top'>"+e(o.autor||"—")+"</td></tr>").join("")+
        "</tbody></table></div>";
    }).join("")+"</div>";
  }

  async function handlePrint(){
    const blocks = Array.from(document.querySelectorAll(".de-print-block"));
    if(!blocks.length) return;
    let html = blocks.map(el=>el.outerHTML).join("\n");
    const printCss = `
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      .cron-caso{margin-top:12px;}
      .cron-caso h4{margin:0 0 6px;font-size:13px;color:#0c2e80;}
      @page{size:landscape;}
      *{box-sizing:border-box;}
      body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#000;margin:24px;}
      .print-header{margin-bottom:16px;}
      .print-header h2{margin:0 0 4px;font-size:19px;}
      .print-header .sub{margin:0;font-size:12.5px;color:#444;}
      .card{border:1px solid #ccc;border-radius:10px;padding:16px 18px;margin-bottom:16px;break-inside:avoid;}
      .card h3{margin:0 0 8px;font-size:14.5px;}
      .desc,.caption{color:#555;font-size:12px;margin:0 0 8px;}
      .print-row{break-inside:avoid;}
      .print-page-break{page-break-before:always;break-before:page;}
      .ficha-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px 16px;}
      .lbl{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#666;font-weight:700;}
      .val{display:block;font-size:14px;font-weight:600;margin-top:2px;color:#000;}
      table{width:100%;border-collapse:collapse;font-size:12.5px;}
      thead th{text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#666;padding:0 6px 8px;border-bottom:1px solid #ccc;}
      tbody td{padding:6px 6px;border-bottom:1px solid #e5e5e5;}
      svg{width:100%;height:auto;display:block;}
      .chart-card svg{max-width:640px;margin:4px auto 0;}
    `;
    // la ventana se abre ya (con el clic) para que el navegador no la bloquee; el historial se lee del servidor mientras tanto
    const win = window.open("", "_blank");
    if(!win){
      alert("El navegador bloqueó la ventana de impresión. Habilitá las ventanas emergentes para este sitio e intentá de nuevo.");
      return;
    }
    if(conCronicos){
      win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Detalle Empleados</title></head><body style="font-family:Arial,sans-serif;margin:24px">Preparando el historial de Crónicos…</body></html>');
      try{
        html += "\n" + await historialCronicosHtml();
      }catch(err){
        win.close();
        alert("No se pudo leer el historial de Crónicos ("+((err && err.message) || "error")+"). Probá de nuevo; si el problema sigue, imprimí sin esa opción.");
        return;
      }
      win.document.open();
    }
    win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Detalle Empleados</title><style>'+printCss+'</style></head><body>'+html+'</body></html>');
    win.document.close();
    win.focus();
    setTimeout(()=>{ win.print(); }, 300);
  }

  if(!employeeOptions.length) return <div className="tabpanel"><div className="card chart-card"><p className="desc">Sin legajos en la base.</p></div></div>;

  return (
    <div className="tabpanel">
      <div className="print-header de-print-block">
        <h2>Detalle Empleados</h2>
        <p className="sub">Período: {periodoLabel}</p>
      </div>

      <div className="card controls no-print">
        <div className="field">
          <label>Empleado</label>
          <SearchSelect options={employeeOptions} value={legajoSel} onChange={setLegajoSel} placeholder="Buscar legajo o nombre…" />
        </div>
        <div className="field">
          <label>Período</label>
          <select value={periodoVal} onChange={e=>setPeriodoVal(e.target.value)}>
            {PERIODO_OPTIONS.map(p=>(<option key={p.value} value={p.value}>{p.label}</option>))}
          </select>
        </div>
        <div className="field">
          <label>Año</label>
          <select value={anioSel||""} onChange={e=>setAnioSel(parseInt(e.target.value,10))}>
            {availableYearsAll.map(y=>(<option key={y} value={y}>{y}</option>))}
          </select>
        </div>
        <label className="motivo-check" style={{alignSelf:"flex-end", paddingBottom:8}} title="Si un motivo se repite en días seguidos, el detalle muestra una sola línea con fecha de inicio y de fin (en pantalla y al imprimir)">
          <input type="checkbox" checked={agrupar} onChange={e=>setAgrupar(e.target.checked)} />
          Agrupar días consecutivos (inicio y fin)
        </label>
        <label className="motivo-check" style={{alignSelf:"flex-end", paddingBottom:8}} title="Agrega al final de la hoja lo registrado en Crónicos (observaciones y acciones) durante los últimos 12 meses">
          <input type="checkbox" checked={conCronicos} onChange={e=>setConCronicos(e.target.checked)} />
          Incluir historial de Crónicos (últimos 12 meses)
        </label>
        <button type="button" className="btn secondary print-btn" onClick={handlePrint}>Imprimir</button>
      </div>

      {periodoVal==="personalizado" && (
        <div className="card motivo-settings no-print">
          <h3>Meses (personalizado)</h3>
          <div className="motivo-checklist">
            {MESES.map((m,i)=>(
              <label key={i} className="motivo-check">
                <input type="checkbox" checked={customMonths.has(i+1)} onChange={()=>{
                  const next = new Set(customMonths);
                  if(next.has(i+1)) next.delete(i+1); else next.add(i+1);
                  setCustomMonths(next);
                }} />
                {m}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="print-row de-print-block">
        {ficha && (
          <div className="card table-card">
            <h3>Ficha del empleado</h3>
            <div className="ficha-grid">
              <div><span className="lbl">Legajo</span><span className="val">{ficha.legajo}</span></div>
              <div><span className="lbl">Nombre</span><span className="val">{fichaDato("nombre") || "—"}</span></div>
              <div><span className="lbl">Unidad de Negocio</span><span className="val">{fichaDato("unidad") || "—"}</span></div>
              <div><span className="lbl">Sector</span><span className="val">{fichaDato("sector") || "—"}</span></div>
              <div><span className="lbl">Puesto</span><span className="val">{fichaDato("puesto") || "—"}</span></div>
              <div><span className="lbl">Jefe directo</span><span className="val">{fichaDato("jefe") || "—"}</span></div>
              <div><span className="lbl">Celular</span><span className="val">{(plantelFicha && plantelFicha.celular) || "—"}</span></div>
              <div><span className="lbl">Fecha de Ingreso</span><span className="val">{plantelFicha && plantelFicha.altaTs!=null ? fmtDateFromTs(plantelFicha.altaTs) : "—"}</span></div>
              <div><span className="lbl">Edad</span><span className="val">{plantelFicha && plantelFicha.nacimientoTs!=null ? calcEdad(plantelFicha.nacimientoTs)+" años" : "—"}</span></div>
            </div>
          </div>
        )}

        <div className="card chart-card">
          <h3>Días por categoría</h3>
          <p className="desc">Cantidad de filas del período elegido — no depende del filtro de Id Motivo de abajo.</p>
          <EmployeeBarChart items={[
            {label:"Presentes", value:cardVals.presentes, color:"#3CC84A"},
            {label:"Vacaciones", value:cardVals.vac, color:"#2FB38A"},
            {label:"Ausente Pago", value:cardVals.ap, color:"#F5A62B"},
            {label:"Ausente No Pago", value:cardVals.anp, color:"#F0605D"},
            {label:"Sanciones", value:cardVals.sanciones, color:"#E8508C"}
          ]} />
        </div>
      </div>

      {!motivosPorDefecto && <div className="no-print">
        <ToggleList title="Filtro Id Motivo (solo para el detalle de abajo)"
          items={parsed.idMotivoUniverse.map(m=>({key:m.key,label:m.label,ap:m.ap,anp:m.anp}))}
          included={idMotivoIncluded} onChange={setIdMotivoIncluded}
          defaultKeys={parsed.idMotivoUniverse.filter(m=>DETALLE_DEFAULT_MOTIVOS.has(m.key)).map(m=>m.key)} />
      </div>}

      {anioSel!=null && (
        <div className="card table-card de-print-block print-page-break">
          <style>{ANUAL_GRID_CSS}</style>
          <h3>Calendario anual de ausencias {anioSel}{ficha && (ficha.nombre||legajoSel) ? " — "+(fichaDato("nombre")||ficha.nombre||"")+" (Legajo "+legajoSel+")" : ""}</h3>
          <p className="desc">Cada casillero es un día, con el código (Id Motivo) de la ausencia. Muestra todas las ausencias AP y ANP del año elegido, sin importar el período ni el filtro de Id Motivo.</p>
          <div className="ygrid-wrap"><table className="ygrid">
            <thead><tr>
              <th className="ymes">{anioSel}</th>
              {Array.from({length:31}, (_,i)=>(<th key={i}>{i+1}</th>))}
            </tr></thead>
            <tbody>
              {MESES.map((mn,mi)=>{
                const dim = daysInMonth(mi+1, anioSel);
                return (
                  <tr key={mi}>
                    <th className="ymes">{mn.toUpperCase()}</th>
                    {Array.from({length:31}, (_,di)=>{
                      const d = di+1;
                      if(d>dim) return <td key={di} className="g-none"></td>;
                      const ab = anualMap.get(mi+1+"-"+d);
                      if(ab) return <td key={di} className={ab.cat==="AP" ? "g-ap" : "g-anp"} title={fmtDate(d,mi+1,anioSel)+": "+ab.label}>{ab.code}</td>;
                      const ts = Date.UTC(anioSel, mi, d);
                      return <td key={di} className={anualMap.get("off-"+(mi+1)+"-"+d) || isNonWorkingGapDay(ts) ? "g-off" : ""}></td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          <div className="ygrid-leg">
            <span><i className="g-anp"></i>ANP (ausente no pago)</span>
            <span><i className="g-ap"></i>AP (ausente pago)</span>
            <span><i className="g-off"></i>Sábado, domingo y feriado</span>
          </div>
        </div>
      )}

      <div className="card table-card de-print-block print-page-break">
        <h3>{ausenciaRows.length ? ("DETALLE (" + fmt(ausenciaRows.length) + " días" + (agrupar ? " en " + fmt(ausGrupos.length) + (ausGrupos.length===1 ? " período" : " períodos") : "") + ")") : "Sin días con los Id Motivo seleccionados en el período"}</h3>
        {ausenciaRows.length>0 && agrupar && (
          <div className="overflow-x">
            <table>
              <thead><tr>
                <SortTh k="desde" label="Desde" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="hasta" label="Hasta" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="dias" label="Días" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="estado" label="Estado" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="idMotivo" label="Id Motivo" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="agrup" label="Agrup. presentismo" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="presidencia" label="Agrup. presidencia" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="tipo" label="Tipo" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="motivo" label="Motivo" sort={grpSort.sort} toggle={grpSort.toggle} />
                <SortTh k="razon" label="Razón" sort={grpSort.sort} toggle={grpSort.toggle} />
              </tr></thead>
              <tbody>
                {grpSort.sorted.map((g,i)=>(
                  <tr key={i}>
                    <td>{fmtDateFromTs(g.desdeTs)}</td>
                    <td>{g.hastaTs===g.desdeTs ? "—" : fmtDateFromTs(g.hastaTs)}</td>
                    <td>{g.dias}</td>
                    <td>{g.estados.join(" / ")}</td>
                    <td>{g.row.idMotivo}</td>
                    <td>{g.row.agrup || "(vacío)"}</td>
                    <td>{g.row.presidencia || "—"}</td>
                    <td>{tipoOf(g.row)}</td>
                    <td>{g.row.motivo}</td>
                    <td>{g.razones.join(" / ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {ausenciaRows.length>0 && !agrupar && (
          <div className="overflow-x">
            <table>
              <thead><tr>
                <SortTh k="fecha" label="Fecha" sort={ausSort.sort} toggle={ausSort.toggle} />
                <SortTh k="estado" label="Estado" sort={ausSort.sort} toggle={ausSort.toggle} />
                <SortTh k="idMotivo" label="Id Motivo" sort={ausSort.sort} toggle={ausSort.toggle} />
                <SortTh k="agrup" label="Agrup. presentismo" sort={ausSort.sort} toggle={ausSort.toggle} />
                <SortTh k="presidencia" label="Agrup. presidencia" sort={ausSort.sort} toggle={ausSort.toggle} />
                <SortTh k="tipo" label="Tipo" sort={ausSort.sort} toggle={ausSort.toggle} />
                <SortTh k="motivo" label="Motivo" sort={ausSort.sort} toggle={ausSort.toggle} />
                <SortTh k="razon" label="Razón" sort={ausSort.sort} toggle={ausSort.toggle} />
              </tr></thead>
              <tbody>
                {ausSort.sorted.map((r,i)=>(
                  <tr key={i}>
                    <td>{fmtDate(r.dia,r.mes,r.anio)}</td>
                    <td>{r.estado}</td>
                    <td>{r.idMotivo}</td>
                    <td>{r.agrup || "(vacío)"}</td>
                    <td>{r.presidencia || "—"}</td>
                    <td>{tipoOf(r)}</td>
                    <td>{r.motivo}</td>
                    <td>{r.razon}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===================== barra de scroll horizontal arriba de una tabla ancha ===================== */
function TopScrollSync({targetRef}){
  const topRef = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(()=>{
    const el = targetRef.current;
    if(!el) return;
    function sync(){ setWidth(el.scrollWidth); }
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    const mo = new MutationObserver(sync);
    mo.observe(el, {childList:true, subtree:true});
    function onBottomScroll(){ if(topRef.current) topRef.current.scrollLeft = el.scrollLeft; }
    el.addEventListener("scroll", onBottomScroll);
    return ()=>{ ro.disconnect(); mo.disconnect(); el.removeEventListener("scroll", onBottomScroll); };
  }, [targetRef]);
  function onTopScroll(e){ if(targetRef.current) targetRef.current.scrollLeft = e.target.scrollLeft; }
  if(width<=0) return null;
  return (
    <div ref={topRef} onScroll={onTopScroll} className="top-scrollbar">
      <div style={{width, height:1}}></div>
    </div>
  );
}

/* ===================== encabezado fijo de una tabla ancha =====================
   Al bajar por la página, cuando los títulos de la tabla salen de la pantalla aparece una copia fija justo debajo del menú
   (y de la barra de desplazamiento horizontal), con las mismas columnas, que acompaña el desplazamiento lateral y sigue siendo
   clickeable para ordenar. Los datos son lo único que se mueve. */
function StickyTableHead({targetRef, columns, sortKey, sortDir, onSort}){
  const innerRef = useRef(null);
  const [widths, setWidths] = useState([]);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(false);
  useEffect(()=>{
    const box = targetRef.current;
    if(!box) return;
    const table = box.querySelector("table");
    if(!table || !table.tHead) return;
    function measure(){
      const cells = Array.from(table.tHead.rows[0].cells);
      setWidths(cells.map(c=>c.getBoundingClientRect().width));
      setTotal(table.getBoundingClientRect().width);
    }
    function check(){
      const tabsH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tabs-h")) || 0;
      const stick = tabsH + 16;
      const head = table.tHead.getBoundingClientRect();
      const tbl = table.getBoundingClientRect();
      setActive(head.top < stick && tbl.bottom > stick + head.height);
    }
    function syncX(){ if(innerRef.current) innerRef.current.scrollLeft = box.scrollLeft; }
    measure(); check();
    const ro = new ResizeObserver(()=>{ measure(); check(); });
    ro.observe(table);
    const mo = new MutationObserver(()=>{ measure(); check(); });
    mo.observe(table, {childList:true, subtree:true});
    window.addEventListener("scroll", check, {passive:true});
    window.addEventListener("resize", check);
    box.addEventListener("scroll", syncX);
    return ()=>{ ro.disconnect(); mo.disconnect(); window.removeEventListener("scroll", check); window.removeEventListener("resize", check); box.removeEventListener("scroll", syncX); };
  }, [targetRef]);
  useEffect(()=>{ if(active && innerRef.current && targetRef.current) innerRef.current.scrollLeft = targetRef.current.scrollLeft; }, [active, total]);
  if(!widths.length) return null;
  return (
    <div className="sticky-head-proxy no-print">
      {active && (
        <div className="shp-inner" ref={innerRef}>
          <table style={{width:total}}>
            <colgroup>{widths.map((w,i)=>(<col key={i} style={{width:w}} />))}</colgroup>
            <thead><tr>
              {columns.map(col=>(
                <th key={col.key} className={col.align==="num"?"num":undefined} style={{cursor:"pointer", userSelect:"none", whiteSpace:"nowrap"}} onClick={()=>onSort(col.key)}>
                  {col.label}{sortKey===col.key ? (sortDir==="asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr></thead>
          </table>
        </div>
      )}
    </div>
  );
}

/* ===================== crónicos (tab) ===================== */
const CRONICOS_CASOS_TABLE = "cronicos_casos";
const CRONICOS_CONFIG_TABLE = "cronicos_config";

/* ---- fechas del campo "Posible alta": siempre DD/MM/AAAA, se corrige lo que se escriba mal ---- */
const MESES_TXT = {ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,set:9,oct:10,nov:11,dic:12};
// Devuelve {ok:true, value:"DD/MM/AAAA" | ""} o {ok:false}. Acepta 15102026, 15/10/26, 15-10-2026, 15.10, 1510, 2026-10-15, "15 oct 2026", etc.
function normalizarFechaDMA(raw, hoy){
  const s = String(raw==null ? "" : raw).trim().toLowerCase();
  if(!s) return {ok:true, value:""};
  hoy = hoy || new Date();
  const yearNow = hoy.getFullYear();
  const fullYear = t => t.length===2 ? 2000 + (+t) : +t;
  let d, m, y, mt;
  if((mt = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/))){ y=+mt[1]; m=+mt[2]; d=+mt[3]; }
  else if((mt = s.match(/^(\d{1,2})\s*[\/\-.\s]\s*(\d{1,2})(?:\s*[\/\-.\s]\s*(\d{2}|\d{4}))?$/))){ d=+mt[1]; m=+mt[2]; y = mt[3] ? fullYear(mt[3]) : yearNow; }
  else if((mt = s.match(/^(\d{1,2})\s*(?:de\s+)?([a-záéíóú]{3,})\.?\s*(?:de\s+|del\s+)?(\d{2}|\d{4})?$/))){
    const key = mt[2].normalize("NFD").replace(/[̀-ͯ]/g,"").slice(0,3);
    if(!MESES_TXT[key]) return {ok:false};
    d=+mt[1]; m=MESES_TXT[key]; y = mt[3] ? fullYear(mt[3]) : yearNow;
  }
  else if(/^\d{8}$/.test(s)){ d=+s.slice(0,2); m=+s.slice(2,4); y=+s.slice(4); }
  else if(/^\d{6}$/.test(s)){ d=+s.slice(0,2); m=+s.slice(2,4); y=2000+(+s.slice(4)); }
  else if(/^\d{4}$/.test(s)){ d=+s.slice(0,2); m=+s.slice(2,4); y=yearNow; }
  else return {ok:false};
  if(!(m>=1 && m<=12) || !(y>=1900 && y<=2100) || !(d>=1 && d<=daysInMonth(m,y))) return {ok:false};
  return {ok:true, value: pad2(d)+"/"+pad2(m)+"/"+y};
}
// mientras se escribe solo con números, va poniendo las barras: 15102026 -> 15/10/2026
function formatDigitsDMA(v){
  if(!/^\d+$/.test(v) || v.length>8) return v;
  if(v.length<=2) return v;
  if(v.length<=4) return v.slice(0,2)+"/"+v.slice(2);
  return v.slice(0,2)+"/"+v.slice(2,4)+"/"+v.slice(4);
}
function dmaToTs(v){
  const mt = String(v||"").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return mt ? Date.UTC(+mt[3], +mt[2]-1, +mt[1]) : 0;
}
function newObsId(){ return "o"+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
const CRONICO_COLUMNS = [
  {key:"legajo", label:"Legajo", get:c=>c.legajo||"", sortType:"text"},
  {key:"nombre", label:"Nombre", get:c=>c.nombre||"", sortType:"text"},
  {key:"telefono", label:"Teléfono de contacto", get:c=>c.telefonoContacto||"", sortType:"text"},
  {key:"grupo", label:"Grupo", get:c=>c.grupo||"", sortType:"text"},
  {key:"sindicato", label:"Sindicato", get:c=>c.sindicato||"", sortType:"text"},
  {key:"gerencia", label:"Gerencia", get:c=>c.gerencia||"", sortType:"text"},
  {key:"codpla", label:"Codpla", get:c=>c.codpla||"", sortType:"text"},
  // Orden del Tipo: RES PTO, CRONICO, ACTUAL, PROC BAJA (y después los demás). Es también el orden inicial de la tabla,
  // con los días de mayor a menor dentro de cada tipo.
  {key:"tipo", label:"Tipo", get:c=>{ const i = CRONICO_TIPO_ORDEN.indexOf(c.tipo||""); return i===-1 ? CRONICO_TIPO_ORDEN.length : i; }, sortType:"num", firstDir:"asc"},
  {key:"inicio", label:"Inicio", get:c=>c.inicioTs||0, sortType:"num"},
  {key:"dias", label:"Días", get:c=>cronicoDias(c.inicioTs), sortType:"num", align:"num"},
  {key:"motivo", label:"Motivo - Razón", get:c=>c.motivoLabel||"", sortType:"text"},
  {key:"fechaIngreso", label:"Fecha Ingreso", get:c=>c.fechaIngresoTs==null?-1:c.fechaIngresoTs, sortType:"num"},
  {key:"notificar", label:"Notificar Res. Puesto", get:c=>c.notificar||"", sortType:"text"},
  {key:"opinionMedica", label:"Opinión médica", get:c=>c.opinionMedica||"", sortType:"text"},
  {key:"tactoEmpleado", label:"Táctico empleado", get:c=>c.tactoEmpleado||"", sortType:"text"},
  {key:"posibleAlta", label:"Posible alta", get:c=>dmaToTs(c.posibleAlta), sortType:"num"},
  {key:"acciones", label:"Acción", get:c=>c.acciones.length, sortType:"num"},
  {key:"citado", label:"Medicina Laboral", get:c=>c.cita ? (c.cita.atendido ? 2 : 1) : 0, sortType:"num"},
  {key:"observaciones", label:"Observación / Evolución", get:c=>c.observaciones.length, sortType:"num"}
];
// Códigos de ausencia por motivos de salud: su "Razón" del ausentismo se carga sola como primera información del historial del caso.
// (Se pueden agregar más códigos acá.)
const CRONICOS_CODIGOS_SALUD = new Set(["AT","ET","EN","CAE"]);
// Listas de movimientos de un caso (observaciones y acciones): las viejas no tenían id, se les da uno estable para poder editarlas o borrarlas.
function conIds(arr, pref){ return Array.isArray(arr) ? arr.map(o=> o && o.id ? o : {...o, id:pref+(o&&o.ts)}) : []; }
function casoRowToManual(row){
  let acciones = conIds(row.acciones, "a");
  // antes la acción era un único texto (columna `accion`): si todavía no se pasó a la lista, se muestra como primera acción
  if(!acciones.length && row.accion) acciones = [{id:"alegacy", ts: row.updated_at ? new Date(row.updated_at).getTime() : 0, texto: row.accion, autor:""}];
  return {
    tipo: row.tipo||"", notificar: row.notificar||"", opinionMedica: row.opinion_medica||"",
    tactoEmpleado: row.tacto_empleado||"", posibleAlta: row.posible_alta||"",
    inicioManualTs: row.inicio_manual ? isoDateToTs(row.inicio_manual) : null,
    observaciones: conIds(row.observaciones, "o"),
    acciones,
    razonSembrada: !!row.razon_sembrada,
    telefonoContacto: row.telefono_contacto||""
  };
}
// Teléfono de contacto de un caso: el que se cargó en Crónicos y, si no hay, el celular del plantel.
// Devuelve {tel, editado, plantel} (editado = hay uno cargado a mano que reemplaza al del plantel).
function telefonoContactoDe(manualCaso, celularPlantel){
  const own = String((manualCaso||{}).telefonoContacto||"").trim();
  return {tel: own || celularPlantel || "", editado: !!own, plantel: celularPlantel||""};
}
/* ---- Medicina Laboral: citaciones (tabla `medicina_laboral`, migración supabase-migracion-medicina-laboral.sql) ----
   Una citación = un empleado/caso citado para un día. La puede crear RRHH/Administrador desde Crónicos (origen "rrhh") o la Dra.
   desde Medicina Laboral (origen "medicina", p. ej. un control para otro día). Se "atiende" (visto por la Dra.) y se puede anular. */
const MEDICINA_TABLE = "medicina_laboral";
function citaRowToObj(r){
  return {id:r.id, casoId:r.caso_id, legajo:r.legajo, nombre:r.nombre||"", unidad:r.unidad||"", motivo:r.motivo||"", anio:r.anio||0,
    fecha:r.fecha, origen:r.origen||"rrhh", citadoPor:r.citado_por||"", citadoTs:Number(r.citado_ts)||0, nota:r.nota_cita||"",
    atendido:!!r.atendido, atendidoPor:r.atendido_por||"", atendidoTs:Number(r.atendido_ts)||0, anulada:!!r.anulada};
}
function citaObjToRow(o){
  return {id:o.id, caso_id:o.casoId, legajo:o.legajo, nombre:o.nombre||"", unidad:o.unidad||"", motivo:o.motivo||"", anio:o.anio||0,
    fecha:o.fecha, origen:o.origen||"rrhh", citado_por:o.citadoPor||"", citado_ts:o.citadoTs||null, nota_cita:o.nota||"",
    atendido:!!o.atendido, atendido_por:o.atendidoPor||"", atendido_ts:o.atendidoTs||null, anulada:!!o.anulada, updated_at:new Date().toISOString()};
}
async function loadCitas(){
  const {data, error} = await supabaseClient.from(MEDICINA_TABLE).select("*");
  if(error) throw error;
  return new Map((data||[]).map(r=>{ const o = citaRowToObj(r); return [o.id, o]; }));
}
async function saveCita(obj){
  const {error} = await supabaseClient.from(MEDICINA_TABLE).upsert(citaObjToRow(obj));
  if(error) throw error;
  return obj;
}
/* ---- citación de un empleado que todavía no figura en Crónicos ----
   Si todavía no se actualizó la base de ausentes, se lo cita igual (por nombre o legajo). Su "caso" provisorio es <legajo>-MANUAL-<año>:
   ahí se guardan las anotaciones de la Dra. Cuando el empleado aparece como caso de Crónicos, Medicina Laboral toma los datos médicos
   del caso real y copia a ese caso lo que escribió la Dra. (ver MedicinaLaboralTab). */
function manualCaseId(legajo, fechaISO){ return cronicoCaseId(legajo, "MANUAL", String(fechaISO||"").slice(0,4) || new Date().getFullYear()); }
function esCasoManualId(id){ return /-MANUAL-\d+$/.test(String(id||"")); }
// empleados que se pueden citar a mano: activos del plantel y, si no están en el plantel, los que figuran en las filas de ausentismo
function employeeOptionsForCita(plantel, records){
  const map = new Map(), enPlantel = new Set();
  (plantel||[]).forEach(p=>{
    const k = (p.legajo||"").toUpperCase(); if(!k) return;
    enPlantel.add(k);
    if(p.bajaTs==null) map.set(k, {legajo:p.legajo, nombre:p.nombre||"", unidad:p.unidad||""});
  });
  (records||[]).forEach(r=>{
    if(!r.legajo) return;
    const k = r.legajo.toUpperCase();
    if(enPlantel.has(k) || map.has(k)) return;
    map.set(k, {legajo:r.legajo, nombre:r.nombre||"", unidad:r.unidad||""});
  });
  return Array.from(map.values())
    .map(e=>({value:e.legajo, legajo:e.legajo, nombre:(e.nombre||"").toUpperCase(), unidad:e.unidad, label:e.legajo+" "+(e.nombre||"").toUpperCase()}))
    .sort((a,b)=> a.nombre.localeCompare(b.nombre,"es") || a.value.localeCompare(b.value,"es"));
}
function CitarEmpleadoBox({options, minFecha, defaultFecha, onCitar}){
  const [leg, setLeg] = useState("");
  const [fecha, setFecha] = useState(defaultFecha||"");
  const [nota, setNota] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(()=>{ if(!fecha && defaultFecha) setFecha(defaultFecha); }, [defaultFecha]);
  const emp = options.find(o=>o.value===leg) || null;
  async function go(){
    if(!emp || !fecha){ setMsg("Elegí el empleado y la fecha de la citación."); return; }
    if(minFecha && fecha<minFecha){ setMsg("La fecha no puede ser anterior al "+dateKeyToLabel(minFecha)+"."); return; }
    setBusy(true); setMsg("Guardando...");
    try{
      const r = await onCitar(emp, fecha, nota.trim());
      setMsg(r || "Citado.");
      if(!r || !/^Ya /.test(r)){ setLeg(""); setNota(""); }
    }catch(err){ setMsg("No se pudo citar: "+((err && err.message) ? err.message : String(err))); }
    setBusy(false);
  }
  return (
    <details className="card" style={{padding:"10px 14px"}}>
      <summary style={{cursor:"pointer", fontWeight:700}}>Citar a un empleado que todavía no figura en Crónicos</summary>
      <p className="desc" style={{margin:"8px 0"}}>Si todavía no se actualizaron los ausentes, buscalo por nombre o legajo y elegí la fecha: queda en los Citados de Medicina Laboral de ese día. Cuando se actualice la base, se toman sus datos médicos de Crónicos y lo que escriba la Dra. se suma a su caso.</p>
      <div style={{display:"flex", gap:10, flexWrap:"wrap", alignItems:"flex-end"}}>
        <div className="field"><label>Empleado</label><SearchSelect options={options} value={leg} onChange={setLeg} placeholder="Buscar legajo o nombre…" /></div>
        <div className="field"><label>Fecha de la citación</label><input type="date" value={fecha} min={minFecha||undefined} onChange={e=>setFecha(e.target.value)} /></div>
        <div className="field"><label>Motivo de la cita (opcional)</label><input type="text" value={nota} onChange={e=>setNota(e.target.value)} placeholder="Ej.: control, certificado…" style={{minWidth:220}} /></div>
        <button type="button" className="btn" onClick={go} disabled={busy || !emp || !fecha}>Citar</button>
        {msg && <span className="hint">{msg}</span>}
      </div>
    </details>
  );
}
// Guarda un cambio en un caso de Crónicos leyendo ANTES el caso tal como está en el servidor y aplicando solo ese cambio
// (así nunca se pisa lo que guardó otro usuario). `patch` es un objeto, o una función (estadoActual) => objeto | null.
// Devuelve el estado final guardado, o null si no había nada que cambiar. Lo usan Crónicos y Medicina Laboral.
async function persistCronicoCase(caseObj, patch, localFallback){
  const {data:row, error:selErr} = await supabaseClient.from(CRONICOS_CASOS_TABLE).select("*").eq("id", caseObj.id).maybeSingle();
  if(selErr) throw selErr;
  const prev = row ? casoRowToManual(row) : (localFallback || {});
  const base = {
    notificar: caseObj.notificar||"", opinionMedica: caseObj.opinionMedica||"", tactoEmpleado: caseObj.tactoEmpleado||"",
    posibleAlta: caseObj.posibleAlta||"",
    inicioManualTs: caseObj.inicioManualTs!=null ? caseObj.inicioManualTs : null,
    observaciones: [], acciones: [], razonSembrada: false, telefonoContacto: "",
    ...prev
  };
  const p = typeof patch==="function" ? patch(base) : patch;
  if(p===null) return null;
  const m = {...base, ...p, tipo: caseObj.tipo || prev.tipo || ""};
  const {error} = await supabaseClient.from(CRONICOS_CASOS_TABLE).upsert({
    id: caseObj.id, legajo: caseObj.legajo, anio: caseObj.anio,
    tipo: m.tipo, notificar: m.notificar||"", opinion_medica: m.opinionMedica||"",
    tacto_empleado: m.tactoEmpleado||"", posible_alta: m.posibleAlta||"",
    // `accion` (texto único, versión anterior) se mantiene con la última acción para no romper pantallas que no se recargaron
    accion: (m.acciones||[]).length ? m.acciones.slice().sort((a,b)=>a.ts-b.ts)[m.acciones.length-1].texto : "",
    acciones: m.acciones||[], razon_sembrada: !!m.razonSembrada, telefono_contacto: m.telefonoContacto||"",
    inicio_manual: m.inicioManualTs!=null ? tsToISODate(m.inicioManualTs) : null,
    observaciones: m.observaciones||[], updated_at: new Date().toISOString()
  });
  if(error) throw error;
  return m;
}
// Historial de movimientos de un caso (observaciones o acciones, según `field`): ordenable, y cada uno se puede editar o eliminar
// (se ve igual para todos los usuarios).
function ObservacionesHistory({c, field, labelCol, editingObs, setEditingObs, onStartEdit, onSaveEdit, onDelete, disabled, readOnly}){
  const {sorted, sort, toggle} = useTableSort(c[field], {
    fecha:{get:o=>o.ts, type:"num"}, texto:{get:o=>o.texto, type:"text"}, autor:{get:o=>o.autor||"", type:"text"}
  }, {key:"fecha", dir:"desc"});
  return (
    <table style={{width:"100%"}}>
      <thead><tr>
        <SortTh k="fecha" label="Fecha" sort={sort} toggle={toggle} />
        <SortTh k="texto" label={labelCol||"Movimiento"} sort={sort} toggle={toggle} />
        <SortTh k="autor" label="Registró" sort={sort} toggle={toggle} />
        <th></th>
      </tr></thead>
      <tbody>
        {sorted.map(o=>{
          const editing = editingObs && editingObs.caseId===c.id && editingObs.field===field && editingObs.obsId===o.id;
          return (
            <tr key={o.id}>
              <td style={{whiteSpace:"nowrap", verticalAlign:"top"}}>{new Date(o.ts).toLocaleString("es-AR")}</td>
              <td style={{whiteSpace:"pre-wrap"}}>
                {editing ? (
                  <textarea value={editingObs.texto} autoFocus rows={2} style={{width:"100%"}}
                    onChange={e=>setEditingObs({...editingObs, texto:e.target.value})}
                    onKeyDown={e=>{ if(e.key==="Escape") setEditingObs(null); }} />
                ) : o.texto}
                {!editing && o.editadoTs && <div className="hint">editado {new Date(o.editadoTs).toLocaleString("es-AR")}{o.editadoPor ? " por "+o.editadoPor : ""}</div>}
              </td>
              <td style={{verticalAlign:"top"}}>{o.autor || "—"}{o.origen==="medicina" && <div className="hint" style={{color:"var(--accent)", fontWeight:700}}>Medicina Laboral{o.fechaVisita ? " · "+dateKeyToLabel(o.fechaVisita) : ""}</div>}</td>
              <td style={{whiteSpace:"nowrap", verticalAlign:"top"}}>
                {readOnly ? null : editing ? (
                  <React.Fragment>
                    <button type="button" className="btn small" onClick={()=>onSaveEdit(c)} disabled={disabled}>Guardar</button>{" "}
                    <button type="button" className="btn secondary small" onClick={()=>setEditingObs(null)}>Cancelar</button>
                  </React.Fragment>
                ) : (
                  <React.Fragment>
                    <button type="button" className="btn secondary small" onClick={()=>onStartEdit(c,field,o)} disabled={disabled}>Editar</button>{" "}
                    <button type="button" className="btn secondary small" onClick={()=>onDelete(c,field,o)} disabled={disabled}>Eliminar</button>
                  </React.Fragment>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
function CronicosTab({parsed, plantel, idMotivoUniverse, puedeEditar, motivosFijos, puedeCitar}){
  const [dbReady, setDbReady] = useState(false);
  // Filtro de motivos: cada vez que se abre la app arranca en "Por defecto". Los cambios (ej. sumar VAC) son de esta pantalla:
  // se conservan mientras se navega entre menús, pero no se guardan en el servidor ni cambian lo que ven los demás.
  const [motivoIncluded, setMotivoIncluded] = useKeptState("cron.motivos", () => new Set(idMotivoUniverse.filter(m=>CRONICOS_DEFAULT_MOTIVOS.has(m.key)).map(m=>m.key)));
  const [casesManual, setCasesManual] = useState(new Map());
  const manualRef = useRef(new Map());
  const [expandedId, setExpandedId] = useState(null);       // caso con el historial de observaciones abierto
  const [expandedAccId, setExpandedAccId] = useState(null);  // caso con el historial de acciones abierto
  const [obsDrafts, setObsDrafts] = useState({});            // texto a medio escribir: clave "observaciones:<caso>" / "acciones:<caso>"
  const seedingRef = useRef(new Set());                      // casos cuya "Razón" ya se intentó cargar en esta sesión
  const [search, setSearch] = useKeptState("cron.search", "");
  const [tipoFilter, setTipoFilter] = useKeptState("cron.tipo", "__all");
  const [saludFilter, setSaludFilter] = useKeptState("cron.salud", "__all"); // "__all" | "__salud" (AT/ET/EN/CAE) | un código
  const [unidadSel, setUnidadSel] = useKeptState("cron.unidad", null);       // null = todas las unidades; si no, Set con las elegidas
  const [saveStatus, setSaveStatus] = useState("");
  const [sortKey, setSortKey] = useKeptState("cron.sortKey", "tipo");
  const [sortDir, setSortDir] = useKeptState("cron.sortDir", "asc");
  const scrollRef = useRef(null);
  const locked = !dbReady || !puedeEditar; // sin permiso de edición todo se ve, pero no se puede modificar
  const aliveRef = useRef(true);
  const saveQueueRef = useRef(new Map()); // id del caso -> cola de guardados (uno por vez, en orden)
  const userRef = useRef("");              // email del usuario, para firmar los movimientos
  const [editingObs, setEditingObs] = useState(null); // {caseId, field, obsId, texto}
  const [citas, setCitas] = useState(new Map());       // citaciones a Medicina Laboral (id -> cita)
  const [citaBusy, setCitaBusy] = useState(null);      // caso cuya citación se está guardando
  // Día que se cita desde esta pantalla. Por defecto el último día cargado (el "hoy" de la información), pero se puede elegir una fecha
  // posterior (la Dra. no viene todos los días): `fechaCita`. La columna "Medicina Laboral" muestra la citación de ESE día.
  const citaFecha = parsed.maxTs!=null ? tsToISODate(parsed.maxTs) : "";
  const [citaFechaSel, setCitaFechaSel] = useKeptState("cron.citaFecha", null);
  const fechaCita = citaFechaSel && citaFechaSel>=citaFecha ? citaFechaSel : citaFecha;
  const empOptions = useMemo(()=> employeeOptionsForCita(plantel, parsed.records), [plantel, parsed]);

  // Lee de Supabase todos los casos (lo guardado por cualquier usuario) y las citaciones a Medicina Laboral.
  async function loadFromServer(){
    const {data:casos, error:casosErr} = await supabaseClient.from(CRONICOS_CASOS_TABLE).select("*");
    if(!aliveRef.current) return;
    if(casosErr){ setSaveStatus("Error al leer Supabase: "+casosErr.message); return false; }
    if(casos){
      const m = new Map();
      casos.forEach(row=> m.set(row.id, casoRowToManual(row)));
      manualRef.current = m;
      setCasesManual(m);
    }
    try{ const cm = await loadCitas(); if(aliveRef.current) setCitas(cm); }
    catch(err){ /* si todavía no se creó la tabla de Medicina Laboral, Crónicos sigue funcionando sin la columna de citación */ }
    return true;
  }
  useEffect(()=>{
    aliveRef.current = true;
    (async ()=>{
      try{
        const {data} = await supabaseClient.auth.getSession();
        userRef.current = (data && data.session && data.session.user && data.session.user.email) || "";
      }catch(e){}
      await loadFromServer();
      if(aliveRef.current) setDbReady(true);
    })();
    return ()=>{ aliveRef.current = false; };
  }, []);
  async function refreshFromServer(){
    setSaveStatus("Actualizando...");
    const ok = await loadFromServer();
    if(ok) setSaveStatus("Datos actualizados");
  }

  // motivosFijos (Servicio médico): se usan siempre los motivos "Por defecto", sin mostrar ni guardar el filtro
  const motivoEfectivo = motivosFijos || motivoIncluded;
  const cases = useMemo(()=> buildCronicoCases(parsed.records, plantel, motivoEfectivo), [parsed, plantel, motivoEfectivo]);

  const plantelCelulares = useMemo(()=> new Map((plantel||[]).map(p=>[String(p.legajo||"").toUpperCase(), p.celular||""])), [plantel]);
  const celularPlantelDe = legajo => plantelCelulares.get(String(legajo||"").toUpperCase()) || "";
  // citaciones pendientes (no anuladas ni atendidas, de hoy en adelante) por legajo: para avisar si ya está citado para otro día
  const pendientesPorLegajo = useMemo(()=>{
    const m = new Map();
    citas.forEach(ct=>{
      if(ct.anulada || ct.atendido || !citaFecha || ct.fecha<citaFecha) return;
      const k = String(ct.legajo).toUpperCase();
      if(!m.has(k)) m.set(k, []);
      m.get(k).push(ct);
    });
    m.forEach(arr=>arr.sort((a,b)=>a.fecha<b.fecha?-1:1));
    return m;
  }, [citas, citaFecha]);
  const casesFull = useMemo(()=> cases.map(c=>{
    const manual = casesManual.get(c.id) || {};
    const inicioManualTs = manual.inicioManualTs!=null ? manual.inicioManualTs : null;
    const withInicio = {...c, inicioAutoTs: c.inicioTs, inicioManualTs, inicioTs: inicioManualTs!=null ? inicioManualTs : c.inicioTs};
    return {...withInicio,
      tipo: cronicoTipoAuto(withInicio),
      notificar: manual.notificar || "",
      opinionMedica: manual.opinionMedica || "",
      tactoEmpleado: manual.tactoEmpleado || "",
      posibleAlta: manual.posibleAlta || "",
      acciones: Array.isArray(manual.acciones) ? manual.acciones : [],
      // texto de la última acción: para el listado impreso
      accion: (Array.isArray(manual.acciones) && manual.acciones.length) ? manual.acciones.slice().sort((a,b)=>a.ts-b.ts)[manual.acciones.length-1].texto : "",
      observaciones: Array.isArray(manual.observaciones) ? manual.observaciones : [],
      razonSembrada: !!manual.razonSembrada,
      // teléfono de contacto: el cargado acá o, si no hay, el celular del plantel
      telefonoContacto: telefonoContactoDe(manual, celularPlantelDe(c.legajo)).tel,
      telefonoEditado: telefonoContactoDe(manual, celularPlantelDe(c.legajo)).editado,
      telefonoPlantel: celularPlantelDe(c.legajo),
      // citación vigente de este caso para el día elegido (también si se cargó a mano antes de que el empleado figurara en Crónicos)
      cita: (()=>{
        let ct = citas.get(c.id+"|"+fechaCita);
        if(!ct || ct.anulada) ct = citas.get(manualCaseId(c.legajo, fechaCita)+"|"+fechaCita);
        return ct && !ct.anulada ? ct : null;
      })(),
      // otra citación pendiente de este empleado para un día distinto del elegido (solo para avisarlo)
      otraCita: (pendientesPorLegajo.get(String(c.legajo).toUpperCase())||[]).find(ct=>ct.fecha!==fechaCita) || null
    };
  }), [cases, casesManual, citas, fechaCita, pendientesPorLegajo, plantelCelulares]);

  // Citar un empleado que todavía no figura en Crónicos (se carga a mano por nombre o legajo)
  async function citarManual(emp, fecha, nota){
    if(!puedeCitar) return "No tenés permiso para citar.";
    const real = cases.find(c=>String(c.legajo).toUpperCase()===String(emp.legajo).toUpperCase()) || null;
    const casoId = real ? real.id : manualCaseId(emp.legajo, fecha);
    const id = casoId+"|"+fecha;
    const ex = citas.get(id);
    if(ex && !ex.anulada) return "Ya está citado para el "+dateKeyToLabel(fecha)+".";
    const obj = await saveCita({id, casoId, legajo:emp.legajo, nombre:emp.nombre||"", unidad:(real && real.unidad) || emp.unidad || "",
      motivo: real ? real.motivoLabel : "Citación manual (todavía no figura en Crónicos)", anio: real ? real.anio : (Number(String(fecha).slice(0,4))||0),
      fecha, origen:"rrhh", citadoPor:userRef.current, citadoTs:Date.now(), nota:nota||"", atendido:false, atendidoPor:"", atendidoTs:0, anulada:false});
    setCitas(prev=>{ const n = new Map(prev); n.set(obj.id, obj); return n; });
    return "Citado para el "+dateKeyToLabel(fecha)+(real ? " (ya figura en Crónicos)." : ". Queda en Medicina Laboral.");
  }

  // Citar / anular la citación a Medicina Laboral desde la lista de Crónicos
  async function citar(c){
    if(!puedeCitar || !fechaCita) return;
    setCitaBusy(c.id); setSaveStatus("Guardando...");
    try{
      const obj = await saveCita({id:c.id+"|"+fechaCita, casoId:c.id, legajo:c.legajo, nombre:c.nombre||"", unidad:c.unidad||"", motivo:c.motivoLabel||"", anio:c.anio,
        fecha:fechaCita, origen:"rrhh", citadoPor:userRef.current, citadoTs:Date.now(), nota:"", atendido:false, atendidoPor:"", atendidoTs:0, anulada:false});
      setCitas(prev=>{ const n = new Map(prev); n.set(obj.id, obj); return n; });
      setSaveStatus("Citado a Medicina Laboral");
    }catch(err){ setSaveStatus("No se pudo citar: "+(err && err.message ? err.message : String(err))); }
    setCitaBusy(null);
  }
  async function anularCita(c){
    if(!puedeCitar || !c.cita || c.cita.atendido) return;
    setCitaBusy(c.id); setSaveStatus("Guardando...");
    try{
      const obj = await saveCita({...c.cita, anulada:true});
      setCitas(prev=>{ const n = new Map(prev); n.set(obj.id, obj); return n; });
      setSaveStatus("Citación anulada");
    }catch(err){ setSaveStatus("No se pudo anular: "+(err && err.message ? err.message : String(err))); }
    setCitaBusy(null);
  }

  const SIN_UNIDAD = "(Sin unidad)";
  // opciones del filtro de Unidad de Negocio (con la cantidad de casos de cada una)
  const unidadOptions = useMemo(()=>{
    const counts = new Map();
    casesFull.forEach(c=>{ const u = c.unidad || SIN_UNIDAD; counts.set(u, (counts.get(u)||0)+1); });
    return Array.from(counts.keys()).sort((a,b)=> unitOrderIndex(a)-unitOrderIndex(b) || a.localeCompare(b, "es"))
      .map(u=>({value:u, label:u+" ("+counts.get(u)+")"}));
  }, [casesFull]);
  const saludCount = useMemo(()=>{
    const o = {}; casesFull.forEach(c=>{ o[c.codpla] = (o[c.codpla]||0)+1; });
    return o;
  }, [casesFull]);
  const filtered = useMemo(()=>{
    const q = normTxt(search);
    return casesFull.filter(c=>{
      if(tipoFilter!=="__all" && c.tipo!==tipoFilter) return false;
      if(saludFilter==="__salud" && !CRONICOS_CODIGOS_SALUD.has(c.codpla)) return false;
      if(saludFilter!=="__all" && saludFilter!=="__salud" && c.codpla!==saludFilter) return false;
      if(unidadSel && !unidadSel.has(c.unidad || SIN_UNIDAD)) return false;
      if(q && !(normTxt(c.legajo).includes(q) || normTxt(c.nombre).includes(q))) return false;
      return true;
    });
  }, [casesFull, search, tipoFilter, saludFilter, unidadSel]);

  const sorted = useMemo(()=>{
    const col = CRONICO_COLUMNS.find(c=>c.key===sortKey) || CRONICO_COLUMNS.find(c=>c.key==="tipo");
    const dir = sortDir==="asc" ? 1 : -1;
    return filtered.slice().sort((a,b)=>{
      const va = col.get(a), vb = col.get(b);
      const r = col.sortType==="num" ? ((va||0)-(vb||0))*dir : String(va).localeCompare(String(vb), "es", {sensitivity:"base"}) * dir;
      // a igualdad, siempre los días de mayor a menor
      return r || (cronicoDias(b.inicioTs) - cronicoDias(a.inicioTs));
    });
  }, [filtered, sortKey, sortDir]);

  function handleSort(key){
    if(sortKey===key){ setSortDir(d=> d==="asc"?"desc":"asc"); return; }
    const col = CRONICO_COLUMNS.find(c=>c.key===key);
    setSortKey(key);
    setSortDir(col && col.firstDir ? col.firstDir : (col && col.sortType==="num" ? "desc" : "asc"));
  }

  // Cada guardado primero lee el caso tal como está AHORA en el servidor y le aplica solo este cambio.
  // Así lo que otro usuario guardó (otro campo u otra observación) nunca se pisa ni se pierde, y dos guardados
  // seguidos del mismo caso se hacen uno después del otro. `patch` es un objeto, o una función
  // (estadoActual) => objeto cuando el cambio depende de lo que ya hay (agregar/editar/borrar observaciones).
  function saveCase(caseObj, patch){
    if(!puedeEditar) return;
    const run = async ()=>{
      setSaveStatus("Guardando...");
      let m;
      try{ m = await persistCronicoCase(caseObj, patch, manualRef.current.get(caseObj.id)); }
      catch(err){ setSaveStatus("Error al guardar: "+(err && err.message ? err.message : String(err))); return; }
      if(m===null){ setSaveStatus(""); return; } // nada que cambiar (ej. la observación ya no existe)
      if(!aliveRef.current) return;
      const nextMap = new Map(manualRef.current);
      nextMap.set(caseObj.id, m);
      manualRef.current = nextMap;
      setCasesManual(nextMap);
      setSaveStatus("Guardado");
    };
    const queue = saveQueueRef.current;
    const prevJob = queue.get(caseObj.id) || Promise.resolve();
    const job = prevJob.then(run, run).catch(err=>{ setSaveStatus("Error al guardar: "+(err && err.message ? err.message : String(err))); });
    queue.set(caseObj.id, job);
  }

  function commitField(caseObj, field, value){
    saveCase(caseObj, {[field]: value});
  }

  // Posible alta: siempre una fecha DD/MM/AAAA. Lo que se escribe mal se corrige solo; si no se entiende, vuelve al valor anterior.
  function commitPosibleAlta(caseObj, el){
    const raw = el.value;
    const anterior = caseObj.posibleAlta || "";
    if(raw.trim()===anterior) return;
    const r = normalizarFechaDMA(raw);
    if(!r.ok){
      el.value = anterior;
      setSaveStatus("Posible alta: «"+raw.trim()+"» no es una fecha válida. Escribila como DD/MM/AAAA (se restauró el valor anterior).");
      return;
    }
    el.value = r.value;
    if(r.value!==anterior) commitField(caseObj, "posibleAlta", r.value);
  }

  // Observaciones ("observaciones") y acciones ("acciones") funcionan igual: lista de movimientos con fecha, autor, edición y borrado.
  const NOMBRE_ENTRADA = {observaciones:"observación", acciones:"acción"};
  function addEntry(caseObj, field){
    const key = field+":"+caseObj.id;
    const texto = (obsDrafts[key]||"").trim();
    if(!texto) return;
    const entry = {id:newObsId(), ts:Date.now(), texto, autor:userRef.current};
    saveCase(caseObj, base=>({[field]:[...(base[field]||[]), entry]}));
    setObsDrafts(prev=>({...prev, [key]:""}));
  }
  function startEditEntry(caseObj, field, o){ setEditingObs({caseId:caseObj.id, field, obsId:o.id, texto:o.texto}); }
  function saveEditEntry(caseObj){
    if(!editingObs) return;
    const {obsId, field} = editingObs;
    const texto = (editingObs.texto||"").trim();
    if(!texto){ window.alert("La "+NOMBRE_ENTRADA[field]+" no puede quedar vacía. Si querés quitarla, usá Eliminar."); return; }
    const editor = userRef.current, ahora = Date.now();
    saveCase(caseObj, base=>{
      const lista = base[field]||[];
      if(!lista.some(o=>o.id===obsId)) return null;
      return {[field]: lista.map(o=> o.id===obsId ? {...o, texto, editadoTs:ahora, editadoPor:editor} : o)};
    });
    setEditingObs(null);
  }
  function deleteEntry(caseObj, field, o){
    if(!window.confirm("¿Eliminar esta "+NOMBRE_ENTRADA[field]+"?\n\n«"+o.texto+"»\n\nSe borra para todos los usuarios.")) return;
    saveCase(caseObj, base=>{
      const lista = base[field]||[];
      if(!lista.some(x=>x.id===o.id)) return null;
      return {[field]: lista.filter(x=>x.id!==o.id)};
    });
    if(editingObs && editingObs.obsId===o.id && editingObs.field===field) setEditingObs(null);
  }

  // Ausencias por motivos de salud (AT, ET, EN, CAE...): la "Razón" que viene en el ausentismo se carga sola, una única vez,
  // como primera información del historial del caso (Observación / Evolución). Solo la hace quien puede editar.
  useEffect(()=>{
    if(!puedeEditar || !dbReady) return;
    casesFull.forEach(c=>{
      if(!c.razon || !CRONICOS_CODIGOS_SALUD.has(c.codpla)) return;
      if(c.razonSembrada || c.observaciones.length) return;
      if(seedingRef.current.has(c.id)) return;
      seedingRef.current.add(c.id);
      saveCase(c, base=>{
        if(base.razonSembrada || (base.observaciones||[]).length) return null; // otro usuario ya la cargó o ya hay información
        return {
          observaciones:[{id:"orazon", ts:c.inicioAutoTs + 12*3600*1000, texto:c.razon, autor:"Razón registrada en el ausentismo", origen:"razon"}],
          razonSembrada:true
        };
      });
    });
  }, [casesFull, dbReady, puedeEditar]);

  function handlePrint(){
    // Hoja horizontal. La Acción y la Última observación van en una línea propia debajo de cada caso, usando TODO el ancho de la hoja
    // (antes quedaban en columnas angostas: el texto se partía en muchas líneas cortas y se gastaban más hojas).
    const printCss = `
      @page{size:A4 landscape;margin:10mm;}
      *{box-sizing:border-box;}
      body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#000;margin:0;}
      h2{margin:0 0 4px;font-size:19px;}
      p{margin:0 0 8px;font-size:12px;}
      table{width:100%;border-collapse:collapse;font-size:10.5px;}
      thead{display:table-header-group;}
      thead th{text-align:left;font-size:9.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#666;padding:0 4px 5px;border-bottom:1px solid #999;}
      /* cada caso es un recuadro completo (marco grueso azul) con sus datos en cuadrícula, y una separación entre un caso y el siguiente */
      tbody.caso{break-inside:avoid;page-break-inside:avoid;}
      tbody.caso td{padding:4px 5px;vertical-align:top;border:1px solid #9aa4b5;}
      tbody.caso tr.dato td{background:#eef3fb;border-top:2.5px solid #0c2e80;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      tbody.caso td:first-child{border-left:2.5px solid #0c2e80;}
      tbody.caso td:last-child{border-right:2.5px solid #0c2e80;}
      tbody.caso tr:last-child td{border-bottom:2.5px solid #0c2e80;}
      tbody.caso tr.dato td.id{font-weight:700;font-size:12.5px;color:#000;}
      tbody.caso tr.nota td{padding:3px 5px 6px 5px;font-size:10.5px;line-height:1.4;}
      tbody.sep td{height:10px;padding:0;border:0;}
      .nota .linea{white-space:pre-wrap;margin:0 0 2px;}
      .nota b{color:#0c2e80;}
    `;
    const e = escHtml;
    const NCOLS = 15;
    const rows = sorted.map(c=>{
      const ultima = c.observaciones.length ? c.observaciones.slice().sort((a,b)=>a.ts-b.ts)[c.observaciones.length-1] : null;
      const notas = (c.accion ? "<p class='linea'><b>Acción:</b> "+e(c.accion)+"</p>" : "")
        + (ultima ? "<p class='linea'><b>Última observación ("+e(new Date(ultima.ts).toLocaleDateString("es-AR"))+"):</b> "+e(ultima.texto)+"</p>" : "");
      return "<tbody class='caso'><tr class='dato'><td class='id'>"+e(c.legajo)+"</td><td class='id'>"+e(c.nombre||"—")+"</td><td class='id'>"+e(c.grupo||"—")+"</td><td>"+e(c.sindicato||"—")+"</td><td>"+e(c.gerencia||"—")+"</td><td>"+e(c.codpla||"—")+"</td><td>"+e(c.tipo||"—")+"</td><td>"+fmtDateFromTs(c.inicioTs)+"</td><td>"+cronicoDias(c.inicioTs)+"</td><td>"+e(c.motivoLabel||"—")+"</td><td>"+(c.fechaIngresoTs!=null?fmtDateFromTs(c.fechaIngresoTs):"—")+"</td><td>"+e(c.notificar||"—")+"</td><td>"+e(c.opinionMedica||"—")+"</td><td>"+e(c.tactoEmpleado||"—")+"</td><td>"+e(c.posibleAlta||"—")+"</td></tr>"
        + (notas ? "<tr class='nota'><td colspan='"+NCOLS+"'>"+notas+"</td></tr>" : "")
        + "</tbody><tbody class='sep'><tr><td colspan='"+NCOLS+"'></td></tr></tbody>";
    }).join("");
    const html = "<h2>Crónicos</h2><p>"+sorted.length+" casos activos — "+new Date().toLocaleDateString("es-AR")+"</p>"+
      "<table><thead><tr><th>Legajo</th><th>Nombre</th><th>Grupo</th><th>Sindicato</th><th>Gerencia</th><th>Codpla</th><th>Tipo</th><th>Inicio</th><th>Días</th><th>Motivo - Razón</th><th>Fecha Ingreso</th><th>Notificar Res. Puesto</th><th>Opinión médica</th><th>Táctico empleado</th><th>Posible alta</th></tr></thead>"+rows+"</table>";
    const win = window.open("", "_blank");
    if(!win){ alert("El navegador bloqueó la ventana de impresión. Habilitá las ventanas emergentes para este sitio e intentá de nuevo."); return; }
    win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Crónicos</title><style>'+printCss+'</style></head><body>'+html+'</body></html>');
    win.document.close();
    win.focus();
    setTimeout(()=>{ win.print(); }, 300);
  }

  // lo que está escrito ahora en la fila (aunque todavía no haya terminado de guardarse en el servidor)
  function liveValue(c, field){
    const el = Array.from(document.querySelectorAll("input[data-case]")).find(x=>x.getAttribute("data-case")===c.id && x.getAttribute("data-field")===field);
    return el ? el.value : null;
  }

  function printHistoria(list){
    if(!list.length) return;
    if(list.length>5 && !window.confirm("Se van a imprimir "+list.length+" historias clínicas (una por hoja). ¿Continuar?")) return;
    const e = escHtml;
    const logoUrl = new URL("icon-192.png", location.href).href;
    const emitido = new Date().toLocaleString("es-AR");
    const css = `
      @page{size:A4;margin:14mm;}
      *{box-sizing:border-box;}
      body{font-family:Arial,"Segoe UI",sans-serif;color:#111;font-size:12px;margin:0;}
      .hc{page-break-after:always;}
      .hc:last-child{page-break-after:auto;}
      .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0c2e80;padding-bottom:10px;margin-bottom:12px;}
      .kicker{font-size:10px;letter-spacing:.14em;font-weight:700;color:#2a78d6;}
      h1{margin:2px 0 2px;font-size:22px;color:#0c2e80;}
      .sub{color:#555;font-size:11.5px;}
      .head img{width:64px;height:64px;}
      h2{font-size:12.5px;color:#0c2e80;margin:14px 0 6px;padding-bottom:3px;border-bottom:1px solid #bfd3f2;text-transform:uppercase;letter-spacing:.04em;}
      table{width:100%;border-collapse:collapse;}
      tr{break-inside:avoid;}
      .kv td{padding:4px 6px;border-bottom:1px solid #eee;vertical-align:top;}
      .kv td.k{width:20%;color:#555;font-weight:700;font-size:11px;}
      .kv td.v{width:30%;}
      .grid th{text-align:left;font-size:10.5px;color:#555;text-transform:uppercase;padding:4px 6px;border-bottom:1px solid #999;}
      .grid td{padding:4px 6px;border-bottom:1px solid #e5e5e5;vertical-align:top;}
      .box{border:1px solid #cfd8e8;border-radius:6px;padding:8px 10px;min-height:34px;white-space:pre-wrap;margin:0;}
      .mov{padding:6px 0 7px;border-bottom:1px solid #e5e5e5;}
      .mfecha{font-size:10.5px;font-weight:700;color:#0c2e80;}
      .mmeta{font-weight:400;color:#777;}
      .mtexto{margin-top:3px;white-space:pre-wrap;line-height:1.45;font-size:12px;}
      .none{color:#777;font-style:italic;}
      .foot{margin-top:18px;font-size:10px;color:#777;border-top:1px solid #ddd;padding-top:6px;}
      .firmas{display:flex;gap:40px;margin-top:40px;}
      .firmas div{flex:1;border-top:1px solid #333;padding-top:4px;text-align:center;font-size:10.5px;color:#444;}
    `;
    const kv = (a,b) =>"<tr><td class='k'>"+a[0]+"</td><td class='v'>"+a[1]+"</td><td class='k'>"+(b?b[0]:"")+"</td><td class='v'>"+(b?b[1]:"")+"</td></tr>";
    const pages = list.map(c0=>{
      const pick = f => { const v = liveValue(c0, f); return v!=null ? v : (c0[f]||""); };
      const inicioLive = liveValue(c0, "inicio");
      const inicioTs = inicioLive ? isoDateToTs(inicioLive) : c0.inicioTs;
      const notif = pick("notificar");
      const notifTxt = notif ? (isoDateToTs(notif)!=null ? fmtDateFromTs(isoDateToTs(notif)) : notif) : "—";
      const altaRaw = pick("posibleAlta"), altaN = normalizarFechaDMA(altaRaw);
      // La historia clínica NO imprime las "Acciones": la firma el empleado y esa información es interna.
      const opinion = pick("opinionMedica"), tacto = pick("tactoEmpleado"), alta = altaN.ok ? altaN.value : altaRaw;
      const box = t => t ? "<p class='box'>"+e(t)+"</p>" : "<p class='box none'>Sin datos cargados.</p>";
      const tramos = (c0.tramos||[]).map(t=>"<tr><td>"+fmtDateFromTs(t.desdeTs)+"</td><td>"+fmtDateFromTs(t.hastaTs)+"</td><td>"+t.dias+"</td><td>"+e(CAT_LABEL[t.cat]||t.cat)+"</td><td>"+e(t.label)+"</td></tr>").join("");
      // cada movimiento ocupa todo el ancho de la hoja: fecha arriba y el texto completo debajo (antes quedaba una columna casi vacía)
      const obs = (c0.observaciones||[]).slice().sort((a,b)=>a.ts-b.ts).map(o=>"<div class='mov'><div class='mfecha'>"+e(new Date(o.ts).toLocaleString("es-AR"))+(o.autor||o.editadoTs ? " <span class='mmeta'>"+e((o.origen==="medicina" ? " · Medicina Laboral" : "")+(o.autor ? " · Registró: "+o.autor : "")+(o.editadoTs ? " · editado "+new Date(o.editadoTs).toLocaleString("es-AR")+(o.editadoPor?" por "+o.editadoPor:"") : ""))+"</span>" : "")+"</div><div class='mtexto'>"+e(o.texto)+"</div></div>").join("");
      return "<section class='hc'>"+
        "<div class='head'><div><div class='kicker'>HISTORIA CLÍNICA LABORAL</div><h1>"+e(c0.nombre||"Sin nombre")+"</h1><div class='sub'>Legajo "+e(c0.legajo)+" · Seguimiento de ausentismo</div></div><img src='"+e(logoUrl)+"' alt=''></div>"+
        "<h2>Datos del empleado</h2><table class='kv'>"+
          kv(["Legajo",e(c0.legajo)],["Nombre",e(c0.nombre||"—")])+
          kv(["Gerencia",e(c0.gerencia||"—")],["Grupo",e(c0.grupo||"—")])+
          kv(["Sindicato",e(c0.sindicato||"—")],["Fecha de ingreso",c0.fechaIngresoTs!=null?fmtDateFromTs(c0.fechaIngresoTs):"—"])+
        "</table>"+
        "<h2>Caso</h2><table class='kv'>"+
          kv(["Tipo",e(c0.tipo||"—")],["Motivo / diagnóstico",e(c0.motivoLabel||"—")])+
          kv(["Inicio de la ausencia",fmtDateFromTs(inicioTs)],["Días de ausencia",String(cronicoDias(inicioTs))])+
          kv(["Notificar res. de puesto",e(notifTxt)],["Posible alta",e(alta||"—")])+
        "</table>"+
        "<h2>Opinión médica</h2>"+box(opinion)+
        "<h2>Táctico empleado</h2>"+box(tacto)+
        "<h2>Tramos de ausencia</h2>"+(tramos ? "<table class='grid'><thead><tr><th>Desde</th><th>Hasta</th><th>Días</th><th>Categoría</th><th>Motivo</th></tr></thead><tbody>"+tramos+"</tbody></table>" : "<p class='box none'>Sin datos.</p>")+
        "<h2>Evolución / Observaciones</h2>"+(obs ? "<div class='movs'>"+obs+"</div>" : "<p class='box none'>Sin movimientos registrados.</p>")+
        "<div class='firmas'><div>Firma del profesional</div><div>Firma del empleado</div></div>"+
        "<div class='foot'>Documento confidencial: contiene información de salud del empleado. Emitido el "+e(emitido)+".</div>"+
      "</section>";
    }).join("");
    const win = window.open("", "_blank");
    if(!win){ alert("El navegador bloqueó la ventana de impresión. Habilitá las ventanas emergentes para este sitio e intentá de nuevo."); return; }
    win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Historia clínica</title><style>'+css+'</style></head><body>'+pages+'</body></html>');
    win.document.close();
    win.focus();
    setTimeout(()=>{ win.print(); }, 700);
  }

  return (
    <div className="tabpanel cronicos-tab">
      {!dbReady && (
        <div className="card"><p className="desc" style={{margin:0}}>Cargando datos guardados de Cronicos...</p></div>
      )}
      {!motivosFijos && <ToggleList title="Motivos que generan un caso crónico" items={idMotivoUniverse.map(m=>({key:m.key,label:m.label,ap:m.ap,anp:m.anp}))} included={motivoIncluded} onChange={setMotivoIncluded}
        defaultKeys={idMotivoUniverse.filter(m=>CRONICOS_DEFAULT_MOTIVOS.has(m.key)).map(m=>m.key)} />}

      {puedeCitar && <CitarEmpleadoBox options={empOptions} minFecha={citaFecha} defaultFecha={fechaCita} onCitar={citarManual} />}

      {!motivoEfectivo.size ? (
        <div className="card table-card">
          <h3>Crónicos</h3>
          <p className="desc">Elegí arriba qué Id Motivo generan un caso (ej. Enfermedad, Enfermedad ART, Accidente de trabajo, Reserva de puesto) — el filtro arranca siempre en «Por defecto» y lo que cambies vale para tu pantalla (no modifica lo que ven los demás). Un caso agrupa, por legajo, todas las ausencias con ese motivo dentro del mismo año, y sólo se lista si el empleado sigue activo y su registro más reciente todavía está bajo ese mismo motivo (si ya volvió a estar presente o cambió de motivo, el caso deja de mostrarse).</p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="filter-row" style={{display:"flex", gap:10, flexWrap:"wrap", alignItems:"center"}}>
            <input type="text" placeholder="Buscar legajo o nombre…" value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:240}} />
            <select value={tipoFilter} onChange={e=>setTipoFilter(e.target.value)}>
              <option value="__all">Todos los tipos</option>
              {CRONICO_TIPOS.filter(Boolean).map(t=>(<option key={t} value={t}>{t}</option>))}
            </select>
            <select value={saludFilter} onChange={e=>setSaludFilter(e.target.value)} title="Filtrar los casos por ausencias de salud">
              <option value="__all">Todos los casos</option>
              <option value="__salud">Salud: AT, ET, EN y CAE ({Array.from(CRONICOS_CODIGOS_SALUD).reduce((a,k)=>a+(saludCount[k]||0),0)})</option>
              {Array.from(CRONICOS_CODIGOS_SALUD).map(k=>(<option key={k} value={k}>Solo {k} ({saludCount[k]||0})</option>))}
            </select>
            <MultiSelect label="Unidad de negocio" options={unidadOptions} selected={unidadSel} onChange={setUnidadSel} allLabel="Todas las unidades" />
            {puedeCitar && (
              <label style={{display:"inline-flex", gap:6, alignItems:"center", fontSize:13}} title="La Dra. no viene todos los días: elegí para qué día se cita al tildar «Citar» en la columna Medicina Laboral">
                Citar para el día
                <input type="date" value={fechaCita} min={citaFecha||undefined} onChange={e=>{ if(e.target.value) setCitaFechaSel(e.target.value); }} style={{fontSize:12.5, padding:"5px 6px"}} disabled={!citaFecha} />
              </label>
            )}
            <button type="button" className="btn secondary print-btn" onClick={handlePrint}>Imprimir</button>
            <button type="button" className="btn secondary" onClick={()=>printHistoria(sorted)} disabled={!sorted.length}>Historias clínicas ({sorted.length})</button>
            <button type="button" className="btn secondary" title="Vuelve a leer del servidor lo que guardaron los demás usuarios" onClick={refreshFromServer} disabled={!dbReady}>Actualizar datos</button>
            <span className="hint">{filtered.length} de {casesFull.length} casos activos y vigentes{saveStatus?" · "+saveStatus:""}</span>
          </div>
          <TopScrollSync targetRef={scrollRef} />
          <StickyTableHead targetRef={scrollRef} columns={CRONICO_COLUMNS} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <div className="overflow-x" ref={scrollRef}>
            <table>
              <thead><tr>
                {CRONICO_COLUMNS.map(col=>(
                  <th key={col.key} className={col.align==="num"?"num":undefined} style={{cursor:"pointer", userSelect:"none", whiteSpace:"nowrap"}} onClick={()=>handleSort(col.key)}>
                    {col.label}{sortKey===col.key ? (sortDir==="asc" ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {!sorted.length && <tr><td colSpan="19" style={{textAlign:"center",color:"var(--muted)",padding:"18px 0"}}>Sin casos activos y vigentes con estos filtros.</td></tr>}
                {sorted.map(c=>{
                  const notifStatus = cronicoNotificarStatus(c);
                  return (
                  <React.Fragment key={c.id}>
                    <tr className={notifStatus ? "cronico-row-"+notifStatus : undefined}>
                      <td>{c.legajo}</td>
                      <td>{c.nombre||"—"}</td>
                      <td style={{minWidth:150}}>
                        <input key={c.id+"-tel-"+(c.telefonoContacto||"")} type="tel" data-case={c.id} data-field="telefonoContacto" defaultValue={c.telefonoContacto} placeholder="Sin teléfono" disabled={locked}
                          onKeyDown={e=>{ if(e.key==="Enter") e.target.blur(); }}
                          onBlur={e=>{ const v = e.target.value.trim(); if(v!==(c.telefonoContacto||"")) commitField(c,"telefonoContacto", v); }}
                          style={{width:140, fontSize:12.5, padding:"5px 6px"}} />
                        {c.telefonoEditado && (
                          <div className="hint" style={puedeEditar ? {cursor:"pointer", marginTop:2} : {marginTop:2}} onClick={puedeEditar ? ()=>commitField(c,"telefonoContacto","") : undefined}
                            title={c.telefonoPlantel ? "Celular del plantel: "+c.telefonoPlantel : "El plantel no tiene celular cargado"}>
                            {puedeEditar ? "distinto al plantel · restablecer" : "distinto al plantel"}
                          </div>
                        )}
                      </td>
                      <td>{c.grupo||"—"}</td>
                      <td>{c.sindicato||"—"}</td>
                      <td>{c.gerencia||"—"}</td>
                      <td>{c.codpla||"—"}</td>
                      <td>{c.tipo}</td>
                      <td style={{whiteSpace:"nowrap"}}>
                        <input key={c.id+"-"+(c.inicioManualTs||"auto")} data-case={c.id} data-field="inicio" type="date" defaultValue={tsToISODate(c.inicioTs)} disabled={locked}
                          onBlur={e=>{ const v=e.target.value; if(v) commitField(c,"inicioManualTs", isoDateToTs(v)); }}
                          style={{width:130, fontSize:12.5, padding:"5px 6px"}} />
                        {c.inicioManualTs!=null && (
                          <div className="hint" style={puedeEditar ? {cursor:"pointer", marginTop:2} : {marginTop:2}} onClick={puedeEditar ? ()=>commitField(c,"inicioManualTs", null) : undefined}>
                            {puedeEditar ? "editado a mano · restablecer" : "editado a mano"}
                          </div>
                        )}
                      </td>
                      <td className="num">{fmt(cronicoDias(c.inicioTs))}</td>
                      <td>{c.motivoLabel||"—"}</td>
                      <td>{c.fechaIngresoTs!=null ? fmtDateFromTs(c.fechaIngresoTs) : "—"}</td>
                      <td>
                        <input key={c.id+"-notif-"+(c.notificar||"")} type="date" data-case={c.id} data-field="notificar" defaultValue={c.notificar||""} disabled={locked}
                          onChange={e=>commitField(c,"notificar", e.target.value||"")}
                          style={{width:130, fontSize:12.5, padding:"5px 6px"}} />
                      </td>
                      <td><input key={c.id+"-op-"+c.opinionMedica} type="text" data-case={c.id} data-field="opinionMedica" defaultValue={c.opinionMedica} onBlur={e=>{ if(e.target.value!==c.opinionMedica) commitField(c,"opinionMedica",e.target.value); }} disabled={locked} /></td>
                      <td><input key={c.id+"-te-"+c.tactoEmpleado} type="text" data-case={c.id} data-field="tactoEmpleado" defaultValue={c.tactoEmpleado} onBlur={e=>{ if(e.target.value!==c.tactoEmpleado) commitField(c,"tactoEmpleado",e.target.value); }} disabled={locked} /></td>
                      <td><input key={c.id+"-pa-"+c.posibleAlta} type="text" data-case={c.id} data-field="posibleAlta" defaultValue={c.posibleAlta} placeholder="DD/MM/AAAA" maxLength={10} style={{width:110}}
                        onChange={e=>{ const f = formatDigitsDMA(e.target.value); if(f!==e.target.value) e.target.value = f; }}
                        onKeyDown={e=>{ if(e.key==="Enter") e.target.blur(); }}
                        onBlur={e=>commitPosibleAlta(c, e.target)} disabled={locked} /></td>
                      <td style={{minWidth:220}}>
                        {c.acciones.length>0 && (
                          <div className="hint" style={{cursor:"pointer", marginBottom:4}} onClick={()=>setExpandedAccId(expandedAccId===c.id?null:c.id)}>
                            {expandedAccId===c.id ? "Ocultar" : "Ver"} historial ({c.acciones.length})
                          </div>
                        )}
                        {puedeEditar && (
                          <div style={{display:"flex", gap:4}}>
                            <input type="text" placeholder="Nueva acción…" value={obsDrafts["acciones:"+c.id]||""} onChange={e=>setObsDrafts(prev=>({...prev,["acciones:"+c.id]:e.target.value}))} onKeyDown={e=>{ if(e.key==="Enter") addEntry(c,"acciones"); }} disabled={locked} />
                            <button type="button" className="btn secondary" title="Agregar esta acción al historial del caso" onClick={()=>addEntry(c,"acciones")} disabled={locked}>+</button>
                          </div>
                        )}
                        {!puedeEditar && c.acciones.length===0 && "—"}
                      </td>
                      <td style={{whiteSpace:"nowrap", fontSize:12.5}}>
                        {c.cita && c.cita.atendido ? (
                          <span style={{color:"var(--good)", fontWeight:700}}>✓ Atendido{c.cita.atendidoTs ? " "+new Date(c.cita.atendidoTs).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}) : ""}</span>
                        ) : c.cita ? (
                          <label style={{cursor:puedeCitar?"pointer":"default", display:"flex", gap:6, alignItems:"center"}} title={"Citado "+(c.cita.origen==="medicina"?"por la Dra.":"desde Crónicos")+" — destildar para anular"}>
                            <input type="checkbox" checked onChange={()=>anularCita(c)} disabled={!puedeCitar || citaBusy===c.id || (c.cita.origen==="medicina" && !puedeEditar)} />
                            <span style={{fontWeight:700}}>Citado {dateKeyToLabel(c.cita.fecha).slice(0,5)}</span>
                          </label>
                        ) : puedeCitar ? (
                          <label style={{cursor:"pointer", display:"flex", gap:6, alignItems:"center"}} title={"Citar a Medicina Laboral para el "+dateKeyToLabel(fechaCita)}>
                            <input type="checkbox" checked={false} onChange={()=>citar(c)} disabled={citaBusy===c.id || !fechaCita} /> Citar {dateKeyToLabel(fechaCita).slice(0,5)}
                          </label>
                        ) : "—"}
                        {!(c.cita && c.cita.atendido) && c.otraCita && <div className="hint" style={{marginTop:2}}>Ya citado el {dateKeyToLabel(c.otraCita.fecha).slice(0,5)}</div>}
                      </td>
                      <td style={{minWidth:220}}>
                        {c.observaciones.length>0 && (
                          <div className="hint" style={{cursor:"pointer", marginBottom:4}} onClick={()=>setExpandedId(expandedId===c.id?null:c.id)}>
                            {expandedId===c.id ? "Ocultar" : "Ver"} historial ({c.observaciones.length})
                          </div>
                        )}
                        {puedeEditar && (
                          <div style={{display:"flex", gap:4}}>
                            <input type="text" placeholder="Nuevo movimiento…" value={obsDrafts["observaciones:"+c.id]||""} onChange={e=>setObsDrafts(prev=>({...prev,["observaciones:"+c.id]:e.target.value}))} onKeyDown={e=>{ if(e.key==="Enter") addEntry(c,"observaciones"); }} disabled={locked} />
                            <button type="button" className="btn secondary" title="Agregar este movimiento al historial del caso" onClick={()=>addEntry(c,"observaciones")} disabled={locked}>+</button>
                          </div>
                        )}
                        <div className="hint" style={{cursor:"pointer", marginTop:4, textDecoration:"underline"}} onClick={()=>printHistoria([c])}>Imprimir historia clínica</div>
                      </td>
                    </tr>
                    {expandedAccId===c.id && c.acciones.length>0 && (
                      <tr>
                        <td colSpan="19" style={{background:"var(--plane)"}}>
                          <div className="hint" style={{marginBottom:4, fontWeight:700}}>Acciones — {c.nombre||c.legajo} (no se imprimen en la historia clínica)</div>
                          <ObservacionesHistory c={c} field="acciones" labelCol="Acción" editingObs={editingObs} setEditingObs={setEditingObs}
                            onStartEdit={startEditEntry} onSaveEdit={saveEditEntry} onDelete={deleteEntry} disabled={locked} readOnly={!puedeEditar} />
                        </td>
                      </tr>
                    )}
                    {expandedId===c.id && c.observaciones.length>0 && (
                      <tr>
                        <td colSpan="19" style={{background:"var(--plane)"}}>
                          <div className="hint" style={{marginBottom:4, fontWeight:700}}>Observación / Evolución — {c.nombre||c.legajo}</div>
                          <ObservacionesHistory c={c} field="observaciones" labelCol="Movimiento" editingObs={editingObs} setEditingObs={setEditingObs}
                            onStartEdit={startEditEntry} onSaveEdit={saveEditEntry} onDelete={deleteEntry} disabled={locked} readOnly={!puedeEditar} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===================== Medicina Laboral =====================
   Jornada de la Dra.: ausentes por salud del día (AT, ET, EN, CAE...), empleados citados (por RRHH desde Crónicos o por la Dra. en una
   visita anterior), ficha con la evolución cargada en Crónicos y sus propias anotaciones (que se guardan en Crónicos como observaciones),
   y el listado/reporte imprimible de todo lo visto en la jornada. */
function MedicinaLaboralTab({parsed, plantel, puedeEditar}){
  const [fechaSel, setFechaSel] = useKeptState("ml.fecha", null);
  const maxISO = parsed.maxTs!=null ? tsToISODate(parsed.maxTs) : "";
  const minISO = parsed.minTs!=null ? tsToISODate(parsed.minTs) : "";
  const fechaISO = fechaSel || maxISO;
  const dTs = fechaISO ? isoDateToTs(fechaISO) : null;
  const [dbReady, setDbReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [manual, setManual] = useState(new Map());   // caso -> datos de Crónicos (observaciones, opinión médica...)
  const [citas, setCitas] = useState(new Map());     // citaciones
  const [status, setStatus] = useState("");
  const [openKey, setOpenKey] = useState(null);      // ficha abierta
  const [notas, setNotas] = useState({});            // borrador de anotación por caso
  const [reCita, setReCita] = useState({});          // {caso: {fecha, nota}} para "citar nuevamente"
  const [busy, setBusy] = useState(null);
  const [search, setSearch] = useState("");
  const [conEvolucion, setConEvolucion] = useState(false);
  const userRef = useRef("");
  const aliveRef = useRef(true);
  const manualRef = useRef(new Map());
  const queueRef = useRef(new Map());

  async function loadAll(){
    try{
      const {data:casos, error} = await supabaseClient.from(CRONICOS_CASOS_TABLE).select("*");
      if(error) throw error;
      const m = new Map((casos||[]).map(row=>[row.id, casoRowToManual(row)]));
      const cm = await loadCitas();
      if(!aliveRef.current) return false;
      manualRef.current = m; setManual(m); setCitas(cm); setLoadError("");
      return true;
    }catch(err){
      if(aliveRef.current) setLoadError((err && err.message) ? err.message : String(err));
      return false;
    }
  }
  useEffect(()=>{
    aliveRef.current = true;
    (async ()=>{
      try{ const {data} = await supabaseClient.auth.getSession(); userRef.current = (data && data.session && data.session.user && data.session.user.email) || ""; }catch(e){}
      await loadAll();
      if(aliveRef.current) setDbReady(true);
    })();
    return ()=>{ aliveRef.current = false; };
  }, []);
  async function refresh(){ setStatus("Actualizando..."); const ok = await loadAll(); setStatus(ok ? "Datos actualizados" : ""); }

  // ausentes por salud ese día: casos de salud vigentes con último registro justo ese día
  const ausentes = useMemo(()=>{
    if(dTs==null) return [];
    const upTo = parsed.records.filter(r=>r.valid && r.ts<=dTs);
    return buildCronicoCases(upTo, plantel, CRONICOS_CODIGOS_SALUD).filter(c=>c.ultimaTs===dTs)
      .map(c=>({...c, dias: Math.round((dTs-c.inicioTs)/86400000)+1}));
  }, [parsed, plantel, dTs]);
  const ausentesById = useMemo(()=> new Map(ausentes.map(c=>[c.id, c])), [ausentes]);

  const citasDelDia = useMemo(()=> Array.from(citas.values()).filter(c=>c.fecha===fechaISO && !c.anulada), [citas, fechaISO]);
  // citación de ese día de un caso; si el empleado se citó a mano antes de figurar en Crónicos, la citación está bajo su caso provisorio
  const citaDe = (id, legajo) => {
    let c = citas.get(id+"|"+fechaISO);
    if((!c || c.anulada) && legajo) c = citas.get(manualCaseId(legajo, fechaISO)+"|"+fechaISO);
    return c && !c.anulada ? c : null;
  };

  // Caso real de Crónicos de cada legajo (si ya figura) y datos del plantel (celular)
  const casosVigentes = useMemo(()=>{
    const m = new Map();
    buildCronicoCases(parsed.records, plantel, CRONICOS_DEFAULT_MOTIVOS).forEach(c=>m.set(String(c.legajo).toUpperCase(), c));
    return m;
  }, [parsed, plantel]);
  const realDe = legajo => casosVigentes.get(String(legajo).toUpperCase()) || null;
  const plantelPorLegajo = useMemo(()=> new Map((plantel||[]).map(p=>[String(p.legajo||"").toUpperCase(), p])), [plantel]);
  const celularDe = legajo => ((plantelPorLegajo.get(String(legajo).toUpperCase())||{}).celular)||"";
  // Teléfono de contacto de un empleado/caso: el que se cargó en Crónicos y, si no, el celular del plantel
  const telefonoDe = item => telefonoContactoDe(manual.get(item.dataId) || manual.get(item.casoId), celularDe(item.legajo));
  const empOptions = useMemo(()=> employeeOptionsForCita(plantel, parsed.records), [plantel, parsed]);
  // casos provisorios (citaciones manuales) de un legajo
  const manualIdsDe = legajo => Array.from(manual.keys()).filter(id=>esCasoManualId(id) && id.startsWith(sanitizeIdSeg(legajo)+"-MANUAL-"));

  // Traspaso: cuando un empleado citado a mano ya figura como caso de Crónicos, lo que escribió la Dra. en su caso provisorio se copia
  // al caso real (sin repetir lo ya copiado). Lo hace quien puede editar, una vez por cada novedad.
  const traspasoRef = useRef(new Set());
  useEffect(()=>{
    if(!puedeEditar || !dbReady) return;
    manual.forEach((m, id)=>{
      if(!esCasoManualId(id) || !(m.observaciones||[]).length) return;
      const legKey = id.replace(/-MANUAL-\d+$/, "");
      const real = Array.from(casosVigentes.values()).find(c=>sanitizeIdSeg(c.legajo)===legKey);
      if(!real) return;
      const have = new Set(((manual.get(real.id)||{}).observaciones||[]).map(o=>o.id));
      const faltan = m.observaciones.filter(o=>!have.has(o.id));
      if(!faltan.length) return;
      const key = id+">"+real.id+":"+faltan.map(o=>o.id).join(",");
      if(traspasoRef.current.has(key)) return;
      traspasoRef.current.add(key);
      enCola(real.id, async ()=>{
        const nm = await persistCronicoCase({id:real.id, legajo:real.legajo, anio:real.anio}, base=>{
          const h = new Set((base.observaciones||[]).map(o=>o.id));
          const add = faltan.filter(o=>!h.has(o.id));
          return add.length ? {observaciones:[...(base.observaciones||[]), ...add]} : null;
        }, manualRef.current.get(real.id));
        if(nm && aliveRef.current){ const n = new Map(manualRef.current); n.set(real.id, nm); manualRef.current = n; setManual(n); setStatus("Se sumó a Crónicos lo anotado a "+(real.nombre||real.legajo)); }
      }).catch(()=>{ traspasoRef.current.delete(key); });
    });
  }, [manual, casosVigentes, puedeEditar, dbReady]);

  // elementos unificados para las tablas. dataId = caso donde están los datos médicos (el real de Crónicos si ya existe).
  const itemDeAusente = c => ({key:c.id, casoId:c.id, dataId:c.id, legajo:c.legajo, nombre:c.nombre||"", unidad:c.unidad||"", motivo:c.motivoLabel||"", anio:c.anio, dias:c.dias});
  const itemDeCita = ct => {
    const real = realDe(ct.legajo);
    const live = ausentesById.get(ct.casoId) || (real ? ausentesById.get(real.id) : null);
    if(live) return {...itemDeAusente(live), nota:ct.nota};
    if(real){
      const d = dTs!=null ? Math.round((dTs-real.inicioTs)/86400000)+1 : null;
      return {key:ct.casoId, casoId:ct.casoId, dataId:real.id, legajo:ct.legajo, nombre:ct.nombre||real.nombre||"", unidad:real.unidad||ct.unidad, motivo:real.motivoLabel||ct.motivo, anio:real.anio, dias:d>=1 ? d : null, nota:ct.nota};
    }
    return {key:ct.casoId, casoId:ct.casoId, dataId:ct.casoId, legajo:ct.legajo, nombre:ct.nombre, unidad:ct.unidad, motivo:ct.motivo, anio:ct.anio, dias:null, nota:ct.nota};
  };
  const q = normTxt(search);
  const pasa = it => !q || normTxt(it.legajo).includes(q) || normTxt(it.nombre).includes(q);
  const itemsCitados = citasDelDia.map(itemDeCita).filter(pasa).sort((a,b)=>String(a.nombre).localeCompare(String(b.nombre),"es"));
  const itemsAusentes = ausentes.map(itemDeAusente).filter(pasa).sort((a,b)=>unitOrderIndex(a.unidad)-unitOrderIndex(b.unidad) || String(a.nombre).localeCompare(String(b.nombre),"es"));
  const vistos = citasDelDia.filter(c=>c.atendido).sort((a,b)=>a.atendidoTs-b.atendidoTs);

  // anotaciones de la Dra. de esa jornada (están guardadas como observaciones del caso, marcadas como Medicina Laboral)
  // Todas las observaciones de un empleado: las de su caso real de Crónicos y las de sus casos provisorios (sin repetir las ya copiadas).
  const obsDe = item => {
    const seen = new Map();
    new Set([item.casoId, item.dataId, ...manualIdsDe(item.legajo)]).forEach(id=>((manual.get(id)||{}).observaciones||[]).forEach(o=>{ if(!seen.has(o.id)) seen.set(o.id, o); }));
    return Array.from(seen.values());
  };
  const anotacionesDelDia = item => obsDe(item).filter(o=>o.origen==="medicina" && o.fechaVisita===fechaISO).sort((a,b)=>a.ts-b.ts);

  // ---- acciones ----
  function enCola(casoId, fn){
    const qm = queueRef.current; const prev = qm.get(casoId) || Promise.resolve();
    const job = prev.then(fn, fn); qm.set(casoId, job.catch(()=>{})); return job;
  }
  const citaNueva = (item, fecha, extra) => { const cid = item.dataId || item.casoId; return {id:cid+"|"+fecha, casoId:cid, legajo:item.legajo, nombre:item.nombre, unidad:item.unidad, motivo:item.motivo, anio:item.anio||0,
    fecha, origen:"medicina", citadoPor:userRef.current, citadoTs:Date.now(), nota:"", atendido:false, atendidoPor:"", atendidoTs:0, anulada:false, ...(extra||{})}; };
  async function guardarCitaLocal(obj){ const saved = await saveCita(obj); setCitas(prev=>{ const n = new Map(prev); n.set(saved.id, saved); return n; }); return saved; }
  // Cita a un empleado que todavía no figura en Crónicos (o que sí figura): queda en los Citados del día elegido
  async function citarManual(emp, fecha, nota){
    if(!puedeEditar) return "No tenés permiso para citar.";
    const real = realDe(emp.legajo);
    const casoId = real ? real.id : manualCaseId(emp.legajo, fecha);
    const ex = citas.get(casoId+"|"+fecha);
    if(ex && !ex.anulada) return "Ya está citado para el "+dateKeyToLabel(fecha)+".";
    await guardarCitaLocal({id:casoId+"|"+fecha, casoId, legajo:emp.legajo, nombre:emp.nombre||"", unidad:(real && real.unidad) || emp.unidad || "",
      motivo: real ? real.motivoLabel : "Citación manual (todavía no figura en Crónicos)", anio: real ? real.anio : (Number(String(fecha).slice(0,4))||0),
      fecha, origen:"medicina", citadoPor:userRef.current, citadoTs:Date.now(), nota:nota||"", atendido:false, atendidoPor:"", atendidoTs:0, anulada:false});
    return "Citado para el "+dateKeyToLabel(fecha)+(fecha===fechaISO ? ". Ya figura en los Citados de este día." : ".");
  }
  async function marcarVisto(item){
    if(!puedeEditar) return;
    setBusy(item.key); setStatus("Guardando...");
    try{
      const cur = citaDe(item.casoId, item.legajo);
      await guardarCitaLocal({...(cur || citaNueva(item, fechaISO)), atendido:true, atendidoPor:userRef.current, atendidoTs:Date.now(), anulada:false});
      setStatus("Marcado como visto");
    }catch(err){ setStatus("No se pudo guardar: "+((err && err.message) ? err.message : String(err))); }
    setBusy(null);
  }
  async function deshacerVisto(item){
    const cur = citaDe(item.casoId, item.legajo);
    if(!puedeEditar || !cur) return;
    setBusy(item.key); setStatus("Guardando...");
    try{ await guardarCitaLocal({...cur, atendido:false, atendidoPor:"", atendidoTs:0}); setStatus("Visto deshecho"); }
    catch(err){ setStatus("No se pudo guardar: "+((err && err.message) ? err.message : String(err))); }
    setBusy(null);
  }
  async function guardarAnotacion(item){
    const texto = (notas[item.key]||"").trim();
    if(!puedeEditar || !texto) return;
    setBusy(item.key); setStatus("Guardando...");
    const entry = {id:newObsId(), ts:Date.now(), texto, autor:userRef.current, origen:"medicina", fechaVisita:fechaISO};
    // la anotación va al caso real de Crónicos si el empleado ya figura; si no, a su caso provisorio (después se copia al real)
    const destId = item.dataId || item.casoId;
    try{
      await enCola(destId, async ()=>{
        const m = await persistCronicoCase({id:destId, legajo:item.legajo, anio:item.anio}, base=>({observaciones:[...(base.observaciones||[]), entry]}), manualRef.current.get(destId));
        if(m && aliveRef.current){ const n = new Map(manualRef.current); n.set(destId, m); manualRef.current = n; setManual(n); }
      });
      setNotas(p=>({...p, [item.key]:""}));
      const cur = citaDe(item.casoId, item.legajo);
      if(!cur || !cur.atendido) await guardarCitaLocal({...(cur || citaNueva(item, fechaISO)), atendido:true, atendidoPor:userRef.current, atendidoTs:Date.now(), anulada:false});
      setStatus("Anotación guardada (también figura en Crónicos)");
    }catch(err){ setStatus("No se pudo guardar: "+((err && err.message) ? err.message : String(err))); }
    setBusy(null);
  }
  async function citarNuevamente(item){
    const rc = reCita[item.key] || {};
    if(!puedeEditar) return;
    if(!rc.fecha || isoDateToTs(rc.fecha)==null){ setStatus("Elegí la fecha de la nueva cita."); return; }
    if(rc.fecha < fechaISO){ setStatus("La nueva cita no puede ser anterior al día que estás viendo."); return; }
    setBusy(item.key); setStatus("Guardando...");
    try{
      await guardarCitaLocal(citaNueva(item, rc.fecha, {nota:(rc.nota||"").trim()}));
      setReCita(p=>({...p, [item.key]:{fecha:"", nota:""}}));
      setStatus("Citado para el "+dateKeyToLabel(rc.fecha));
    }catch(err){ setStatus("No se pudo guardar: "+((err && err.message) ? err.message : String(err))); }
    setBusy(null);
  }

  // ---- reporte imprimible de la jornada ----
  function imprimirJornada(){
    const e = escHtml;
    const profesionales = Array.from(new Set(vistos.map(v=>v.atendidoPor).filter(Boolean)));
    const css = `
      @page{size:A4;margin:12mm;}
      *{box-sizing:border-box;}
      body{font-family:Arial,"Segoe UI",sans-serif;color:#111;font-size:12px;margin:0;}
      .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0c2e80;padding-bottom:8px;margin-bottom:10px;}
      .kicker{font-size:10px;letter-spacing:.14em;font-weight:700;color:#2a78d6;}
      h1{margin:2px 0;font-size:20px;color:#0c2e80;}
      .sub{color:#555;font-size:11.5px;}
      .head img{width:56px;height:56px;}
      .emp{border:1px solid #cfd8e8;border-radius:6px;padding:8px 10px;margin:0 0 9px;break-inside:avoid;}
      .emp .t{display:flex;justify-content:space-between;gap:10px;font-weight:700;color:#0c2e80;font-size:12.5px;}
      .emp .m{color:#555;font-size:11px;margin:2px 0 5px;}
      .lbl{font-size:10px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.04em;margin:5px 0 2px;}
      .txt{white-space:pre-wrap;line-height:1.45;margin:0 0 3px;}
      .meta{color:#777;font-size:10px;}
      .none{color:#777;font-style:italic;}
      .firma{margin-top:30px;width:40%;border-top:1px solid #333;padding-top:4px;text-align:center;font-size:10.5px;color:#444;}
      .foot{margin-top:14px;font-size:10px;color:#777;border-top:1px solid #ddd;padding-top:5px;}
    `;
    const bloques = vistos.map(v=>{
      const it = itemDeCita(v);
      const notasDia = anotacionesDelDia(it);
      const previas = obsDe(it).filter(o=>!(o.origen==="medicina" && o.fechaVisita===fechaISO)).slice().sort((a,b)=>a.ts-b.ts);
      const cel = telefonoDe(it).tel;
      return "<div class='emp'><div class='t'><span>"+e(v.nombre||"Sin nombre")+" — Legajo "+e(v.legajo)+(cel ? " · Cel. "+e(cel) : "")+"</span><span>"+e(v.atendidoTs ? new Date(v.atendidoTs).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}) : "")+" hs</span></div>"+
        "<div class='m'>"+e(it.unidad||"—")+" · "+e(it.motivo || "—")+(it.dias!=null ? " · "+it.dias+" día(s) de ausencia" : "")+" · "+(v.origen==="medicina" ? "Citado por la Dra." : "Seleccionado por RRHH")+(v.nota ? " · Motivo de la cita: "+e(v.nota) : "")+"</div>"+
        "<div class='lbl'>Anotaciones de la jornada</div>"+
        (notasDia.length ? notasDia.map(o=>"<p class='txt'>"+e(o.texto)+" <span class='meta'>("+e(new Date(o.ts).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}))+(o.autor ? " · "+e(o.autor) : "")+")</span></p>").join("") : "<p class='txt none'>Sin anotaciones registradas.</p>")+
        (conEvolucion && previas.length ? "<div class='lbl'>Evolución previa (Crónicos)</div>"+previas.map(o=>"<p class='txt'><span class='meta'>"+e(new Date(o.ts).toLocaleString("es-AR"))+(o.autor ? " · "+e(o.autor) : "")+" — </span>"+e(o.texto)+"</p>").join("") : "")+
        "</div>";
    }).join("");
    const logoUrl = new URL("icon-192.png", location.href).href;
    const html = "<div class='head'><div><div class='kicker'>MEDICINA LABORAL</div><h1>Reporte de la jornada — "+e(dateKeyToLabel(fechaISO))+"</h1><div class='sub'>"+vistos.length+" empleado(s) visto(s)"+(profesionales.length ? " · Profesional: "+e(profesionales.join(", ")) : "")+"</div></div><img src='"+e(logoUrl)+"' alt=''></div>"+
      (bloques || "<p class='none'>No hay empleados vistos en esta jornada.</p>")+
      "<div class='firma'>Firma del profesional</div>"+
      "<div class='foot'>Documento confidencial: contiene información de salud de los empleados. Emitido el "+e(new Date().toLocaleString("es-AR"))+".</div>";
    const win = window.open("", "_blank");
    if(!win){ alert("El navegador bloqueó la ventana de impresión. Habilitá las ventanas emergentes para este sitio e intentá de nuevo."); return; }
    win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Reporte de la jornada</title><style>'+css+'</style></head><body>'+html+'</body></html>');
    win.document.close(); win.focus();
    setTimeout(()=>{ win.print(); }, 500);
  }

  // ---- ficha de un empleado ----
  function renderFicha(item){
    const m = manual.get(item.dataId) || manual.get(item.casoId) || {};
    const obs = obsDe(item).sort((a,b)=>b.ts-a.ts);
    const cur = citaDe(item.casoId, item.legajo);
    const rc = reCita[item.key] || {fecha:"", nota:""};
    const ocupado = busy===item.key;
    const sinCaso = esCasoManualId(item.dataId || item.casoId);   // todavía no figura como caso de Crónicos
    return (
      <div style={{display:"flex", flexDirection:"column", gap:10, padding:"6px 2px"}}>
        {sinCaso && <div className="hint" style={{color:"var(--warning)", fontWeight:700}}>Citado a mano: todavía no figura como caso en Crónicos. Cuando se actualice la base se toman sus datos médicos de allí y lo que anotes se suma a su caso.</div>}
        <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))", gap:"6px 20px"}}>
          <div><span className="hint">Unidad</span><div><b>{item.unidad||"—"}</b></div></div>
          <div><span className="hint">Celular / teléfono de contacto</span><div><b>{telefonoDe(item).tel||"—"}</b>{telefonoDe(item).editado && <span className="hint"> (cargado en Crónicos{telefonoDe(item).plantel ? "; plantel: "+telefonoDe(item).plantel : ""})</span>}</div></div>
          <div><span className="hint">Motivo - Razón</span><div><b>{item.motivo||"—"}</b></div></div>
          <div><span className="hint">Opinión médica</span><div>{m.opinionMedica||"—"}</div></div>
          <div><span className="hint">Táctico empleado</span><div>{m.tactoEmpleado||"—"}</div></div>
          <div><span className="hint">Posible alta</span><div>{m.posibleAlta||"—"}</div></div>
          {cur && <div><span className="hint">Citación</span><div>{cur.origen==="medicina" ? "Citado por la Dra." : "Seleccionado por RRHH"}{cur.nota ? " — "+cur.nota : ""}</div></div>}
        </div>
        <div>
          <div className="hint" style={{fontWeight:700, marginBottom:4}}>Evolución / Observaciones (las mismas de Crónicos)</div>
          {obs.length ? (
            <div style={{display:"flex", flexDirection:"column", gap:6}}>
              {obs.map(o=>(
                <div key={o.id} style={{borderBottom:"1px solid var(--border)", paddingBottom:5}}>
                  <div className="hint">{new Date(o.ts).toLocaleString("es-AR")}{o.autor ? " · "+o.autor : ""}{o.origen==="medicina" ? " · Medicina Laboral" : ""}</div>
                  <div style={{whiteSpace:"pre-wrap"}}>{o.texto}</div>
                </div>
              ))}
            </div>
          ) : <div className="hint">Todavía no hay observaciones cargadas.</div>}
        </div>
        {puedeEditar && (
          <React.Fragment>
            <div>
              <div className="hint" style={{fontWeight:700, marginBottom:4}}>Anotación de la Dra. (se guarda también en Crónicos y marca al empleado como visto)</div>
              <textarea rows={3} style={{width:"100%"}} placeholder="Escribí acá lo observado en la consulta…" value={notas[item.key]||""} onChange={e=>setNotas(p=>({...p,[item.key]:e.target.value}))} disabled={ocupado} />
              <div style={{display:"flex", gap:8, flexWrap:"wrap", marginTop:6}}>
                <button type="button" className="btn small" onClick={()=>guardarAnotacion(item)} disabled={ocupado || !(notas[item.key]||"").trim()}>Guardar anotación</button>
                {cur && cur.atendido
                  ? <button type="button" className="btn secondary small" onClick={()=>deshacerVisto(item)} disabled={ocupado}>Deshacer "visto"</button>
                  : <button type="button" className="btn secondary small" onClick={()=>marcarVisto(item)} disabled={ocupado}>Marcar como visto (sin anotación)</button>}
              </div>
            </div>
            <div style={{display:"flex", gap:8, flexWrap:"wrap", alignItems:"center"}}>
              <span className="hint" style={{fontWeight:700}}>Citar nuevamente:</span>
              <input type="date" value={rc.fecha} min={fechaISO} onChange={e=>setReCita(p=>({...p,[item.key]:{...rc, fecha:e.target.value}}))} style={{fontSize:12.5, padding:"5px 6px"}} disabled={ocupado} />
              <input type="text" placeholder="Motivo de la cita (opcional)" value={rc.nota} onChange={e=>setReCita(p=>({...p,[item.key]:{...rc, nota:e.target.value}}))} style={{minWidth:220}} disabled={ocupado} />
              <button type="button" className="btn secondary small" onClick={()=>citarNuevamente(item)} disabled={ocupado || !rc.fecha}>Citar</button>
            </div>
          </React.Fragment>
        )}
      </div>
    );
  }

  function renderTabla(items, titulo, vacio, mostrarDias){
    return (
      <div className="overflow-x">
        <table>
          <thead><tr>
            <th>Legajo</th><th>Nombre</th><th>Unidad</th><th>Motivo - Razón</th>{mostrarDias && <th className="num">Días</th>}<th>Citación</th><th>Estado</th><th></th>
          </tr></thead>
          <tbody>
            {!items.length && <tr><td colSpan={mostrarDias ? 8 : 7} style={{textAlign:"center",color:"var(--muted)",padding:"16px 0"}}>{vacio}</td></tr>}
            {items.map(it=>{
              const ct = citaDe(it.casoId, it.legajo);
              const abierto = openKey===titulo+"|"+it.key;
              return (
                <React.Fragment key={it.key}>
                  <tr>
                    <td>{it.legajo}</td><td>{it.nombre||"—"}</td><td>{it.unidad||"—"}</td><td>{it.motivo||"—"}</td>
                    {mostrarDias && <td className="num">{it.dias!=null ? fmt(it.dias) : "—"}</td>}
                    <td>{ct ? (ct.origen==="medicina" ? "Citado por la Dra." : "Seleccionado por RRHH") : "—"}{ct && ct.nota ? <div className="hint">{ct.nota}</div> : null}</td>
                    <td>{ct && ct.atendido ? <span style={{color:"var(--good)", fontWeight:700}}>✓ Visto {ct.atendidoTs ? new Date(ct.atendidoTs).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}) : ""}</span> : ct ? <span style={{color:"var(--warning)", fontWeight:700}}>Pendiente</span> : "—"}</td>
                    <td><button type="button" className="btn secondary small" onClick={()=>setOpenKey(abierto ? null : titulo+"|"+it.key)}>{abierto ? "Cerrar ficha" : (puedeEditar ? "Ver ficha / Atender" : "Ver ficha")}</button></td>
                  </tr>
                  {abierto && (
                    <tr><td colSpan={mostrarDias ? 8 : 7} style={{background:"var(--plane)"}}>{renderFicha(it)}</td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if(dTs==null) return <div className="tabpanel"><div className="card table-card"><p className="desc">Todavía no hay datos de ausentismo cargados.</p></div></div>;
  return (
    <div className="tabpanel">
      <div className="card controls">
        <div className="field">
          <label>Día</label>
          <input type="date" value={fechaISO} min={minISO} max={maxISO} onChange={e=>{ if(e.target.value) setFechaSel(e.target.value); }} />
        </div>
        <div className="field">
          <label>Buscar</label>
          <input type="text" placeholder="Legajo o nombre…" value={search} onChange={e=>setSearch(e.target.value)} style={{minWidth:200}} />
        </div>
        <button type="button" className="btn secondary" onClick={()=>setFechaSel(null)} disabled={fechaISO===maxISO}>Ir al último día cargado</button>
        <button type="button" className="btn secondary" onClick={refresh} disabled={!dbReady} title="Vuelve a leer lo que cargaron los demás usuarios">Actualizar datos</button>
        <span className="hint">{status}</span>
      </div>
      {puedeEditar && <CitarEmpleadoBox options={empOptions} minFecha={minISO} defaultFecha={fechaISO} onCitar={citarManual} />}
      {loadError && <div className="warn-banner">No se pudieron leer los datos de Medicina Laboral ({loadError}). ¿Ya corriste supabase-migracion-medicina-laboral.sql en Supabase?</div>}

      <div className="card table-card">
        <h3>Citados — {dateKeyToLabel(fechaISO)} ({itemsCitados.length})</h3>
        <div className="caption">Empleados citados para este día: los que RRHH seleccionó desde Crónicos y los que la Dra. citó en una visita anterior.</div>
        {renderTabla(itemsCitados, "citados", "No hay empleados citados para este día.", false)}
      </div>

      <div className="card table-card">
        <h3>Ausentes por salud — {dateKeyToLabel(fechaISO)} ({itemsAusentes.length})</h3>
        <div className="caption">Ausencias por motivos de salud ({Array.from(CRONICOS_CODIGOS_SALUD).join(", ")}) del día. Desde acá se puede abrir la ficha, anotar y marcar como visto.</div>
        {renderTabla(itemsAusentes, "ausentes", "No hay ausentes por salud este día.", true)}
      </div>

      <div className="card table-card">
        <div style={{display:"flex", alignItems:"center", gap:12, flexWrap:"wrap"}}>
          <h3 style={{margin:0}}>Vistos en la jornada — {dateKeyToLabel(fechaISO)} ({vistos.length})</h3>
          <label className="motivo-check" style={{cursor:"pointer", marginLeft:"auto"}}>
            <input type="checkbox" checked={conEvolucion} onChange={e=>setConEvolucion(e.target.checked)} /> Incluir evolución previa en el reporte
          </label>
          <button type="button" className="btn" onClick={imprimirJornada} disabled={!vistos.length}>Imprimir reporte de la jornada</button>
        </div>
        <div className="overflow-x">
          <table>
            <thead><tr><th>Hora</th><th>Legajo</th><th>Nombre</th><th>Unidad</th><th>Motivo - Razón</th><th>Anotaciones de la jornada</th></tr></thead>
            <tbody>
              {!vistos.length && <tr><td colSpan="6" style={{textAlign:"center",color:"var(--muted)",padding:"16px 0"}}>Todavía no hay empleados vistos en esta jornada.</td></tr>}
              {vistos.map(v=>{
                const it = itemDeCita(v);
                const nd = anotacionesDelDia(it);
                return (
                  <tr key={v.id}>
                    <td style={{whiteSpace:"nowrap"}}>{v.atendidoTs ? new Date(v.atendidoTs).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}) : "—"}</td>
                    <td>{v.legajo}</td><td>{v.nombre||"—"}</td><td>{it.unidad||"—"}</td><td>{it.motivo||"—"}</td>
                    <td style={{whiteSpace:"pre-wrap"}}>{nd.length ? nd.map(o=>o.texto).join("\n— ") : <span className="hint">Sin anotaciones</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SimuladorTab({rankingUnits, objetivo}){
  const [unit, setUnit] = useState(rankingUnits[0] ? rankingUnits[0].name : "");
  const [dotacion, setDotacion] = useState(0);
  const [dias, setDias] = useState(0);
  const [ausencias, setAusencias] = useState(0);

  useEffect(()=>{
    if(!rankingUnits.length) return;
    if(!rankingUnits.find(u=>u.name===unit)) setUnit(rankingUnits[0].name);
  }, [rankingUnits]);

  const loadDefaults = useCallback(()=>{
    const u = rankingUnits.find(x=>x.name===unit);
    if(!u) return;
    setDotacion(u.dotacion);
    setDias(u.dotacion>0 ? Math.round(u.base/u.dotacion) : 0);
    setAusencias(u.ausencias);
  }, [rankingUnits, unit]);

  useEffect(()=>{ loadDefaults(); }, [unit, rankingUnits]);

  const base = dotacion*dias;
  const pct = base>0 ? ausencias/base*100 : 0;
  const sem = semaforo(pct, objetivo);
  const semColor = sem.level==="good"?"var(--good)":sem.level==="warn"?"var(--warning)":"var(--critical)";
  const perDay = base>0 ? (1/base*100) : 0;
  const diasParaObjetivo = base>0 ? Math.floor(base*objetivo/100) : 0;

  if(!rankingUnits.length) return <div className="tabpanel"><div className="card chart-card"><p className="desc">Sin datos para simular con estos filtros.</p></div></div>;

  return (
    <div className="tabpanel">
      <div className="card chart-card">
        <h3>Simulador de impacto</h3>
        <p className="desc">Ajustá dotación, días o ausencias de una unidad y mirá cómo se mueve el % respecto del objetivo.</p>
        <div className="sim-grid">
          <div>
            <div className="sim-field">
              <label>Unidad de negocio</label>
              <select value={unit} onChange={e=>setUnit(e.target.value)}>
                {rankingUnits.map(u=>(<option key={u.name} value={u.name}>{u.name}</option>))}
              </select>
            </div>
            <div className="sim-field">
              <label>Dotación</label>
              <input type="number" min="0" value={dotacion} onChange={e=>setDotacion(+e.target.value||0)} />
            </div>
            <div className="sim-field">
              <label>Días del período</label>
              <input type="number" min="0" value={dias} onChange={e=>setDias(+e.target.value||0)} />
            </div>
            <div className="sim-field">
              <label>Filas de ausencia contabilizadas</label>
              <input type="number" min="0" value={ausencias} onChange={e=>setAusencias(+e.target.value||0)} />
            </div>
            <button className="btn secondary small" onClick={loadDefaults}>Volver a los datos reales</button>
          </div>
          <div className="sim-result">
            <div className="card kpi-tile" style={{display:"inline-flex", flexDirection:"row", alignItems:"center", gap:14, width:"fit-content"}}>
              <div>
                <div className="kpi-label">Ausentismo simulado</div>
                <div className="sim-big" style={{color:semColor}}>{fmtPct(pct,2)}</div>
              </div>
              <SemChip pct={pct} objetivo={objetivo} />
            </div>
            <div className="sim-note">
              Con una dotación de <b>{fmt(dotacion)}</b> y <b>{fmt(dias)}</b> días, cada fila de ausencia adicional mueve el ausentismo <b>{fmtPct(perDay,3)}</b> puntos.<br/>
              Para quedar exactamente en el objetivo, esta unidad podría acumular hasta <b>{fmt(diasParaObjetivo)}</b> filas de ausencia en el período (tiene {fmt(ausencias)}).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== app ===================== */
function App({userEmail, userId, rol, permisosSinActivar, onSignOut}){
  const perms = ROLES[rol] || ROLES.gerencias;
  const verResumen = perms.tabs.includes("resumen"); // las tarjetas de ausentismo de arriba pertenecen al Resumen
  const [fileName, setFileName] = useState(null);
  const [error, setError] = useState(null);
  const [parsedRaw, setParsed] = useState(null);
  const parsedRef = useRef(null);
  parsedRef.current = parsedRaw;
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(false);

  const [activeTab, setActiveTab] = useState(perms.tabs[0]);
  const shownTab = perms.tabs.includes(activeTab) ? activeTab : perms.tabs[0]; // nunca se muestra un menú que el perfil no tiene
  const [objetivo, setObjetivo] = useState(3);
  const [FILTERS, setFiltersState] = useState({mes:null, departamento:null, gerencia:null, sector:null});
  const [empresaIncluded, setEmpresaIncluded] = useState(null);
  const [excludedMotivos, setExcludedMotivos] = useState(new Set());
  const [rankingIdIncluded, setRankingIdIncluded] = useState(new Set());
  const [rankingPresIncluded, setRankingPresIncluded] = useState(new Set());
  const [plantel, setPlantel] = useState([]);
  const [plantelHistorial, setPlantelHistorial] = useState([]);
  const [plantelUpdatedAt, setPlantelUpdatedAt] = useState(null);
  const plantelActive = plantel.length>0;
  // datos de ausentismo con el nombre de empresa unificado según el plantel (ver withCanonEmpresa)
  const parsed = useMemo(()=> withCanonEmpresa(parsedRaw, plantel), [parsedRaw, plantel]);
  const [cuatriSel, setCuatriSel] = useState("");
  const [ausUpdatePreview, setAusUpdatePreview] = useState(null);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [cloudError, setCloudError] = useState(null);
  // estado de la descarga desde el servidor: "pending" (bajando), "ok" (terminó) o "error" (falló; se reintenta sola)
  const [serverState, setServerState] = useState("pending");
  const [dlRows, setDlRows] = useState(0);        // registros de ausentismo descargados hasta ahora (primer ingreso)
  const [retryInfo, setRetryInfo] = useState(0);  // cantidad de reintentos automáticos hechos
  const loadRef = useRef(null);
  const [uploadNotice, setUploadNotice] = useState(null); // aviso no bloqueante de la última carga (ej. columna opcional faltante)
  const [syncStatus, setSyncStatus] = useState(null); // {label, done, total} | null

  // espacio usado de la base de datos: se consulta al abrir y cada vez que termina una carga
  const [dbUsage, setDbUsage] = useState(null);
  const [dbUsageError, setDbUsageError] = useState(null);
  const [dbChecking, setDbChecking] = useState(false);
  const checkDb = useCallback(async ()=>{
    setDbChecking(true);
    try{
      const {data, error} = await supabaseClient.rpc("estado_base");
      if(error) throw error;
      setDbUsage(data); setDbUsageError(null);
    }catch(err){
      setDbUsageError("No se pudo consultar el estado de la base" + (err && err.message ? " ("+err.message+")" : "") + ". ¿Ya corriste supabase-estado-base.sql en el SQL Editor de Supabase?");
    }
    setDbChecking(false);
  }, []);
  const syncActive = !!syncStatus;
  useEffect(()=>{ if(!syncActive && perms.plantelCompleto) checkDb(); }, [syncActive]); // el estado de la base lo ve solo el Administrador
  const dbRowsPerMonth = useMemo(()=> rowsPerMonthOf(parsed), [parsed]);

  // la barra de pestañas queda fija arriba al bajar; su alto se guarda en --tabs-h para que la barra de scroll horizontal de las tablas se fije justo debajo
  const tabsRef = useRef(null);
  useEffect(()=>{
    const el = tabsRef.current;
    if(!el || typeof ResizeObserver==="undefined") return;
    const setH = ()=> document.documentElement.style.setProperty("--tabs-h", el.offsetHeight+"px");
    setH();
    const ro = new ResizeObserver(setH);
    ro.observe(el);
    return ()=>{ ro.disconnect(); document.documentElement.style.removeProperty("--tabs-h"); };
  }, [!!parsed]);
  const dbPct = dbUsagePct(dbUsage);

  // Servicio médico: la empresa queda fija en "Propios" (el filtro no se muestra) y Crónicos / Detalle trabajan solo con esos legajos
  const propiosName = parsed ? (parsed.empresas.find(n=>normTxt(n)==="propios") || null) : null;
  useEffect(()=>{
    if(!perms.soloPropios || !propiosName) return;
    setEmpresaIncluded(prev=> (prev && prev.size===1 && prev.has(propiosName)) ? prev : new Set([propiosName]));
  }, [propiosName]);
  const parsedVista = useMemo(()=>{
    if(!perms.soloPropios || !parsed || !empresaIncluded) return parsed;
    return {...parsed, records: parsed.records.filter(r=>!r.empresa || empresaIncluded.has(r.empresa))};
  }, [parsed, empresaIncluded]);

  // si cambia la escritura de una empresa (p. ej. al cargar el plantel), el filtro de Empresa ya elegido se adapta a los nombres vigentes
  const empresasSig = parsed ? parsed.empresas.join("|") : "";
  useEffect(()=>{
    if(!empresaIncluded || !parsed) return;
    const vigentes = new Map(parsed.empresas.map(n=>[normTxt(n), n]));
    let cambio = false;
    const next = new Set();
    empresaIncluded.forEach(n=>{
      const v = vigentes.get(normTxt(n));
      if(v!==n) cambio = true;
      if(v) next.add(v);
    });
    if(cambio) setEmpresaIncluded(next.size===parsed.empresas.length ? null : next);
  }, [empresasSig]);

  const setFilterDim = (dim, val) => setFiltersState(prev => ({...prev, [dim]: val}));

  function applyParsedRecords(records, fileNameLabel, hasMotivo){
    const next = buildParsedAggregates(records, fileNameLabel, hasMotivo);
    const motivoDefaultExcluded = new Set(next.motivoUniverse.filter(m=>isDefaultExcludedMotivoKey(m.key)).map(m=>m.key));
    const rankingIdDefault = new Set(next.idMotivoUniverse.filter(m=>isDefaultIncludedMotivoCode(m.key)).map(m=>m.key));
    const rankingPresDefault = new Set(next.presidenciaUniverse.filter(v=>RANKING_DEFAULT_PRESIDENCIA_INCLUDE.has(v)));
    let defaultYear=null, defaultMonth=null;
    if(next.monthKeys.length){
      const lastKey = next.monthKeys[next.monthKeys.length-1];
      const [y,m] = lastKey.split("-");
      defaultYear = parseInt(y,10); defaultMonth = parseInt(m,10);
    }
    setParsed(next);
    setSel(defaultYear && defaultMonth ? {year:defaultYear, month:defaultMonth} : null);
    setFileName(next.fileName);
    setExcludedMotivos(motivoDefaultExcluded);
    setRankingIdIncluded(rankingIdDefault);
    setRankingPresIncluded(rankingPresDefault);
  }

  useEffect(()=>{
    let cancelled = false;
    let retryTimer = null;
    // Si la descarga falla (por ejemplo una conexión de celular que se corta), se reintenta sola unas veces; nunca se le pide a la
    // persona que suba el archivo (eso lo tiene solo el administrador).
    async function run(attempt){
      setCloudLoading(true);
      setCloudError(null);
      setServerState("pending");
      setDlRows(0);
      try{
        // 1) primero, lo que ya quedó guardado en este navegador de la vez pasada — se ve al instante, sin red.
        const [cachedAusRows, cachedAusSync, cachedPlantelRows, cachedPlantelSync] = await Promise.all([
          idbGet("ausentismo_rows"), idbGet("ausentismo_lastSync"), idbGet("plantel_rows"), idbGet("plantel_lastSync")
        ]);
        if(cancelled) return;
        let ausRows = cachedAusRows || [];
        let plantelRows = cachedPlantelRows || [];
        let prevAggregate = null;
        if(plantelRows.length){
          setPlantel(plantelRows.map(plantelRowToRecord));
          setPlantelUpdatedAt(new Date());
        }
        if(ausRows.length){
          const records = ausRows.map(ausRowToRecord);
          const hasMotivo = records.some(r=>r.idMotivo || r.motivo);
          prevAggregate = buildParsedAggregates(records, "Datos guardados en el servidor", hasMotivo);
          // en un reintento con datos ya en pantalla no se vuelven a aplicar (no se pierden los filtros que la persona ya eligió)
          if(!(attempt>0 && parsedRef.current)) applyParsedRecords(records, "Datos guardados en el servidor", hasMotivo);
        }
        setCloudLoading(false);

        // 2) después, en segundo plano, solo lo nuevo/modificado desde la última vez (no vuelve a bajar todo).
        const [newPlantelRows, newAusRows] = await Promise.all([
          fetchRowsSince(PLANTEL_TABLE, cachedPlantelSync, null, "legajo"),
          fetchRowsSince(AUSENTISMO_TABLE, cachedAusSync, n=>{ if(!cancelled) setDlRows(n); }, "id")
        ]);
        if(cancelled) return;

        if(newPlantelRows.length){
          plantelRows = mergeRawRowsById(plantelRows, newPlantelRows, "legajo");
          setPlantel(plantelRows.map(plantelRowToRecord));
          setPlantelUpdatedAt(new Date());
          idbSet("plantel_rows", plantelRows);
          idbSet("plantel_lastSync", maxUpdatedAt(newPlantelRows, cachedPlantelSync));
        }
        if(newAusRows.length){
          ausRows = mergeRawRowsById(ausRows, newAusRows, "id");
          const records = ausRows.map(ausRowToRecord);
          const hasMotivo = records.some(r=>r.idMotivo || r.motivo);
          const nextAggregate = buildParsedAggregates(records, "Datos guardados en el servidor", hasMotivo);
          if(prevAggregate){
            // ya había datos en caché: solo sumar lo nuevo, sin resetear filtros/selecciones que el usuario ya haya tocado
            setExcludedMotivos(prev => {
              const out = new Set(prev);
              nextAggregate.motivoUniverse.forEach(m=>{ if(!prevAggregate.motivoUniverse.some(om=>om.key===m.key) && isDefaultExcludedMotivoKey(m.key)) out.add(m.key); });
              return out;
            });
            setRankingIdIncluded(prev => {
              const out = new Set(prev);
              nextAggregate.idMotivoUniverse.forEach(m=>{ if(!prevAggregate.idMotivoUniverse.some(om=>om.key===m.key) && isDefaultIncludedMotivoCode(m.key)) out.add(m.key); });
              return out;
            });
            setRankingPresIncluded(prev => {
              const out = new Set(prev);
              nextAggregate.presidenciaUniverse.forEach(v=>{ if(!prevAggregate.presidenciaUniverse.includes(v) && RANKING_DEFAULT_PRESIDENCIA_INCLUDE.has(v)) out.add(v); });
              return out;
            });
            setParsed(nextAggregate);
            setFileName(nextAggregate.fileName);
          } else {
            applyParsedRecords(records, "Datos guardados en el servidor", hasMotivo);
          }
          idbSet("ausentismo_rows", ausRows);
          idbSet("ausentismo_lastSync", maxUpdatedAt(newAusRows, cachedAusSync));
        }
        if(!cancelled){ setServerState("ok"); setRetryInfo(0); }
      }catch(err){
        if(cancelled) return;
        setServerState("error");
        setCloudError("No se pudieron cargar los datos guardados en el servidor: " + (err && err.message ? err.message : String(err)));
        const esperas = [4000, 10000, 20000, 40000];
        if(attempt < esperas.length){ setRetryInfo(attempt+1); retryTimer = setTimeout(()=>run(attempt+1), esperas[attempt]); }
      }
      if(!cancelled) setCloudLoading(false);
    }
    loadRef.current = ()=>{ if(retryTimer) clearTimeout(retryTimer); run(0); };
    run(0);
    return ()=>{ cancelled = true; if(retryTimer) clearTimeout(retryTimer); };
  }, []);

  const handleFile = useCallback((file) => {
    setLoading(true);
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, {type:"array", cellDates:false});
        const ws = wb.Sheets["Sheet1"] || wb.Sheets[wb.SheetNames[0]];
        const rows2d = XLSX.utils.sheet_to_json(ws, {header:1, defval:"", raw:true});
        const parsedRows = parseAusentismoRows(rows2d);
        if(parsedRows.error){
          setError(parsedRows.error);
          setLoading(false);
          setFileName(file.name);
          setParsed(null);
          return;
        }
        // si ya hay datos cargados, solo se sube lo nuevo o modificado (no las ~200.000 filas enteras):
        // ahorra datos de subida y evita que todos los usuarios tengan que volver a bajar toda la base.
        const prevRecords = parsedRef.current ? parsedRef.current.records : null;
        const validRecords = parsedRows.records.filter(r=>r.valid);
        const recordsToUpload = prevRecords ? mergeAusentismoRecords(prevRecords, validRecords).changedRows : validRecords;
        applyParsedRecords(parsedRows.records, file.name, parsedRows.hasMotivoCol);
        setUploadNotice(parsedRows.missingTipoContrat);
        setActiveTab("resumen");
        setObjetivo(3);
        setFiltersState({mes:null, departamento:null, gerencia:null, sector:null});
        setEmpresaIncluded(null);
        setAusUpdatePreview(null);
        setLoading(false);
        const validRows = recordsToUpload.map(ausRecordToRow);
        setCloudError(null);
        setSyncStatus({label:"Guardando en el servidor", done:0, total:validRows.length});
        upsertInBatches(AUSENTISMO_TABLE, validRows, "id", (done,total)=>setSyncStatus({label:"Guardando en el servidor", done, total}))
          .then(()=> setSyncStatus(null))
          .catch(err=>{ setSyncStatus(null); setCloudError("No se pudo guardar en el servidor: " + (err && err.message ? err.message : String(err))); });
      }catch(err){
        setError("No se pudo leer el archivo: " + (err && err.message ? err.message : String(err)));
        setParsed(null);
        setLoading(false);
      }
    };
    reader.onerror = () => { setError("No se pudo leer el archivo."); setLoading(false); };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleUpdateFile = useCallback((file) => {
    if(!parsed){ handleFile(file); return; }
    setLoading(true);
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, {type:"array", cellDates:false});
        const ws = wb.Sheets["Sheet1"] || wb.Sheets[wb.SheetNames[0]];
        const rows2d = XLSX.utils.sheet_to_json(ws, {header:1, defval:"", raw:true});
        const parsedRows = parseAusentismoRows(rows2d);
        if(parsedRows.error){
          setError(parsedRows.error);
          setLoading(false);
          return;
        }
        const {merged, nuevos, modificados, sinCambios, nuevosInvalidos, changedRows} = mergeAusentismoRecords(parsed.records, parsedRows.records);
        const hasMotivo = parsed.hasMotivo || parsedRows.hasMotivoCol;
        setUploadNotice(parsedRows.missingTipoContrat);
        const nextParsed = buildParsedAggregates(merged, file.name, hasMotivo);
        setAusUpdatePreview({
          fileName: file.name,
          encontrados: parsedRows.records.length,
          nuevos, modificados, sinCambios, nuevosInvalidos, changedRows,
          nextParsed
        });
      }catch(err){
        setError("No se pudo leer el archivo: " + (err && err.message ? err.message : String(err)));
      }
      setLoading(false);
    };
    reader.onerror = () => { setError("No se pudo leer el archivo."); setLoading(false); };
    reader.readAsArrayBuffer(file);
  }, [parsed, handleFile]);

  function confirmAusUpdate(){
    if(!ausUpdatePreview || !parsed) return;
    const next = ausUpdatePreview.nextParsed;
    setExcludedMotivos(prev => {
      const out = new Set(prev);
      next.motivoUniverse.forEach(m=>{ if(!parsed.motivoUniverse.some(om=>om.key===m.key) && isDefaultExcludedMotivoKey(m.key)) out.add(m.key); });
      return out;
    });
    setRankingIdIncluded(prev => {
      const out = new Set(prev);
      next.idMotivoUniverse.forEach(m=>{ if(!parsed.idMotivoUniverse.some(om=>om.key===m.key) && isDefaultIncludedMotivoCode(m.key)) out.add(m.key); });
      return out;
    });
    setRankingPresIncluded(prev => {
      const out = new Set(prev);
      next.presidenciaUniverse.forEach(v=>{ if(!parsed.presidenciaUniverse.includes(v) && RANKING_DEFAULT_PRESIDENCIA_INCLUDE.has(v)) out.add(v); });
      return out;
    });
    setParsed(next);
    setFileName(next.fileName);
    const changedRows = (ausUpdatePreview.changedRows||[]).map(ausRecordToRow);
    setAusUpdatePreview(null);
    if(changedRows.length){
      setCloudError(null);
      setSyncStatus({label:"Guardando cambios en el servidor", done:0, total:changedRows.length});
      upsertInBatches(AUSENTISMO_TABLE, changedRows, "id", (done,total)=>setSyncStatus({label:"Guardando cambios en el servidor", done, total}))
        .then(()=> setSyncStatus(null))
        .catch(err=>{ setSyncStatus(null); setCloudError("No se pudo guardar la actualización en el servidor: " + (err && err.message ? err.message : String(err))); });
    }
  }
  function cancelAusUpdate(){ setAusUpdatePreview(null); }

  const onInputChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if(f) handleFile(f);
    e.target.value = "";
  };
  const onUpdateInputChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if(f) handleUpdateFile(f);
    e.target.value = "";
  };

  const rangoDesde = parsed && parsed.minTs!=null ? new Date(parsed.minTs) : null;
  const rangoHasta = parsed && parsed.maxTs!=null ? new Date(parsed.maxTs) : null;

  /* ---- Dashboard nuevo — con filtros ---- */
  const scopeRecords = useMemo(() => {
    if(!parsed) return [];
    return parsed.records.filter(r => r.valid && passesFilters(r, FILTERS, empresaIncluded, true));
  }, [parsed, FILTERS, empresaIncluded]);
  // Comité de ausentismo: mismos filtros (gerencia, departamento, sector, empresa) pero SIN el de Mes, porque analiza varios meses seguidos
  const comiteRecords = useMemo(() => {
    if(!parsed) return [];
    return parsed.records.filter(r => r.valid && passesFilters(r, FILTERS, empresaIncluded, false));
  }, [parsed, FILTERS, empresaIncluded]);
  const scopeEmpleados = useMemo(() => new Set(scopeRecords.map(r=>r.legajo.toUpperCase())).size, [scopeRecords]);
  const scopeUnitsMap = useMemo(() => buildUnitsMap(scopeRecords), [scopeRecords]);
  const scopeMotivoUniverse = useMemo(() => {
    if(!parsed || !parsed.hasMotivo) return [];
    const counts = new Map();
    scopeRecords.forEach(r => {
      if(!isCountedCat(r.cat)) return;
      const k = motivoKeyOf(r);
      counts.set(k, (counts.get(k)||0)+1);
    });
    return parsed.motivoUniverse.map(m => ({...m, count: counts.get(m.key)||0}));
  }, [parsed, scopeRecords]);

  /* ---- Plantel (dotación por días activos) ---- */
  const scopeMonthKeys = useMemo(() => {
    if(FILTERS.mes) return Array.from(FILTERS.mes);
    return parsed ? parsed.monthKeys : [];
  }, [FILTERS.mes, parsed]);
  const scopeMonthLabel = useMemo(() => {
    if(!scopeMonthKeys.length) return "—";
    if(scopeMonthKeys.length===1) return monthLabel(scopeMonthKeys[0]);
    return scopeMonthKeys.length + " meses (" + scopeMonthKeys.map(monthLabel).join(", ") + ")";
  }, [scopeMonthKeys]);
  const scopePlantel = useMemo(() => plantel.filter(p => passesPlantelFilters(p, FILTERS, empresaIncluded)), [plantel, FILTERS, empresaIncluded]);
  const cutoffTs = parsed ? parsed.maxTs : null; // último día con datos: el mes en curso cuenta solo hasta ahí
  const globalPlantelStats = useMemo(() => {
    if(!plantelActive) return null;
    return plantelScopeStats(scopePlantel, scopeMonthKeys, cutoffTs);
  }, [plantelActive, scopePlantel, scopeMonthKeys, cutoffTs]);

  const rankingUnits = useMemo(() => {
    const base = Array.from(scopeUnitsMap.entries()).map(([name,rows])=>({name, ...unitStats(rows, excludedMotivos)}));
    if(plantelActive){
      base.forEach(u=>{
        const employees = scopePlantel.filter(p => (p.unidad||"(Sin unidad)")===u.name);
        const st = plantelScopeStats(employees, scopeMonthKeys, cutoffTs);
        u.jornalesDotacion = st.jornalesDotacion;
        u.dotacionEquivalente = st.dotacionEquivalente;
        u.empleadosConsiderados = st.empleadosConsiderados;
        u.pct = st.jornalesDotacion>0 ? u.ausencias/st.jornalesDotacion*100 : 0;
      });
    }
    return base.sort((a,b)=> unitOrderIndex(a.name)-unitOrderIndex(b.name) || b.pct-a.pct);
  }, [scopeUnitsMap, excludedMotivos, plantelActive, scopePlantel, scopeMonthKeys, cutoffTs]);
  const compositionData = useMemo(() => rankingUnits.map(u=>({name:u.name, ausC:u.ausencias, ausX:u.excluded})), [rankingUnits]);
  const apAnpData = useMemo(() => rankingUnits.map(u=>({name:u.name, ap:u.apContado, anp:u.anpContado})), [rankingUnits]);
  const motivoEntries = useMemo(() => {
    if(!parsed || !parsed.hasMotivo) return [];
    const map = new Map();
    scopeRecords.forEach(r => {
      if(!isCountedCat(r.cat)) return;
      if(excludedMotivos.has(motivoKeyOf(r))) return;
      const label = motivoLabelOf(r);
      map.set(label, (map.get(label)||0)+1);
    });
    const entries = Array.from(map.entries()).map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count);
    if(entries.length<=15) return entries;
    const top = entries.slice(0,14);
    const restCount = entries.slice(14).reduce((a,e)=>a+e.count,0);
    top.push({label:"Otros motivos", count:restCount});
    return top;
  }, [scopeRecords, parsed, excludedMotivos]);

  const evoRecords = useMemo(() => {
    if(!parsed) return [];
    return parsed.records.filter(r => r.valid && passesFilters(r, FILTERS, empresaIncluded, false));
  }, [parsed, FILTERS, empresaIncluded]);
  const evoMonths = useMemo(() => {
    const s = new Set(); evoRecords.forEach(r=>s.add(r.monthKey)); return Array.from(s).sort();
  }, [evoRecords]);
  const evoUnitsMap = useMemo(() => buildUnitsMap(evoRecords), [evoRecords]);
  const evoSeries = useMemo(() => {
    return Array.from(evoUnitsMap.entries()).map(([name,rows],i)=>{
      const byMonth = new Map();
      rows.forEach(r=>{ if(!byMonth.has(r.monthKey)) byMonth.set(r.monthKey, []); byMonth.get(r.monthKey).push(r); });
      const employees = plantelActive ? scopePlantel.filter(p => (p.unidad||"(Sin unidad)")===name) : null;
      const pts = evoMonths.map(mk => {
        const st = unitStats(byMonth.get(mk)||[], excludedMotivos);
        if(!plantelActive) return st.pct;
        const pStats = plantelScopeStats(employees, [mk], cutoffTs);
        return pStats.jornalesDotacion>0 ? st.ausencias/pStats.jornalesDotacion*100 : 0;
      });
      return {name, color: SERIES_COLOR[i % SERIES_COLOR.length], pts};
    });
  }, [evoUnitsMap, evoMonths, excludedMotivos, plantelActive, scopePlantel, cutoffTs]);

  const scopeAgg = useMemo(() => {
    const totals = {presentes:0, ausencias:0, excluded:0, vac:0, franco:0, ap:0, anp:0, apContado:0, anpContado:0, baja:0, ce:0};
    rankingUnits.forEach(u=>{
      totals.presentes+=u.presentes; totals.ausencias+=u.ausencias; totals.excluded+=u.excluded;
      totals.vac+=u.vac; totals.franco+=u.franco; totals.ap+=u.ap; totals.anp+=u.anp;
      totals.apContado+=u.apContado; totals.anpContado+=u.anpContado; totals.baja+=u.baja; totals.ce+=u.ce;
    });
    const total = scopeRecords.length;
    const base = total - totals.excluded;
    let pct = base>0 ? totals.ausencias/base*100 : 0;
    if(plantelActive && globalPlantelStats && globalPlantelStats.jornalesDotacion>0){
      pct = totals.ausencias/globalPlantelStats.jornalesDotacion*100;
    }
    return {...totals, total, base, pct};
  }, [rankingUnits, scopeRecords, plantelActive, globalPlantelStats]);
  const plantelConsistencia = useMemo(() => {
    if(!plantelActive || !globalPlantelStats) return null;
    return {...globalPlantelStats, ap:scopeAgg.apContado, anp:scopeAgg.anpContado, pct:scopeAgg.pct};
  }, [plantelActive, globalPlantelStats, scopeAgg]);
  const unidadesFuera = rankingUnits.filter(u=>u.pct>objetivo).length;

  /* ---- Fila adicional: solo filtro Cuatrimestre, independiente del resto de filtros ---- */
  const cuatriMonths = useMemo(() => (CUATRI_OPTIONS.find(c=>c.value===cuatriSel)||CUATRI_OPTIONS[0]).months, [cuatriSel]);
  const cuatriRecords = useMemo(() => {
    if(!parsed) return [];
    const monthsSet = new Set(cuatriMonths);
    return parsed.records.filter(r => r.valid && monthsSet.has(r.mes));
  }, [parsed, cuatriMonths]);
  const cuatriEmpleados = useMemo(() => new Set(cuatriRecords.map(r=>r.legajo.toUpperCase())).size, [cuatriRecords]);
  const cuatriUnitsMap = useMemo(() => buildUnitsMap(cuatriRecords), [cuatriRecords]);
  const cuatriMonthKeys = useMemo(() => {
    if(!parsed) return [];
    const monthsSet = new Set(cuatriMonths);
    return parsed.monthKeys.filter(mk => monthsSet.has(+mk.split("-")[1]));
  }, [parsed, cuatriMonths]);
  const cuatriPlantelStats = useMemo(() => {
    if(!plantelActive) return null;
    return plantelScopeStats(plantel, cuatriMonthKeys, cutoffTs);
  }, [plantelActive, plantel, cuatriMonthKeys, cutoffTs]);
  const cuatriRankingUnits = useMemo(() => {
    const base = Array.from(cuatriUnitsMap.entries()).map(([name,rows])=>({name, ...unitStats(rows, excludedMotivos)}));
    if(plantelActive){
      base.forEach(u=>{
        const employees = plantel.filter(p => (p.unidad||"(Sin unidad)")===u.name);
        const st = plantelScopeStats(employees, cuatriMonthKeys, cutoffTs);
        u.jornalesDotacion = st.jornalesDotacion;
        u.dotacionEquivalente = st.dotacionEquivalente;
        u.pct = st.jornalesDotacion>0 ? u.ausencias/st.jornalesDotacion*100 : 0;
      });
    }
    return base.sort((a,b)=> unitOrderIndex(a.name)-unitOrderIndex(b.name) || b.pct-a.pct);
  }, [cuatriUnitsMap, excludedMotivos, plantelActive, plantel, cuatriMonthKeys, cutoffTs]);
  const cuatriScopeAgg = useMemo(() => {
    const totals = {presentes:0, ausencias:0, excluded:0, vac:0, franco:0, ap:0, anp:0, apContado:0, anpContado:0, baja:0, ce:0};
    cuatriRankingUnits.forEach(u=>{
      totals.presentes+=u.presentes; totals.ausencias+=u.ausencias; totals.excluded+=u.excluded;
      totals.vac+=u.vac; totals.franco+=u.franco; totals.ap+=u.ap; totals.anp+=u.anp;
      totals.apContado+=u.apContado; totals.anpContado+=u.anpContado; totals.baja+=u.baja; totals.ce+=u.ce;
    });
    const total = cuatriRecords.length;
    const base = total - totals.excluded;
    let pct = base>0 ? totals.ausencias/base*100 : 0;
    if(plantelActive && cuatriPlantelStats && cuatriPlantelStats.jornalesDotacion>0){
      pct = totals.ausencias/cuatriPlantelStats.jornalesDotacion*100;
    }
    return {...totals, total, base, pct};
  }, [cuatriRankingUnits, cuatriRecords, plantelActive, cuatriPlantelStats]);
  const cuatriDotacionDisplay = plantelActive && cuatriPlantelStats ? Math.round(cuatriPlantelStats.dotacionEquivalente) : cuatriEmpleados;
  const cuatriUnidadesFuera = cuatriRankingUnits.filter(u=>u.pct>objetivo).length;

  const mesOptions = useMemo(() => parsed ? parsed.monthKeys.map(mk=>({value:mk,label:monthLabel(mk)})) : [], [parsed]);
  const deptOptions = useMemo(() => parsed ? parsed.departamentos.map(v=>({value:v,label:v})) : [], [parsed]);
  const gerOptions = useMemo(() => parsed ? parsed.gerencias.map(v=>({value:v,label:v})) : [], [parsed]);
  const secOptions = useMemo(() => parsed ? parsed.sectores.map(v=>({value:v,label:v})) : [], [parsed]);

  const TABS = [
    {key:"resumen", label:"Resumen", color:"#2f80ed"},
    {key:"resumen_gerencia", label:"Resumen por Gerencia", color:"#12a594"},
    {key:"cuadro_diario", label:"Cuadro Diario", color:"#f2771a"},
    {key:"evolucion", label:"Evolución mensual", color:"#2fa84f"},
    {key:"tipos", label:"Tipos de ausencia", color:"#8e63e6"},
    {key:"cronicos", label:"Crónicos", color:"#e5484d"},
    {key:"medicina_laboral", label:"Medicina Laboral", color:"#b4724a"},
    {key:"ranking", label:"Ranking", color:"#e5a000"},
    {key:"detalle_empleados", label:"Detalle Empleados", color:"#0ea5c6"},
    {key:"plantel", label:"Gestión de Plantel", color:"#d6409f"},
    {key:"usuarios", label:"Usuarios y permisos", color:"#7b8794"}
  ];
  const dotacionDisplay = plantelActive && globalPlantelStats ? Math.round(globalPlantelStats.dotacionEquivalente) : scopeEmpleados;

  return (
    <div className="app">
      <div className="masthead no-print">
        <div className="masthead-text">
          <div className="eyebrow">Indicador de Ausentismo / Presentismo</div>
          <h1>Radar de ausentismo por unidad de negocio</h1>
          <p className="sub">Lee el export tal como sale del sistema (hoja Sheet1) y usa "Agrupador cuadro presentismo" + "Entrada" (DD/MM/AAAA) como única fuente de verdad para todo el cálculo.</p>
          {parsed && perms.tabs.includes("plantel") && (
            <p className="hint" style={{marginTop:2}}>
              {plantelActive
                ? <React.Fragment>Plantel: actualizado {plantelUpdatedAt ? plantelUpdatedAt.toLocaleString("es-AR") : ""} · {fmt(plantel.length)} legajos — dotación calculada por días activos.</React.Fragment>
                : <React.Fragment>Sin plantel cargado — dotación calculada contando filas del Excel.</React.Fragment>}
              {" "}<button type="button" className="cell-link" onClick={()=>setActiveTab("plantel")}>{perms.plantelCompleto ? "Gestionar plantel" : "Actualizar plantel"}</button>
            </p>
          )}
        </div>
        <div className="hint" style={{display:"flex", alignItems:"center", gap:8}}>
          {perms.plantelCompleto && dbUsage && dbPct>=DB_WARN_PCT && (
            <button type="button" className={"schip "+dbUsageLevel(dbPct)} style={{border:"none", cursor:"pointer", fontSize:11}}
              title={"La base de datos usa "+fmt(dbUsage.db_bytes/MB)+" de "+fmt(DB_LIMIT_MB)+" MB. Tocá para ver el detalle."}
              onClick={()=>setActiveTab("plantel")}>
              <span className="dot"></span>Base de datos {fmt(dbPct)} %
            </button>
          )}
          <span title={perms.desc}>{userEmail} · <b>{perms.label}</b></span>
          <InstallButton />
          <ChangePasswordButton userEmail={userEmail} />
          <button type="button" className="btn secondary" onClick={onSignOut}>Cerrar sesion</button>
        </div>
        {parsed && perms.objetivo && (
          <div className="objetivo-box">
            <label htmlFor="objetivoInput">Objetivo</label>
            <input id="objetivoInput" type="number" step="0.1" min="0" value={objetivo} onChange={e=>{ const v=parseFloat(e.target.value); setObjetivo(isNaN(v)?3:v); }} />
            <span className="pct">%</span>
          </div>
        )}
      </div>

      {permisosSinActivar && <div className="warn-banner no-print">Los permisos por perfil todavía no están activados: ejecutá <b>supabase-permisos-roles.sql</b> en el SQL Editor de Supabase. Mientras tanto todos los usuarios tienen acceso total.</div>}
      {cloudError && <div className="warn-banner no-print">{cloudError}</div>}
      {uploadNotice &&<div className="warn-banner no-print">{uploadNotice}</div>}
      {syncStatus && (
        <div className="chip ok no-print" style={{alignSelf:"flex-start"}}>
          <span className="dot"></span>{syncStatus.label}… {fmt(syncStatus.done)}/{fmt(syncStatus.total)}
        </div>
      )}

      {/* Primer ingreso en este dispositivo: todavía no hay datos guardados acá y se están bajando del servidor. Hasta que termine NO se
          ofrece subir el archivo (eso lo hace solo el administrador); se explica que en breve se podrá ver la información. */}
      {!parsed && !error && (cloudLoading || serverState==="pending") && (
        <div className="upload-card" style={{flexDirection:"column", alignItems:"flex-start", gap:8}}>
          <div style={{fontWeight:700, fontSize:15}}>Es su primer ingreso desde este dispositivo</div>
          <div className="hint" style={{fontSize:13}}>Se están descargando los datos del servidor. <b>En breve va a poder visualizar la información</b>: no hace falta que haga nada ni que cargue ningún archivo. Esto pasa solo la primera vez; las próximas veces se abre al instante.</div>
          <div className="chip ok"><span className="dot"></span>{dlRows>0 ? "Registros descargados: "+fmt(dlRows) : "Conectando con el servidor…"}</div>
        </div>
      )}
      {!parsed && !error && !cloudLoading && serverState==="error" && (
        <div className="upload-card" style={{flexDirection:"column", alignItems:"flex-start", gap:8}}>
          <div style={{fontWeight:700, fontSize:15}}>Todavía no se pudieron descargar los datos</div>
          <div className="hint" style={{fontSize:13}}>Seguramente sea la conexión. Se reintenta automáticamente{retryInfo>0 && retryInfo<=4 ? " (reintento "+retryInfo+" de 4)" : ""}; en cuanto llegue la información se va a mostrar sola. No hace falta cargar ningún archivo.</div>
          <button type="button" className="btn secondary" onClick={()=>{ if(loadRef.current) loadRef.current(); }}>Reintentar ahora</button>
        </div>
      )}
      {!cloudLoading && serverState==="ok" && !parsed && !error && !perms.cargar && (
        <div className="upload-card"><div className="hint">Todavía no hay datos cargados en el servidor. Cuando RRHH o el Administrador los carguen vas a poder verlos acá.</div></div>
      )}
      {!cloudLoading && serverState==="ok" && !parsed && !error && perms.cargar && (
        <div className="upload-card">
          <div className="upload-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2Z"/></svg>
          </div>
          <div>
            <div style={{fontWeight:700, fontSize:15}}>Subir archivo .xlsx</div>
            <div className="hint" style={{marginTop:4}}>Exportación de asistencia, hoja "Sheet1" — se guarda en el servidor, no hace falta volver a subirlo la próxima vez.</div>
          </div>
          <label className="btn" htmlFor="fileInput">{loading ? "Leyendo…" : "Elegir archivo"}</label>
          <input id="fileInput" type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={onInputChange} />
        </div>
      )}

      {error && (
        <React.Fragment>
          <div className="error-card">
            <h2>No se pudo procesar el archivo</h2>
            <p>{error}</p>
          </div>
          {perms.cargar && (
            <div>
              <label className="btn secondary" htmlFor="fileInputRetry">Elegir otro archivo</label>
              <input id="fileInputRetry" type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={onInputChange} />
            </div>
          )}
        </React.Fragment>
      )}

      {parsed && (
        <React.Fragment>
          <div className="card filebar no-print">
            <div className="name">{parsed.fileName}</div>
            <div className="meta">{fmt(parsed.totalRows)} filas leídas</div>
            <div className="meta">Entrada: {rangoDesde ? fmtDate(rangoDesde.getUTCDate(), rangoDesde.getUTCMonth()+1, rangoDesde.getUTCFullYear()) : "—"} – {rangoHasta ? fmtDate(rangoHasta.getUTCDate(), rangoHasta.getUTCMonth()+1, rangoHasta.getUTCFullYear()) : "—"}</div>
            <div className="spacer"></div>
            {perms.cargar && (
              <React.Fragment>
                <label className="btn secondary" htmlFor="fileInputUpdate">{loading ? "Leyendo…" : "Actualizar archivo"}</label>
                <input id="fileInputUpdate" type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={onUpdateInputChange} />
              </React.Fragment>
            )}
            {perms.reemplazar && (
              <React.Fragment>
                <label className="btn secondary" htmlFor="fileInputSwap">{loading ? "Leyendo…" : "Cambiar archivo"}</label>
                <input id="fileInputSwap" type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={onInputChange} />
              </React.Fragment>
            )}
          </div>

          {perms.cargar && ausUpdatePreview && (
            <div className="card table-card no-print">
              <h3>Resumen de la actualización — {ausUpdatePreview.fileName}</h3>
              <p className="hint">Se fusiona con el archivo actual por Legajo + Fecha de Entrada. Nada de lo ya cargado se borra: las filas nuevas se agregan y las que ya existían con esa combinación se actualizan si cambiaron.</p>
              <div className="kpi-grid">
                <KpiTile label="Filas encontradas" value={ausUpdatePreview.encontrados} />
                <KpiTile label="Filas nuevas" value={ausUpdatePreview.nuevos} />
                <KpiTile label="Filas modificadas" value={ausUpdatePreview.modificados} />
                <KpiTile label="Sin cambios" value={ausUpdatePreview.sinCambios} />
              </div>
              <p className="hint">Total de filas después de actualizar: <b>{fmt(ausUpdatePreview.nextParsed.totalRows)}</b> (antes: {fmt(parsed.totalRows)}).</p>
              <div style={{display:"flex", gap:10, marginTop:6}}>
                <button className="btn" onClick={confirmAusUpdate}>Confirmar actualización</button>
                <button className="btn secondary" onClick={cancelAusUpdate}>Cancelar</button>
              </div>
            </div>
          )}

          {perms.filtros && (
            <React.Fragment>
              <div className="filters-bar no-print">
                <MultiSelect label="Mes" options={mesOptions} selected={FILTERS.mes} onChange={v=>setFilterDim("mes",v)} allLabel="Todos los meses" />
                <MultiSelect label="Gerencia" options={gerOptions} selected={FILTERS.gerencia} onChange={v=>setFilterDim("gerencia",v)} allLabel="Todos" />
                <MultiSelect label="Departamento" options={deptOptions} selected={FILTERS.departamento} onChange={v=>setFilterDim("departamento",v)} allLabel="Todos" />
                <MultiSelect label="Sector" options={secOptions} selected={FILTERS.sector} onChange={v=>setFilterDim("sector",v)} allLabel="Todos" />
              </div>

              {!perms.soloPropios && (
                <div className="no-print">
                  <EmpresaChecklist options={parsed.empresas} included={empresaIncluded} onChange={setEmpresaIncluded} />
                </div>
              )}
            </React.Fragment>
          )}

          {verResumen && (
            <React.Fragment>
              <KpiGroups plantelActive={plantelActive} dotacion={dotacionDisplay} plantelStats={globalPlantelStats} agg={scopeAgg} />
              <p className="kgroup-caption no-print">
                Objetivo <b>{fmtPct(objetivo,1)}</b> · {plantelActive ? "Dotación equivalente (plantel) en el alcance actual" : "Empleados únicos en el alcance actual"}: <b>{fmt(dotacionDisplay)}</b> · <b>{unidadesFuera} / {rankingUnits.length}</b> unidades fuera de objetivo
                {" "}<SemChip pct={scopeAgg.pct} objetivo={objetivo} />
                {" "}· {plantelActive ? "Desvío = (AP+ANP) / Jornales de dotación del plantel (ver Gestión de Plantel)" : "Excluye CE + BAJA y los motivos sin tildar (ver Resumen) del denominador"}
              </p>

              {perms.filtros && (
                <React.Fragment>
                  <div className="filters-bar no-print">
                    <div className="field">
                      <label>Cuatrimestre</label>
                      <select value={cuatriSel} onChange={e=>setCuatriSel(e.target.value)}>
                        {CUATRI_OPTIONS.map(c=>(<option key={c.value} value={c.value}>{c.label}</option>))}
                      </select>
                    </div>
                  </div>
                  <p className="hint no-print" style={{marginTop:-8}}>Esta fila de tarjetas depende únicamente del filtro de Cuatrimestre — no se ve afectada por Mes, Departamento, Gerencia, Sector ni Empresa. El período en curso se calcula sobre los días transcurridos (hasta el último día cargado), no sobre el cuatrimestre completo.</p>
                </React.Fragment>
              )}
              <KpiGroups plantelActive={plantelActive} dotacion={cuatriDotacionDisplay} plantelStats={cuatriPlantelStats} agg={cuatriScopeAgg} />
              <p className="kgroup-caption no-print">
                Cuatrimestre: <b>{(CUATRI_OPTIONS.find(c=>c.value===cuatriSel)||CUATRI_OPTIONS[0]).label}</b> · {plantelActive ? "Dotación equivalente (plantel)" : "Empleados únicos"}: <b>{fmt(cuatriDotacionDisplay)}</b> · <b>{cuatriUnidadesFuera} / {cuatriRankingUnits.length}</b> unidades fuera de objetivo
                {" "}<SemChip pct={cuatriScopeAgg.pct} objetivo={objetivo} />
              </p>
            </React.Fragment>
          )}

          <nav className="tabs no-print" ref={tabsRef}>
            {TABS.filter(t=>perms.tabs.includes(t.key)).map(t=>(
              <button key={t.key} className={shownTab===t.key?"active":""} style={{"--tab-color":t.color}} onClick={()=>setActiveTab(t.key)}><span className="tdot"></span>{t.label}</button>
            ))}
          </nav>

          {shownTab==="resumen" && <ResumenTab rankingUnits={rankingUnits} objetivo={objetivo} scopeUnitsMap={scopeUnitsMap} excludedMotivos={excludedMotivos} setExcludedMotivos={setExcludedMotivos} motivoUniverse={scopeMotivoUniverse} scopeEmpleados={scopeEmpleados} scopeAgg={scopeAgg} plantelActive={plantelActive} scopePlantel={scopePlantel} scopeMonthKeys={scopeMonthKeys} dotacionTotal={dotacionDisplay} jornalesTotal={plantelActive && globalPlantelStats ? globalPlantelStats.jornalesDotacion : 0} cutoffTs={cutoffTs} verFiltros={perms.filtros} />}
          {shownTab==="resumen_gerencia" && <ResumenGerenciaTab parsed={parsed} plantel={plantel} objetivo={objetivo} mesFilter={FILTERS.mes} empresaIncluded={empresaIncluded} excludedMotivos={excludedMotivos} setExcludedMotivos={setExcludedMotivos} scopeMonthKeys={scopeMonthKeys} verFiltros={perms.filtros} />}
          {shownTab==="cuadro_diario" && <CuadroDiarioTab parsed={parsed} />}
          {shownTab==="evolucion" && <EvolucionTab evoMonths={evoMonths} evoSeries={evoSeries} objetivo={objetivo} />}
          {shownTab==="tipos" && <TiposTab compositionData={compositionData} apAnpData={apAnpData} motivoEntries={motivoEntries} hasMotivo={parsed.hasMotivo} soloApAnpYMotivo={!perms.filtros} />}
          {shownTab==="ranking" && <RankingTab scopeUnitsMap={scopeUnitsMap} hasUnidad={parsed.hasUnidad} idMotivoUniverse={parsed.idMotivoUniverse} presidenciaUniverse={parsed.presidenciaUniverse} presidenciaCats={parsed.presidenciaCats||{}} idIncluded={rankingIdIncluded} setIdIncluded={setRankingIdIncluded} presIncluded={rankingPresIncluded} setPresIncluded={setRankingPresIncluded} plantel={plantel} ocultarFiltrosMotivo={!!perms.motivosPorDefecto} comiteRecords={comiteRecords} monthKeys={parsed.monthKeys} excludedMotivos={excludedMotivos} />}
          {shownTab==="detalle_empleados" && <DetalleEmpleadosTab parsed={parsedVista} plantel={plantel} motivosPorDefecto={!!perms.motivosPorDefecto} />}
          {shownTab==="plantel" && <PlantelTab plantel={plantel} setPlantel={setPlantel} plantelHistorial={plantelHistorial} setPlantelHistorial={setPlantelHistorial} plantelUpdatedAt={plantelUpdatedAt} setPlantelUpdatedAt={setPlantelUpdatedAt} plantelActive={plantelActive} globalPlantelStats={plantelConsistencia} scopeMonthKeys={scopeMonthKeys} diasPeriodoLabel={scopeMonthLabel} dbUsage={dbUsage} dbUsageError={dbUsageError} dbChecking={dbChecking} onCheckDb={checkDb} dbRowsPerMonth={dbRowsPerMonth} dataStartTs={parsed ? parsed.minTs : null} soloCarga={!perms.plantelCompleto} />}
          {shownTab==="cronicos" && <CronicosTab parsed={parsedVista} plantel={plantel} idMotivoUniverse={parsed.idMotivoUniverse} puedeEditar={perms.cronicosEditar} puedeCitar={!!perms.citar} motivosFijos={perms.motivosPorDefecto ? CRONICOS_DEFAULT_MOTIVOS : null} />}
          {shownTab==="medicina_laboral" && <MedicinaLaboralTab parsed={parsedVista} plantel={plantel} puedeEditar={!!perms.medicinaEditar} />}
          {shownTab==="usuarios" && <UsuariosTab userId={userId} />}
        </React.Fragment>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<AuthGate />);

if("serviceWorker" in navigator && (location.protocol==="https:" || location.hostname==="localhost")){
  const registerSW = ()=>{ navigator.serviceWorker.register("sw.js").catch(()=>{}); };
  if(document.readyState==="complete") registerSW(); else window.addEventListener("load", registerSW);
}
