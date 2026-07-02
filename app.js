(() => {
  "use strict";

  // =========================
  // Config
  // =========================
  const BOARD_SIZE = 6;
  const ROUND_TIME = 120;
  const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
  const MASTER_STREAK = 3;
  const MASTER_CORRECT = 4;
  const REVIEW_CHANCE = 0.18;

  const LANGS = {
    "en-pt": {
      label: "LinkWords (EN ↔ PT)",
      source: "INGLÊS",
      target: "PORTUGUÊS",
      file: "content.json",
      tts: "en-US"
    },
    "ja-pt": {
      label: "Japonês Visual",
      source: "JAPONÊS",
      target: "PORTUGUÊS",
      file: "content.json", // não usado no JP visual
      tts: "ja-JP"
    }
  };

  const KEYS = {
    lang: "lw_lang_v1",
    custom: "lw_custom_v1",
    progress: "lw_progress_v1"
  };

  // =========================
  // Utils
  // =========================
  const $ = (id) => document.getElementById(id);
  const has = (id) => !!$(id);

  const shuffle = (arr) =>
    arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

  const idx = (lv) => CEFR.indexOf(lv);
  const enKey = (s) => String(s || "").trim().toLowerCase();

  function normText(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function ptVariants(item) {
    const base = [item?.pt || ""];
    const extra = Array.isArray(item?.ptAlt) ? item.ptAlt : [];
    return [...base, ...extra].map(normText).filter(Boolean);
  }

  function isEquivalentPT(a, b) {
    const A = new Set(ptVariants(a));
    const B = new Set(ptVariants(b));
    for (const v of A) if (B.has(v)) return true;
    return false;
  }

  // =========================
  // State
  // =========================
  let content = null;
  let bank = new Map();
  let activeItems = [];
  let wrongMap = new Map();
  let timerId = null;

  let currentLanguage = localStorage.getItem(KEYS.lang) || "en-pt";

  let currentLevelIdx = 0;
  let introducedNextCount = 0;
  let roundNumber = 0;
  let roundMode = "word";   // word | phrase
  let playMode = "text";    // text | audio
  let sessionType = "normal"; // normal | reinforce

  let totalCorrect = 0;
  let roundScore = 0;
  let time = ROUND_TIME;

  let selectedEn = null;
  let selectedPt = null;

  let previousScreen = "startScreen";
  let reinforcePool = [];

  // =========================
  // Screen
  // =========================
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    if ($(id)) $(id).classList.add("active");
  }

  function goStart() {
    clearInterval(timerId);
    showScreen("startScreen");
  }

  function goGame() {
    showScreen("gameScreen");
  }

  function goJP() {
    clearInterval(timerId);
    showScreen("jpVisualScreen");
  }

  function goSettings(from = "startScreen") {
    previousScreen = from;
    showScreen("settingsScreen");
  }

  function goBackFromSettings() {
    showScreen(previousScreen);
    if (previousScreen === "gameScreen" && time > 0) startTimer();
  }

  // =========================
  // Language
  // =========================
  function langCfg() {
    return LANGS[currentLanguage] || LANGS["en-pt"];
  }

  function renderLanguageButtons() {
    if (has("langEnPtBtn")) $("langEnPtBtn").classList.toggle("active", currentLanguage === "en-pt");
    if (has("langJaPtBtn")) $("langJaPtBtn").classList.toggle("active", currentLanguage === "ja-pt");
  }

  async function switchLanguage(lang) {
    currentLanguage = lang;
    localStorage.setItem(KEYS.lang, currentLanguage);
    renderLanguageButtons();

    const cfg = langCfg();
    if (has("gameTitle")) $("gameTitle").textContent = cfg.label;
    if (has("sourceColumnTitle")) $("sourceColumnTitle").textContent = cfg.source;
    if (has("targetColumnTitle")) $("targetColumnTitle").textContent = cfg.target;
  }

  // =========================
  // UI
  // =========================
  function setMsg(msg, kind = "") {
    if (!has("msg")) return;
    const el = $("msg");
    el.textContent = msg;
    el.style.color = kind === "ok" ? "#86efac" : kind === "err" ? "#fca5a5" : "#9FB1CE";
  }

  function hud() {
    const cfg = langCfg();
    if (has("gameTitle")) {
      $("gameTitle").textContent =
        sessionType === "reinforce" ? `${cfg.label} • Reforçando` : cfg.label;
    }
    if (has("sourceColumnTitle")) $("sourceColumnTitle").textContent = cfg.source;
    if (has("targetColumnTitle")) $("targetColumnTitle").textContent = cfg.target;

    if (has("level")) $("level").textContent = CEFR[currentLevelIdx];
    if (has("xp")) $("xp").textContent = String(totalCorrect);
    if (has("roundScore")) $("roundScore").textContent = String(roundScore);
    if (has("playMode")) $("playMode").textContent = playMode === "audio" ? "Escuta" : "Leitura";
    if (has("time")) $("time").textContent = String(time);
  }

  function clearSelections() {
    document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    selectedEn = null;
    selectedPt = null;
  }

  // =========================
  // Audio
  // =========================
  function speakSource(text) {
    const cfg = langCfg();

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = cfg.tts;
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
      return;
    }

    const tl = cfg.tts.startsWith("ja") ? "ja" : "en";
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${tl}&q=${encodeURIComponent(text)}`;
    new Audio(url).play().catch(() => {});
  }

  // =========================
  // Storage keys by language
  // =========================
  const keyCustom = () => `${KEYS.custom}_${currentLanguage}`;
  const keyProgress = () => `${KEYS.progress}_${currentLanguage}`;

  // =========================
  // Content
  // =========================
  function validateContent(obj) {
    if (!obj || typeof obj !== "object" || !obj.levels) {
      throw new Error("JSON inválido: faltou levels.");
    }

    for (const lv of CEFR) {
      const node = obj.levels[lv] || { words: [], phrases: [] };
      if (!Array.isArray(node.words) || !Array.isArray(node.phrases)) {
        throw new Error(`JSON inválido em ${lv}.`);
      }
      for (const w of node.words) if (!w.en || !w.pt) throw new Error(`Palavra inválida em ${lv}.`);
      for (const p of node.phrases) if (!p.en || !p.pt) throw new Error(`Frase inválida em ${lv}.`);
    }
  }

  async function loadDefaultContent() {
    const res = await fetch(langCfg().file);
    if (!res.ok) throw new Error(`Não consegui carregar ${langCfg().file}`);
    return res.json();
  }

  async function loadContent() {
    const custom = localStorage.getItem(keyCustom());
    if (custom) {
      const parsed = JSON.parse(custom);
      validateContent(parsed);
      return parsed;
    }

    const def = await loadDefaultContent();
    validateContent(def);
    return def;
  }

  function rebuildBank() {
    bank = new Map();

    for (const lv of CEFR) {
      const node = content.levels[lv] || { words: [], phrases: [] };

      node.words.forEach((w, i) => {
        const id = `w_${lv}_${i}_${String(w.en)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 28)}`;

        bank.set(id, {
          id,
          en: w.en,
          pt: w.pt,
          ptAlt: Array.isArray(w.ptAlt) ? w.ptAlt : [],
          cefr: lv,
          type: "word",
          prereqWords: [],
          correct: 0,
          wrong: 0,
          streak: 0,
          mastered: false,
          active: false,
          seenRound: 0
        });
      });

      node.phrases.forEach((p, i) => {
        const id = `p_${lv}_${i}_${String(p.en)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 28)}`;

        bank.set(id, {
          id,
          en: p.en,
          pt: p.pt,
          ptAlt: Array.isArray(p.ptAlt) ? p.ptAlt : [],
          cefr: lv,
          type: "phrase",
          prereqWords: Array.isArray(p.prereqWords) ? p.prereqWords : [],
          correct: 0,
          wrong: 0,
          streak: 0,
          mastered: false,
          active: false,
          seenRound: 0
        });
      });
    }

    loadProgress();
  }

  // =========================
  // Progress
  // =========================
  function saveProgress() {
    const stats = {};
    for (const [id, it] of bank.entries()) {
      stats[id] = { c: it.correct, w: it.wrong, s: it.streak, m: it.mastered };
    }

    localStorage.setItem(
      keyProgress(),
      JSON.stringify({
        totalCorrect,
        currentLevelIdx,
        introducedNextCount,
        roundNumber,
        stats
      })
    );
  }

  function loadProgress() {
    const raw = localStorage.getItem(keyProgress());
    if (!raw) return;

    try {
      const p = JSON.parse(raw);
      totalCorrect = Number(p.totalCorrect || 0);
      currentLevelIdx = Math.max(0, Math.min(5, Number(p.currentLevelIdx || 0)));
      introducedNextCount = Math.max(0, Math.min(2, Number(p.introducedNextCount || 0)));
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
    } catch {
      // ignore progress corruption
    }
  }

  function resetProgress() {
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

  // =========================
  // Progression logic
  // =========================
  function levelStats(level) {
    const arr = [...bank.values()].filter((i) => i.type === "word" && i.cefr === level);
    const total = arr.length || 1;
    const mastered = arr.filter((i) => i.mastered).length;
    const attempts = arr.reduce((s, i) => s + i.correct + i.wrong, 0);
    const correct = arr.reduce((s, i) => s + i.correct, 0);
    return { ratio: mastered / total, attempts, acc: attempts ? correct / attempts : 0 };
  }

  function maybeAdvance() {
    const next = currentLevelIdx + 1;
    if (next >= CEFR.length) return;

    const curr = levelStats(CEFR[currentLevelIdx]);
    const nx = levelStats(CEFR[next]);

    if (introducedNextCount === 0 && curr.ratio >= 0.72 && curr.attempts >= 24 && curr.acc >= 0.68) {
      introducedNextCount = 1;
      saveProgress();
      return;
    }

    if (introducedNextCount === 1 && curr.ratio >= 0.84 && curr.attempts >= 34 && curr.acc >= 0.72) {
      introducedNextCount = 2;
      saveProgress();
      return;
    }

    const nextReady = nx.attempts >= 18 && (nx.acc >= 0.62 || nx.ratio >= 0.2);
    if (introducedNextCount >= 2 && curr.ratio >= 0.9 && curr.acc >= 0.75 && nextReady) {
      currentLevelIdx = next;
      introducedNextCount = 0;
      saveProgress();
    }
  }

  function decideRoundMode() {
    if (currentLevelIdx < 1) return "word";
    if (currentLevelIdx === 1) return roundNumber % 3 === 0 ? "phrase" : "word";
    if (currentLevelIdx === 2) return roundNumber % 2 === 0 ? "phrase" : "word";
    if (currentLevelIdx === 3) return roundNumber % 3 === 1 ? "word" : "phrase";
    return "phrase";
  }

  function decidePlayMode() {
    playMode = roundNumber % 2 === 0 ? "audio" : "text";
  }

  function checkMastery(it) {
    if (!it.mastered && it.streak >= MASTER_STREAK && it.correct >= MASTER_CORRECT) {
      it.mastered = true;
    }
  }

  function smartSort(pool) {
    return pool.sort((a, b) => {
      const am = a.mastered ? 1 : 0;
      const bm = b.mastered ? 1 : 0;
      if (am !== bm) return am - bm;

      const as = a.correct - a.wrong;
      const bs = b.correct - b.wrong;
      if (as !== bs) return as - bs;

      return a.seenRound - b.seenRound;
    });
  }

  function masteredWordsSet() {
    const s = new Set();
    for (const i of bank.values()) if (i.type === "word" && i.mastered) s.add(i.en.toLowerCase());
    return s;
  }

  function phraseEligible(it) {
    if (it.type !== "phrase" || idx(it.cefr) > currentLevelIdx) return false;
    const req = it.prereqWords || [];
    if (!req.length) return true;

    const solid = masteredWordsSet();
    const hit = req.filter((w) => solid.has(String(w).toLowerCase())).length;
    return hit >= Math.ceil(req.length / 2);
  }

  function isEnInActive(en, ignoreId = null) {
    const key = enKey(en);
    return activeItems.some((i) => i.id !== ignoreId && enKey(i.en) === key);
  }

  // =========================
  // Reinforce mode
  // =========================
  function getUnlockedWords() {
    return [...bank.values()].filter((i) => i.type === "word" && idx(i.cefr) <= currentLevelIdx);
  }

  function buildReinforcePool() {
    const unlocked = getUnlockedWords();
    if (!unlocked.length) {
      reinforcePool = [];
      return;
    }

    const withErrors = unlocked.filter((i) => i.wrong > 0);
    const base = withErrors.length
      ? withErrors
      : [...unlocked]
          .sort((a, b) => b.wrong - b.correct - (a.wrong - a.correct))
          .slice(0, Math.min(20, unlocked.length));

    reinforcePool = base.map((item) => ({
      item,
      weight: Math.max(
        1,
        1 + item.wrong * 4 + (item.wrong > item.correct ? 3 : 0) + (item.mastered ? 0 : 2)
      )
    }));
  }

  function weightedChoice(pool) {
    const total = pool.reduce((s, p) => s + p.weight, 0);
    if (!total) return null;

    let r = Math.random() * total;
    for (const p of pool) {
      r -= p.weight;
      if (r <= 0) return p.item;
    }
    return pool[pool.length - 1]?.item || null;
  }

  // =========================
  // Board build
  // =========================
  function fillWordRound() {
    for (const i of bank.values()) i.active = false;
    activeItems = [];

    const all = [...bank.values()].filter((i) => i.type === "word");
    const prev = all.filter((i) => idx(i.cefr) < currentLevelIdx);
    const curr = all.filter((i) => idx(i.cefr) === currentLevelIdx);
    const next = all.filter((i) => idx(i.cefr) === currentLevelIdx + 1);

    const reviewQ = currentLevelIdx > 0 && Math.random() < REVIEW_CHANCE ? 1 : 0;
    const nextQ = Math.min(introducedNextCount, 2, next.length);
    const currQ = Math.max(0, BOARD_SIZE - reviewQ - nextQ);

    const picks = [];
    const usedEn = new Set();

    const addFrom = (arr, qWanted) => {
      let q = qWanted;
      for (const it of smartSort([...arr])) {
        if (q <= 0 || picks.length >= BOARD_SIZE) break;
        const k = enKey(it.en);
        if (usedEn.has(k)) continue;
        picks.push(it);
        usedEn.add(k);
        q--;
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
    activeItems.forEach((i) => {
      i.active = true;
      i.seenRound = roundNumber;
    });
  }

  function fillPhraseRound() {
    for (const i of bank.values()) i.active = false;

    let pool = smartSort([...bank.values()].filter((i) => i.type === "phrase" && phraseEligible(i)));
    if (!pool.length) pool = smartSort(getUnlockedWords());

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
    activeItems.forEach((i) => {
      i.active = true;
      i.seenRound = roundNumber;
    });
  }

  function fillReinforceRound() {
    for (const i of bank.values()) i.active = false;
    activeItems = [];
    buildReinforcePool();

    const usedIds = new Set();
    const usedEn = new Set();

    while (activeItems.length < BOARD_SIZE) {
      let cand = null;

      for (let t = 0; t < 80; t++) {
        const x = weightedChoice(reinforcePool);
        if (!x) break;
        if (usedIds.has(x.id) || usedEn.has(enKey(x.en)) || x.active) continue;
        cand = x;
        break;
      }

      if (!cand) break;

      cand.active = true;
      cand.seenRound = roundNumber;
      activeItems.push(cand);
      usedIds.add(cand.id);
      usedEn.add(enKey(cand.en));
    }

    if (activeItems.length < BOARD_SIZE) {
      for (const f of smartSort(getUnlockedWords())) {
        if (activeItems.length >= BOARD_SIZE) break;
        if (usedEn.has(enKey(f.en)) || f.active) continue;

        f.active = true;
        f.seenRound = roundNumber;
        activeItems.push(f);
        usedEn.add(enKey(f.en));
      }
    }

    activeItems = shuffle(activeItems);
  }

  function fillBoard() {
    if (sessionType === "reinforce") fillReinforceRound();
    else if (roundMode === "phrase") fillPhraseRound();
    else fillWordRound();

    renderBoard();
  }

  function replaceMatched(oldId) {
    const i = activeItems.findIndex((x) => x.id === oldId);
    if (i < 0) return;

    const old = activeItems[i];
    old.active = false;

    if (sessionType === "reinforce") {
      buildReinforcePool();

      const activeEn = new Set(
        activeItems.filter((x) => x.id !== oldId).map((x) => enKey(x.en))
      );

      let next = null;
      for (let t = 0; t < 80; t++) {
        const cand = weightedChoice(reinforcePool);
        if (!cand) break;
        if (cand.active || activeEn.has(enKey(cand.en))) continue;
        next = cand;
        break;
      }

      if (next) {
        next.active = true;
        next.seenRound = roundNumber;
        activeItems[i] = next;
      } else {
        activeItems.splice(i, 1);
      }

      renderBoard();
      return;
    }

    let pool = [];
    if (roundMode === "phrase") {
      pool = smartSort(
        [...bank.values()].filter((x) => x.type === "phrase" && !x.active && phraseEligible(x))
      );
    } else {
      pool = smartSort(
        [...bank.values()].filter(
          (x) => x.type === "word" && !x.active && idx(x.cefr) <= currentLevelIdx + 1
        )
      );
    }

    const next = pool.find((c) => !isEnInActive(c.en, oldId));
    if (next) {
      next.active = true;
      next.seenRound = roundNumber;
      activeItems[i] = next;
    } else {
      activeItems.splice(i, 1);
    }

    renderBoard();
  }

  // =========================
  // Render game
  // =========================
  function renderBoard() {
    if (!has("enList") || !has("ptList")) return;

    const en = $("enList");
    const pt = $("ptList");
    en.innerHTML = "";
    pt.innerHTML = "";

    const enCards = shuffle([...activeItems]);
    const ptCards = shuffle([...activeItems]);

    enCards.forEach((it) => {
      const b = document.createElement("button");
      b.className = "card";
      b.dataset.key = it.id;

      if (playMode === "audio") {
        b.textContent = "🔊";
        b.title = `Ouvir ${it.en}`;
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

    ptCards.forEach((it) => {
      const b = document.createElement("button");
      b.className = "card";
      b.dataset.key = it.id;
      b.textContent = it.pt;
      b.onclick = () => pick("pt", it.id, b);
      pt.appendChild(b);
    });

    hud();
  }

  function markWrong(a, b) {
    if (a) wrongMap.set(a.id, a);
    if (b) wrongMap.set(b.id, b);
  }

  function pick(side, id, el) {
    if (time <= 0) return;

    document.querySelectorAll(".card.err,.card.ok").forEach((c) => c.classList.remove("err", "ok"));

    if (side === "en") {
      document.querySelectorAll("#enList .card").forEach((c) => c.classList.remove("selected"));
      selectedEn = id;
      el.classList.add("selected");
    } else {
      document.querySelectorAll("#ptList .card").forEach((c) => c.classList.remove("selected"));
      selectedPt = id;
      el.classList.add("selected");
    }

    if (!(selectedEn && selectedPt)) return;

    const a = bank.get(selectedEn);
    const b = bank.get(selectedPt);

    const exact = selectedEn === selectedPt;
    const semantic = a && b && isEquivalentPT(a, b);
    const match = exact || semantic;

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

      if (!exact && semantic && b) {
        setMsg(`✅ Aceito por tradução equivalente: ${a.en} = ${b.pt}`, "ok");
      } else {
        setMsg(`✅ ${a.en} = ${a.pt}`, "ok");
      }

      maybeAdvance();
      saveProgress();
      setTimeout(() => replaceMatched(a.id), 220);
    } else {
      if (a) {
        a.wrong++;
        a.streak = 0;
      }
      if (b) {
        b.wrong++;
        b.streak = 0;
      }

      markWrong(a, b);

      time = Math.max(0, time - 2);
      enEl?.classList.add("err");
      ptEl?.classList.add("err");
      setMsg("❌ Não bateu. -2s", "err");
      saveProgress();
    }

    setTimeout(() => {
      clearSelections();
      hud();
      checkEnd();
    }, 90);
  }

  // =========================
  // End screen
  // =========================
  function buildEndItems() {
    const m = new Map();
    for (const i of wrongMap.values()) m.set(i.id, i);
    for (const i of activeItems) m.set(i.id, i);
    return [...m.values()];
  }

  function renderEnd(reason) {
    if (!has("endList") || !has("endSummary")) {
      goStart();
      return;
    }

    const endList = $("endList");
    endList.innerHTML = "";

    $("endSummary").textContent =
      reason === "timeout"
        ? `⏱️ Tempo esgotado • Acertos: ${roundScore}`
        : `🏁 Partida finalizada • Acertos: ${roundScore}`;

    const items = buildEndItems();
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "end-item";
      d.textContent = "Perfeito! Nenhum item pendente 🎉";
      endList.appendChild(d);
    } else {
      items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "end-item";

        const t = document.createElement("span");
        t.textContent = `${it.en} = ${it.pt}`;
        row.appendChild(t);

        if (playMode === "audio") {
          const right = document.createElement("div");
          const b = document.createElement("button");
          b.textContent = "🔊";
          b.onclick = () => speakSource(it.en);
          right.appendChild(b);
          row.appendChild(right);
        }

        endList.appendChild(row);
      });
    }

    showScreen("endScreen");
  }

  // =========================
  // Timer / rounds
  // =========================
  function startTimer() {
    clearInterval(timerId);
    timerId = setInterval(() => {
      time--;
      hud();
      checkEnd();
    }, 1000);
  }

  function checkEnd() {
    if (time <= 0) {
      clearInterval(timerId);
      renderEnd("timeout");
      return;
    }

    if (activeItems.length === 0) {
      clearInterval(timerId);
      renderEnd("clear");
    }
  }

  function newRound() {
    time = ROUND_TIME;
    roundScore = 0;
    wrongMap = new Map();
    clearSelections();

    roundNumber++;
    roundMode = sessionType === "reinforce" ? "word" : decideRoundMode();
    decidePlayMode();

    fillBoard();

    const modeText = playMode === "audio" ? "Escuta" : "Leitura";
    if (sessionType === "reinforce") {
      setMsg(`🔥 Reforçando • palavras com mais erro • ${modeText}`);
    } else {
      setMsg(`Nova partida (${roundMode === "phrase" ? "frases" : "palavras"}) • ${modeText}`);
    }

    saveProgress();
    goGame();
    startTimer();
  }

  // =========================
  // Reports
  // =========================
  function acc(c, w) {
    const t = c + w;
    return t ? c / t : 0;
  }

  function buildReport() {
    const items = [...bank.values()];
    const practiced = items.filter((i) => i.correct + i.wrong > 0);
    const c = practiced.reduce((s, i) => s + i.correct, 0);
    const w = practiced.reduce((s, i) => s + i.wrong, 0);

    const byLevel = {};
    for (const lv of CEFR) {
      const arr = items.filter((i) => i.cefr === lv);
      const lc = arr.reduce((s, i) => s + i.correct, 0);
      const lw = arr.reduce((s, i) => s + i.wrong, 0);

      byLevel[lv] = {
        attempts: lc + lw,
        correct: lc,
        wrong: lw,
        accuracy: acc(lc, lw),
        masteredWords: arr.filter((i) => i.type === "word" && i.mastered).length
      };
    }

    const hardest = [...practiced]
      .sort(
        (a, b) =>
          b.wrong - a.wrong || b.correct + b.wrong - (a.correct + a.wrong)
      )
      .slice(0, 10)
      .map((i) => ({
        en: i.en,
        pt: i.pt,
        type: i.type,
        level: i.cefr,
        attempts: i.correct + i.wrong,
        correct: i.correct,
        wrong: i.wrong,
        accuracy: acc(i.correct, i.wrong)
      }));

    return {
      generatedAt: new Date().toISOString(),
      language: langCfg().label,
      sessionType,
      currentLevel: CEFR[currentLevelIdx],
      roundsPlayed: roundNumber,
      totals: { attempts: c + w, correct: c, wrong: w, accuracy: acc(c, w) },
      byLevel,
      hardestItems: hardest
    };
  }

  function reportToCSV(r) {
    const rows = [];
    rows.push(["language", r.language]);
    rows.push(["sessionType", r.sessionType]);
    rows.push(["section", "en", "pt", "type", "level", "attempts", "correct", "wrong", "accuracy"]);

    r.hardestItems.forEach((i) => {
      rows.push([
        "hardest",
        i.en,
        i.pt,
        i.type,
        i.level,
        i.attempts,
        i.correct,
        i.wrong,
        (i.accuracy * 100).toFixed(1) + "%"
      ]);
    });

    rows.push([]);
    rows.push(["level", "attempts", "correct", "wrong", "accuracy", "masteredWords"]);

    CEFR.forEach((lv) => {
      const x = r.byLevel[lv];
      rows.push([
        lv,
        x.attempts,
        x.correct,
        x.wrong,
        (x.accuracy * 100).toFixed(1) + "%",
        x.masteredWords
      ]);
    });

    return rows
      .map((cols) => cols.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // =========================
  // Flow
  // =========================
  async function startGameFlow(mode = "normal"){
    sessionType = mode;

  // Japonês abre tela visual (não carrega content-ja.json)
    if (currentLanguage === "ja-pt") {
      goJP();
      if (typeof window.startJPVisualTraining === "function") {
        window.startJPVisualTraining();
      }
      return;
    }

    // Inglês segue fluxo normal
    try{
      content = await loadContent();
      rebuildBank();
      hud();
      newRound();
    } catch (e){
      goStart();
      alert(`Erro ao iniciar: ${e.message}`);
    }
  }

  // =========================
  // Events (bind completo)
  // =========================
  function bindEvents() {
    const on = (id, event, fn) => {
      const el = $(id);
      if (el) el.addEventListener(event, fn);
    };

    // Idioma
    on("langEnPtBtn", "click", () => switchLanguage("en-pt"));
    on("langJaPtBtn", "click", () => switchLanguage("ja-pt"));

    // Início
    on("startGameBtn", "click", () => startGameFlow("normal"));
    on("startReinforceBtn", "click", () => {
      if (currentLanguage === "ja-pt") {
        goJP();
        if (typeof window.startJPVisualTraining === "function") {
          window.startJPVisualTraining();
        }
        return;
      }
      startGameFlow("reinforce");
    });

    // Navegação
    on("goSettingsBtn", "click", () => goSettings("startScreen"));
    on("openSettingsFromGameBtn", "click", () => {
      clearInterval(timerId);
      goSettings("gameScreen");
    });

    on("goMenuFromGameBtn", "click", goStart);
    on("goMenuFromSettingsBtn", "click", goStart);
    on("goMenuFromEndBtn", "click", goStart);
    on("goMenuFromJPBtn", "click", goStart);
    on("backFromSettingsBtn", "click", goBackFromSettings);

    // Jogo EN
    on("restartBtn", "click", () => newRound());
    on("addTimeBtn", "click", () => {
      time += 30;
      hud();
    });

    on("fullResetBtn", "click", () => {
      if (bank.size) {
        resetProgress();
        alert("Progresso zerado.");
      }
    });

    // JP visual
    on("jpStartBtn", "click", () => {
      if (typeof window.startJPVisualTraining === "function") {
        window.startJPVisualTraining();
      }
    });

    // JSON custom
    on("pickJsonBtn", "click", () => $("fileInput")?.click());

    on("fileInput", "change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;

      try {
        const txt = await file.text();
        const obj = JSON.parse(txt);
        validateContent(obj);
        localStorage.setItem(keyCustom(), JSON.stringify(obj));
        content = obj;
        rebuildBank();
        alert(`JSON aplicado: ${file.name}`);
      } catch (e) {
        alert(`JSON inválido: ${e.message}`);
      } finally {
        ev.target.value = "";
      }
    });

    on("useDefaultBtn", "click", async () => {
      try {
        localStorage.removeItem(keyCustom());
        content = await loadDefaultContent();
        validateContent(content);
        rebuildBank();
        alert("Conteúdo padrão ativado.");
      } catch (e) {
        alert(`Falha ao ativar padrão: ${e.message}`);
      }
    });

    // Relatórios
    on("reportBtn", "click", () => {
      if (!bank.size) {
        alert("Inicie uma partida antes.");
        return;
      }

      const r = buildReport();
      const fmt = $("reportFormat")?.value || "json";
      const day = new Date().toISOString().slice(0, 10);
      const tag = (currentLanguage || "en-pt").replace("-", "_");

      if (fmt === "json") {
        download(
          `relatorio_${tag}_${day}.json`,
          JSON.stringify(r, null, 2),
          "application/json;charset=utf-8"
        );
      } else {
        download(`relatorio_${tag}_${day}.csv`, reportToCSV(r), "text/csv;charset=utf-8");
      }

      alert(`Relatório ${fmt.toUpperCase()} gerado.`);
    });
  }

  // =========================
  // Init
  // =========================
  async function init() {
    bindEvents();
    await switchLanguage(currentLanguage);
    goStart();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  init();
})();