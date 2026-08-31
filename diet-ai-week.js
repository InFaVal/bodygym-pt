(function(){
  const AI_URL="https://bodygym-pt-ai.onrender.com";
  const LAST_PANTRY_KEY="bodygym_ai_last_pantry";
  const TARGET={kcal:2450,protein_g:160,carbs_min:250,carbs_max:290,fat_min:70,fat_max:75};
  const DAYS=["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"];
  const FOOD_NAMES={
    pollo:"Pechuga de pollo",lomo:"Lomo fresco",sardinas:"Sardinas en lata",atun:"Atún al natural",salmon:"Salmón ahumado",garbanzos:"Garbanzos",
    avena:"Avena",leche:"Leche semidesnatada",whey:"Proteína whey",yogur:"Yogur griego 0 %",cottage:"Cottage",canela:"Canela",
    patata:"Patata",pasta:"Pasta",arandanos:"Arándanos",pina:"Piña",kiwi:"Kiwi",ensalada:"Lechuga / rúcula",tomate:"Tomate / cebolla",aguacate:"Aguacate",aove:"AOVE"
  };

  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
  function appState(){
    try{if(typeof state!=="undefined")return state}catch(e){}
    try{return JSON.parse(localStorage.getItem("bodygym_pt_data_v2")||"{}")}catch(e){return{}}
  }
  function persist(){
    try{if(typeof save==="function")save();else localStorage.setItem("bodygym_pt_data_v2",JSON.stringify(appState()))}catch(e){}
  }
  function mondayIndex(jsDay){return(jsDay+6)%7}

  function inventory(){
    const s=appState();
    const pantry=Object.entries(s.pantry||{}).filter(([,v])=>Boolean(v)).map(([id])=>({id,name:FOOD_NAMES[id]||id}));
    const customFoods=Object.entries(s.pantryCustom||{}).filter(([,v])=>Boolean(v)).map(([name])=>name);
    return{pantry,customFoods};
  }
  function inventorySignature(){
    const inv=inventory();
    const rows=inv.pantry.map(x=>`base:${x.id}`).concat(inv.customFoods.map(x=>`custom:${x}`)).sort((a,b)=>a.localeCompare(b,"es"));
    return JSON.stringify(rows);
  }
  function observedHints(){
    try{
      const d=JSON.parse(localStorage.getItem(LAST_PANTRY_KEY)||"null");
      if(!d)return[];
      return[...(d.foods||[]),...(d.extra_foods||[])].map(x=>({name:x.name||x.id||"",quantity:x.quantity||"visible"})).filter(x=>x.name);
    }catch(e){return[]}
  }
  function plan(){return appState().aiWeekPlan||null}
  function stale(p){return Boolean(p&&p.inventorySignature&&p.inventorySignature!==inventorySignature())}

  async function api(path,payload){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),240000);
    try{
      const r=await fetch(AI_URL+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:ctrl.signal});
      const text=await r.text();
      let data={};try{data=text?JSON.parse(text):{}}catch(e){throw new Error(`Respuesta inválida del servidor (${r.status})`)}
      if(!r.ok)throw new Error(data.error||`Error IA ${r.status}`);
      return data;
    }catch(e){
      if(e.name==="AbortError")throw new Error("La generación semanal ha tardado demasiado. Prueba de nuevo; Render puede haberse despertado tarde.");
      throw e;
    }finally{clearTimeout(timer)}
  }

  function setWeekStatus(text,kind="info"){
    const el=document.getElementById("aiWeekStatus");if(!el)return;
    el.textContent=text;el.dataset.kind=kind;
    el.style.color=kind==="error"?"#a61b29":kind==="ok"?"#146c43":"";
    el.style.fontWeight=kind==="error"||kind==="ok"?"800":"";
  }

  window.generateAiWeekMenu=async function(){
    const inv=inventory();
    if(inv.pantry.length+inv.customFoods.length<3){setWeekStatus("Marca primero varios alimentos en Despensa.","error");return}
    const btn=document.getElementById("generateAiWeekBtn");
    if(btn){btn.disabled=true;btn.textContent="✨ Generando semana…"}
    setWeekStatus("Generando 7 días, priorizando perecederos y cuadrando macros. Puede tardar alrededor de un minuto…","info");
    try{
      const data=await api("/api/generate-week",{pantry:inv.pantry,customFoods:inv.customFoods,observed:observedHints(),target:TARGET});
      if(!Array.isArray(data.days)||data.days.length!==7)throw new Error("La IA no devolvió una semana completa.");
      const s=appState();
      s.aiWeekPlan={...data,inventorySignature:inventorySignature(),generatedAt:new Date().toISOString()};
      persist();
      setWeekStatus("✓ Semana generada y guardada.","ok");
      try{if(typeof renderDiet==="function")renderDiet()}catch(e){}
    }catch(e){
      console.error("Weekly AI menu error",e);
      setWeekStatus(`⚠ ${e.message||"No se pudo generar la semana."}`,"error");
    }finally{
      if(btn&&document.body.contains(btn)){btn.disabled=false;btn.textContent=plan()?"✨ Regenerar semana con mi despensa":"✨ Generar semana con mi despensa"}
    }
  };

  window.clearAiWeekMenu=function(){
    const s=appState();delete s.aiWeekPlan;persist();
    try{if(typeof renderDiet==="function")renderDiet()}catch(e){}
  };

  window.toggleAiWeekMealDone=function(slot){
    const s=appState();if(!s.mealDone)s.mealDone={};
    const key=new Date().toISOString().slice(0,10)+"|aiweek|"+slot;
    s.mealDone[key]=!s.mealDone[key];persist();
    try{if(typeof renderDiet==="function")renderDiet()}catch(e){}
  };

  function targetHtml(t=TARGET){
    return `<div class="ai-week-target"><b>Objetivo:</b> ≈${Math.round(Number(t.kcal)||TARGET.kcal)} kcal · ${Math.round(Number(t.protein_g)||TARGET.protein_g)} g proteína · ${Math.round(Number(t.carbs_min)||TARGET.carbs_min)}–${Math.round(Number(t.carbs_max)||TARGET.carbs_max)} g HC · ${Math.round(Number(t.fat_min)||TARGET.fat_min)}–${Math.round(Number(t.fat_max)||TARGET.fat_max)} g grasa</div>`;
  }

  function weekControls(){
    const p=plan(),isStale=stale(p),inv=inventory();
    const high=(p?.perishable_priority?.high||[]).slice(0,8);
    const generated=p?.generatedAt?new Date(p.generatedAt).toLocaleString("es-ES",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"";
    return `<div class="panel ai-week-panel">
      <div class="diet-day-title"><h2>Semana IA · despensa real</h2><span class="protein-badge">${inv.pantry.length+inv.customFoods.length} disponibles</span></div>
      ${targetHtml(p?.target||TARGET)}
      <p>La IA usa los alimentos <b>marcados en verde</b>, intenta gastar primero los <b>perecederos</b> y considera siempre disponibles <b>sal, pimienta, especias, hierbas, vinagre y agua</b>. No da por disponible aceite u otros ingredientes con calorías si no están marcados.</p>
      ${high.length?`<div class="ai-perishable"><b>⚡ Consumir primero:</b> ${high.map(esc).join(" · ")}</div>`:""}
      ${isStale?`<div class="ai-week-warning">⚠ Tu despensa ha cambiado desde que se generó esta semana. Regenera el menú para no usar alimentos que ya se hayan acabado.</div>`:""}
      <div class="ai-week-actions"><button id="generateAiWeekBtn" class="primary" onclick="generateAiWeekMenu()">${p?"✨ Regenerar semana con mi despensa":"✨ Generar semana con mi despensa"}</button>${p?`<button class="secondary" onclick="clearAiWeekMenu()">Volver al menú base</button>`:""}</div>
      <div id="aiWeekStatus" class="muted">${p?`Semana IA guardada${generated?` · ${generated}`:""}. Varias comidas incluyen receta paso a paso.`:"Genera una semana nueva usando lo que tienes ahora mismo."}</div>
    </div>`;
  }

  function macroHtml(m){const x=m?.macros||{};return `<div class="ai-week-macros">≈ <b>${Math.round(Number(x.kcal)||0)} kcal</b> · ${Math.round(Number(x.protein_g)||0)} g proteína · ${Math.round(Number(x.carbs_g)||0)} g HC · ${Math.round(Number(x.fat_g)||0)} g grasa</div>`}
  function itemsHtml(items){return `<div class="meal-items">${(items||[]).map(x=>`<div class="meal-item"><span>${esc(x.name)}</span><b>${esc(x.quantity)}</b></div>`).join("")}</div>`}
  function recipeHtml(m){
    const steps=Array.isArray(m?.recipe_steps)?m.recipe_steps:[];
    if(!steps.length&&!m?.seasoning)return"";
    return `<details class="ai-recipe"><summary>👨‍🍳 Ver receta / preparación</summary>${m.seasoning?`<p><b>Sazón:</b> ${esc(m.seasoning)}</p>`:""}${steps.length?`<ol>${steps.map(x=>`<li>${esc(x)}</li>`).join("")}</ol>`:"<p>Montar y servir según las cantidades indicadas.</p>"}</details>`;
  }
  function weekMealHtml(m){return `<div class="ai-week-meal"><div class="diet-day-title"><h3>${esc(m.slot)} · ${esc(m.title)}</h3>${m.uses_perishable?'<span class="ai-perishable-badge">⚡ perecedero</span>':""}</div>${itemsHtml(m.items)}${macroHtml(m)}${recipeHtml(m)}</div>`}
  function dayHtml(d,open=false){
    const t=d?.totals||{};
    return `<details class="week-day ai-week-day" ${open?"open":""}><summary>${esc(d.day)} · ≈${Math.round(Number(t.kcal)||0)} kcal · ${Math.round(Number(t.protein_g)||0)} g proteína</summary>${(d.meals||[]).map(weekMealHtml).join("")}</details>`;
  }

  function todayPlanHtml(p){
    const idx=mondayIndex(new Date().getDay()),d=p.days?.[idx];if(!d)return"";
    const date=new Date().toISOString().slice(0,10),s=appState();
    return `<div class="panel"><div class="diet-day-title"><h2>${esc(d.day)} · Hoy · IA</h2><span class="protein-badge">4 comidas</span></div>${targetHtml(p.target||TARGET)}${stale(p)?'<div class="ai-week-warning">⚠ La despensa ha cambiado. Regenera la semana antes de seguir este menú.</div>':""}</div>${(d.meals||[]).map(m=>{const key=date+"|aiweek|"+m.slot,done=!!s.mealDone?.[key];return `<div class="meal-card ai-today-meal"><div class="diet-day-title"><h3>${esc(m.slot)} · ${esc(m.title)}</h3>${m.uses_perishable?'<span class="ai-perishable-badge">⚡ perecedero</span>':""}</div>${itemsHtml(m.items)}${macroHtml(m)}${recipeHtml(m)}<div class="meal-actions"><button class="meal-done ${done?"active":""}" onclick="toggleAiWeekMealDone('${esc(m.slot)}')">${done?"✓ Hecho":"Marcar hecho"}</button></div></div>`}).join("")}`;
  }

  const oldWeek=typeof renderDietWeek==="function"?renderDietWeek:null;
  const oldToday=typeof renderDietToday==="function"?renderDietToday:null;
  if(oldWeek){try{renderDietWeek=function(){const p=plan();return weekControls()+(p&&!stale(p)?p.days.map((d,i)=>dayHtml(d,i===mondayIndex(new Date().getDay()))).join(""):oldWeek())}}catch(e){}}
  if(oldToday){try{renderDietToday=function(){const p=plan();return p&&!stale(p)?weekControls()+todayPlanHtml(p):weekControls()+oldToday()}}catch(e){}}

  const style=document.createElement("style");
  style.textContent=`
    .ai-week-panel{border:2px solid #d7e4ef}.ai-week-target{margin:12px 0;padding:12px;border-radius:12px;background:#edf4fb;color:#17365D}
    .ai-week-actions{display:grid;grid-template-columns:1fr auto;gap:10px;margin:14px 0}.ai-week-warning{margin:12px 0;padding:12px;border-radius:12px;background:#fff2f2;color:#9d1c2b;font-weight:800}
    .ai-perishable{margin:12px 0;padding:12px;border-radius:12px;background:#fff8df}.ai-perishable-badge{display:inline-block;padding:6px 9px;border-radius:999px;background:#fff1bd;color:#705100;font-weight:800;font-size:.8em}
    .ai-week-day .ai-week-meal{padding:14px 2px;border-bottom:1px solid #e4e8ed}.ai-week-day .ai-week-meal:last-child{border-bottom:0}.ai-week-macros{margin:10px 0;padding:9px 11px;border-radius:10px;background:#edf4fb;color:#17365D;font-weight:650}
    .ai-recipe{margin:10px 0;border:1px solid #d8e0e8;border-radius:12px;background:#fbfcfd;padding:0 12px}.ai-recipe summary{cursor:pointer;font-weight:850;padding:12px 0}.ai-recipe ol{padding-left:25px}.ai-recipe li{margin:7px 0}.ai-today-meal .ai-recipe{margin-bottom:14px}
    @media(max-width:520px){.ai-week-actions{grid-template-columns:1fr}.ai-week-actions button{width:100%}}
  `;
  document.head.appendChild(style);

  document.addEventListener("DOMContentLoaded",()=>setTimeout(()=>{try{if(typeof renderDiet==="function")renderDiet()}catch(e){}},180));
})();