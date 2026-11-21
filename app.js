/* Shabdshilpi pilot quiz. Plain JS, no build step. */
(() => {
  "use strict";

  const CFG = window.SS_CONFIG || {};
  // Which artist? ?a=<slug> in the link. No ?a= shows the artist picker.
  const params = new URLSearchParams(location.search);
  const ARTIST_SLUG = (params.get("a") || "").toLowerCase();
  let ARTIST = "";       // display name, e.g. "KR$NA"
  let ROUND = "round";   // round id, e.g. "krsna-r1" (Sheet + saved first scores)
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------
  let pool = [];      // every question in questions.json (main + reserve)
  let questions = []; // the 15 picked for this play
  let idx = 0;
  let score = 0;
  let results = []; // {id, choice, correct, ms, timedOut}
  let timer = null;
  let qStart = 0;
  let locked = false;

  const session = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  // ---------- modes ----------
  // Reading time: about 3 words a second, plus thinking time. The timer is never shorter than the mode's base time.
  const WORDS_PER_SEC = 3, MAX_SECS = 60;
  const wordCount = (q) => [q.lead, ...(q.bar || []), q.prompt, ...q.options.map((o) => o.text)].join(" ").split(/\s+/).filter(Boolean).length;
  const MODES = {
    normal: { label: "Normal", levels: [["easy", 3], ["medium", 5], ["hard", 2]], bars: [3, 4], secs: { fact: 20, bar: 40 }, think: { fact: 10, bar: 15 }, get key() { return ROUND; } },
    hardcore: { label: "Hardcore", levels: [["easy", 0], ["medium", 1], ["hard", 9]], bars: [3, 4], secs: { fact: 15, bar: 30 }, think: { fact: 7, bar: 10 }, get key() { return ROUND + "-hc"; } },
  };
  let mode = "normal";
  const attemptsKey = () => `ss_${MODES[mode].key}_attempts`;
  const firstKey = () => `ss_${MODES[mode].key}_first`;
  let attempt = 1;
  const nameKey = "ss_player_name";
  let playerName = store.get(nameKey, "");
  const cleanName = (v) => v.replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 20);

  // ---------- logging to Google Sheet ----------
  function send(event, data = {}) {
    const row = {
      ts: new Date().toISOString(), session, round: ROUND, attempt, event, name: playerName, mode,
      ...data,
      ua: navigator.userAgent.slice(0, 160),
    };
    // Local preview (127.0.0.1 / localhost / file) never writes to the real Sheet.
    const isLocal = ["127.0.0.1", "localhost", ""].includes(location.hostname);
    if (!CFG.sheetUrl || isLocal) { console.info("[ss]", row); return; }
    try {
      fetch(CFG.sheetUrl, {
        method: "POST", mode: "no-cors", keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(row),
      });
    } catch { /* never block play */ }
  }

  // ---------- sound: meme clips in site/sounds/ (picked by the founder) ----------
  // Each moment has a list of clips; they rotate. Clips are trimmed (leading silence, max length) and
  // volume-matched in code. CFG.memeSounds === false turns every sound off (safety switch).
  const SOUNDS = {
    right:   [{ f: "baat-to-sahi-hai.mp3" }, { f: "waah-kya-scene-hai.mp3" }, { f: "kya-baat-hai-sir.mp3", max: 2.2 }],
    wrong:   [{ f: "aayein-meme.mp3" }, { f: "faaah.mp3" }, { f: "sadtrombone.swf.mp3", max: 2.2 }, { f: "aisa-mat-karo.mp3", max: 2.2 }],
    wrongStreak: [{ f: "ye-kya-hai.mp3", max: 2.8 }],
    fast:    [{ f: "fast-swish.mp3", max: 1.6 }],
    start:   [{ f: "chaliye-shuru-karte-hai_jD4Gwwq.mp3" }],
    startHardcore: [{ f: "dun_dun_dun.mp3", max: 2.4 }],
    timerLow: [{ f: "clock-ticking-sound.mp3", exact: true, vol: 0.5 }],   // starts so its last tick lands on 0
    endZero: [{ f: "emotional-damage-trimmed.mp3", max: 2.4 }],
    timeup:  [{ f: "kya-kar-raha-hai-tu.mp3", max: 2.5 }],
    streak:  [{ f: "cheering.mp3", max: 2.5 }],
    endHigh: [{ f: "super-smash-bros-bonus-results.mp3", max: 3.5 }],
    endMid:  [{ f: "aplausos_2.mp3", max: 3 }],
    endLow:  [{ f: "meme-violin-sad-violin.mp3", max: 3.5 }],
  };
  const SFX = (() => {
    const enabled = CFG.memeSounds !== false;
    let ctx = null, loading = null;
    let on = enabled && store.get("ss_sound", true);
    const buffers = {};   // file -> { buf, start, gain }
    const turn = {};      // moment -> next index
    const ac = () => {
      if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    };
    // find where the sound starts (skip silence) and a gain that brings every clip to a similar loudness
    function analyse(buf) {
      const d = buf.getChannelData(0), n = d.length;
      let start = 0; while (start < n && Math.abs(d[start]) < 0.02) start++;
      let end = n - 1; while (end > start && Math.abs(d[end]) < 0.02) end--;
      let sum = 0, cnt = 0; for (let i = start; i < n; i += 4) { sum += d[i] * d[i]; cnt++; }
      const rms = Math.sqrt(sum / Math.max(1, cnt)) || 0.1;
      return { start: start / buf.sampleRate, end: (end + 1) / buf.sampleRate, gain: Math.min(3, 0.12 / rms) };
    }
    function preload() {
      if (loading || !enabled) return loading;
      const c = ac(); if (!c) return null;
      const files = [...new Set(Object.values(SOUNDS).flat().map((s) => s.f))];
      loading = Promise.all(files.map((f) =>
        fetch("sounds/" + encodeURIComponent(f)).then((r) => r.arrayBuffer())
          .then((ab) => new Promise((res, rej) => c.decodeAudioData(ab, res, rej)))
          .then((buf) => { buffers[f] = { buf, ...analyse(buf) }; })
          .catch(() => { /* a missing clip is simply skipped */ })));
      return loading;
    }
    function playClip(s, skip = 0) {
      const b = buffers[s.f]; const c = ac(); if (!b || !c) return;
      const src = c.createBufferSource(), g = c.createGain(), t = c.currentTime + 0.01;
      const from = b.start + skip;
      const len = s.exact ? Math.max(0.05, b.end - from) : Math.min(b.buf.duration - b.start, s.max || 2.5);
      const v = b.gain * 0.9 * (s.vol || 1);
      g.gain.setValueAtTime(v, t);
      g.gain.setValueAtTime(v, t + Math.max(0, len - 0.25));
      g.gain.linearRampToValueAtTime(0.0001, t + len);          // fade out at the cut
      src.buffer = b.buf; src.connect(g); g.connect(c.destination);
      src.start(t, from, len + 0.05);
      return () => { try { g.gain.cancelScheduledValues(c.currentTime); g.gain.setValueAtTime(0.0001, c.currentTime); src.stop(); } catch { /* already stopped */ } };
    }
    let ticking = null;   // stopper for the clock-ticking clip
    const stopTick = () => { if (ticking) { ticking(); ticking = null; } };
    function moment(name, keep, skip) {
      if (!on) return;
      const list = SOUNDS[name]; if (!list || !list.length) return;
      const i = (turn[name] || 0) % list.length; turn[name] = i + 1;
      (preload() || Promise.resolve()).then(() => { const stop = playClip(list[i], skip); if (keep) keep(stop); });
    }
    // how long the ticking clip really is (audible part only), so the timer can start it at the right moment
    const tickSecs = () => { const b = buffers[SOUNDS.timerLow[0].f]; return b ? b.end - b.start : 3; };
    return {
      enabled,
      unlock() { if (on) preload(); },
      get on() { return on; },
      toggle() { on = !on; store.set("ss_sound", on); if (on) preload(); return on; },
      start(mode) { moment(mode === "hardcore" ? "startHardcore" : "start"); },
      tickSecs,
      // remainSecs: time left when called; if we're a little late, skip into the clip so it still ends at 0
      timerLow(remainSecs) { stopTick(); moment("timerLow", (stop) => { ticking = stop; }, Math.max(0, tickSecs() - remainSecs)); },
      // a right answer: every 3rd in a row = cheering; a very fast one (< 3s) = swish; else the usual rotation
      right(streak, ms) { stopTick(); moment(streak >= 3 && streak % 3 === 0 ? "streak" : ms < 3000 ? "fast" : "right"); },
      // 3 wrong in a row = "ye kya hai"
      wrong(wrongs) { stopTick(); moment(wrongs >= 3 && wrongs % 3 === 0 ? "wrongStreak" : "wrong"); },
      timeout(wrongs) { stopTick(); moment(wrongs >= 3 && wrongs % 3 === 0 ? "wrongStreak" : "timeup"); },
      stop: stopTick,
      finish(score, n) { stopTick(); moment(score === 0 ? "endZero" : score / n >= 0.7 ? "endHigh" : score / n >= 0.5 ? "endMid" : "endLow"); },  // 0 | 1-4 | 5-6 | 7-10 (out of 10)
    };
  })();

  function initSoundButton() {
    const b = $("btn-sound");
    if (!SFX.enabled) { b.hidden = true; return; }
    const paint = () => { b.textContent = SFX.on ? "🔊" : "🔇"; b.setAttribute("aria-label", SFX.on ? "Sound on. Tap to mute." : "Sound off. Tap to turn on."); b.setAttribute("aria-pressed", String(SFX.on)); };
    b.addEventListener("click", () => { SFX.toggle(); paint(); });
    paint();
  }

  // ---------- helpers ----------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = (s) => esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const pad = (n) => String(n).padStart(2, "0");

  function show(screen) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("is-active", el.id === screen));
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  // ---------- round building ----------
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  // Pick 10 from the pool by the mode's level mix (easy to hard, shuffled inside each level),
  // with 4-6 bar questions. If a level runs short, the gap is filled from the next level down.
  // Options are shuffled too (number-only options stay in order).
  function buildRound() {
    const M = MODES[mode];
    const total = M.levels.reduce((a, [, n]) => a + n, 0);
    const byId = Object.fromEntries(pool.map((q) => [q.id, q]));
    let picked = [];
    for (let tries = 0; tries < 200; tries++) {
      const used = new Set();
      // "avoid" pairs (e.g. a "who said this bar?" question and a question naming that rapper) never share a play
      const clash = (q) => [...used].some((id) => (q.avoid || []).includes(id) || (byId[id].avoid || []).includes(q.id));
      const take = (lvl, n) => {
        const got = [];
        for (const q of shuffle(pool.filter((x) => x.level === lvl && !used.has(x.id)))) {
          if (got.length >= n) break;
          if (clash(q)) continue;
          used.add(q.id); got.push(q);
        }
        return got;
      };
      const byLevel = Object.fromEntries(M.levels.map(([lvl, n]) => [lvl, take(lvl, n)]));
      let short = total - Object.values(byLevel).reduce((a, l) => a + l.length, 0);
      for (const lvl of ["hard", "medium", "easy"]) {
        if (short <= 0) break;
        const extra = take(lvl, short); byLevel[lvl].push(...extra); short -= extra.length;
      }
      picked = ["easy", "medium", "hard"].flatMap((lvl) => shuffle(byLevel[lvl] || []));
      const bars = picked.filter((q) => q.kind === "bar").length;
      if (bars >= M.bars[0] && bars <= M.bars[1]) break;
    }
    return picked.map((q) => {
      const numeric = q.options.every((o) => /^\d+$/.test(o.text.trim()));
      const seconds = Math.min(MAX_SECS, Math.max(M.secs[q.kind], Math.ceil(wordCount(q) / WORDS_PER_SEC + M.think[q.kind])));
      return { ...q, seconds, shown: numeric ? q.options.slice() : shuffle(q.options) };
    });
  }

  // ---------- start ----------
  function initStart() {
    const notes = Object.keys(MODES).map((m) => [m, store.get(`ss_${MODES[m].key}_first`, null)]).filter(([, f]) => f);
    if (notes.length) {
      const note = $("practice-note");
      note.hidden = false;
      note.textContent = "Pehla score count hota hai: " + notes.map(([m, f]) => `${MODES[m].label} ${f.score}/${f.total}`).join(" · ") + ". Ab replays practice hain.";
    }
    const input = $("player-name");
    input.value = playerName;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startRound("normal"); } });
    $("btn-start").addEventListener("click", () => startRound("normal"));
    $("btn-hardcore").addEventListener("click", () => startRound("hardcore"));
  }

  let streak = 0, wrongs = 0;
  function startRound(m) {
    SFX.unlock(); streak = 0; wrongs = 0;
    if (m) mode = m;
    attempt = store.get(attemptsKey(), 0) + 1;
    document.body.classList.toggle("is-hardcore", mode === "hardcore");
    playerName = cleanName($("player-name").value || "");
    store.set(nameKey, playerName);
    idx = 0; score = 0; results = []; locked = false;
    questions = buildRound();
    SFX.start(mode);
    $("score-live").textContent = "0";
    send("start", { answers: questions.map((q) => q.id).join(" ") });
    show("screen-quiz");
    renderQuestion();
  }

  // ---------- question ----------
  function renderQuestion() {
    const q = questions[idx];
    locked = false;
    $("q-num").textContent = pad(idx + 1);
    document.querySelector(".counter .of").textContent = "/" + questions.length;

    const kind = $("q-kind");
    kind.textContent = q.kind === "bar" ? "Bar" : "Fact";
    kind.classList.toggle("is-bar", q.kind === "bar");
    $("q-level").textContent = q.level;
    $("q-explicit").hidden = !q.explicit;

    $("q-lead").innerHTML = q.lead ? md(q.lead) : "";
    const bar = $("q-bar");
    if (q.bar) {
      bar.innerHTML = q.bar.map((l) => `<span>${esc(l)}</span>`).join("");
      bar.hidden = false;
    } else {
      bar.hidden = true;
      bar.innerHTML = "";
    }
    $("q-prompt").innerHTML = md(q.prompt);

    const box = $("q-options");
    box.className = "options" + (q.options.length === 2 ? " two" : "");
    box.innerHTML = "";
    q.shown.forEach((o, pos) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.dataset.key = o.key; // the original key, so answers and the Sheet stay consistent
      b.innerHTML = `<span class="key">${"ABCD"[pos]}</span><span class="txt">${md(o.text)}</span>`;
      b.addEventListener("click", () => answer(o.key));
      box.appendChild(b);
    });

    $("reveal").hidden = true;
    $("report-text").value = "";
    $("report-done").hidden = true;
    document.querySelector(".report").open = false;

    startTimer(q.seconds);
    box.querySelector(".opt")?.focus({ preventScroll: true });
  }

  function startTimer(seconds) {
    stopTimer();
    const fill = $("timer-fill");
    const left = $("timer-left");
    fill.classList.remove("is-low");
    let tickStarted = false;
    qStart = performance.now();
    const total = seconds * 1000;
    let lastWhole = -1;
    const tick = () => {
      const el = performance.now() - qStart;
      const remain = Math.max(0, total - el);
      fill.style.transform = `scaleX(${remain / total})`;
      const whole = Math.ceil(remain / 1000);
      if (whole !== lastWhole) {
        left.textContent = whole;
        lastWhole = whole;
        if (whole === 10 || whole === 5) $("timer-sr").textContent = `${whole} seconds left`;
      }
      if (remain <= 5000) fill.classList.add("is-low");
      if (!tickStarted && remain <= SFX.tickSecs() * 1000) { tickStarted = true; SFX.timerLow(remain / 1000); }
      if (remain <= 0) { answer(null); return; }
      timer = requestAnimationFrame(tick);
    };
    timer = requestAnimationFrame(tick);
  }
  function stopTimer() { if (timer) cancelAnimationFrame(timer); timer = null; }

  function answer(key) {
    if (locked) return;
    locked = true;
    stopTimer();
    const q = questions[idx];
    const ms = Math.round(performance.now() - qStart);
    const correct = key === q.answer;
    if (correct) score++;
    streak = correct ? streak + 1 : 0;
    wrongs = correct ? 0 : wrongs + 1;
    if (correct) SFX.right(streak, ms); else if (key === null) SFX.timeout(wrongs); else SFX.wrong(wrongs);
    $("score-live").textContent = score;
    results.push({ id: q.id, choice: key, correct, ms, timedOut: key === null });
    send("answer", { q: q.id, choice: key ?? "timeout", correct, ms });

    document.querySelectorAll(".opt").forEach((b) => {
      b.disabled = true;
      if (b.dataset.key === q.answer) b.classList.add("is-right");
      else if (b.dataset.key === key) b.classList.add("is-wrong");
      else b.classList.add("is-dim");
    });

    const v = $("reveal-verdict");
    // [without name, with name] — the name is used about half the time so it doesn't get repetitive
    const RIGHT = [
      ["Bohot hard!", "Bohot hard, {n}!"], ["Sick bro!", "Sick, {n}!"], ["Aag laga di! 🔥", "{n} ne aag laga di! 🔥"],
      ["Kya baat hai!", "Kya baat hai, {n}!"], ["Ekdum fire!", "{n}, ekdum fire!"], ["Tu toh OG nikla!", "{n} toh OG nikla!"],
      ["Full scene samjha!", "{n} ne full scene samjha!"], ["Bars pakad liye!", "{n} ne bars pakad liye!"],
    ];
    const WRONG = [["Arre nahi yaar", "Arre nahi {n}"], ["Close tha!", "Close tha, {n}!"], ["Agli baar pakka", "Agli baar pakka, {n}"]];
    const pick = correct ? fromBag("right", RIGHT) : key === null ? ["Time up!", "Time up, {n}!"] : fromBag("wrong", WRONG);
    v.textContent = playerName && Math.random() < 0.5 ? pick[1].replace("{n}", playerName) : pick[0];
    v.className = "verdict " + (correct ? "ok" : "no");
    $("reveal-expl").innerHTML = md(q.explanation);

    const song = $("reveal-song");
    if (q.songLink) {
      song.href = q.songLink;
      song.hidden = false;
      song.onclick = () => send("song_click", { q: q.id, url: q.songLink });
    } else {
      song.hidden = true;
    }
    $("btn-next").innerHTML = idx === questions.length - 1 ? 'Result dekho <span aria-hidden="true">→</span>' : 'Next <span aria-hidden="true">→</span>';
    $("reveal").hidden = false;
    $("btn-next").focus({ preventScroll: true });
    $("reveal").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  }

  // Shuffle bag: every line is used once before any line repeats, and never twice in a row.
  const bags = {};
  function fromBag(name, lines) {
    let bag = bags[name];
    if (!bag || !bag.items.length) {
      const items = lines.map((_, i) => i);
      for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
      if (bag && items.length > 1 && items[items.length - 1] === bag.last) items.unshift(items.pop());
      bag = bags[name] = { items, last: bag ? bag.last : -1 };
    }
    const i = bag.items.pop();
    bag.last = i;
    return lines[i];
  }

  function next() {
    if (idx < questions.length - 1) { idx++; renderQuestion(); }
    else finish();
  }

  // ---------- result ----------
  function rankFor(s, n) {
    const p = s / n;
    if (mode === "hardcore") {
      if (p >= 0.87) return ["Hardcore Shabdshilpi", "Ye level alag hai. Full respect."];
      if (p >= 0.6) return ["Underground Certified", "Deep cuts bhi pakad liye. Solid."];
      if (p >= 0.34) return ["Hardcore Survivor", "Hardcore mein tika rehna bhi badi baat hai."];
      return ["Hardcore Ne Hila Diya", "Ye mode tough hai. Normal pe warm-up karo, phir aao."];
    }
    if (p >= 0.87) return ["Shabdshilpi", "Bars ki poori samajh. Respect."];
    if (p >= 0.6) return ["Bars Pakad Leta", "Deep listener. Thoda aur, aur tum top pe."];
    if (p >= 0.34) return ["Scene Mein Hai", "Basics strong hain. Bars wale sawaal dobara suno."];
    return ["Warm-up Chal Raha", "Koi baat nahi. Gaane suno aur phir aao."];
  }

  function finish() {
    SFX.finish(score, questions.length);
    const n = questions.length;
    const totalMs = results.reduce((a, r) => a + r.ms, 0);
    const first = store.get(firstKey(), null);
    if (!first) store.set(firstKey(), { score, total: n, at: new Date().toISOString() });
    store.set(attemptsKey(), attempt);

    send("finish", {
      score, total: n, ms: totalMs,
      answers: results.map((r) => `${r.id}:${r.choice ?? "-"}${r.correct ? "+" : "x"}${Math.round(r.ms / 1000)}s`).join(" "),
    });

    const tag = mode === "hardcore" ? `${ARTIST} · Hardcore 🔥` : `${ARTIST} · Round 01`;
    $("result-kicker").textContent = playerName ? `${playerName} · ${tag}` : tag;
    $("final-score").textContent = score;
    document.querySelector(".big-score .of").textContent = "/" + n;
    const [title, sub] = rankFor(score, n);
    $("result-title").textContent = title;
    $("result-sub").textContent = first ? `${sub} (Practice run: pehla score ${first.score}/${first.total} count hota hai.)` : sub;

    $("stamp-row").innerHTML = results
      .map((r, i) => `<div class="stamp ${r.correct ? "ok" : "no"}" title="Q${i + 1}">${r.correct ? "✓" : "✗"}<span class="sr-only">Question ${i + 1} ${r.correct ? "right" : "wrong"}</span></div>`)
      .join("");
    show("screen-result");
  }

  // ---------- share card (canvas, 1080x1350) ----------
  async function makeCard() {
    const n = questions.length;
    const [title] = rankFor(score, n);
    try { await Promise.all(["120px Anton", "40px Kalam", "60px 'Rozha One'"].map((f) => document.fonts.load(f))); } catch { /* fallback fonts */ }
    const c = document.createElement("canvas");
    c.width = 1080; c.height = 1350;
    const g = c.getContext("2d");
    g.fillStyle = "#141417"; g.fillRect(0, 0, 1080, 1350);
    // glow
    const grd = g.createRadialGradient(1000, 100, 50, 1000, 100, 700);
    grd.addColorStop(0, "rgba(232,255,60,0.18)"); grd.addColorStop(1, "rgba(232,255,60,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 1080, 1350);
    // tape strip
    g.save(); g.translate(540, 150); g.rotate(-0.03);
    g.fillStyle = "#e8ff3c"; g.fillRect(-640, -40, 1280, 80);
    g.fillStyle = "#0c0c0e"; g.font = "44px Anton"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("BARS • FACTS • FLOW • WORDPLAY • KALAM • BARS • FACTS", 0, 4);
    g.restore();
    // wordmark
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.fillStyle = "#e8ff3c"; g.font = "64px 'Rozha One'"; g.fillText("शब्दशिल्पी", 80, 330);
    g.fillStyle = "#b9b3a6"; g.font = "34px Anton"; g.fillText(`${ARTIST.toUpperCase()} · ${mode === "hardcore" ? "HARDCORE MODE" : "ROUND 01"}`, 80, 390);
    if (playerName) { g.fillStyle = "#f2ede2"; g.font = "56px Kalam"; g.fillText(`${playerName} ka score`, 80, 455); }
    // score
    g.font = "420px Anton"; g.fillStyle = "#ff4b2b"; g.fillText(String(score), 92, 860);
    g.fillStyle = "#e8ff3c"; g.fillText(String(score), 80, 848);
    const w = g.measureText(String(score)).width;
    g.font = "130px Anton"; g.fillStyle = "#f2ede2"; g.fillText("/" + n, 100 + w, 848);
    // rank
    g.font = "96px Anton"; g.fillStyle = "#f2ede2"; g.fillText(title.toUpperCase(), 80, 1000);
    // stamps
    results.forEach((r, i) => {
      const x = 80 + i * 62, y = 1060;
      g.fillStyle = r.correct ? "#4de1c1" : "#141417";
      g.strokeStyle = r.correct ? "#4de1c1" : "#ff4b2b"; g.lineWidth = 4;
      g.beginPath(); g.roundRect ? g.roundRect(x, y, 50, 50, 10) : g.rect(x, y, 50, 50); g.fill(); g.stroke();
    });
    g.font = "48px Kalam"; g.fillStyle = "#f2ede2"; g.fillText("Tum kitna jaante ho? Khelo →", 80, 1250);
    g.font = "30px 'Space Grotesk', sans-serif"; g.fillStyle = "#b9b3a6"; g.fillText(location.host + location.pathname, 80, 1300);
    return new Promise((res) => c.toBlob(res, "image/png"));
  }

  async function share() {
    const n = questions.length;
    const text = `${playerName ? playerName + " here! " : ""}Maine Shabdshilpi ka ${ARTIST} ${mode === "hardcore" ? "Hardcore round" : "round"} khela: ${score}/${n} (${rankFor(score, n)[0]}). Tum kitna jaante ho?`;
    const url = location.href.split("#")[0];
    send("share_tap", { score });
    try {
      const blob = await makeCard();
      const file = new File([blob], `shabdshilpi-${ARTIST_SLUG}.png`, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: text + " " + url });
        return;
      }
      if (navigator.share) { await navigator.share({ text, url }); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      try { await navigator.clipboard.writeText(text + " " + url); } catch { /* ignore */ }
    } catch { /* user cancelled */ }
  }

  // ---------- feedback & report ----------
  function initForms() {
    const picked = (name) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value || "";
    $("a9").addEventListener("change", (e) => { $("fb-other").hidden = !e.target.checked; if (e.target.checked) $("fb-other").focus(); });
    $("fb-add-comment").addEventListener("click", (e) => { e.target.hidden = true; $("fb-more").hidden = false; $("fb-more").focus(); });
    $("feedback").addEventListener("submit", (e) => {
      e.preventDefault();
      const artists = [...document.querySelectorAll("#fb-artists input:checked")]
        .map((i) => (i.value === "other" ? $("fb-other").value.trim() : i.value))
        .filter(Boolean).join(", ");
      const fb = {
        fb_vibe: picked("fb-vibe"), fb_level: picked("fb-level"), fb_bars: picked("fb-bars"),
        fb_artist: artists, fb_more: $("fb-more").value.trim(),
      };
      // "text" keeps a readable summary, so nothing is lost even with an older Sheet script.
      send("feedback", { score, ...fb, text: `vibe=${fb.fb_vibe}; level=${fb.fb_level}; bars=${fb.fb_bars}; artist=${fb.fb_artist}` });
      $("fb-done").hidden = false;
      e.target.querySelector("button[type=submit]").disabled = true;
    });
    $("report-form").addEventListener("submit", (e) => {
      e.preventDefault();
      send("report", { q: questions[idx].id, text: $("report-text").value.trim() });
      $("report-done").hidden = false;
    });
    $("btn-next").addEventListener("click", next);
    $("btn-share").addEventListener("click", share);
    $("btn-replay").addEventListener("click", () => startRound(mode));
    document.addEventListener("keydown", (e) => {
      if (!$("screen-quiz").classList.contains("is-active")) return;
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      const k = e.key.toUpperCase();
      if (!locked && ["A", "B", "C", "D", "1", "2", "3", "4"].includes(k)) {
        const pos = /\d/.test(k) ? +k - 1 : "ABCD".indexOf(k);
        const o = questions[idx].shown[pos];
        if (o) answer(o.key);
      }
    });
  }

  // ---------- boot ----------
  const fail = (where) => $(where).insertAdjacentHTML("beforeend", '<p class="muted">Load nahi hua. Page refresh karo.</p>');

  function showPicker(artists) {
    $("artist-list").innerHTML = artists.map((a) =>
      `<a class="artist-card" href="?a=${encodeURIComponent(a.slug)}"><span class="an">${esc(a.name)}</span><span class="ac">${a.count} sawaal<br>Normal<br>Hardcore 🔥</span></a>`).join("");
    show("screen-pick");
  }

  function setPoster(name) {
    const words = name.split(/\s+/);
    const longest = Math.max(...words.map((w) => w.length));
    const size = `min(${Math.min(27, Math.floor(135 / longest))}vw, ${Math.min(168, Math.floor(840 / longest))}px)`;
    $("start-title").classList.toggle("multi", words.length > 1);
    ["poster-name", "poster-echo"].forEach((id) => {
      const el = $(id);
      el.innerHTML = words.map(esc).join("<br>");
      el.style.fontSize = size;
    });
  }

  initSoundButton();
  fetch("data/artists.json", { cache: "no-store" })
    .then((r) => r.json())
    .then(({ artists }) => {
      const a = artists.find((x) => x.slug === ARTIST_SLUG);
      if (!a) { showPicker(artists); return null; }
      ARTIST = a.name; ROUND = a.round;
      document.title = `Shabdshilpi · ${a.name} Round`;
      setPoster(a.name);
      $("back-link").hidden = artists.length < 2;
      // the next-artist chips shouldn't offer the artist you just played
      document.querySelectorAll("#fb-artists input").forEach((i) => {
        if (i.value.toLowerCase() === a.name.toLowerCase()) { i.remove(); document.querySelector(`label[for="${i.id}"]`)?.remove(); }
      });
      return fetch(`data/${a.slug}.json`, { cache: "no-store" }).then((r) => r.json());
    })
    .then((data) => {
      if (!data) return;
      pool = data.questions;
      show("screen-start");
      initStart();
      initForms();
    })
    .catch(() => fail("app"));
})();
