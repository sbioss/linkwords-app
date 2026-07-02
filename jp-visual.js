let jpWords = [];
let jpQueue = [];
let jpActive = [];
let jpPlaying = false;

const jpBoard = document.getElementById("jpBoard");
const jpStatus = document.getElementById("jpStatus");

function setJPStatus(msg, kind = "info") {
  if (!jpStatus) return;
  jpStatus.textContent = msg;

  if (kind === "ok") jpStatus.style.color = "#86efac";
  else if (kind === "err") jpStatus.style.color = "#fca5a5";
  else if (kind === "warn") jpStatus.style.color = "#fcd34d";
  else jpStatus.style.color = "#9FB1CE";
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function disableAudioButtons(disabled) {
  if (!jpBoard) return;
  jpBoard.querySelectorAll(".jp-audio-btn").forEach((btn) => {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.7" : "1";
  });
}

async function loadJPWords() {
  setJPStatus("Carregando palavras japonesas...", "info");

  const res = await fetch("jp-visual-week1.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Falha ao carregar jp-visual-week1.json (HTTP ${res.status})`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("JSON do japonês está inválido (erro de parse).");
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Arquivo jp-visual-week1.json vazio ou fora do formato esperado.");
  }

  const cleaned = data.filter((w) => {
    const hasId = typeof w?.id === "string" && w.id.trim().length > 0;
    const hasImage = typeof w?.image === "string" && w.image.trim().length > 0;
    const hasSpeechText =
      (typeof w?.kana === "string" && w.kana.trim().length > 0) ||
      (typeof w?.jp === "string" && w.jp.trim().length > 0);

    return hasId && hasImage && hasSpeechText;
  });

  if (cleaned.length === 0) {
    throw new Error("Nenhuma palavra válida encontrada no JSON japonês.");
  }

  jpWords = cleaned;
  jpQueue = shuffle(jpWords);
  setJPStatus(`Base carregada: ${jpWords.length} palavras.`, "ok");
}

function jpSlots() {
  // Requisito: sempre 4 imagens
  return 4;
}

function nextJPWord(excludeIds = new Set()) {
  if (!jpWords.length) return null;
  if (jpQueue.length === 0) jpQueue = shuffle(jpWords);

  for (let i = 0; i < jpQueue.length; i++) {
    const w = jpQueue[i];
    if (!excludeIds.has(w.id)) {
      jpQueue.splice(i, 1);
      return w;
    }
  }

  jpQueue = shuffle(jpWords);
  const found = jpQueue.find((w) => !excludeIds.has(w.id));
  if (!found) return null;

  const idx = jpQueue.findIndex((w) => w.id === found.id);
  if (idx >= 0) jpQueue.splice(idx, 1);
  return found;
}

function fillJPBoard() {
  if (!jpBoard) return;

  const slots = jpSlots();
  jpBoard.style.gridTemplateColumns = "1fr 1fr";

  jpActive = [];
  const used = new Set();

  while (jpActive.length < slots) {
    const w = nextJPWord(used);
    if (!w) break;
    jpActive.push(w);
    used.add(w.id);
  }
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
    if (item.audio && String(item.audio).trim()) {
      await playAudioFile(item.audio, r);
    } else {
      await speakTTSJP(item.kana || item.jp, r);
    }
    await sleep(180);
  }
}

function renderJPBoard() {
  if (!jpBoard) return;
  jpBoard.innerHTML = "";

  if (!jpActive.length) {
    const empty = document.createElement("div");
    empty.textContent = "Sem itens para exibir.";
    empty.style.color = "#9FB1CE";
    jpBoard.appendChild(empty);
    setJPStatus("Sem itens para exibir.", "warn");
    return;
  }

  jpActive.forEach((item) => {
    const card = document.createElement("article");
    card.className = "jp-card";

    const img = document.createElement("img");
    img.src = item.image;
    img.alt = item.pt || item.id || "Imagem";
    img.loading = "lazy";
    img.onerror = () => {
      img.style.opacity = "0.35";
      setJPStatus(`Imagem não encontrada: ${item.image}`, "warn");
    };

    const meta = document.createElement("div");
    meta.className = "jp-meta";
    meta.innerHTML = `<div>${item.pt || "-"}</div><small>${item.jp || ""} ${item.kana ? `• ${item.kana}` : ""}</small>`;

    const actions = document.createElement("div");
    actions.className = "jp-actions";

    const audioBtn = document.createElement("button");
    audioBtn.type = "button";
    audioBtn.className = "jp-audio-btn";
    audioBtn.textContent = "🔊 Ouvir (3x)";

    audioBtn.addEventListener("click", async () => {
      if (jpPlaying) return;
      jpPlaying = true;
      disableAudioButtons(true);

      setJPStatus(`Tocando: ${item.pt} (${item.kana || item.jp})`, "info");
      await playJPTriple(item);

      // remove item tocado e repõe por outro
      const idx = jpActive.findIndex((x) => x.id === item.id);
      if (idx >= 0) {
        const used = new Set(jpActive.map((x) => x.id));
        used.delete(item.id);
        const replacement = nextJPWord(used);
        if (replacement) jpActive[idx] = replacement;
        else jpActive.splice(idx, 1);
      }

      renderJPBoard();
      setJPStatus(`Pronto. Cartas na tela: ${jpActive.length}`, "ok");

      jpPlaying = false;
      disableAudioButtons(false);
    });

    actions.appendChild(audioBtn);
    card.appendChild(img);
    card.appendChild(meta);
    card.appendChild(actions);

    jpBoard.appendChild(card);
  });

  setJPStatus(`Treino ativo • Cartas: ${jpActive.length}`, "ok");
}

async function startJPVisualTraining() {
  try {
    if (!jpBoard || !jpStatus) {
      throw new Error("Elementos da tela japonesa não encontrados no HTML.");
    }

    await loadJPWords();
    fillJPBoard();
    renderJPBoard();
  } catch (e) {
    setJPStatus(`Erro: ${e.message}`, "err");
    if (jpBoard) {
      jpBoard.innerHTML = `<div style="color:#fca5a5;padding:8px;">${e.message}</div>`;
    }
    console.error("[JP Visual]", e);
  }
}

window.startJPVisualTraining = startJPVisualTraining;