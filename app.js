(() => {
  const BOARD_SIZE = 6;
  const ROUND_TIME = 120;
  const MASTER_STREAK = 3;
  const MASTER_CORRECT = 4;
  const REVIEW_CHANCE = 0.18;
  const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];

  const KEYS = {
    customContent: "lw_custom_content_v1",
    progress: "lw_progress_v1"
  };

  const $ = (id) => document.getElementById(id);
  const shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
  const idx = (lv) => CEFR.indexOf(lv);

  // ---------- state ----------
  let content = null;
  let bank = new Map(); // id -> item
  let activeItems = [];

  let time = ROUND_TIME, roundScore = 0, totalCorrect = 0;
  let currentLevelIdx = 0, introducedNextCount = 0, roundNumber = 0, roundMode = "word";
  let selectedEn = null, selectedPt = null, timerId = null;

  // ---------- UI ----------
  function setMsg(t, kind=""){
    const el = $("msg");
    el.textContent = t;
    el.style.color = kind==="ok" ? "#86efac" : kind==="err" ? "#fca5a5" : "#94a3b8";
  }
  function hud(){
    $("level").textContent = CEFR[currentLevelIdx];
    $("xp").textContent = totalCorrect;
    $("roundScore").textContent = roundScore;
    $("time").textContent = time;
  }
  function clearUnanswered(){
    $("unansweredList").innerHTML = "";
    $("unansweredBox").style.display = "none";
  }
  function showUnanswered(){
    const ul = $("unansweredList");
    ul.innerHTML = "";
    const u = new Map();
    activeItems.forEach(i => u.set(i.id, `${i.en} = ${i.pt}`));
    for (const line of u.values()) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    }
    if (u.size) $("unansweredBox").style.display = "block";
  }

  // ---------- content ----------
  function validateContent(obj){
    if (!obj || typeof obj !== "object" || !obj.levels) throw new Error("JSON inválido: faltou levels.");
    for (const lv of CEFR) {
      const node = obj.levels[lv] || { words: [], phrases: [] };
      if (!Array.isArray(node.words) || !Array.isArray(node.phrases)) throw new Error(`JSON inválido em ${lv}.`);
      for (const w of node.words) if (!w.en || !w.pt) throw new Error(`Palavra inválida em ${lv}.`);
      for (const p of node.phrases) if (!p.en || !p.pt) throw new Error(`Frase inválida em ${lv}.`);
    }
    return true;
  }

  async function loadDefaultContent() {
    const res = await fetch("content.json");
    if (!res.ok) throw new Error("Não consegui carregar content.json");
    return res.json();
  }

  async function loadContent() {
    const custom = localStorage.getItem(KEYS.customContent);
    if (custom) {
      const parsed = JSON.parse(custom);
      validateContent(parsed);
      return parsed;
    }
    const def = await loadDefaultContent();
    validateContent(def);
    return def;
  }

  function saveCustomContent(obj){
    localStorage.setItem(KEYS.customContent, JSON.stringify(obj));
  }
  function clearCustomContent(){
    localStorage.removeItem(KEYS.customContent);
  }

  // ---------- bank ----------
  function makeId(type, lv, i, en){
    const slug = String(en).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28);
    return `${type}_${lv}_${i}_${slug}`;
  }

  function rebuildBank() {
    bank = new Map();
    for (const lv of CEFR) {
      const node = content.levels[lv] || { words: [], phrases: [] };
      node.words.forEach((w, i) => {
        bank.set(makeId("w", lv, i, w.en), {
          id: makeId("w", lv, i, w.en),
          en: w.en, pt: w.pt, cefr: lv, type: "word",
          prereqWords: [],
          correct: 0, wrong: 0, streak: 0, mastered: false, active: false, seenRound: 0
        });
      });
      node.phrases.forEach((p, i) => {
        bank.set(makeId("p", lv, i, p.en), {
          id: makeId("p", lv, i, p.en),
          en: p.en, pt: p.pt, cefr: lv, type: "phrase",
          prereqWords: Array.isArray(p.prereqWords) ? p.prereqWords : [],
          correct: 0, wrong: 0, streak: 0, mastered: false, active: false, seenRound: 0
        });
      });
    }
    loadProgress();
  }

  // ---------- progress ----------
  function saveProgress(){
    const stats = {};
    for (const [id, it] of bank.entries()) stats[id] = {
      c: it.correct, w: it.wrong, s: it.streak, m: it.mastered
    };
    localStorage.setItem(KEYS.progress, JSON.stringify({
      totalCorrect, currentLevelIdx, introducedNextCount, roundNumber, stats
    }));
  }

  function loadProgress(){
    const raw = localStorage.getItem(KEYS.progress);
    if (!raw) return;
    try{
      const p = JSON.parse(raw);
      totalCorrect = Number(p.totalCorrect || 0);
      currentLevelIdx = Math.min(5, Math.max(0, Number(p.currentLevelIdx || 0)));
      introducedNextCount = Math.min(2, Math.max(0, Number(p.introducedNextCount || 0)));
      roundNumber = Number(p.roundNumber || 0);
      if (p.stats) {
        for (const [id, st] of Object.entries(p.stats)) {
          const it = bank.get(id);
          if (!it) continue;
          it.correct = st.c || 0; it.wrong = st.w || 0; it.streak = st.s || 0; it.mastered = !!st.m;
        }
      }
    } catch {}
  }

  function resetProgress(){
    totalCorrect = 0; currentLevelIdx = 0; introducedNextCount = 0; roundNumber = 0;
    for (const it of bank.values()) {
      it.correct = 0; it.wrong = 0; it.streak = 0; it.mastered = false; it.active = false; it.seenRound = 0;
    }
    saveProgress();
  }

  // ---------- progression ----------
  function levelStats(level){
    const arr = [...bank.values()].filter(i => i.type==="word" && i.cefr===level);
    const total = arr.length || 1;
    const mastered = arr.filter(i => i.mastered).length;
    const attempts = arr.reduce((s,i)=>s+i.correct+i.wrong,0);
    const correct = arr.reduce((s,i)=>s+i.correct,0);
    return { ratio: mastered/total, attempts, acc: attempts ? correct/attempts : 0 };
  }

  function maybeAdvance(){
    const next = currentLevelIdx + 1;
    if (next >= CEFR.length) return;
    const currLv = CEFR[currentLevelIdx], nextLv = CEFR[next];
    const curr = levelStats(currLv), nx = levelStats(nextLv);

    if (introducedNextCount===0 && curr.ratio>=0.72 && curr.attempts>=24 && curr.acc>=0.68) {
      introducedNextCount = 1; setMsg(`Introduzindo 1 palavra de ${nextLv}.`, "ok"); saveProgress(); return;
    }
    if (introducedNextCount===1 && curr.ratio>=0.84 && curr.attempts>=34 && curr.acc>=0.72) {
      introducedNextCount = 2; setMsg(`Agora até 2 palavras de ${nextLv}.`, "ok"); saveProgress(); return;
    }
    const nextReady = nx.attempts>=18 && (nx.acc>=0.62 || nx.ratio>=0.20);
    if (introducedNextCount>=2 && curr.ratio>=0.90 && curr.acc>=0.75 && nextReady) {
      currentLevelIdx = next; introducedNextCount = 0;
      setMsg(`Subiu para ${CEFR[currentLevelIdx]}.`, "ok"); saveProgress();
    }
  }

  function decideRoundMode(){
    if (currentLevelIdx < 1) return "word";
    if (currentLevelIdx === 1) return (roundNumber % 3 === 0) ? "phrase" : "word";
    if (currentLevelIdx === 2) return (roundNumber % 2 === 0) ? "phrase" : "word";
    if (currentLevelIdx === 3) return (roundNumber % 3 === 1) ? "word" : "phrase";
    return "phrase";
  }

  function masteredWordsSet(){
    const s = new Set();
    for (const it of bank.values()) if (it.type==="word" && it.mastered) s.add(it.en.toLowerCase());
    return s;
  }

  function phraseEligible(it){
    if (it.type!=="phrase" || idx(it.cefr) > currentLevelIdx) return false;
    const req = it.prereqWords || [];
    if (!req.length) return true;
    const solid = masteredWordsSet();
    const hit = req.filter(w => solid.has(String(w).toLowerCase())).length;
    return hit >= Math.ceil(req.length / 2);
  }

  function smartSort(pool){
    return pool.sort((a,b)=>{
      const am = a.mastered ? 1 : 0, bm = b.mastered ? 1 : 0;
      if (am!==bm) return am-bm;
      const as = a.correct-a.wrong, bs = b.correct-b.wrong;
      if (as!==bs) return as-bs;
      return a.seenRound - b.seenRound;
    });
  }

  function pickFrom(pool,n){ return smartSort([...pool]).slice(0, Math.max(0, Math.min(n,pool.length))); }

  function fillWordRound(){
    for (const it of bank.values()) it.active = false;
    activeItems = [];

    const all = [...bank.values()].filter(i => i.type==="word");
    const prev = all.filter(i => idx(i.cefr) < currentLevelIdx);
    const curr = all.filter(i => idx(i.cefr) === currentLevelIdx);
    const next = all.filter(i => idx(i.cefr) === currentLevelIdx+1);

    const reviewQ = (currentLevelIdx>0 && Math.random()<REVIEW_CHANCE) ? 1 : 0;
    const nextQ = Math.min(introducedNextCount, 2, next.length);
    const currQ = Math.max(0, BOARD_SIZE - reviewQ - nextQ);

    let picks = [
      ...pickFrom(curr, currQ),
      ...pickFrom(next, nextQ),
      ...pickFrom(prev, reviewQ)
    ];

    const used = new Set(picks.map(p=>p.id));
    const fallback = smartSort(all.filter(i => !used.has(i.id)));
    while (picks.length < BOARD_SIZE && fallback.length) picks.push(fallback.shift());

    activeItems = shuffle(picks.slice(0, BOARD_SIZE));
    activeItems.forEach(i => { i.active = true; i.seenRound = roundNumber; });
  }

  function fillPhraseRound(){
    for (const it of bank.values()) it.active = false;
    let pool = smartSort([...bank.values()].filter(i => i.type==="phrase" && phraseEligible(i)));
    if (!pool.length) pool = smartSort([...bank.values()].filter(i => i.type==="word" && idx(i.cefr)<=currentLevelIdx));
    activeItems = shuffle(pool.slice(0, BOARD_SIZE));
    activeItems.forEach(i => { i.active = true; i.seenRound = roundNumber; });
  }

  function fillBoard(){
    if (roundMode === "phrase") fillPhraseRound(); else fillWordRound();
    renderBoard();
  }

  function replaceMatched(oldId){
    const idxOld = activeItems.findIndex(i => i.id===oldId);
    if (idxOld < 0) return;
    const old = activeItems[idxOld];
    old.active = false;

    let pool = [];
    if (roundMode==="phrase") {
      pool = smartSort([...bank.values()].filter(i => i.type==="phrase" && !i.active && phraseEligible(i)));
    } else {
      pool = smartSort([...bank.values()].filter(i => i.type==="word" && !i.active && idx(i.cefr)<=Math.max(currentLevelIdx,currentLevelIdx+1)));
    }
    const next = pool[0];
    if (next) {
      next.active = true; next.seenRound = roundNumber;
      activeItems[idxOld] = next;
    } else activeItems.splice(idxOld,1);
    renderBoard();
  }

  // ---------- render / game ----------
  function renderBoard(){
    const en = $("enList"), pt = $("ptList");
    en.innerHTML = ""; pt.innerHTML = "";

    const enCards = shuffle([...activeItems]);
    const ptCards = shuffle([...activeItems]);

    enCards.forEach(it => {
      const b = document.createElement("button");
      b.className = "card"; b.dataset.key = it.id; b.textContent = it.en;
      b.onclick = () => pick("en", it.id, b);
      en.appendChild(b);
    });

    ptCards.forEach(it => {
      const b = document.createElement("button");
      b.className = "card"; b.dataset.key = it.id; b.textContent = it.pt;
      b.onclick = () => pick("pt", it.id, b);
      pt.appendChild(b);
    });

    hud();
  }

  function clearSelections(){
    document.querySelectorAll(".card.selected").forEach(c=>c.classList.remove("selected"));
    selectedEn = null; selectedPt = null;
  }

  function checkMastery(it){
    if (!it.mastered && it.streak >= MASTER_STREAK && it.correct >= MASTER_CORRECT) it.mastered = true;
  }

  function pick(side, id, el){
    if (time<=0) return;
    document.querySelectorAll(".card.err,.card.ok").forEach(c=>c.classList.remove("err","ok"));

    if (side==="en") {
      document.querySelectorAll("#enList .card").forEach(c=>c.classList.remove("selected"));
      selectedEn = id; el.classList.add("selected");
    } else {
      document.querySelectorAll("#ptList .card").forEach(c=>c.classList.remove("selected"));
      selectedPt = id; el.classList.add("selected");
    }

    if (!(selectedEn && selectedPt)) return;

    const match = selectedEn === selectedPt;
    const a = bank.get(selectedEn), b = bank.get(selectedPt);
    const enEl = document.querySelector(`#enList .card[data-key="${selectedEn}"]`);
    const ptEl = document.querySelector(`#ptList .card[data-key="${selectedPt}"]`);

    if (match && a) {
      roundScore++; totalCorrect++;
      a.correct++; a.streak++; checkMastery(a);
      enEl?.classList.add("ok"); ptEl?.classList.add("ok");
      setMsg(`✅ ${a.en} = ${a.pt}`, "ok");
      maybeAdvance();
      saveProgress();
      setTimeout(()=>replaceMatched(a.id), 220);
    } else {
      if (a) { a.wrong++; a.streak = 0; }
      if (b) { b.wrong++; b.streak = 0; }
      time = Math.max(0, time-2);
      enEl?.classList.add("err"); ptEl?.classList.add("err");
      setMsg("❌ Não bateu. -2s", "err");
      saveProgress();
    }

    setTimeout(()=>{ clearSelections(); hud(); checkEnd(); }, 90);
  }

  function startTimer(){
    clearInterval(timerId);
    timerId = setInterval(()=>{
      time--; hud(); checkEnd();
    },1000);
  }

  function checkEnd(){
    if (time<=0) {
      clearInterval(timerId);
      setMsg(`⏱️ Tempo esgotado! Acertos: ${roundScore}`, "err");
      showUnanswered();
      return;
    }
    if (activeItems.length===0){
      clearInterval(timerId);
      setMsg(`🏆 Rodada concluída! Acertos: ${roundScore}`, "ok");
      showUnanswered();
    }
  }

  function newRound(){
    time = ROUND_TIME; roundScore = 0; clearSelections(); clearUnanswered();
    roundNumber++; roundMode = decideRoundMode();
    fillBoard();
    setMsg(`Nova partida (${roundMode==="phrase" ? "frases" : "palavras"}) • Base ${CEFR[currentLevelIdx]}`);
    saveProgress();
    startTimer();
  }

  // ---------- report ----------
  function dateISO(){ return new Date().toISOString(); }
  function acc(c,w){ const t=c+w; return t ? c/t : 0; }

  function buildReport(){
    const items = [...bank.values()];
    const practiced = items.filter(i => i.correct+i.wrong>0);
    const totalC = practiced.reduce((s,i)=>s+i.correct,0);
    const totalW = practiced.reduce((s,i)=>s+i.wrong,0);

    const byLevel = {};
    for (const lv of CEFR){
      const arr = items.filter(i=>i.cefr===lv);
      const c = arr.reduce((s,i)=>s+i.correct,0);
      const w = arr.reduce((s,i)=>s+i.wrong,0);
      byLevel[lv] = {
        attempts: c+w, correct:c, wrong:w, accuracy: acc(c,w),
        masteredWords: arr.filter(i=>i.type==="word" && i.mastered).length
      };
    }

    const hardest = [...practiced]
      .sort((a,b)=> (b.wrong-a.wrong) || ((b.correct+b.wrong)-(a.correct+a.wrong)))
      .slice(0,10).map(i=>({...i, attempts:i.correct+i.wrong, accuracy: acc(i.correct,i.wrong)}));

    const best = [...practiced]
      .filter(i => i.correct+i.wrong >= 3)
      .sort((a,b)=> (b.correct-a.correct) || (acc(b.correct,b.wrong)-acc(a.correct,a.wrong)))
      .slice(0,10).map(i=>({...i, attempts:i.correct+i.wrong, accuracy: acc(i.correct,i.wrong)}));

    return {
      generatedAt: dateISO(),
      currentLevel: CEFR[currentLevelIdx],
      roundsPlayed: roundNumber,
      totals: { attempts: totalC+totalW, correct: totalC, wrong: totalW, accuracy: acc(totalC,totalW) },
      byLevel,
      hardestItems: hardest.map(i=>({en:i.en,pt:i.pt,type:i.type,level:i.cefr,attempts:i.attempts,correct:i.correct,wrong:i.wrong,accuracy:i.accuracy})),
      bestItems: best.map(i=>({en:i.en,pt:i.pt,type:i.type,level:i.cefr,attempts:i.attempts,correct:i.correct,wrong:i.wrong,accuracy:i.accuracy}))
    };
  }

  function download(name, content, mime){
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  function reportToCSV(r){
    const rows = [];
    rows.push(["section","en","pt","type","level","attempts","correct","wrong","accuracy"]);
    r.hardestItems.forEach(i => rows.push(["hardest",i.en,i.pt,i.type,i.level,i.attempts,i.correct,i.wrong,(i.accuracy*100).toFixed(1)+"%"]));
    r.bestItems.forEach(i => rows.push(["best",i.en,i.pt,i.type,i.level,i.attempts,i.correct,i.wrong,(i.accuracy*100).toFixed(1)+"%"]));
    rows.push([]);
    rows.push(["level","attempts","correct","wrong","accuracy","masteredWords"]);
    CEFR.forEach(lv => {
      const x = r.byLevel[lv];
      rows.push([lv,x.attempts,x.correct,x.wrong,(x.accuracy*100).toFixed(1)+"%",x.masteredWords]);
    });
    return rows.map(cols => cols.map(v => `"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
  }

  // ---------- events ----------
  async function init(){
    try {
      content = await loadContent();
      rebuildBank();
      hud();
      newRound();
      setMsg("Pronto. Conteúdo carregado.");
    } catch (e) {
      setMsg(`Erro ao carregar conteúdo: ${e.message}`, "err");
    }
  }

  $("newRoundBtn").addEventListener("click", newRound);
  $("addTimeBtn").addEventListener("click", () => { time += 30; hud(); setMsg("+30s"); });
  $("fullResetBtn").addEventListener("click", () => { resetProgress(); newRound(); setMsg("Progresso zerado."); });

  $("pickJsonBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      validateContent(obj);
      saveCustomContent(obj);
      content = obj;
      rebuildBank();
      newRound();
      setMsg(`JSON aplicado: ${file.name}`, "ok");
    } catch (e) {
      setMsg(`JSON inválido: ${e.message}`, "err");
    } finally {
      ev.target.value = "";
    }
  });

  $("useDefaultBtn").addEventListener("click", async () => {
    try {
      clearCustomContent();
      content = await loadDefaultContent();
      validateContent(content);
      rebuildBank();
      newRound();
      setMsg("Conteúdo padrão ativado.", "ok");
    } catch(e) {
      setMsg(`Falha ao voltar padrão: ${e.message}`, "err");
    }
  });

  $("reportBtn").addEventListener("click", () => {
    const report = buildReport();
    const f = $("reportFormat").value;
    const day = new Date().toISOString().slice(0,10);
    if (f === "json") {
      download(`relatorio-${day}.json`, JSON.stringify(report, null, 2), "application/json;charset=utf-8");
    } else {
      download(`relatorio-${day}.csv`, reportToCSV(report), "text/csv;charset=utf-8");
    }
    setMsg(`Relatório ${f.toUpperCase()} gerado.`, "ok");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }

  init();
})();