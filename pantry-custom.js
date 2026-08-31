(function(){
  const STORAGE_KEY="bodygym_pt_data_v2";

  function appState(){
    try{if(typeof state!=="undefined")return state}catch(e){}
    try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}")}catch(e){return{}}
  }

  function persist(){
    try{
      if(typeof save==="function")save();
      else localStorage.setItem(STORAGE_KEY,JSON.stringify(appState()));
    }catch(e){}
  }

  function norm(v){
    return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  }

  function categoryFor(name){
    const n=norm(name);
    if(/huevo|clara|pavo|jamon|ternera|vacuno|carne|cerdo|pollo|lomo|pescado|merluza|bacalao|atun|salmon|sardina|caballa|bonito|gamba|langostino|marisco|tofu|tempeh|seitan/.test(n))return"Proteínas";
    if(/yogur|skyr|queso|cottage|leche|kefir|whey|proteina/.test(n))return"Desayuno y lácteos";
    if(/arroz|pan|pasta|patata|boniato|avena|cereal|tortilla|wrap|quinoa|cuscus|couscous|lenteja|garbanzo|alubia|legumbre/.test(n))return"Hidratos";
    if(/manzana|pera|platano|banana|naranja|mandarina|kiwi|pina|fresa|frambuesa|arandano|uva|melon|sandia|mango|aguacate|tomate|cebolla|lechuga|rucula|espinaca|brocoli|coliflor|calabacin|pimiento|zanahoria|pepino|verdura|fruta|ensalada|seta|champinon/.test(n))return"Fruta y verdura";
    return"Otros detectados por IA";
  }

  function findGrid(card,category){
    const cats=[...card.querySelectorAll(".pantry-category")];
    const wanted=norm(category);
    const cat=cats.find(x=>norm(x.textContent)===wanted);
    if(!cat)return null;
    const next=cat.nextElementSibling;
    return next&&next.classList.contains("pantry-grid")?next:null;
  }

  function ensureOtherGrid(card){
    let grid=card.querySelector('[data-ai-custom-grid="Otros detectados por IA"]');
    if(grid)return grid;
    const aiCard=card.querySelector(".ai-card");
    const title=document.createElement("div");
    title.className="pantry-category ai-custom-category";
    title.dataset.aiCustomCategory="1";
    title.textContent="Otros detectados por IA";
    grid=document.createElement("div");
    grid.className="pantry-grid ai-custom-category";
    grid.dataset.aiCustomGrid="Otros detectados por IA";
    card.insertBefore(title,aiCard||null);
    card.insertBefore(grid,aiCard||null);
    return grid;
  }

  function makeButton(name,active){
    const btn=document.createElement("button");
    btn.type="button";
    btn.className="pantry-toggle ai-custom-toggle"+(active?" active":"");
    btn.dataset.aiCustomName=name;
    btn.setAttribute("aria-pressed",active?"true":"false");
    btn.textContent=(active?"✓ ":"")+name+" · IA";
    btn.addEventListener("click",()=>window.toggleAiPantryCustom(name));
    return btn;
  }

  window.toggleAiPantryCustom=function(name){
    const s=appState();
    if(!s.pantryCustom)s.pantryCustom={};
    s.pantryCustom[name]=!s.pantryCustom[name];
    persist();
    try{if(typeof renderDiet==="function")renderDiet()}catch(e){}
    setTimeout(sync,40);
  };

  function sync(){
    const card=document.querySelector("#dietView .pantry-card");
    if(!card)return;
    const s=appState();
    if(!s.pantryCustom)s.pantryCustom={};
    const items=Object.entries(s.pantryCustom).map(([name,active])=>({name,active:Boolean(active),category:categoryFor(name)})).sort((a,b)=>a.category.localeCompare(b.category,"es")||a.name.localeCompare(b.name,"es"));
    const signature=JSON.stringify(items);
    if(card.dataset.aiCustomSignature===signature)return;
    card.dataset.aiCustomSignature=signature;

    card.querySelectorAll(".ai-custom-toggle,.ai-custom-category").forEach(x=>x.remove());
    const oldHint=card.querySelector(".ai-pantry-manual-hint");
    if(oldHint)oldHint.remove();
    if(!items.length)return;

    const intro=card.querySelector("p");
    if(intro){
      const hint=document.createElement("p");
      hint.className="muted ai-pantry-manual-hint";
      hint.innerHTML="✨ <b>Detectados por IA:</b> también aparecen en estas categorías. Márcalos si los tienes y desmárcalos cuando se acaben.";
      intro.insertAdjacentElement("afterend",hint);
    }

    const grouped={};
    items.forEach(item=>(grouped[item.category]||(grouped[item.category]=[])).push(item));
    Object.entries(grouped).forEach(([category,rows])=>{
      const grid=category==="Otros detectados por IA"?ensureOtherGrid(card):findGrid(card,category)||ensureOtherGrid(card);
      rows.forEach(item=>grid.appendChild(makeButton(item.name,item.active)));
    });
  }

  const style=document.createElement("style");
  style.textContent=`
    .ai-custom-pantry{display:none!important}
    .ai-custom-toggle{position:relative}
    .ai-custom-toggle:not(.active){border-style:dashed}
    .ai-pantry-manual-hint{margin-top:-4px;margin-bottom:16px}
  `;
  document.head.appendChild(style);

  document.addEventListener("DOMContentLoaded",()=>setTimeout(sync,150));
  const observer=new MutationObserver(()=>requestAnimationFrame(sync));
  setTimeout(()=>{
    const host=document.getElementById("dietView");
    if(host)observer.observe(host,{childList:true,subtree:true});
    sync();
  },500);
})();
