(function(){
  function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function logsFor(id){
    try{return state.logs.filter(x=>x.exerciseId===id).sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time))}catch(e){return[]}
  }
  function totalReps(log){return (log?.series||[]).reduce((s,x)=>s+(+x.reps||0),0)}
  function sameWeight(a,b){return a&&b&&Math.abs((+a.weight||0)-(+b.weight||0))<0.26}
  function topReps(ex){
    const p=String(ex.reps||'').replace(/[–—]/g,'-').split('-');
    return +(p[1]||p[0])||0;
  }
  function lowReps(ex){
    const p=String(ex.reps||'').replace(/[–—]/g,'-').split('-');
    return +(p[0])||0;
  }
  function advisor(ex){
    const a=logsFor(ex.id), l=a[0];
    if(!l) return {code:'MANTENER',cls:'hold',icon:'🎯',reason:'Primera sesión: calibra una carga que te permita cumplir el rango dejando el RIR indicado.'};

    const pain=+l.pain||0, prev=a[1], prev2=a[2];
    const painPrev=+prev?.pain||0, painPrev2=+prev2?.pain||0;

    if(pain>=5){
      return {code:'REVISAR',cls:'review',icon:'⚠️',reason:`Dolor ${pain}/10 en la última sesión. No progreses la carga hasta revisar técnica, rango o ejercicio.`};
    }
    if(pain>=3 && (painPrev>=3 || pain>painPrev)){
      return {code:'REVISAR',cls:'review',icon:'⚠️',reason:`El dolor está en ${pain}/10 y no es un episodio aislado. Mantén la carga en pausa y revisa antes de progresar.`};
    }

    if(a.length>=3 && sameWeight(a[0],a[1]) && sameWeight(a[1],a[2])){
      const r0=totalReps(a[0]),r1=totalReps(a[1]),r2=totalReps(a[2]);
      const noGain=r0<=r2;
      const falling=r0<r1 && r1<=r2;
      if((noGain||falling) && Math.max(pain,painPrev,painPrev2)<=2){
        return {code:'REVISAR',cls:'review',icon:'🔎',reason:`Tres sesiones con la misma carga sin progreso claro (${r2} → ${r1} → ${r0} reps totales). Conviene revisar recuperación, técnica o programación.`};
      }
    }

    const reps=(l.series||[]).map(s=>+s.reps||0), top=topReps(ex), low=lowReps(ex);
    const fullSets=reps.length>=ex.sets && reps.slice(0,ex.sets).every(v=>v>0);
    const allTop=fullSets && reps.slice(0,ex.sets).every(v=>v>=top);

    if(allTop && pain<=2){
      return {code:'SUBIR',cls:'up',icon:'⬆️',reason:`Has completado ${reps.slice(0,ex.sets).join('/')} con ${l.weight} kg. Sube el incremento mínimo indicado y vuelve a la parte baja del rango.`};
    }

    if(prev && (+l.weight||0)>(+prev.weight||0)+0.25){
      return {code:'MANTENER',cls:'hold',icon:'🧱',reason:`Acabas de subir a ${l.weight} kg. Consolida esta carga antes de volver a aumentarla.`};
    }

    if(fullSets){
      const total=totalReps(l),prevTotal=sameWeight(l,prev)?totalReps(prev):null;
      if(prevTotal!==null && total>prevTotal){
        return {code:'MÁS REPS',cls:'reps',icon:'➕',reason:`Vas progresando con ${l.weight} kg (${prevTotal} → ${total} reps totales). Mantén el peso e intenta sumar 1 repetición total.`};
      }
      if(reps.some(v=>v<top) && reps.every(v=>v>=Math.max(1,low-1))){
        return {code:'MÁS REPS',cls:'reps',icon:'➕',reason:`Mantén ${l.weight} kg hasta alcanzar el máximo del rango en todas las series. Objetivo próximo: +1 repetición total.`};
      }
    }

    return {code:'MANTENER',cls:'hold',icon:'➡️',reason:`Mantén ${l.weight} kg y prioriza repeticiones limpias dentro del rango con el RIR previsto.`};
  }

  window.trainingAdvice=advisor;
  window.suggest=function(ex){
    const a=advisor(ex);
    return `<div class="training-advice ${a.cls}"><div class="advice-label">${a.icon} ${esc(a.code)}</div><div class="advice-reason">${esc(a.reason)}</div></div>`;
  };

  const css=document.createElement('style');
  css.textContent=`
    .training-advice{margin-top:10px;border-radius:16px;padding:16px;border:2px solid #d8e0e8;background:#fff}
    .advice-label{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:8px 14px;font-weight:900;font-size:1.08em;letter-spacing:.02em;margin-bottom:10px}
    .advice-reason{font-weight:650;line-height:1.4}
    .training-advice.up{border-color:#75b798;background:#f1fbf5}.training-advice.up .advice-label{background:#16794a;color:#fff}
    .training-advice.reps{border-color:#86b7fe;background:#f3f8ff}.training-advice.reps .advice-label{background:#1d5fa7;color:#fff}
    .training-advice.hold{border-color:#f0c36b;background:#fffaf0}.training-advice.hold .advice-label{background:#956300;color:#fff}
    .training-advice.review{border-color:#e79aa2;background:#fff5f6}.training-advice.review .advice-label{background:#a61e2d;color:#fff}
    html[data-font-size="xl"] .advice-label{font-size:30px}.advice-reason{font-size:inherit}
  `;
  document.head.appendChild(css);

  function refresh(){try{if(typeof renderRoutine==='function'&&typeof routine!=='undefined'&&Object.keys(routine||{}).length)renderRoutine()}catch(e){}}
  setTimeout(refresh,0);
  setTimeout(refresh,700);
})();
