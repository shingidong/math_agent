// app.js — 화면 로직 (index.html)
// (1) 문제+막힌지점 → /api/coach (서버리스 함수가 Gemini 호출)
// (2) 코칭을 '스레드(대화)'로 쌓고, (3) 핵심 수식을 Plotly 그래프(2D·3D)로.
// 수학 판정·풀이는 안 한다 — 그건 AI(coach.js의 기준). 여긴 '표시'만.
//
// ★ 멀티턴: convo[]에 학생/코치 메시지를 누적해 /api/coach로 보낸다.
//   학생은 '다음 걸음'을 해본 뒤 한 줄 적으면 코치가 '그다음 한 걸음'을 이어준다.

const $ = (id) => document.getElementById(id);
const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ───────── 수식 렌더 (방탄: KaTeX가 늦게/실패해도 준비되면 렌더) ───────── */
const DELIMS = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
  { left: "$", right: "$", display: false },
];
let _kxReady = null;
function katexReady() {
  if (window.renderMathInElement) return Promise.resolve();
  if (_kxReady) return _kxReady;
  _kxReady = new Promise((res) => {
    let n = 0;
    const t = setInterval(() => {
      if (window.renderMathInElement || n++ > 100) { clearInterval(t); res(); }
    }, 50);
  });
  return _kxReady;
}
function typeset(el) {
  if (!el) return;
  katexReady().then(() => {
    if (window.renderMathInElement) {
      try { renderMathInElement(el, { delimiters: DELIMS, throwOnError: false }); } catch (e) {}
    }
  });
}

/* ───────── 코치 호출 (누적 대화 convo[] → /api/coach) ───────── */
let convo = [];            // [{role:'user'|'model', text, image?}] — Gemini로 보낼 누적 대화
let problemImage = null;   // 문제 사진 {mimeType, data(base64), url} — 첫 메시지에 실어 보냄
let imageJob = null;       // 사진 압축이 끝나기 전 제출되는 경우를 막기 위한 대기 작업
let requestBusy = false;   // 중복 클릭으로 같은 요청이 여러 번 나가는 것 방지

// 코치 응답(d) → 다음 호출에 실어 보낼 'model' 턴 텍스트.
// 토큰 절약: 이어가기에 꼭 필요한 '진단 + 직전에 시킨 다음 걸음'만 남긴다.
// (그림·힌트·정답·인정 멘트는 이미 화면에 있고, 다음 코칭엔 불필요 → 매 턴 누적 비용 ↓)
const modelText = (d) =>
  JSON.stringify({ diagnosis: d.diagnosis, next_step: d.next_step });
// Y/N 표기 헬퍼
const Y = (v) => (v ? "Y" : "N");

// 막힌 지점 텍스트에서 답 후보를 추출해 수치검증
function tryVerify(problem, stuck) {
  if (typeof verifyIntegral !== "function") return "na";
  const combined = problem + " " + stuck;
  const integrandM = combined.match(/∫\s*([^dx∫,;。\n]+)\s*d[xt]/);
  if (!integrandM) return "na";
  const integrand = integrandM[1].trim();
  const withC  = stuck.match(/([^\n=]+\+\s*C)\s*$/);
  const eqM    = stuck.match(/=\s*([^\n=]+?)\s*(?:\+\s*C\s*)?$/);
  const cand   = (withC && withC[1]) || (eqM && eqM[1]);
  if (!cand) return "na";
  try { return verifyIntegral(cand.trim(), integrand).result; }
  catch (e) { return "na"; }
}

// 첫 메시지(문제+막힌 지점) → 'user' 턴 텍스트 (코드 판정 블록 포함)
const composeFirst = (problem, stuck) => {
  const tech = typeof guessTechnique === "function" ? guessTechnique(problem) : "other";
  const ev   = typeof extractEvidence === "function" ? extractEvidence(stuck)
               : { goal: false, method: false, expr: false, partial: false, answer: false };
  const K    = typeof loadSelfReport === "function" ? loadSelfReport() : [];
  const prereqPrior = K.includes(tech) ? "ok" : "unknown";
  const vf   = tryVerify(problem, stuck);
  const weak = weaknessText();
  return `[문제]\n${problem.trim() || "(첨부한 사진의 문제를 풀고 있어.)"}\.\n\n[내가 풀다가 막힌 지점]\n${stuck.trim() || "(아직 못 풀었어. 어디서 시작해야 할지 모르겠어.)"}\.\n\n[코드 판정]\ntechnique: ${tech}\nevidence: goal=${Y(ev.goal)} method=${Y(ev.method)} expr=${Y(ev.expr)} partial=${Y(ev.partial)} answer=${Y(ev.answer)}\nverify: ${vf}\nprereq_prior: ${prereqPrior}${weak ? "\n\n" + weak : ""}`;
};

async function askConvo() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 36000);
  try {
    const r = await fetch("/api/coach", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: convo }),
      signal: controller.signal,
    });
    const text = await r.text();
    let d = {};
    try { d = text ? JSON.parse(text) : {}; }
    catch (e) { d = { error: r.ok ? "AI 응답이 잠깐 불안정했어요. 다시 눌러줘." : "서버 응답이 잠깐 불안정했어요. 다시 시도해줘." }; }
    renderQuota(d); // 남은 질문 게이지 갱신(성공·에러 응답 모두 remaining 포함)
    if (!r.ok || d.error) throw new Error(d.error || `서버 오류(${r.status}). 다시 시도해줘.`);
    return d;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("응답이 오래 걸려서 멈췄어요. 같은 내용으로 다시 시도해줘.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ───────── 남은 질문 게이지 (서버 remaining 표시) ───────── */
function renderQuota(d) {
  if (!d || typeof d.remaining !== "number") return;
  const box = $("quota"), fill = $("quotaFill"), num = $("quotaNum");
  if (!box) return;
  const limit = d.limit || 40, rem = Math.max(0, d.remaining);
  const pct = Math.max(0, Math.min(100, Math.round((rem / limit) * 100)));
  box.classList.remove("hidden");
  if (fill) { fill.style.width = pct + "%"; fill.className = pct <= 12 ? "q-low" : pct <= 30 ? "q-mid" : ""; }
  if (num) num.textContent = rem + " / " + limit;
}

/* ───────── 실수 노트 (이 기기 localStorage 에 유형별 누적) ───────── */
// 학생이 '직전 한 걸음'에서 실제로 틀렸을 때만 AI가 mistake:{type,label}을 준다.
// 그걸 이 기기에 쌓아 '어떤 실수가 잦은지'를 막대그래프로 보여준다. (서버 저장 없음)
const MISTAKE_TYPES = {
  calc:      { label: "계산 실수" },        // 부호·사칙·약분
  concept:   { label: "개념·공식 오류" },    // 공식을 잘못 알거나 잘못 적용
  condition: { label: "조건 누락" },        // 정의역·범위·절댓값·부호조건
  setup:     { label: "식 세우기" },        // 식·적분구간·미지수 설정
  notation:  { label: "대입·표기 실수" },
  check:     { label: "검산 누락" },
  etc:       { label: "기타" },
};
const STAGE_LABELS = {
  nostart: "시작 전", comprehension: "문제 이해",
  transform: "방법 선택", process: "계산 진행", encoding: "표기·검산",
};
const CHAIN_LABELS = { ...STAGE_LABELS, prerequisite: "선행 개념 부족" };
const CHAIN_HINT_LEN = { nostart: 2, comprehension: 3, transform: 4, process: 3, encoding: 2, prerequisite: 2 };
const MKEY = "coach.mistakes.v1";
const mtype = (t) => (MISTAKE_TYPES[t] ? t : "etc");
function loadMistakes() { try { return JSON.parse(localStorage.getItem(MKEY) || "[]"); } catch (e) { return []; } }
function recordMistake(m) {
  if (!m || !m.type || m.type === "none") return;
  const list = loadMistakes();
  list.push({ type: mtype(m.type), label: String(m.label || "").slice(0, 120), t: Date.now() });
  try { localStorage.setItem(MKEY, JSON.stringify(list.slice(-500))); } catch (e) {}
}
function clearMistakes() { try { localStorage.removeItem(MKEY); } catch (e) {} }
function weaknessText() {
  const list = loadMistakes();
  if (list.length < 2) return "";
  const recent = list.slice(-80);
  const counts = {};
  recent.forEach((m) => { const k = mtype(m.type); counts[k] = (counts[k] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (!rows.length) return "";
  const top = rows.map(([k, n]) => `${MISTAKE_TYPES[k].label} ${n}회`).join(", ");
  const labels = recent.map((m) => String(m.label || "").trim()).filter(Boolean).slice(-3).join(" / ");
  return `[이 기기 누적 약점]\n최근 실수 기록 기준 자주 나온 유형: ${top}.${labels ? `\n최근 코멘트 예: ${labels}` : ""}\n현재 문제와 관련 있을 때만 이 약점을 반영해서 다음 한 걸음과 힌트를 더 작게 쪼개줘. 관련 없으면 언급하지 마.`;
}
function weaknessSummary() {
  const list = loadMistakes();
  if (list.length < 2) return "";
  const counts = {};
  list.slice(-80).forEach((m) => { const k = mtype(m.type); counts[k] = (counts[k] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return rows.map(([k, n]) => `${MISTAKE_TYPES[k].label} ${n}회`).join(", ");
}
function renderPersonalBadge() {
  const el = $("personalBadge");
  if (!el) return;
  const s = weaknessSummary();
  if (!s) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML = `이번 코칭 참고: <b>${esc(s)}</b>`;
}

/* ───────── 코칭 스레드 ───────── */
const blockHTML = (v, label, body) =>
  `<div class="msg ${v}"><div class="msg-label">${label}</div><div class="msg-body">${esc(body)}</div></div>`;

function aiTurnHTML(d) {
  const hints = Array.isArray(d.hints) ? d.hints.filter(Boolean) : [];
  const mk = d.mistake && d.mistake.type && d.mistake.type !== "none" ? d.mistake : null;
  const read = (d.read || "").trim();
  return `<div class="turn ai">`
    + (read ? blockHTML("read", "📖 내가 읽은 식 — 맞는지 확인!", read) : "")
    + (d.ack ? blockHTML("ack coach-step", "여기까진 좋아", d.ack) : "")
    + (mk ? blockHTML("mistake", "⚠ 이번에 짚은 실수 · " + (MISTAKE_TYPES[mtype(mk.type)].label), mk.label || "") : "")
    + blockHTML("coach-step", "지금 막힌 곳", d.diagnosis)
    + blockHTML("accent coach-step", "이렇게 접근해 보자", d.approach)
    + blockHTML("warn coach-step", "다음 한 걸음", d.next_step)
    + (hints.length
        ? `<div class="msg"><div class="msg-label">💡 힌트</div><div class="hint-list js-hints"></div><div class="hint-row">${hints.length > 1 ? `<button class="btn btn-soft btn-sm js-more">힌트 더 보기</button>` : ""}<button class="btn btn-primary btn-sm js-solo">이제 혼자 해볼게</button></div></div>`
        : "")
    + `<div class="msg answer-wrap"><button class="btn btn-soft btn-sm js-showans" disabled title="힌트를 모두 본 뒤에 열 수 있어요">🔓 정답 방향 펼치기</button><div class="answer hidden js-answer"></div></div>`
    + `</div>`;
}

// 에피소드 추적: 현재 열려 있는 턴의 에피소드 데이터
let _pendingEpisode = null;

function closePendingEpisode() {
  if (_pendingEpisode && typeof closeEpisode === "function") {
    closeEpisode(Object.assign({}, _pendingEpisode, { resolved: false }));
    _pendingEpisode = null;
  }
}

// 턴별로 버튼을 연결(에피소드 추적 포함)
function wireTurn(turnEl, d) {
  const hints   = Array.isArray(d.hints) ? d.hints.filter(Boolean) : [];
  const chain   = typeof chainOf === "function" ? chainOf(d.stage, d.prereq) : "nostart";
  const entry   = typeof entryFor === "function" ? entryFor(chain) : 1;
  const tech    = d.technique || "other";

  let level           = Math.min(entry, hints.length);
  let used            = level;
  let answerRequested = 0;
  let blindRequests   = 0;
  let soloClicked     = false;
  let prevAttempted   = false;

  const epData = typeof openEpisode === "function"
    ? openEpisode(tech, chain, entry)
    : { pid: "default", tech, chain, entry, used: entry, consumed: 0, resolved: false,
        answerRequested: 0, blindRequests: 0, verify: "na", t: Date.now() };
  _pendingEpisode = epData;

  const hintBox = turnEl.querySelector(".js-hints");
  const more    = turnEl.querySelector(".js-more");
  const solo    = turnEl.querySelector(".js-solo");
  const showAns = turnEl.querySelector(".js-showans");
  const ans     = turnEl.querySelector(".js-answer");

  const paint = () => {
    if (hintBox) {
      // 진입점부터 시작 (앞 단계 건너뜀)
      hintBox.innerHTML = hints.slice(entry - 1, level)
        .map((h) => `<div class="hint">${esc(h)}</div>`).join("");
      typeset(hintBox);
    }
    if (more) {
      if (level >= hints.length) {
        more.textContent = "힌트 모두 봄";
        more.disabled = true;
      } else {
        more.textContent = `힌트 ${level + 1} 보기`;
        more.disabled = false;
      }
    }
    if (showAns) {
      const allSeen = level >= hints.length;
      showAns.disabled = !allSeen;
      showAns.title = allSeen ? "" : "힌트를 모두 본 뒤에 열 수 있어요";
    }
  };

  paint();

  if (more) more.onclick = () => {
    if (!prevAttempted) blindRequests++;
    prevAttempted = true;
    level = Math.min(level + 1, hints.length);
    used  = Math.max(used, level);
    epData.used         = used;
    epData.blindRequests = blindRequests;
    paint();
  };

  if (solo) solo.onclick = () => {
    if (soloClicked) return;
    soloClicked = true;
    solo.disabled    = true;
    solo.textContent = "혼자 해보는 중 ✓";
    if (more) more.disabled = true;
    const rec = Object.assign({}, epData, {
      used, consumed: Math.max(0, used - entry + 1),
      resolved: true, answerRequested, blindRequests,
      verify: d.verify || "na",
    });
    if (typeof closeEpisode === "function") closeEpisode(rec);
    _pendingEpisode = null;
  };

  if (showAns) showAns.onclick = () => {
    answerRequested++;
    epData.answerRequested = answerRequested;
    if (ans) {
      ans.classList.toggle("hidden");
      if (!ans.dataset.done) {
        ans.innerHTML = esc(d.answer || "이 문제는 직접 조금 더 시도해보자!");
        typeset(ans);
        ans.dataset.done = "1";
      }
    }
  };

  typeset(turnEl);
}

function appendUserBubble(text, imgUrl) {
  const div = document.createElement("div");
  div.className = "turn me";
  div.innerHTML = `<div class="msg me-bubble">`
    + (imgUrl ? `<img class="bubble-photo" src="${imgUrl}" alt="문제 사진" />` : "")
    + `<div class="msg-body">${esc(text)}</div></div>`;
  $("coach").appendChild(div);
  typeset(div);
  return div;
}
function trimImageAfterRead(d) {
  const first = convo[0];
  const read = (d && d.read || "").trim();
  if (!first || !first.image || !read) return;
  first.text += `\n\n[AI가 읽은 문제 핵심]\n${read}`;
  delete first.image; // 첫 응답 이후에는 사진 대신 읽은 핵심만 보내서 후속 질문을 가볍게 한다.
}

// 코치 응답을 스레드에 한 칸 추가 + 그래프 갱신 + 이어가기 입력 표시
function appendAi(d) {
  closePendingEpisode();  // 직전 턴이 아직 열려 있으면 resolved:false 로 닫음
  renderPersonalBadge();
  renderViz(d.viz);
  const wrap = document.createElement("div");
  wrap.innerHTML = aiTurnHTML(d);
  const turnEl = wrap.firstElementChild;
  $("coach").appendChild(turnEl);
  wireTurn(turnEl, d);
  trimImageAfterRead(d);
  convo.push({ role: "model", text: modelText(d) });
  const fb = $("followBox");
  if (fb) fb.classList.remove("hidden");
  turnEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (d.mistake && d.mistake.type && d.mistake.type !== "none") { recordMistake(d.mistake); renderMistakeNote(); }
  if (d._chainMismatch) console.warn("chain mismatch", d._chainMismatch);
}

// 새 문제로 스레드 시작(이전 대화 비움). 문제 사진(problemImage)이 있으면 첫 메시지에 첨부.
function startThread(problem, stuck) {
  const first = { role: "user", text: composeFirst(problem, stuck) };
  if (problemImage) first.image = { mimeType: problemImage.mimeType, data: problemImage.data };
  convo = [first];
  $("result").classList.remove("hidden");
  renderPersonalBadge();
  $("coach").innerHTML = "";
  const fb = $("followBox");
  if (fb) { fb.classList.add("hidden"); if ($("followup")) $("followup").value = ""; setFollowMsg(""); }
  const label = "📝 " + (problem.trim() || "(사진 속 문제)") + (stuck.trim() ? `\n— 막힌 곳: ${stuck.trim()}` : "");
  appendUserBubble(label, problemImage && problemImage.url);
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ───────── 문제 사진: 압축(긴 변 1152px·JPEG) → base64 (토큰·업로드 절약) ───────── */
function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read fail"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode fail"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        const url = cv.toDataURL("image/jpeg", quality);
        if (!url || !url.includes(",")) return reject(new Error("encode fail"));
        resolve({ mimeType: "image/jpeg", data: url.split(",")[1], url });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function setProblemImage(obj) {
  problemImage = obj;
  const wrap = $("probThumbWrap"), thumb = $("probThumb"), hint = $("probPhotoHint"), inp = $("probPhotoInput");
  if (obj) {
    if (thumb) thumb.src = obj.url;
    if (wrap) wrap.classList.remove("hidden");
    if (hint) hint.textContent = "사진 첨부됨 ✓";
  } else {
    if (wrap) wrap.classList.add("hidden");
    if (thumb) thumb.src = "";
    if (hint) hint.textContent = "";
    if (inp) inp.value = "";
  }
}
function setPhotoBusy(on) {
  const hint = $("probPhotoHint"), btn = $("probPhotoBtn");
  if (btn) btn.disabled = !!on;
  if (hint) hint.textContent = on ? "사진 준비 중… 잠깐만 기다려줘" : (problemImage ? "사진 첨부됨 ✓" : "");
}

/* ───────── 시각화 (Plotly, 8종) — 품질 강화: 조명·고해상도·정돈된 축 ───────── */
const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const getCSS = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#888";
const COLORWAY = ["#4263eb", "#14b8a6", "#f59e0b", "#e8590c"];
const CFG_2D = { responsive: true, displayModeBar: false, displaylogo: false, staticPlot: true };
const CFG_3D = { responsive: true, displayModeBar: false, displaylogo: false, scrollZoom: false, doubleClick: "reset" };
const fn = (s) => math.compile(s);
// 점별 안전 평가: 정의역 밖(sqrt(음수)·log(0)·1/0 등)이 나와도 그래프 전체가 죽지 않게 NaN(=그래프의 끊김)으로.
const sev = (f, scope) => { try { const v = f.evaluate(scope); return typeof v === "number" && isFinite(v) ? v : NaN; } catch { return NaN; } };
const hexA = (hex, a) => {
  const h = (hex || "").replace("#", ""); if (h.length < 6) return hex;
  const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const ax2 = () => ({ gridcolor: getCSS("--border"), zeroline: true, zerolinewidth: 1.5, zerolinecolor: getCSS("--border-strong"), linecolor: getCSS("--border-strong"), ticks: "outside", tickcolor: getCSS("--border"), fixedrange: true });
const withRange = (axis, range) => (Array.isArray(range) && range.length === 2 ? { ...axis, range } : axis);
const layout2d = (equal, xRange, yRange) => ({
  margin: { t: 10, l: 40, r: 16, b: 32 }, height: 360, showlegend: false, hovermode: false, dragmode: false,
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", colorway: COLORWAY,
  font: { family: "Pretendard, sans-serif", size: 12.5, color: getCSS("--muted") },
  xaxis: withRange(ax2(), xRange), yaxis: withRange(equal ? { ...ax2(), scaleanchor: "x" } : ax2(), yRange),
});
const axis3d = () => ({ gridcolor: getCSS("--border"), backgroundcolor: "rgba(0,0,0,0)", showbackground: true, zerolinecolor: getCSS("--border-strong"), showspikes: false });
const layout3d = () => ({
  margin: { t: 6, l: 0, r: 0, b: 0 }, height: 440, paper_bgcolor: "rgba(0,0,0,0)", dragmode: "turntable",
  font: { family: "Pretendard, sans-serif", size: 11, color: getCSS("--muted") },
  scene: { aspectmode: "cube", camera: { eye: { x: 1.55, y: 1.55, z: 1.15 } }, xaxis: axis3d(), yaxis: axis3d(), zaxis: axis3d() },
});
const LIGHT = { ambient: 0.66, diffuse: 0.85, specular: 0.18, roughness: 0.5, fresnel: 0.2 };
const LIGHTPOS = { x: 120, y: 160, z: 220 };
const SURF = "Viridis";

// 그래프는 정답을 펼치기 전에도 보인다. AI가 답이 되는 라벨을 보내면 중립 표현으로 완화한다.
const VIZ_LEAK = /극대|극소|최대|최소|최댓값|최솟값|정답|답|넓이값|확률값|거리값/;
function softVizLabel(s) {
  const t = String(s || "");
  return VIZ_LEAK.test(t) ? "후보점" : t;
}
function softVizTitle(s) {
  return String(s || "")
    .replace(/극대점|극소점|극댓값|극솟값|최댓값|최솟값/g, "후보")
    .replace(/정답|답/g, "방향");
}
function softenViz(viz) {
  if (!viz || typeof viz !== "object") return viz;
  const v = { ...viz, title: softVizTitle(viz.title) };
  if (Array.isArray(v.curves)) v.curves = v.curves.map((c) => ({ ...c, label: softVizLabel(c.label) }));
  if (Array.isArray(v.points)) v.points = v.points.map((p) => ({ ...p, label: softVizLabel(p.label) }));
  return v;
}

let lastViz = null;
function cleanNums(vals) { return vals.filter((v) => typeof v === "number" && isFinite(v)); }
function paddedRange(vals, fallback) {
  const ns = cleanNums(vals);
  if (!ns.length) return fallback;
  let lo = Math.min(...ns), hi = Math.max(...ns);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = Math.max((hi - lo) * 0.18, 0.8);
  return [lo - pad, hi + pad];
}
function geometryRanges(viz) {
  const xs = [], ys = [];
  (viz.points || []).forEach((p) => { xs.push(p.x); ys.push(p.y); });
  (viz.lines || []).forEach((ln) => {
    const a = ln.from || [ln.x1, ln.y1], b = ln.to || [ln.x2, ln.y2];
    xs.push(a[0], b[0]); ys.push(a[1], b[1]);
  });
  (viz.circles || []).forEach((c) => {
    const cx = c.x ?? c.cx ?? 0, cy = c.y ?? c.cy ?? 0, r = Math.abs(c.r ?? c.radius ?? 1);
    xs.push(cx - r, cx + r); ys.push(cy - r, cy + r);
  });
  return { x: viz.xRange || paddedRange(xs, [-5, 5]), y: viz.yRange || paddedRange(ys, [-5, 5]) };
}
function drawPlot(el, traces, layout, cfg) {
  const p = Plotly.newPlot(el, traces, layout, cfg);
  const done = () => {
    const btn = $("vizReset");
    if (btn) btn.classList.toggle("hidden", !lastViz);
  };
  return p && p.then ? p.then(done) : done();
}

function renderViz(viz, keepLast) {
  const el = $("viz"), card = $("vizCard"), cap = $("vizCap"), reset = $("vizReset");
  if (!viz || !viz.kind || viz.kind === "none") { lastViz = null; card.classList.add("hidden"); if (reset) reset.classList.add("hidden"); el.innerHTML = ""; return; }
  if (!keepLast) lastViz = viz;
  viz = softenViz(viz);
  card.classList.remove("hidden"); cap.textContent = viz.title || "";
  if (reset) reset.classList.remove("hidden");
  const A = getCSS("--accent");
  try {
    if (viz.kind === "function2d") {
      const [a, b] = viz.xRange || [-5, 5]; const xs = linspace(a, b, 400);
      const traces = (viz.curves || []).map((cv) => { const f = fn(cv.expr); return { x: xs, y: xs.map((x) => sev(f, { x })), mode: "lines", name: cv.label || cv.expr, line: { width: 3 }, connectgaps: false }; });
      if (viz.shade) {
        const sh = Array.isArray(viz.shade)
          ? { from: viz.shade[0], to: viz.shade[1], lower: "0", upper: (viz.curves && viz.curves[0] ? viz.curves[0].expr : "0") }
          : viz.shade;
        const sx = linspace(sh.from, sh.to, 220); const up = fn(sh.upper || "0"), lo = fn(sh.lower || "0"); const xr = sx.slice().reverse();
        traces.unshift({ x: [...sx, ...xr], y: [...sx.map((x) => sev(up, { x })), ...xr.map((x) => sev(lo, { x }))], fill: "toself", mode: "none", fillcolor: hexA(A, 0.2), hoverinfo: "skip" });
      }
      (viz.points || []).forEach((p) => traces.push({ x: [p.x], y: [p.y], mode: "markers+text", text: [p.label || ""], textposition: "top center", textfont: { size: 13 }, marker: { size: 11, color: A, line: { color: getCSS("--surface"), width: 2 } } }));
      drawPlot(el, traces, layout2d(false, viz.xRange, viz.yRange), CFG_2D);

    } else if (viz.kind === "implicit2d") {
      const [a, b] = viz.xRange || [-6, 6], [c, d] = viz.yRange || [-6, 6];
      const xs = linspace(a, b, 170), ys = linspace(c, d, 170), f = fn(viz.expr);
      const z = ys.map((y) => xs.map((x) => sev(f, { x, y })));
      drawPlot(el, [{ type: "contour", x: xs, y: ys, z, contours: { start: 0, end: 0, size: 1, coloring: "none" }, line: { width: 3, color: A }, showscale: false }], layout2d(true, [a, b], [c, d]), CFG_2D);

    } else if (viz.kind === "parametric2d") {
      const [a, b] = viz.tRange || [0, 6.283], ts = linspace(a, b, 420);
      const fx = fn(viz.xt), fy = fn(viz.yt);
      const px = ts.map((t) => sev(fx, { t })), py = ts.map((t) => sev(fy, { t }));
      drawPlot(el, [{ x: px, y: py, mode: "lines", line: { width: 3, color: A }, connectgaps: false }], layout2d(true, viz.xRange || paddedRange(px, [-4, 4]), viz.yRange || paddedRange(py, [-4, 4])), CFG_2D);

    } else if (viz.kind === "geometry2d") {
      const pts = viz.points || [], ranges = geometryRanges(viz), traces = [];
      const addLine = (idxs, fill) => {
        const linePts = idxs.map((i) => pts[i]).filter(Boolean);
        if (linePts.length < 2) return;
        const closed = fill && linePts.length > 2;
        traces.push({
          x: [...linePts.map((p) => p.x), ...(closed ? [linePts[0].x] : [])],
          y: [...linePts.map((p) => p.y), ...(closed ? [linePts[0].y] : [])],
          mode: "lines", fill: fill ? "toself" : "none", fillcolor: fill ? hexA(A, 0.12) : undefined,
          line: { width: fill ? 2.5 : 3, color: fill ? getCSS("--accent") : getCSS("--border-strong") },
          hoverinfo: "skip",
        });
      };
      (viz.polygons || []).forEach((poly) => addLine(poly, true));
      (viz.segments || []).forEach((seg) => addLine(seg, false));
      (viz.lines || []).forEach((ln) => {
        const p = ln.from || [ln.x1, ln.y1], q = ln.to || [ln.x2, ln.y2];
        if (p.length < 2 || q.length < 2) return;
        traces.push({
          x: [p[0], q[0]], y: [p[1], q[1]], mode: "lines+text",
          text: ["", softVizLabel(ln.label || "")], textposition: "top center",
          line: { width: 2, color: COLORWAY[2], dash: "dash" }, hoverinfo: "skip",
        });
      });
      (viz.circles || []).forEach((c, i) => {
        const cx = c.x ?? c.cx ?? 0, cy = c.y ?? c.cy ?? 0, r = Math.abs(c.r ?? c.radius ?? 1), th = linspace(0, 2 * Math.PI, 180);
        traces.push({ x: th.map((t) => cx + r * Math.cos(t)), y: th.map((t) => cy + r * Math.sin(t)), mode: "lines", name: c.label || "circle" + i, line: { width: 3, color: COLORWAY[(i + 1) % COLORWAY.length] }, hoverinfo: "skip" });
      });
      if (pts.length) traces.push({ x: pts.map((p) => p.x), y: pts.map((p) => p.y), mode: "markers+text", text: pts.map((p) => softVizLabel(p.label || "")), textposition: "top center", textfont: { size: 13 }, marker: { size: 10, color: A, line: { color: getCSS("--surface"), width: 2 } }, hoverinfo: "skip" });
      drawPlot(el, traces, layout2d(true, ranges.x, ranges.y), CFG_2D);

    } else if (viz.kind === "surface3d") {
      const [a, b] = viz.xRange || [-3, 3], [c, d] = viz.yRange || [-3, 3];
      const xs = linspace(a, b, 60), ys = linspace(c, d, 60), f = fn(viz.expr);
      const z = ys.map((y) => xs.map((x) => sev(f, { x, y })));
      drawPlot(el, [{ type: "surface", x: xs, y: ys, z, colorscale: SURF, showscale: false, lighting: LIGHT, lightposition: LIGHTPOS, contours: { z: { show: true, usecolormap: true, width: 2, project: { z: true } } } }], layout3d(), CFG_3D);

    } else if (viz.kind === "solid_revolution") {
      const [a, b] = viz.xRange || [0, 4], f = fn(viz.expr);
      const xs = linspace(a, b, 60), th = linspace(0, 2 * Math.PI, 64), X = [], Y = [], Z = [];
      th.forEach((t) => { const rx = [], ry = [], rz = []; xs.forEach((x) => { const r = sev(f, { x }); rx.push(x); ry.push(r * Math.cos(t)); rz.push(r * Math.sin(t)); }); X.push(rx); Y.push(ry); Z.push(rz); });
      drawPlot(el, [{ type: "surface", x: X, y: Y, z: Z, colorscale: "Blues", showscale: false, lighting: LIGHT, lightposition: LIGHTPOS }], layout3d(), CFG_3D);

    } else if (viz.kind === "curve3d") {
      const [a, b] = viz.tRange || [0, 6.283], ts = linspace(a, b, 360);
      const fx = fn(viz.xt), fy = fn(viz.yt), fz = fn(viz.zt);
      drawPlot(el, [{ type: "scatter3d", mode: "lines", x: ts.map((t) => sev(fx, { t })), y: ts.map((t) => sev(fy, { t })), z: ts.map((t) => sev(fz, { t })), line: { width: 6, color: A } }], layout3d(), CFG_3D);

    } else if (viz.kind === "points3d") {
      const pts = viz.points || [];
      const traces = [{ type: "scatter3d", mode: "markers+text", x: pts.map((p) => p.x), y: pts.map((p) => p.y), z: pts.map((p) => p.z), text: pts.map((p) => p.label || ""), textposition: "top center", textfont: { size: 13 }, marker: { size: 6, color: A } }];
      (viz.segments || []).forEach(([i, j]) => { if (pts[i] && pts[j]) traces.push({ type: "scatter3d", mode: "lines", x: [pts[i].x, pts[j].x], y: [pts[i].y, pts[j].y], z: [pts[i].z, pts[j].z], line: { width: 5, color: A } }); });
      drawPlot(el, traces, layout3d(), CFG_3D);

    } else { card.classList.add("hidden"); }
  } catch (e) { cap.textContent = "이 문제는 그림으로 표현하기 어려웠어요."; el.innerHTML = ""; }
}

/* ───────── 실수 노트 렌더 (유형별 누적 막대그래프) ───────── */
// 모바일/아이패드: staticPlot 으로 차트가 터치 스크롤을 가로채지 않게 한다.
function renderMistakeNote() {
  const card = $("mistakeNote");
  if (!card) return;
  const list = loadMistakes();
  const el = $("mnViz");
  if (!list.length) { card.classList.add("hidden"); if (el) el.innerHTML = ""; return; }

  const counts = {};
  list.forEach((m) => { const k = mtype(m.type); counts[k] = (counts[k] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]); // 잦은 순
  card.classList.remove("hidden");

  const top = rows[0];
  const sum = $("mnSummary");
  const entryInfo = (() => {
    if (typeof loadEntries !== "function") return "";
    const entries = loadEntries();
    return Object.keys(CHAIN_HINT_LEN)
      .filter((c) => CHAIN_LABELS[c])
      .map((c) => {
        const e = entries[c];
        if (e == null) return null;
        return `${CHAIN_LABELS[c]} ${e}/${CHAIN_HINT_LEN[c] - 1}`;
      })
      .filter(Boolean).join(" · ");
  })();
  if (sum) sum.innerHTML = `지금까지 <b>${list.length}</b>번 기록 · 가장 잦은 실수: <b>${MISTAKE_TYPES[top[0]].label}</b> (${top[1]}회) · 다음 코칭에 반영`
    + (entryInfo ? `<br><small style="opacity:.7">${esc(entryInfo)}</small>` : "");

  if (!el || !window.Plotly) return;
  const A = getCSS("--accent");
  const labels = rows.map((r) => MISTAKE_TYPES[r[0]].label).reverse(); // 잦은 게 위로
  const vals = rows.map((r) => r[1]).reverse();
  try {
    Plotly.newPlot(el, [{
      type: "bar", orientation: "h", x: vals, y: labels,
      marker: { color: A }, text: vals.map(String), textposition: "auto", cliponaxis: false, hoverinfo: "skip",
    }], {
      margin: { t: 6, l: 108, r: 20, b: 24 }, height: 60 + rows.length * 34,
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Pretendard, sans-serif", size: 13, color: getCSS("--muted") },
      xaxis: { dtick: 1, rangemode: "tozero", gridcolor: getCSS("--border"), zeroline: false, fixedrange: true },
      yaxis: { automargin: true, fixedrange: true },
    }, { responsive: true, displayModeBar: false, staticPlot: true });
  } catch (e) {}
}

/* ───────── PDF로 저장 (브라우저 인쇄 → 'PDF로 저장') ───────── */
// 텍스트·수식은 벡터 그대로(선명). 그래프는 3D(WebGL)도 인쇄되게 PNG로 한 번 구워 끼운다.
async function saveAsPdf() {
  const el = $("viz");
  let img = null;
  const cleanup = () => { if (img && img.parentNode) img.parentNode.removeChild(img); document.body.classList.remove("printing"); window.removeEventListener("afterprint", cleanup); };
  try {
    const hasPlot = el && el.querySelector && (el.querySelector("canvas") || el.querySelector("svg"));
    if (hasPlot && window.Plotly && Plotly.toImage) {
      const w = el.clientWidth || 700, h = el.clientHeight || 380;
      const url = await Plotly.toImage(el, { format: "png", width: w, height: h, scale: 2 });
      img = document.createElement("img");
      img.className = "print-graph";
      img.src = url;
      el.parentNode.insertBefore(img, el.nextSibling);
      document.body.classList.add("printing"); // 인쇄 시 살아있는 그래프 대신 이 PNG를 보여줌
    }
  } catch (e) {}
  window.addEventListener("afterprint", cleanup);
  window.print();
  setTimeout(cleanup, 1500); // afterprint 미지원 브라우저 안전망
}

/* ───────── 수식 입력 도우미: 기호 버튼 + 실시간 미리보기 ───────── */
const SYMBOLS = [["x²","^2"],["xⁿ","^"],["√","sqrt("],["·","*"],["÷","/"],["π","pi"],["≤","<="],["≥",">="],["( )","()"],["∫","∫"]];
let lastField = null;
function insertToken(tok) {
  const el = lastField || $("stuck") || $("problem"); if (!el) return;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
  el.value = el.value.slice(0, s) + tok + el.value.slice(e);
  el.focus();
  const caret = tok === "()" ? s + 1 : s + tok.length;
  el.setSelectionRange(caret, caret);
  livePreview(el);
}
// 타이핑한 수식 표기를 '보기 좋게' 변환(한글이 섞여도 됨): f'(x)=3x^2-3 → f′(x)=3x²−3
function prettyMath(s) {
  let t = String(s).replace(/<=/g, "≤").replace(/>=/g, "≥"); // 부등호 먼저(유니코드라 esc 안전)
  t = esc(t);                                                 // 사용자 입력의 < > & 무력화
  return t
    .replace(/([A-Za-z])'/g, "$1′")          // 도함수 프라임
    .replace(/sqrt\s*\(/g, "√(")             // 루트
    .replace(/\*/g, "·")                      // 곱셈
    .replace(/\bpi\b/g, "π")                  // 원주율
    .replace(/\^\(([^)]*)\)/g, "<sup>$1</sup>")     // 지수 ^(...)
    .replace(/\^([A-Za-z0-9.]+)/g, "<sup>$1</sup>"); // 지수 ^n
}
function livePreview(srcEl) {
  const map = { problem: "probPrev", stuck: "stuckPrev", followup: "followPrev" };
  const out = $(map[srcEl.id]);
  if (!out) return;
  const v = (srcEl.value || "").trim();
  if (!v) { out.classList.add("hidden"); out.innerHTML = ""; return; }
  out.classList.remove("hidden");
  let body;
  if (!/[가-힣]/.test(v)) {
    // 순수 수식: 전체 KaTeX 렌더 시도, 실패하면 prettify로 폴백
    let tex = null;
    try { tex = math.parse(v).toTex(); } catch (e) {}
    body = tex ? `\\(${tex}\\)` : prettyMath(v);
  } else {
    // 한글 섞임: 수식 토큰만 보기 좋게(½x²·√·′ 등) — '인식됐다'는 안심 신호
    body = prettyMath(v);
  }
  out.innerHTML = `<span class="mprev-lab">미리보기</span>` + body;
  typeset(out);
}

/* ───────── 부팅 ───────── */
function setMsg(t, err) { const m = $("msg"); if (!m) return; m.className = "status" + (err ? " error" : ""); m.innerHTML = t; }
function setFollowMsg(t, err) { const m = $("followMsg"); if (!m) return; m.className = "status" + (err ? " error" : ""); m.innerHTML = t || ""; }
const LOADING = () => `<span class="dots"><i></i><i></i><i></i></span>코치가 생각 중…`;

function boot() {
  // 입력 필드: 마지막 포커스 추적 + 실시간 미리보기 (이어가기 칸 포함)
  ["problem", "stuck", "followup"].forEach((id) => {
    const el = $(id); if (!el) return;
    el.addEventListener("focus", () => (lastField = el));
    el.addEventListener("input", () => livePreview(el));
  });
  // 기호 버튼 (입력부 + 이어가기 칸 둘 다)
  ["symbolbar", "symbolbarFollow"].forEach((barId) => {
    const bar = $(barId);
    if (bar) SYMBOLS.forEach(([label, tok]) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = () => insertToken(tok); bar.appendChild(b); });
  });

  // 메인 버튼: 새 문제로 스레드 시작
  const go = $("go");
  if (go) go.onclick = async () => {
    if (requestBusy) { setMsg("이미 코치가 답하는 중이에요. 잠깐만 기다려줘."); return; }
    const problem = $("problem").value, stuck = $("stuck").value;
    if (imageJob) {
      setMsg("사진을 준비하는 중이에요. 끝나면 바로 물어볼게요…");
      try { await imageJob; }
      catch (e) { setMsg("사진을 처리하지 못했어요. 문제 전체가 보이게 다시 찍어줘.", true); return; }
    }
    if (!problem.trim() && !problemImage) { setMsg("문제 사진을 올려줘. 사진이 없으면 텍스트로 직접 입력해도 돼.", true); return; }
    // 첫 응답을 코치에게 받는다 (예시 보기 상태였다면 버튼 원복)
    const dB = $("demo"); if (dB) { dB.dataset.on = "0"; dB.textContent = "예시 보기"; }
    startThread(problem, stuck);
    setMsg(LOADING()); go.disabled = true;
    requestBusy = true;
    try { const d = await askConvo(); setMsg(""); appendAi(d); }
    catch (e) { setMsg("⚠ " + e.message, true); }
    finally { requestBusy = false; go.disabled = false; }
  };

  // 이어가기 버튼: '다음 걸음'을 해본 결과를 적고 그다음 걸음을 받는다
  const fgo = $("followGo");
  if (fgo) fgo.onclick = async () => {
    if (requestBusy) { setFollowMsg("이미 코치가 답하는 중이에요. 잠깐만 기다려줘."); return; }
    const v = ($("followup").value || "").trim();
    if (!convo.length) { setFollowMsg("먼저 위에서 문제를 물어봐줘.", true); return; }
    if (!v) { setFollowMsg("해본 내용이나 지금 막힌 곳을 한 줄 적어줘.", true); return; }
    const bubble = appendUserBubble(v);
    const weak = weaknessText();
    const ev2   = typeof extractEvidence === "function" ? extractEvidence(v) : { goal: false, method: false, expr: false, partial: false, answer: false };
    const vf2   = tryVerify(convo[0] ? convo[0].text : "", v);
    const codePart = `\n\n[코드 판정]\nevidence: goal=${Y(ev2.goal)} method=${Y(ev2.method)} expr=${Y(ev2.expr)} partial=${Y(ev2.partial)} answer=${Y(ev2.answer)}\nverify: ${vf2}`;
    const userTurn = { role: "user", text: `[코치가 준 '다음 한 걸음'을 해본 결과 / 지금 막힌 곳]\n${v}${codePart}${weak ? "\n\n" + weak : ""}` };
    convo.push(userTurn);
    $("followup").value = ""; livePreview($("followup"));
    setFollowMsg(LOADING()); fgo.disabled = true;
    requestBusy = true;
    try { const d = await askConvo(); setFollowMsg(""); appendAi(d); }
    catch (e) {
      if (convo[convo.length - 1] === userTurn) convo.pop();
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      $("followup").value = v; livePreview($("followup"));
      setFollowMsg("⚠ " + e.message + " 입력은 복구했으니 다시 누르면 돼.", true);
    }
    finally { requestBusy = false; fgo.disabled = false; }
  };
  const followup = $("followup");
  if (followup) followup.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") fgo.onclick(); });

  // PDF로 저장
  const sp = $("savePdf");
  if (sp) sp.onclick = saveAsPdf;

  const vr = $("vizReset");
  if (vr) { vr.classList.add("hidden"); vr.onclick = () => { if (lastViz) renderViz(lastViz, true); }; }

  const clr = $("clear");
  if (clr) clr.onclick = () => {
    ["problem", "stuck"].forEach((id) => { if ($(id)) $(id).value = ""; });
    ["probPrev", "stuckPrev"].forEach((id) => { if ($(id)) { $(id).classList.add("hidden"); $(id).innerHTML = ""; } });
    setProblemImage(null); $("result").classList.add("hidden"); renderPersonalBadge(); convo = []; setMsg("");
  };

  // '예시 보기' = 토글: 누르면 내장 샘플(SAMPLE) 표시, 다시 누르면 닫기
  const demoBtn = $("demo");
  if (demoBtn) demoBtn.onclick = () => {
    if (demoBtn.dataset.on === "1") { closeSample(); return; }   // 다시 누르면 닫기
    setProblemImage(null);
    $("problem").value = SAMPLE.problem; $("stuck").value = SAMPLE.stuck;
    livePreview($("problem")); livePreview($("stuck")); setMsg("");
    startThread(SAMPLE.problem, SAMPLE.stuck); appendAi(SAMPLE.r);
    demoBtn.dataset.on = "1"; demoBtn.textContent = "예시 닫기";
  };
  function closeSample() {
    ["problem", "stuck"].forEach((id) => { if ($(id)) $(id).value = ""; });
    ["probPrev", "stuckPrev"].forEach((id) => { if ($(id)) { $(id).classList.add("hidden"); $(id).innerHTML = ""; } });
    setProblemImage(null); $("result").classList.add("hidden"); renderPersonalBadge(); convo = []; setMsg("");
    if (demoBtn) { demoBtn.dataset.on = "0"; demoBtn.textContent = "예시 보기"; }
  }

  // 문제 사진 업로드(찍기/고르기) → 압축 → 첨부
  const pBtn = $("probPhotoBtn"), pInput = $("probPhotoInput"), pX = $("probThumbX");
  if (pBtn && pInput) pBtn.onclick = () => pInput.click();
  if (pInput) pInput.onchange = async () => {
    const file = pInput.files && pInput.files[0]; if (!file) return;
    if (!/^image\//.test(file.type || "")) { setMsg("이미지 파일만 올릴 수 있어요.", true); return; }
    setMsg("📷 사진 준비 중…");
    setPhotoBusy(true);
    const job = compressImage(file, 1152, 0.74);
    imageJob = job;
    try {
      const img = await job;
      if (imageJob === job) { setProblemImage(img); setMsg(""); }
    } catch (e) {
      if (imageJob === job) { setProblemImage(null); setMsg("사진을 불러오지 못했어요. 문제 전체가 보이게 다시 찍어줘.", true); }
    } finally {
      if (imageJob === job) { imageJob = null; setPhotoBusy(false); }
    }
  };
  if (pX) pX.onclick = () => setProblemImage(null);

  // 실수 노트: 지우기 버튼 + 누적 통계 즉시 표시(돌아온 학생도 바로 약점이 보이게)
  const mnc = $("mnClear");
  if (mnc) mnc.onclick = () => { if (confirm("이 기기에 쌓인 실수 기록을 모두 지울까요?")) { clearMistakes(); renderMistakeNote(); renderPersonalBadge(); } };

  // 실험 데이터 내보내기
  const mnExport = $("mnExport");
  if (mnExport) mnExport.onclick = () => { if (typeof exportEpisodesCSV === "function") exportEpisodesCSV(); };

  // 온보딩: 참가자 코드 + 자기보고 저장
  const onboardSave = $("onboardSave");
  if (onboardSave) {
    // 기존 값 복원
    const pidInput = $("pid");
    const storedPid = typeof _pid === "undefined" ? (localStorage.getItem("coach.pid") || "") : (localStorage.getItem("coach.pid") || "");
    if (pidInput && storedPid) { pidInput.value = storedPid; }
    const storedK = (() => { try { const p = storedPid || "default"; return JSON.parse(localStorage.getItem("coach.selfreport." + p) || "[]"); } catch(e) { return []; } })();
    document.querySelectorAll("#onboard input[type=checkbox]").forEach((cb) => {
      if (storedK.includes(cb.value)) cb.checked = true;
    });
    if (storedPid) { const ob = $("onboard"); if (ob) ob.classList.add("hidden"); }

    onboardSave.onclick = () => {
      const pidVal = pidInput ? pidInput.value.trim() : "";
      if (typeof savePid === "function" && pidVal) savePid(pidVal);
      else if (pidVal) localStorage.setItem("coach.pid", pidVal);
      const checked = Array.from(document.querySelectorAll("#onboard input[type=checkbox]:checked")).map((cb) => cb.value);
      if (typeof saveSelfReport === "function") saveSelfReport(checked);
      else localStorage.setItem("coach.selfreport." + (pidVal || "default"), JSON.stringify(checked));
      const ob = $("onboard");
      if (ob) ob.classList.add("hidden");
    };
  }

  renderMistakeNote();
  renderPersonalBadge();
}
document.addEventListener("DOMContentLoaded", boot);

// '예시 보기' 내장 샘플(회전체 3D) — app.js에 직접 박아둔 한 건(키 없이도 화면/그래프 시연용)
const SAMPLE = {
  problem: "함수 y=√x (0 ≤ x ≤ 4) 를 x축 둘레로 회전시켜 만든 입체의 부피를 구하시오.",
  stuck: "회전체인 건 알겠는데 부피를 어떤 적분으로 세우는지 모르겠어.",
  r: {
    ack: "좋아, $y=\\sqrt{x}$로 회전체를 잡은 것까진 정확해!",
    diagnosis: "막힌 핵심은 '회전체의 부피'를 어떤 적분으로 세우느냐야.",
    approach: "x축 둘레로 돈 회전체는 각 $x$에서 단면이 반지름 $\\sqrt{x}$인 원이야. 그래서 부피는 $V=\\pi\\int_a^b \\{f(x)\\}^2\\,dx$ 로 세워.",
    next_step: "그럼 $f(x)=\\sqrt{x}$를 넣으면 적분 안의 식 $\\{f(x)\\}^2$ 은 무엇이 될까?",
    hints: ["단면은 반지름 $f(x)$인 원이야. 원의 넓이 공식은?", "$\\pi r^2$에서 $r=\\sqrt{x}$. 그러면 $r^2$은?", "$\\pi\\int_0^4 x\\,dx$ 꼴이 돼. 이제 적분만 남았어(값은 직접!)."],
    viz: { kind: "solid_revolution", title: "y=√x 를 x축으로 돌린 회전체", expr: "sqrt(x)", xRange: [0, 4] },
    answer: "$\\pi\\int_0^4 x\\,dx$ 를 계산하면 부피가 나와. 끝까지 직접!",
  },
};
