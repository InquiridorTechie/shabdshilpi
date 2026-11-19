/* Shabdshilpi pilot quiz. Plain JS, no build step. */
(() => {
  "use strict";

  const CFG = window.SS_CONFIG || {};
  const ROUND = CFG.roundId || "round";
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------
  let questions = [];
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
  const attemptsKey = `ss_${ROUND}_attempts`;
  const firstKey = `ss_${ROUND}_first`;
  let attempt = store.get(attemptsKey, 0) + 1;

  // ---------- logging to Google Sheet ----------
  function send(event, data = {}) {
    const row = {
      ts: new Date().toISOString(), session, round: ROUND, attempt, event,
      ...data,
      ua: navigator.userAgent.slice(0, 160),
    };
    if (!CFG.sheetUrl) { console.info("[ss]", row); return; }
    try {
      fetch(CFG.sheetUrl, {
        method: "POST", mode: "no-cors", keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(row),
      });
    } catch { /* never block play */ }
  }

  // ---------- helpers ----------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = (s) => esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const pad = (n) => String(n).padStart(2, "0");

  function show(screen) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("is-active", el.id === screen));
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  // ---------- start ----------
  function initStart() {
    const first = store.get(firstKey, null);
    if (first) {
      const note = $("practice-note");
      note.hidden = false;
      note.textContent = `Practice run. Aapka pehla score (${first.score}/${first.total}) hi count hoga.`;
    }
    $("btn-start").addEventListener("click", startRound);
  }

  function startRound() {
    idx = 0; score = 0; results = []; locked = false;
    $("score-live").textContent = "0";
    send("start");
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
    q.options.forEach((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.dataset.key = o.key;
      b.innerHTML = `<span class="key">${o.key}</span><span class="txt">${md(o.text)}</span>`;
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
    const lines = correct
      ? ["Bohot hard!", "Sick bro!", "Aag laga di! 🔥", "Kya baat hai!", "Ekdum fire!", "Tu toh OG nikla!", "Full scene samjha!", "Bars pakad liye!"]
      : key === null ? ["Time up!"] : ["Arre nahi yaar", "Close tha!", "Agli baar pakka"];
    v.textContent = lines[Math.floor(Math.random() * lines.length)];
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

  function next() {
    if (idx < questions.length - 1) { idx++; renderQuestion(); }
    else finish();
  }

  // ---------- result ----------
  function rankFor(s, n) {
    const p = s / n;
    if (p >= 0.87) return ["Shabdshilpi", "Bars ki poori samajh. Respect."];
    if (p >= 0.6) return ["Bars Pakad Leta", "Deep listener. Thoda aur, aur tum top pe."];
    if (p >= 0.34) return ["Scene Mein Hai", "Basics strong hain. Bars wale sawaal dobara suno."];
    return ["Warm-up Chal Raha", "Koi baat nahi. Gaane suno aur phir aao."];
  }

  function finish() {
    const n = questions.length;
    const totalMs = results.reduce((a, r) => a + r.ms, 0);
    const first = store.get(firstKey, null);
    if (!first) store.set(firstKey, { score, total: n, at: new Date().toISOString() });
    store.set(attemptsKey, attempt);

    send("finish", {
      score, total: n, ms: totalMs,
      answers: results.map((r) => `${r.id}:${r.choice ?? "-"}${r.correct ? "+" : "x"}${Math.round(r.ms / 1000)}s`).join(" "),
    });

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
    g.fillStyle = "#b9b3a6"; g.font = "34px Anton"; g.fillText("KR$NA · ROUND 01", 80, 390);
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
    const text = `Maine Shabdshilpi ka KR$NA round khela: ${score}/${n} (${rankFor(score, n)[0]}). Tum kitna jaante ho?`;
    const url = location.href.split("#")[0];
    send("share_tap", { score });
    try {
      const blob = await makeCard();
      const file = new File([blob], "shabdshilpi-krsna.png", { type: "image/png" });
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
    $("btn-replay").addEventListener("click", () => {
      attempt = store.get(attemptsKey, 0) + 1;
      startRound();
    });
    document.addEventListener("keydown", (e) => {
      if (!$("screen-quiz").classList.contains("is-active")) return;
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      const k = e.key.toUpperCase();
      if (!locked && ["A", "B", "C", "D", "1", "2", "3", "4"].includes(k)) {
        const key = /\d/.test(k) ? "ABCD"[+k - 1] : k;
        if (questions[idx].options.some((o) => o.key === key)) answer(key);
      }
    });
  }

  // ---------- boot ----------
  fetch("questions.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((data) => {
      questions = data.questions.filter((q) => !q.reserve);
      initStart();
      initForms();
    })
    .catch(() => {
      $("screen-start").insertAdjacentHTML("beforeend", '<p class="muted">Questions load nahi hue. Page refresh karo.</p>');
    });
})();
