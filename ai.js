(function(){
  const URL_KEY="bodygym_ai_url";
  const LAST_PANTRY_KEY="bodygym_ai_last_pantry";
  const LAST_COACH_KEY="bodygym_ai_last_coach";

  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
  function baseUrl(){
    let saved="";try{saved=localStorage.getItem(URL_KEY)||""}catch(e){}
    return String(saved||window.BODYGYM_AI_URL||"").trim().replace(/\/$/,"");
  }
  function setBaseUrl(v){try{localStorage.setItem(URL_KEY,v)}catch(e){};ensureAll()}
  window.configureBodyGymAI=function(){
    const current=baseUrl();
    const v=prompt("Pega la URL pública del servidor IA de Railway (por ejemplo https://xxxxx.up.railway.app)",current);
    if(v===null)return false;
    const clean=v.trim().replace(/\/$/,"");
    if(clean&&!/^https:\/\//i.test(clean)){alert("La URL debe empezar por https://");return false}
    setBaseUrl(clean);return Boolean(clean);
  };

  async function api(path,payload){
    let base=baseUrl();
    if(!base){if(!window.configureBodyGymAI())throw new Error("Servidor IA sin configurar");base=baseUrl()}
    const r=await fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    let data={};try{data=await r.json()}catch(e){}
    if(!r.ok)throw new Error(data.error||`Error IA ${r.status}`);
    return data;
  }

  function appState(){
    try{if(typeof state!=="undefined")return state}catch(e){}
    try{return JSON.parse(localStorage.getItem("bodygym_pt_data_v2")||"{}")}catch(e){return{}}
  }
  function configuredHtml(){
    const u=baseUrl();
    return u?`<div class="ai-server ok">● IA conectada <button class="ai-link" onclick="configureBodyGymAI()">Cambiar</button></div>`:`<div class="ai-server pending">IA pendiente de conectar · <button class="ai-link" onclick="configureBodyGymAI()">Configurar</button></div>`;
  }

  function readLast(key){try{return JSON.parse(localStorage.getItem(key)||"null")}catch(e){return null}}
  function writeLast(key,data){try{localStorage.setItem(key,JSON.stringify(data))}catch(e){}}

  function pantryResultHtml(data){
    if(!data)return"";
    const foods=(data.foods||[]).map(x=>`<li><b>${esc(x.name)}</b>${x.quantity?` · ${esc(x.quantity)}`:""} <span class="ai-confidence">${Math.round((x.confidence||0)*100)}%</span></li>`).join("");
    const unknown=(data.unknown_items||[]).map(x=>`<li>${esc(x)}</li>`).join("");
    const ideas=(data.meal_ideas||[]).map(x=>`<div class="ai-meal"><b>${esc(x.title)}</b><div>${(x.ingredients||[]).map(esc).join(" · ")}</div><small>${esc(x.reason)}</small></div>`).join("");
    return `<div class="ai-result"><h4>Detectado</h4>${foods?`<ul>${foods}</ul>`:"<p>No he identificado alimentos del catálogo con suficiente seguridad.</p>"}${unknown?`<details><summary>Otros objetos/alimentos</summary><ul>${unknown}</ul></details>`:""}${ideas?`<h4>Ideas con lo que veo</h4>${ideas}`:""}${data.note?`<p class="muted">${esc(data.note)}</p>`:""}</div>`;
  }

  async function resize(file){
    return new Promise((resolve,reject)=>{
      const fr=new FileReader();fr.onerror=reject;fr.onload=()=>{
        const im=new Image();im.onerror=reject;im.onload=()=>{
          const max=1500,scale=Math.min(1,max/Math.max(im.width,im.height));
          const cv=document.createElement("canvas");cv.width=Math.round(im.width*scale);cv.height=Math.round(im.height*scale);
          cv.getContext("2d").drawImage(im,0,0,cv.width,cv.height);resolve(cv.toDataURL("image/jpeg",.78));
        };im.src=fr.result;
      };fr.readAsDataURL(file);
    });
  }

  window.pickAiPantryPhoto=function(){const e=document.getElementById("aiPantryPhoto");if(e)e.click()};
  window.analyzeAiPantryPhoto=async function(input){
    const file=input.files&&input.files[0];if(!file)return;
    const status=document.getElementById("aiPantryStatus");if(status)status.textContent="Analizando foto…";
    try{
      const image=await resize(file),s=appState(),current=Object.entries(s.pantry||{}).filter(([,v])=>v).map(([k])=>k);
      const data=await api("/api/analyze-pantry",{image,currentPantry:current});
      (data.foods||[]).forEach(x=>{if((x.confidence||0)>=.5&&s.pantry)s.pantry[x.id]=true});
      try{if(typeof save==="function")save();else localStorage.setItem("bodygym_pt_data_v2",JSON.stringify(s))}catch(e){}
      writeLast(LAST_PANTRY_KEY,data);
      try{if(typeof renderDiet==="function")renderDiet()}catch(e){}
      setTimeout(ensureAll,30);
    }catch(e){if(status)status.textContent=e.message||"No se pudo analizar la foto.";else alert(e.message)}finally{input.value=""}
  };

  function ensurePantry(){
    const host=document.querySelector("#dietView .ai-card");if(!host||host.dataset.liveAi==="1")return;
    host.dataset.liveAi="1";
    host.innerHTML=`<h3>📷 Despensa con IA</h3><p>Haz una foto de la nevera, la compra o varios alimentos. La IA intentará reconocerlos, marcará los que conozca en tu despensa y propondrá ideas de comida.</p>${configuredHtml()}<button class="primary full ai-main" onclick="pickAiPantryPhoto()">📷 Foto o galería · Analizar con IA</button><input id="aiPantryPhoto" hidden type="file" accept="image/*" onchange="analyzeAiPantryPhoto(this)"><div id="aiPantryStatus" class="muted">La foto se envía al servidor IA para analizarla; no se guarda en este repositorio.</div>${pantryResultHtml(readLast(LAST_PANTRY_KEY))}`;
  }

  function coachResultHtml(d){
    if(!d)return"";
    const list=(title,a)=>a&&a.length?`<h4>${title}</h4><ul>${a.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`:"";
    return `<div class="ai-result coach ${esc(d.status)}"><div class="ai-status">${d.status==="bien"?"✅ BIEN":d.status==="vigilar"?"👀 VIGILAR":"⚠️ REVISAR"}</div><p><b>${esc(d.summary)}</b></p>${list("Entrenamiento",d.training)}${list("Nutrición / tendencia",d.nutrition)}${list("A vigilar",d.watchouts)}${d.next_review?`<p><b>Próxima revisión:</b> ${esc(d.next_review)}</p>`:""}</div>`;
  }

  window.runAiCoachReview=async function(){
    const status=document.getElementById("aiCoachStatus");if(status)status.textContent="Revisando tus datos…";
    try{
      const s=appState(),logs=[...(s.logs||[])].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).slice(-60),measures=[...(s.measures||[])].sort((a,b)=>a.date.localeCompare(b.date)).slice(-20);
      const data=await api("/api/coach-review",{logs,measures});writeLast(LAST_COACH_KEY,data);
      const out=document.getElementById("aiCoachResult");if(out)out.innerHTML=coachResultHtml(data);if(status)status.textContent="Revisión terminada.";
    }catch(e){if(status)status.textContent=e.message||"No se pudo hacer la revisión."}
  };

  function ensureCoach(){
    const section=document.getElementById("progreso");if(!section||document.getElementById("aiCoachPanel"))return;
    const panel=document.createElement("div");panel.id="aiCoachPanel";panel.className="panel ai-coach-panel";
    panel.innerHTML=`<h2>Revisión IA</h2><p>Analiza tus últimas sesiones, RIR/dolor y la tendencia de peso/cintura. <b>No cambia nada por sí sola.</b></p>${configuredHtml()}<button class="primary full ai-main" onclick="runAiCoachReview()">Analizar mi progreso con IA</button><div id="aiCoachStatus" class="muted">Úsala cuando ya tengas varias sesiones registradas.</div><div id="aiCoachResult">${coachResultHtml(readLast(LAST_COACH_KEY))}</div>`;
    const before=document.getElementById("measureList");section.insertBefore(panel,before||section.firstChild);
  }

  function ensureAll(){ensurePantry();ensureCoach()}
  const style=document.createElement("style");style.textContent=`
    .ai-server{margin:12px 0;padding:10px 12px;border-radius:12px;font-weight:750}.ai-server.ok{background:#edf9f2;color:#146c43}.ai-server.pending{background:#fff7e6;color:#7a5200}.ai-link{border:0;background:transparent;color:inherit;text-decoration:underline;min-height:auto!important;padding:2px 5px!important;font-size:.9em!important}.ai-main{margin:12px 0}.ai-result{margin-top:14px;border:2px solid #dce4ec;border-radius:16px;padding:16px;background:#fff}.ai-result h4{margin:12px 0 6px}.ai-confidence{font-size:.8em;color:#667085}.ai-meal{margin:10px 0;padding:12px;border-radius:12px;background:#f4f7fa}.ai-meal small{display:block;margin-top:5px;color:#5c6670}.ai-status{display:inline-block;padding:8px 12px;border-radius:999px;font-weight:900;background:#17365D;color:#fff}.ai-result.coach.bien{border-color:#75b798}.ai-result.coach.vigilar{border-color:#f0c36b}.ai-result.coach.revisar{border-color:#e79aa2}html[data-font-size="xl"] .ai-result,html[data-font-size="xl"] .ai-server{font-size:.9em}
  `;document.head.appendChild(style);

  document.addEventListener("DOMContentLoaded",ensureAll);
  const obs=new MutationObserver(()=>ensureAll());
  setTimeout(()=>{const d=document.getElementById("dietView");if(d)obs.observe(d,{childList:true,subtree:true});ensureAll()},500);
})();
