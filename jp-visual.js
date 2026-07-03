let jpWords = [];
let jpQueue = [];
let jpDeck = [];        // 5 imagens atuais (estáticas)
let jpFlashPool = [];   // acumulado para áudio + tradução (sem duplicar)
let jpCurrentFlash = null;
let jpBusy = false;
let jpFlashQueue = [];
let jpFlashIndex = 0;

const JP_DECK_SIZE = 5;

const jpBoard = document.getElementById("jpBoard");
const jpStatus = document.getElementById("jpStatus");

const jpModeImageBtn = document.getElementById("jpModeImageBtn");
const jpModeFlashBtn = document.getElementById("jpModeFlashBtn");
const jpImageSection = document.getElementById("jpImageSection");
const jpFlashSection = document.getElementById("jpFlashSection");

const jpGenerateBtn = document.getElementById("jpGenerateBtn");

const jpFlashHead = document.getElementById("jpFlashHead");
const jpFlashOptions = document.getElementById("jpFlashOptions");
const jpFlashFeedback = document.getElementById("jpFlashFeedback");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setStatus(msg, kind = "info") {
  if (!jpStatus) return;
  jpStatus.textContent = msg;
  if (kind === "ok") jpStatus.style.color = "#86efac";
  else if (kind === "err") jpStatus.style.color = "#fca5a5";
  else if (kind === "warn") jpStatus.style.color = "#fcd34d";
  else jpStatus.style.color = "#9FB1CE";
}

async function loadJPWords() {
  const res = await fetch("jp-visual-week1.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Falha ao carregar jp-visual-week1.json (HTTP ${res.status})`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("JSON japonês inválido.");
  }

  if (!Array.isArray(data) || !data.length) {
    throw new Error("JSON japonês vazio.");
  }

  const cleaned = data.filter((w) => {
    const hasId = typeof w?.id === "string" && w.id.trim();
    const hasPt = typeof w?.pt === "string" && w.pt.trim();
    const hasImage = typeof w?.image === "string" && w.image.trim();
    const hasJP = (typeof w?.kana === "string" && w.kana.trim()) || (typeof w?.jp === "string" && w.jp.trim());
    return hasId && hasPt && hasImage && hasJP;
  });

  if (!cleaned.length) throw new Error("Nenhuma palavra válida no JSON japonês.");

  jpWords = cleaned;
  jpQueue = shuffle(jpWords);
}

function nextWord(excludeIds = new Set()) {
  if (!jpQueue.length) jpQueue = shuffle(jpWords);

  for (let i = 0; i < jpQueue.length; i++) {
    const w = jpQueue[i];
    if (!excludeIds.has(w.id)) {
      jpQueue.splice(i, 1);
      return w;
    }
  }

  jpQueue = shuffle(jpWords);
  const w = jpQueue.find((x) => !excludeIds.has(x.id));
  if (!w) return null;

  const idx = jpQueue.findIndex((x) => x.id === w.id);
  if (idx >= 0) jpQueue.splice(idx, 1);
  return w;
}

function buildDeck() {
  const used = new Set();
  const deck = [];

  while (deck.length < JP_DECK_SIZE) {
    const w = nextWord(used);
    if (!w) break;
    deck.push(w);
    used.add(w.id);
  }

  jpDeck = deck;
}

function addDeckToFlashPool() {
  const used = new Set(jpFlashPool.map((w) => w.id));
  for (const w of jpDeck) {
    if (!used.has(w.id)) {
      jpFlashPool.push(w);
      used.add(w.id);
    }
  }
}

function setMode(mode) {
  const imageMode = mode === "image";

  jpImageSection?.classList.toggle("active", imageMode);
  jpFlashSection?.classList.toggle("active", !imageMode);
  jpModeImageBtn?.classList.toggle("active", imageMode);
  jpModeFlashBtn?.classList.toggle("active", !imageMode);

  if (imageMode) {
    setStatus(`Imagens: ${jpDeck.length} • Pool flash: ${jpFlashPool.length}/${jpWords.length}`, "ok");
  } else {
    if (!jpFlashPool.length) {
      setStatus("Flash vazio. Clique em Gerar novas imagens no modo Imagens + áudio.", "warn");
      if (jpFlashOptions) jpFlashOptions.innerHTML = "";
      if (jpFlashFeedback) jpFlashFeedback.textContent = "";
      if (jpFlashHead) jpFlashHead.textContent = "Áudio + tradução";
      return;
    }
    buildFlashRound();
    renderFlashQuestion();
    setStatus(`Flash ativo • Pool: ${jpFlashPool.length}/${jpWords.length}`, "ok");
  }
}

function renderImageDeck() {
  if (!jpBoard) return;
  jpBoard.innerHTML = "";

  jpDeck.forEach((item) => {
    const card = document.createElement("article");
    card.className = "jp-card";

    const img = document.createElement("img");
    img.src = item.image;
    img.alt = item.pt || item.id || "Imagem";
    img.loading = "lazy";
    img.onerror = () => {
      img.style.opacity = "0.35";
      setStatus(`Imagem não encontrada: ${item.image}`, "warn");
    };

    const meta = document.createElement("div");
    meta.className = "jp-meta";
    meta.innerHTML = `<div>${item.pt}</div><small>${item.jp || ""} ${item.kana ? `• ${item.kana}` : ""}</small>`;

    const actions = document.createElement("div");
    actions.className = "jp-actions";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "jp-audio-btn";
    btn.textContent = "🔊 Ouvir (3x)";
    btn.addEventListener("click", async () => {
      if (jpBusy) return;
      jpBusy = true;
      await playJPTriple(item);
      jpBusy = false;
    });

    actions.appendChild(btn);
    card.appendChild(img);
    card.appendChild(meta);
    card.appendChild(actions);
    jpBoard.appendChild(card);
  });

  setStatus(`Imagens: ${jpDeck.length} • Pool flash: ${jpFlashPool.length}/${jpWords.length}`, "ok");
}

function speakTTSJP(text, rate = 1) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = rate;
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.speak(u);
  });
}

function playAudioFile(url, rate = 1) {
  return new Promise((resolve) => {
    const a = new Audio(url);
    a.playbackRate = rate;
    a.onended = resolve;
    a.onerror = resolve;
    a.play().catch(resolve);
  });
}

async function playJPTriple(item) {
  const seq = [1.0, 1.0, 0.8];
  for (const r of seq) {
    if (item.audio && String(item.audio).trim()) await playAudioFile(item.audio, r);
    else await speakTTSJP(item.kana || item.jp, r);
    await sleep(180);
  }
}

async function playJPOne(item) {
  if (!item) return;
  if (item.audio && String(item.audio).trim()) await playAudioFile(item.audio, 1.0);
  else await speakTTSJP(item.kana || item.jp, 1.0);
}

function buildFlashRound() {
  jpFlashQueue = shuffle([...jpFlashPool]);
  jpFlashIndex = 0;
  jpCurrentFlash = null;
}

function flashOptions(correct) {
  const distractors = shuffle(jpWords.filter((w) => w.id !== correct.id)).slice(0, 2);
  return shuffle([correct, ...distractors]);
}

async function renderFlashQuestion() {
  if (!jpFlashOptions || !jpFlashHead || !jpFlashFeedback) return;

  if (!jpFlashQueue.length) {
    jpFlashOptions.innerHTML = "";
    jpFlashFeedback.textContent = "Sem palavras no flash.";
    return;
  }

  if (jpFlashIndex >= jpFlashQueue.length) {
    jpFlashQueue = shuffle([...jpFlashPool]);
    jpFlashIndex = 0;
  }

  jpCurrentFlash = jpFlashQueue[jpFlashIndex];
  jpFlashHead.textContent = `Áudio + tradução • ${jpFlashIndex + 1}/${jpFlashQueue.length}`;
  jpFlashFeedback.textContent = "Escute e escolha a tradução correta.";
  jpFlashFeedback.style.color = "#9FB1CE";

  const opts = flashOptions(jpCurrentFlash);
  jpFlashOptions.innerHTML = "";

  opts.forEach((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt.pt;
    b.addEventListener("click", () => answerFlash(opt.id === jpCurrentFlash.id, opt, jpCurrentFlash));
    jpFlashOptions.appendChild(b);
  });

  await playJPOne(jpCurrentFlash); // toca automaticamente 1x
}

function answerFlash(correct, chosen, target) {
  const btns = [...jpFlashOptions.querySelectorAll("button")];
  btns.forEach((b) => (b.disabled = true));

  if (correct) {
    jpFlashFeedback.style.color = "#86efac";
    jpFlashFeedback.textContent = `✅ Correto: ${target.pt}`;
  } else {
    jpFlashFeedback.style.color = "#fca5a5";
    jpFlashFeedback.textContent = `❌ Você marcou "${chosen.pt}". Correto: ${target.pt}`;
  }

  setTimeout(async () => {
    jpFlashIndex += 1;
    await renderFlashQuestion();
  }, 650);
}

function bindOnce() {
  if (jpModeImageBtn && !jpModeImageBtn.dataset.bound) {
    jpModeImageBtn.dataset.bound = "1";
    jpModeImageBtn.addEventListener("click", () => setMode("image"));
  }

  if (jpModeFlashBtn && !jpModeFlashBtn.dataset.bound) {
    jpModeFlashBtn.dataset.bound = "1";
    jpModeFlashBtn.addEventListener("click", () => setMode("flash"));
  }

  if (jpGenerateBtn && !jpGenerateBtn.dataset.bound) {
    jpGenerateBtn.dataset.bound = "1";
    jpGenerateBtn.addEventListener("click", () => {
      addDeckToFlashPool();   // envia as 5 atuais para o pool de associação
      buildDeck();            // gera novo lote de 5 imagens
      renderImageDeck();
    });
  }

  // segundo botão Menu da tela flash usa mesmo comportamento do primeiro
  const goMenuFromJPBtnFlash = document.getElementById("goMenuFromJPBtnFlash");
  const goMenuFromJPBtn = document.getElementById("goMenuFromJPBtn");
  if (goMenuFromJPBtnFlash && !goMenuFromJPBtnFlash.dataset.bound && goMenuFromJPBtn) {
    goMenuFromJPBtnFlash.dataset.bound = "1";
    goMenuFromJPBtnFlash.addEventListener("click", () => goMenuFromJPBtn.click());
  }
}

async function startJPVisualTraining() {
  try {
    if (!jpWords.length) {
      setStatus("Carregando japonês...", "info");
      await loadJPWords();
    }

    // reset de sessão japonesa
    jpFlashPool = [];
    jpFlashQueue = [];
    jpFlashIndex = 0;
    jpCurrentFlash = null;

    buildDeck();
    renderImageDeck();
    bindOnce();
    setMode("image");
  } catch (e) {
    console.error("[JP Visual]", e);
    setStatus(`Erro: ${e.message}`, "err");
    if (jpBoard) jpBoard.innerHTML = `<div style="color:#fca5a5;padding:8px;">${e.message}</div>`;
  }
}

window.startJPVisualTraining = startJPVisualTraining;