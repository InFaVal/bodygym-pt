(function(){
  const FIXED_URL="https://bodygym-pt-ai.onrender.com";
  const URL_KEY="bodygym_ai_url";
  const LAST_PANTRY_KEY="bodygym_ai_last_pantry";
  let healthBusy=false;

  try{localStorage.setItem(URL_KEY,FIXED_URL)}catch(e){}

  function appState(){
    try{if(typeof state!=="undefined")return state}catch(e){}
    try{return JSON.parse(localStorage.getItem("bodygym_pt_data_v2")||"{}")}catch(e){return{}}
  }
  function persist(){
    try{if(typeof save==="function")save();else localStorage.setItem("bodygym_pt_data_v2",JSON.stringify(appState()))}catch(e){}
  }
  function storeLast(data){try{localStorage.setItem(LAST_PANTRY_KEY,JSON.stringify(data))}catch(e){}}
  function setStatus(text,kind="info"){
    const el=document.getElementById("aiPantryStatus");
    if(!el)return;
    el.textContent=text;
    el.dataset.kind=kind;
    el.style.fontWeight=kind==="error"||kind==="ok"?"800":"";
    el.style.color=kind==="error"?"#a61b29":kind==="ok"?"#146c43":"";
  }
  function setConnection(text,ok){
    document.querySelectorAll(".ai-server").forEach(el=>{
      const desired=(ok?"● ":"⚠ ")+text;
      if(el.dataset.realHealth===desired)return;
      el.dataset.realHealth=desired;
      el.classList.toggle("ok",ok);
      el.classList.toggle("pending",!ok);
      el.textContent=desired;
    });
  }
  async function checkHealth(){
    if(healthBusy)return;
    healthBusy=true;
    try{
      const ctrl=new AbortController();
      const timer=setTimeout(()=>ctrl.abort(),45000);
      const r=await fetch(FIXED_URL+"/health",{cache:"no-store",signal:ctrl.signal});
      clearTimeout(timer);
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      if(!d.aiConfigured)throw new Error("Gemini sin clave");
      setConnection(`IA operativa · ${d.model||"Gemini"}`,true);
    }catch(e){
      setConnection(`IA no responde · ${e.name==="AbortError"?"servidor dormido o lento":e.message}`,false);
    }finally{healthBusy=false}
  }

  async function resizePhoto(file){
    return new Promise((resolve,reject)=>{
      const fr=new FileReader();
      fr.onerror=()=>reject(new Error("No pude leer la foto"));
      fr.onload=()=>{
        const im=new Image();
        im.onerror=()=>reject(new Error("No pude abrir la foto"));
        im.onload=()=>{
          const max=1400,scale=Math.min(1,max/Math.max(im.width,im.height));
          const cv=document.createElement("canvas");
          cv.width=Math.max(1,Math.round(im.width*scale));
          cv.height=Math.max(1,Math.round(im.height*scale));
          const ctx=cv.getContext("2d");
          ctx.drawImage(im,0,0,cv.width,cv.height);
          resolve(cv.toDataURL("image/jpeg",.76));
        };
        im.src=fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  async function postJson(path,payload){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),120000);
    try{
      const r=await fetch(FIXED_URL+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:ctrl.signal});
      const text=await r.text();
      let data={};
      try{data=text?JSON.parse(text):{}}catch(e){throw new Error(`Respuesta inválida del servidor (${r.status})`)}
      if(!r.ok)throw new Error(data.error||`Error HTTP ${r.status}`);
      return data;
    }catch(e){
      if(e.name==="AbortError")throw new Error("La IA ha tardado demasiado. Render puede estar despertando; prueba otra vez.");
      if(/Failed to fetch|NetworkError/i.test(String(e.message)))throw new Error("No puedo comunicar con Render. Comprueba que el servicio esté activo.");
      throw e;
    }finally{clearTimeout(timer)}
  }

  function retryableJsonError(error){
    return /JSON generado no se pudo interpretar|respuesta inválida|malformed|JSON.*interpretar/i.test(String(error?.message||""));
  }
  async function analyzeWithRetry(payload){
    try{return await postJson("/api/analyze-pantry",payload)}
    catch(first){
      if(!retryableJsonError(first))throw first;
      setStatus("↻ Gemini respondió con formato irregular. Reintentando automáticamente…","info");
      await new Promise(r=>setTimeout(r,650));
      return postJson("/api/analyze-pantry",payload);
    }
  }

  window.analyzeAiPantryPhoto=async function(input){
    const file=input?.files?.[0];
    if(!file){setStatus("No se recibió ninguna foto.","error");return}
    const camera=document.getElementById("aiPantryCamera"),gallery=document.getElementById("aiPantryGallery");
    if(camera)camera.disabled=true;if(gallery)gallery.disabled=true;
    setStatus("📷 Foto recibida. Preparando imagen…","info");
    let wakeTimer=null;
    try{
      const image=await resizePhoto(file);
      const s=appState();
      if(!s.pantry)s.pantry={};
      if(!s.pantryCustom)s.pantryCustom={};
      const current=Object.entries(s.pantry).filter(([,v])=>v).map(([k])=>k)
        .concat(Object.entries(s.pantryCustom).filter(([,v])=>v).map(([k])=>k));
      setStatus("🤖 Analizando con Gemini…","info");
      wakeTimer=setTimeout(()=>setStatus("⏳ Render puede estar despertando. Sigo esperando a Gemini…","info"),5000);
      const data=await analyzeWithRetry({image,currentPantry:current});
      clearTimeout(wakeTimer);wakeTimer=null;
      let added=0;
      (data.foods||[]).forEach(x=>{
        if(Number(x.confidence||0)>=.5&&x.id){if(!s.pantry[x.id])added++;s.pantry[x.id]=true}
      });
      (data.extra_foods||[]).forEach(x=>{
        if(Number(x.confidence||0)>=.55&&x.name){if(!s.pantryCustom[x.name])added++;s.pantryCustom[x.name]=true}
      });
      const detected=(data.foods||[]).length+(data.extra_foods||[]).length;
      data.sync_note=added
        ?`Despensa actualizada: ${added} alimento${added===1?"":"s"} añadido${added===1?"":"s"}.`
        :detected?"Foto analizada: lo detectado ya estaba marcado en tu despensa.":"Foto analizada, pero no reconocí alimentos con suficiente seguridad.";
      persist();storeLast(data);
      try{if(typeof renderDiet==="function")renderDiet()}catch(e){}
      setTimeout(()=>{
        if(typeof window.ensureAll==="function")try{window.ensureAll()}catch(e){}
        setStatus(`✓ Foto procesada: ${detected} detectado${detected===1?"":"s"}, ${added} añadido${added===1?"":"s"} a la despensa.`,"ok");
        checkHealth();
      },120);
    }catch(e){
      if(wakeTimer)clearTimeout(wakeTimer);
      console.error("BodyGym AI photo error",e);
      setStatus(`⚠ ${e.message||"No se pudo analizar la foto."}`,"error");
      setConnection("IA con error en la última consulta",false);
    }finally{
      input.value="";
      if(camera)camera.disabled=false;if(gallery)gallery.disabled=false;
    }
  };

  window.bodyGymAiHealthCheck=checkHealth;
  document.addEventListener("DOMContentLoaded",()=>setTimeout(checkHealth,500));
  const obs=new MutationObserver(()=>{if(document.querySelector(".ai-server"))setTimeout(checkHealth,150)});
  setTimeout(()=>{obs.observe(document.body,{childList:true,subtree:true});checkHealth()},1200);
})();