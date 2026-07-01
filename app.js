(() => {
  const BOARD_SIZE = 6;
  const ROUND_TIME = 120;
  const MASTER_STREAK = 3;
  const MASTER_CORRECT = 4;
  const REVIEW_CHANCE = 0.18;
  const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];

  const LANGS = {
    "en-pt": {
      id: "en-pt",
      label: "Inglês → Português",
      sourceLabel: "INGLÊS",
      targetLabel: "PORTUGUÊS",
      defaultFile: "content.json",
      ttsLang: "en-US"
    },
    "ja-pt": {
      id: "ja-pt",
      label: "Japonês → Português",
      sourceLabel: "JAPONÊS",
      targetLabel: "PORTUGUÊS",
      defaultFile: "content-ja.json",
      ttsLang: "ja-JP"
    }
  };

  const KEYS = {
    customContent: "lw_custom_content_v1",
    progress: "lw_progress_v1",
    lang: "lw_lang_v1"
  };

  const $ = (id) => document.getElementById(id);
  const shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
  const idx = (lv) => CEFR.indexOf(lv);

  // ---------- state ----------
  let content = null;
  let bank = new Map();
  let activeItems = [];
  let wrongMap = new Map();

  let currentLanguage = localStorage.getItem(KEYS.lang) || "en-pt";

  let time = ROUND_TIME, roundScore = 0, totalCorrect = 0;
  let currentLevelIdx = 0, introducedNextCount = 0, roundNumber = 0, roundMode = "word", playMode = "text";
  let selectedEn = null, selectedPt = null, timerId = null;

  let previousScreen = "startScreen";

  // ---------- screen ----------
  function showScreen(id){
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    $(id)?.classList.add("active");
  }

  function goStartScreen(){
    clearInterval(timerId);
    showScreen("startScreen");
  }

  function goGameScreen(){
    showScreen("gameScreen");
  }

  function goSettingsScreen(from = "startScreen"){
    previousScreen = from;
    showScreen("settingsScreen");
  }

  function goBackFromSettings(){
    showScreen(previousScreen || "startScreen");
  }

  function goEndScreen(){
    showScreen("endScreen");
  }

  // ---------- helpers ----------
  function enKey(text){
    return String(text || "").trim().toLowerCase();
  }

  function isEnInActive(en, ignoreId = null){
    const key = enKey(en);
    return activeItems.some(i => i.id !== ignoreId && enKey(i.en) === key);
  }

  function normText(s){
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function ptVariants(item){
    const base = [item?.pt || ""];
    const extra = Array.isArray(item?.ptAlt) ? item.ptAlt : [];
    return [...base, ...extra].map(normText).filter(Boolean);
  }

  function isEquivalentPT(enItem, ptItem){
    const a = new Set(ptVariants(enItem));
    const b = new Set(ptVariants(ptItem));
    for (const v of a) if (b.has(v)) return true;
    return false;
  }

  function getLangCfg(){
    return LANGS[currentLanguage] || LANGS["en-pt"];
  }

  // ---------- UI ----------
  function setMsg(t, kind=""){
    const el = $("msg");
    if (!el) return;
    el.textContent = t;
    el.style.color = kind==="ok" ? "#86efac" : kind==="err" ? "#fca5a5" : "#94a3b8";
  }

  function hud(){
    $("level").textContent = CEFR[currentLevelIdx];
    $("xp").textContent = totalCorrect;
    $("roundScore").textContent = roundScore;
    $("time").textContent = time;
    $("playMode").textContent = playMode === "audio" ? "Escuta" : "Leitura";

    const cfg = getLangCfg();
    $("sourceColumnTitle").textContent = cfg.sourceLabel;
    $("targetColumnTitle").textContent = cfg.targetLabel;
    $("gameTitle").textContent = cfg.label;
  }

  function resetRoundBuffers(){
    wrongMap = new Map();
    selectedEn = null;
    selectedPt = null;
  }

  // ---------- audio ----------
  function speakSource(text){
    const cfg = getLangCfg();

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = cfg.ttsLang;
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
      return;
    }

    const encoded = encodeURIComponent(text);
    const target = cfg.ttsLang.startsWith("ja") ? "ja" : "en";
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${target}&q=${encoded}`;
    const audio = new Audio(url);
    audio.play().catch(() => {});
  }

  function decidePlayMode(){
    playMode = (roundNumber % 2 === 0) ? "audio" : "text";
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
    const cfg = getLangCfg();
    const res = await fetch(cfg.defaultFile);
    if (!res.ok) throw new Error(`Não consegui carregar ${cfg.defaultFile}`);
    return res.json();
  }

  function customKeyByLang(){
    return `${KEYS.customContent}_${currentLanguage}`;
  }
  function progressKeyByLang(){
    return `${KEYS.progress}_${currentLanguage}`;
  }

  async function loadContent() {
    const custom = localStorage.getItem(customKeyByLang());
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
    localStorage.setItem(customKeyByLang(), JSON.stringify(obj));
  }

  function clearCustomContent(){
    localStorage.removeItem(customKeyByLang());
  }

  // ---------- bank ----------
  function makeId(type, lv, i, en){
    const slug = String(en).toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/g, "-").slice(0, 28);
    return `${type}_${lv}_${i}_${slug}`;
  }

  function rebuildBank() {
    bank = new Map();
    for (const lv of CEFR) {
      const node = content.levels[lv] || { words: [], phrases: [] };
      node.words.forEach((w, i) => {
        const id = makeId("w", lv, i, w.en);
        bank.set(id, {
          id,
          en: w.en,
          pt: w.pt,
          ptAlt: Array.isArray(w.ptAlt) ? w.ptAlt : [],
          cefr: lv,
          type: "word",
          prereqWords: [],
          correct: 0, wrong: 0, streak: 0, mastered: false, active: false, seenRound: 0
        });
      });
      node.phrases.forEach((p, i) => {
        const id = makeId("p", lv, i, p.en);
        bank.set(id, {
          id,
          en: p.en,
          pt: p.pt,
          ptAlt: Array.isArray(p.ptAlt) ? p.ptAlt : [],
          cefr: lv,
          type: "phrase",
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
    for (const [id, it] of bank.entries()) {
      stats[id] = { c: it.correct, w: it.wrong, s: it.streak, m: it.mastered };
    }

    localStorage.setItem(progressKeyByLang(), JSON.stringify({
      totalCorrect, currentLevelIdx, introducedNextCount, roundNumber, stats
    }));
  }

  function loadProgress(){
    const raw = localStorage.getItem(progressKeyByLang());
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
          it.correct = st.c || 0;
          it.wrong = st.w || 0;
          it.streak = st.s || 0;
          it.mastered = !!st.m;
        }
      }
    } catch {}
  }

  function resetProgress(){
    totalCorrect = 0;
    currentLevelIdx = 0;
    introducedNextCount = 0;
    roundNumber = 0;

    for (const it of bank.values()) {
      it.correct = 0;
      it.wrong = 0;
      it.streak = 0;
      it.mastered = false;
      it.active = false;
      it.seenRound = 0;
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

    const currLv = CEFR[currentLevelIdx];
    const nextLv = CEFR[next];
    const curr = levelStats(currLv);
    const nx = levelStats(nextLv);

    if (introducedNextCount===0 && curr.ratio>=0.72 && curr.attempts>=24 && curr.acc>=0.68) {
      introducedNextCount = 1;
      setMsg(`Introduzindo 1 item de ${nextLv}.`, "ok");
      saveProgress();
      return;
    }

    if (introducedNextCount===1 && curr.ratio>=0.84 && curr.attempts>=34 && curr.acc>=0.72) {
      introducedNextCount = 2;
      setMsg(`Agora até 2 itens de ${nextLv}.`, "ok");
      saveProgress();
      return;
    }

    const nextReady = nx.attempts>=18 && (nx.acc>=0.62 || nx.ratio>=0.20);
    if (introducedNextCount>=2 && curr.ratio>=0.90 && curr.acc>=0.75 && nextReady) {
      currentLevelIdx = next;
      introducedNextCount = 0;
      setMsg(`Subiu para ${CEFR[currentLevelIdx]}.`, "ok");
      saveProgress();
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
      const am = a.mastered ? 1 : 0;
      const bm = b.mastered ? 1 : 0;
      if (am!==bm) return am-bm;

      const as = a.correct-a.wrong;
      const bs = b.correct-b.wrong;
      if (as!==bs) return as-bs;

      return a.seenRound - b.seenRound;
    });
  }

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

    const picks = [];
    const usedEn = new Set();

    const addFrom = (arr, wanted) => {
      if (wanted <= 0) return;
      const sorted = smartSort([...arr]);
      for (const it of sorted) {
        if (wanted <= 0 || picks.length >= BOARD_SIZE) break;
        const k = enKey(it.en);
        if (usedEn.has(k)) continue;
        picks.push(it);
        usedEn.add(k);
        wanted--;
      }
    };

    addFrom(curr, currQ);
    addFrom(next, nextQ);
    addFrom(prev, reviewQ);

    for (const it of smartSort([...all])) {
      if (picks.length >= BOARD_SIZE) break;
      const k = enKey(it.en);
      if (usedEn.has(k)) continue;
      picks.push(it);
      usedEn.add(k);
    }

    activeItems = shuffle(picks.slice(0, BOARD_SIZE));
    activeItems.forEach(i => { i.active = true; i.seenRound = roundNumber; });
  }

  function fillPhraseRound(){
    for (const it of bank.values()) it.active = false;

    let pool = smartSort([...bank.values()].filter(i => i.type==="phrase" && phraseEligible(i)));
    if (!pool.length) {
      pool = smartSort([...bank.values()].filter(i => i.type==="word" && idx(i.cefr)<=currentLevelIdx));
    }

    const picks = [];
    const usedEn = new Set();

    for (const it of pool) {
      if (picks.length >= BOARD_SIZE) break;
      const k = enKey(it.en);
      if (usedEn.has(k)) continue;
      picks.push(it);
      usedEn.add(k);
    }

    activeItems = shuffle(picks);
    activeItems.forEach(i => { i.active = true; i.seenRound = roundNumber; });
  }

  function fillBoard(){
    if (roundMode === "phrase") fillPhraseRound();
    else fillWordRound();
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
      pool = smartSort([...bank.values()].filter(i => i.type==="word" && !i.active && idx(i.cefr)<=currentLevelIdx+1));
    }

    const next = pool.find(c => !isEnInActive(c.en, oldId));

    if (next) {
      next.active = true;
      next.seenRound = roundNumber;
      activeItems[idxOld] = next;
    } else {
      activeItems.splice(idxOld,1);
    }

    renderBoard();
  }

  // ---------- render / game ----------
  function renderBoard(){
    const en = $("enList");
    const pt = $("ptList");
    en.innerHTML = "";
    pt.innerHTML = "";

    const enCards = shuffle([...activeItems]);
    const ptCards = shuffle([...activeItems]);

    enCards.forEach(it => {
      const b = document.createElement("button");
      b.className = "card";
      b.dataset.key = it.id;

      if (playMode === "audio") {
        b.textContent = "🔊";
        b.setAttribute("aria-label", `Ouvir ${it.en}`);
        b.title = "Toque para ouvir";
        b.onclick = () => {
          speakSource(it.en);
          pick("en", it.id, b);
        };
      } else {
        b.textContent = it.en;
        b.onclick = () => pick("en", it.id, b);
      }

      en.appendChild(b);
    });

    ptCards.forEach(it => {
      const b = document.createElement("button");
      b.className = "card";
      b.dataset.key = it.id;
      b.textContent = it.pt;
      b.onclick = () => pick("pt", it.id, b);
      pt.appendChild(b);
    });

    hud();
  }

  function clearSelections(){
    document.querySelectorAll(".card.selected").forEach(c=>c.classList.remove("selected"));
    selectedEn = null;
    selectedPt = null;
  }

  function checkMastery(it){
    if (!it.mastered && it.streak >= MASTER_STREAK && it.correct >= MASTER_CORRECT) {
      it.mastered = true;
    }
  }

  function markWrong(a, b){
    if (a) wrongMap.set(a.id, a);
    if (b) wrongMap.set(b.id, b);
  }

  function pick(side, id, el){
    if (time<=0) return;
    document.querySelectorAll(".card.err,.card.ok").forEach(c=>c.classList.remove("err","ok"));

    if (side==="en") {
      document.querySelectorAll("#enList .card").forEach(c=>c.classList.remove("selected"));
      selectedEn = id;
      el.classList.add("selected");
    } else {
      document.querySelectorAll("#ptList .card").forEach(c=>c.classList.remove("selected"));
      selectedPt = id;
      el.classList.add("selected");
    }

    if (!(selectedEn && selectedPt)) return;

    const a = bank.get(selectedEn);
    const b = bank.get(selectedPt);

    const exactMatch = selectedEn === selectedPt;
    const semanticMatch = a && b && isEquivalentPT(a, b);
    const match = exactMatch || semanticMatch;

    const enEl = document.querySelector(`#enList .card[data-key="${selectedEn}"]`);
    const ptEl = document.querySelector(`#ptList .card[data-key="${selectedPt}"]`);

    if (match && a) {
      roundScore++;
      totalCorrect++;
      a.correct++;
      a.streak++;
      checkMastery(a);

      enEl?.classList.add("ok");
      ptEl?.classList.add("ok");

      if (!exactMatch && semanticMatch && b) {
        setMsg(`✅ Aceito por tradução equivalente: ${a.en} = ${b.pt}`, "ok");
      } else {
        setMsg(`✅ ${a.en} = ${a.pt}`, "ok");
      }

      maybeAdvance();
      saveProgress();
      setTimeout(()=>replaceMatched(a.id), 220);
    } else {
      if (a) { a.wrong++; a.streak = 0; }
      if (b) { b.wrong++; b.streak = 0; }

      markWrong(a, b);

      time = Math.max(0, time-2);
      enEl?.classList.add("err");
      ptEl?.classList.add("err");
      setMsg("❌ Não bateu. -2s", "err");
      saveProgress();
    }

    setTimeout(()=>{ clearSelections(); hud(); checkEnd(); }, 90);
  }

  function startTimer(){
    clearInterval(timerId);
    timerId = setInterval(()=>{
      time--;
      hud();
      checkEnd();
    },1000);
  }

  function buildEndItems(){
    const m = new Map();

    for (const it of wrongMap.values()) m.set(it.id, it);
    for (const it of activeItems) m.set(it.id, it);

    return [...m.values()];
  }

  function renderEndScreen(reason){
    const items = buildEndItems();
    const endList = $("endList");
    endList.innerHTML = "";

    const summary = reason === "timeout"
      ? `⏱️ Tempo esgotado. Acertos na rodada: ${roundScore}`
      : `🏆 Rodada concluída. Acertos na rodada: ${roundScore}`;
    $("endSummary").textContent = summary;

    if (!items.length) {
      const div = document.createElement("div");
      div.className = "end-item";
      div.innerHTML = `<span>Perfeito! Nenhum item pendente 🎉</span>`;
      endList.appendChild(div);
    } else {
      items.forEach(it => {
        const row = document.createElement("div");
        row.className = "end-item";

        const txt = document.createElement("span");
        txt.textContent = `${it.en} = ${it.pt}`;

        const right = document.createElement("div");
        right.className = "row";

        if (playMode === "audio") {
          const btn = document.createElement("button");
          btn.textContent = "🔊";
          btn.title = `Ouvir: ${it.en}`;
          btn.addEventListener("click", () => speakSource(it.en));
          right.appendChild(btn);
        }

        row.appendChild(txt);
        row.appendChild(right);
        endList.appendChild(row);
      });
    }

    goEndScreen();
  }

  function checkEnd(){
    if (time<=0) {
      clearInterval(timerId);
      renderEndScreen("timeout");
      return;
    }

    if (activeItems.length===0){
      clearInterval(timerId);
      renderEndScreen("clear");
    }
  }

  function newRound(){
    time = ROUND_TIME;
    roundScore = 0;
    resetRoundBuffers();
    clearSelections();

    roundNumber++;
    roundMode = decideRoundMode();
    decidePlayMode();

    fillBoard();

    setMsg(`Nova partida (${roundMode==="phrase" ? "frases" : "palavras"}) • ${playMode==="audio" ? "Escuta" : "Leitura"} • Base ${CEFR[currentLevelIdx]}`);
    saveProgress();
    goGameScreen();
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
      language: getLangCfg().label,
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
    rows.push(["language", r.language]);
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

  // ---------- actions ----------
  async function startGameFlow(){
    try {
      localStorage.setItem(KEYS.lang, currentLanguage);
      content = await loadContent();
      rebuildBank();
      hud();
      newRound();
    } catch (e) {
      goStartScreen();
      alert(`Erro ao iniciar: ${e.message}`);
    }
  }

  async function switchLanguage(langId){
    currentLanguage = langId;
    localStorage.setItem(KEYS.lang, currentLanguage);
    $("languageSelect").value = currentLanguage;

    // Não inicia automaticamente, só prepara UI
    const cfg = getLangCfg();
    $("gameTitle").textContent = cfg.label;
    $("sourceColumnTitle").textContent = cfg.sourceLabel;
    $("targetColumnTitle").textContent = cfg.targetLabel;
  }

  // ---------- events ----------
  function bindEvents(){
    $("startGameBtn").addEventListener("click", startGameFlow);
    $("goSettingsBtn").addEventListener("click", () => goSettingsScreen("startScreen"));

    $("openSettingsFromGameBtn").addEventListener("click", () => {
      clearInterval(timerId);
      goSettingsScreen("gameScreen");
    });

    $("goMenuFromGameBtn").addEventListener("click", goStartScreen);
    $("goMenuFromSettingsBtn").addEventListener("click", goStartScreen);
    $("goMenuFromEndBtn").addEventListener("click", goStartScreen);

    $("backFromSettingsBtn").addEventListener("click", () => {
      goBackFromSettings();
      if (previousScreen === "gameScreen" && time > 0) startTimer();
    });

    $("restartBtn").addEventListener("click", () => newRound());

    $("languageSelect").addEventListener("change", (e) => {
      switchLanguage(e.target.value);
    });

    $("addTimeBtn").addEventListener("click", () => {
      time += 30;
      hud();
      if (document.getElementById("gameScreen").classList.contains("active")) {
        setMsg("+30s");
      }
    });

    $("fullResetBtn").addEventListener("click", () => {
      if (!bank.size) return;
      resetProgress();
      alert("Progresso zerado.");
    });

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
        alert(`JSON aplicado: ${file.name}`);
      } catch (e) {
        alert(`JSON inválido: ${e.message}`);
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
        alert("Conteúdo padrão ativado.");
      } catch(e) {
        alert(`Falha ao voltar padrão: ${e.message}`);
      }
    });

    $("reportBtn").addEventListener("click", () => {
      if (!bank.size) {
        alert("Inicie ao menos uma partida antes de gerar relatório.");
        return;
      }
      const report = buildReport();
      const f = $("reportFormat").value;
      const day = new Date().toISOString().slice(0,10);
      const langTag = currentLanguage.replace("-", "_");

      if (f === "json") {
        download(`relatorio_${langTag}_${day}.json`, JSON.stringify(report, null, 2), "application/json;charset=utf-8");
      } else {
        download(`relatorio_${langTag}_${day}.csv`, reportToCSV(report), "text/csv;charset=utf-8");
      }
      alert(`Relatório ${f.toUpperCase()} gerado.`);
    });
  }

  async function init(){
    bindEvents();
    await switchLanguage(currentLanguage);
    goStartScreen();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(()=>{});
    }
  }

  init();
})();