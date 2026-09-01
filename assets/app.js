/* 赤青ナビ フロントエンド
   data/data.json を読み込み、判定・予測を《サイト側でも再計算》して描画する。
   遡り年数・最小サンプル数・判定しきい値・指標の重みは調整パネルで変更可能。 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STORE_KEY = "akaao_params_v1";
  const REGIME_JP = { up: "上昇トレンド", down: "下降トレンド", mid: "もみ合い" };
  const RZONE_JP = { hot: "過熱", cold: "底値圏", high: "やや強", low: "やや弱" };

  let DATA = null, params = null, firstVerdict = true;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    wireSheet();
    renderTerms();
    try {
      const res = await fetch("data/data.json?v=" + Date.now());
      if (!res.ok) throw new Error("HTTP " + res.status);
      DATA = await res.json();
    } catch (e) {
      $("freshness").innerHTML =
        '<div style="color:var(--gold)">データを読み込めません</div>' +
        '<div style="font-size:10px">data/data.json を確認してください</div>';
      console.error(e); return;
    }
    params = loadParams(DATA.config);
    renderFreshness(DATA);
    renderIndex(DATA.index);
    renderLeverage(DATA.leverage);
    renderIndicators(DATA.indicators);
    renderOvernight(DATA.overnight);
    renderSources(DATA.sources, DATA.generated_at, DATA.config.run_times_jst);
    renderCutoff();
    buildAdjuster();
    recompute();               // 判定・予測を params で計算して描画
    updateMethodologyValues();  // 仕組みセクションの現在値を反映
    $("foot").textContent =
      `データ元: ${DATA.source}　/　テクニカルの機械的集計であり投資助言ではありません`;
  }

  /* ============================================================ 再計算コア */
  function recompute() {
    renderVerdict(computeVerdict(DATA.indicators, params.weights, params.threshold));
    renderPrediction(computePrediction(
      DATA.pred_samples, DATA.prediction.key, params.lookback, params.minSamples));
  }

  // ルールベース判定（Python の aggregate と同じロジック）
  function computeVerdict(indicators, weights, threshold) {
    const map = { bull: 1, bear: -1, neutral: 0 };
    let totalW = 0, raw = 0, nb = 0, ns = 0;
    indicators.forEach((s) => {
      const w = (weights[s.id] != null) ? weights[s.id] : s.weight;
      totalW += w; raw += map[s.signal] * w;
      if (s.signal === "bull") nb++; else if (s.signal === "bear") ns++;
    });
    const score = Math.round(raw / totalW * 100);
    let side, label;
    if (score >= threshold) { side = "bull"; label = "ブル寄り"; }
    else if (score <= -threshold) { side = "bear"; label = "ベア寄り"; }
    else { side = "neutral"; label = "様子見"; }
    const conviction = Math.min(5, Math.round(Math.abs(score) / 20));
    const summary = `${indicators.length}指標中 強気${nb} / 弱気${ns}。総合スコア ${score > 0 ? "+" : ""}${score}。`;
    return { side, label, score, conviction, summary };
  }

  // 過去データ予測（Python の historical_prediction と同じロジック）
  function computePrediction(samples, key, lookbackYears, minSamples) {
    const anchor = new Date(DATA.index.date + "T00:00:00");
    const cut = new Date(anchor); cut.setFullYear(cut.getFullYear() - lookbackYears);
    const cutStr = cut.toISOString().slice(0, 10);
    const win = samples.filter((s) => s[0] >= cutStr);
    const reg = key.split("|")[0];
    let matched = win.filter((s) => s[1] === key), basis = "類似局面";
    if (matched.length < minSamples) { matched = win.filter((s) => s[1].split("|")[0] === reg); basis = "トレンド区分"; }
    const n = matched.length;
    const up = n ? matched.filter((s) => s[2] > 0).length / n : 0.5;
    const avg = n ? matched.reduce((a, s) => a + s[2], 0) / n : 0;
    let side, label;
    if (up >= 0.55) { side = "bull"; label = "ブル寄り"; }
    else if (up <= 0.45) { side = "bear"; label = "ベア寄り"; }
    else { side = "neutral"; label = "五分五分"; }
    const conf = n >= 40 ? "高" : (n >= 15 ? "中" : "低");
    const [r, z, m] = key.split("|");
    const note = `直近${lookbackYears}年で、同じ状態（${REGIME_JP[r]}・RSI${RZONE_JP[z]}・MACD${m === "pos" ? "＋" : "−"}）だった日は${n}回。そのうち翌日上昇は${Math.round(up * 100)}%（${basis}ベース、サンプル信頼度：${conf}）。`;
    return { side, label, up_probability: up, sample_size: n, avg_next_return_pct: avg, confidence: conf };
  }

  /* ============================================================ 描画 */
  function renderFreshness(d) {
    const dt = new Date(d.generated_at);
    const stamp = isNaN(dt) ? d.generated_at :
      `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
    let html = `<div>更新 <b>${stamp}</b></div>`;
    if (d.is_sample) html += `<span class="badge-sample">サンプルデータ</span>`;
    $("freshness").innerHTML = html;
  }

  function renderVerdict(v) {
    const el = $("verdict");
    el.classList.remove("is-bull", "is-bear", "is-neutral");
    el.classList.add("is-" + v.side);
    $("callSide").textContent = v.label;
    $("callScore").textContent = (v.score > 0 ? "+" : "") + v.score;
    $("callSummary").textContent = v.summary;

    const pos = (v.score + 100) / 2, marker = $("tugMarker");
    if (reduce || !firstVerdict) marker.style.left = pos + "%";
    else { marker.style.left = "50%"; requestAnimationFrame(() => setTimeout(() => (marker.style.left = pos + "%"), 60)); }
    firstVerdict = false;

    const pips = $("pips"); pips.innerHTML = "";
    for (let i = 0; i < 5; i++) {
      const p = document.createElement("div");
      p.className = "pip" + (i < v.conviction ? " on" : "");
      pips.appendChild(p);
    }
    const lev = DATA.leverage;
    $("bullMove").textContent = "1日 ±" + lev.swing_bull_pct + "%";
    $("bearMove").textContent = "1日 ±" + lev.swing_bear_pct + "%";
    $("pickBull").classList.toggle("active", v.side === "bull");
    $("pickBear").classList.toggle("active", v.side === "bear");
  }

  function renderCutoff() {
    const c = (DATA.config && DATA.config.order_cutoff) || "15:20";
    $("cutoffNote").textContent = `購入申込は ${c} まで（引け15:30の10分前）`;
  }

  function renderIndex(ix) {
    $("idxDate").textContent = ix.date;
    $("idxNow").textContent = fmtNum(ix.last);
    const up = ix.change >= 0;
    $("idxChg").innerHTML =
      `<span class="${up ? "up" : "down"}">${up ? "▲" : "▼"} ${fmtNum(Math.abs(ix.change))} (${fmtPct(ix.change_pct)})</span>`;
    drawSpark(ix.history, up);
  }

  function renderPrediction(p) {
    drawDonut(p.up_probability, p.side);
    $("predLabel").innerHTML =
      `翌日は <span class="read-${p.side}">${p.label}</span>　（上昇確率 ${Math.round(p.up_probability * 100)}%）`;
    $("predNote").textContent =
      `直近${params.lookback}年で、同じ状態だった日は${p.sample_size}回。そのうち翌日上昇は${Math.round(p.up_probability * 100)}%（サンプル信頼度：${p.confidence}）。`;
    $("predMeta").innerHTML = [
      `<span class="chipstat">類似局面 <b>${p.sample_size}回</b></span>`,
      `<span class="chipstat">翌日平均 <b>${fmtPct(p.avg_next_return_pct)}</b></span>`,
      `<span class="chipstat">信頼度 <b>${p.confidence}</b></span>`,
    ].join("");
  }

  function renderIndicators(list) {
    const tech = list.filter((i) => i.group !== "overnight");
    const ov = list.filter((i) => i.group === "overnight");
    renderGrid(tech, "gridTech");
    renderGrid(ov, "gridOv");
  }
  function renderGrid(items, elId) {
    const grid = $(elId); if (!grid) return; grid.innerHTML = "";
    items.forEach((ind) => {
      const btn = document.createElement("button");
      btn.className = "ind";
      btn.innerHTML =
        `<div class="in-top"><span class="in-name">${ind.name}</span><span class="dot ${ind.signal}"></span></div>` +
        `<div class="in-val">${ind.display}</div>` +
        `<div class="in-read read-${ind.signal}">${ind.reading}</div>` +
        `<div class="in-tap">タップで解説</div>`;
      btn.addEventListener("click", () => openIndicator(ind));
      grid.appendChild(btn);
    });
  }

  function renderOvernight(ov) {
    const sec = $("ovSection");
    if (!ov || !ov.available) { if (sec) sec.style.display = "none"; return; }
    const p = ov.prediction;
    if (p && p.available) {
      $("ovProb").textContent = Math.round(p.up_probability * 100) + "%";
      $("ovProb").className = "ovp-prob num read-" + p.side;
      $("ovLabel").innerHTML = `翌営業日は <span class="read-${p.side}">${p.label}</span>`;
      $("ovNote").textContent = p.note;
      $("ovMeta").innerHTML = [
        `<span class="chipstat">該当 <b>${p.sample_size}回</b></span>`,
        `<span class="chipstat">翌日平均 <b>${fmtPct(p.avg_next_return_pct)}</b></span>`,
        `<span class="chipstat">信頼度 <b>${p.confidence}</b></span>`,
      ].join("");
      $("ovPredCard").style.display = "";
    } else {
      $("ovPredCard").style.display = "none";
    }
  }

  /* ============================================================ データ鮮度 */
  const pad = (n) => String(n).padStart(2, "0");
  const fmtMD = (iso) => { const [, m, d] = iso.split("-"); return `${+m}/${+d}`; };

  function renderSources(sources, genAt, runTimes) {
    const box = $("srcRows"); if (box) {
      box.innerHTML = "";
      (sources || []).forEach((s) => {
        const ok = s.ok !== false;
        const row = document.createElement("div");
        row.className = "src-row";
        row.innerHTML =
          `<span class="src-dot ${ok ? "ok" : "ng"}"></span>` +
          `<span class="src-name">${s.name}</span>` +
          `<span class="src-asof num">${ok && s.as_of ? fmtMD(s.as_of) + " 時点" : "取得できず"}</span>` +
          `<span class="src-prov">${s.provider || ""}</span>`;
        box.appendChild(row);
      });
    }
    const dt = new Date(genAt);
    $("srcGen").textContent = isNaN(dt) ? genAt
      : `${dt.getMonth() + 1}/${dt.getDate()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    const nx = nextRun(runTimes || ["08:00", "18:00", "20:00"]);
    $("srcNext").textContent = nx ? fmtNext(nx) : "—";
  }

  // 平日の指定時刻（JST）から次回実行を求める。端末TZに関わらずJST基準で計算。
  function nextRun(times) {
    const slots = times.map((t) => { const [h, m] = t.split(":"); return { h: +h, m: +(m || 0) }; });
    const now = new Date();
    const jstNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    for (let add = 0; add < 8; add++) {
      const day = new Date(jstNow); day.setDate(jstNow.getDate() + add); day.setHours(0, 0, 0, 0);
      const dow = day.getDay();
      if (dow === 0 || dow === 6) continue;   // 土日は実行なし
      for (const s of slots) {
        const cand = new Date(day); cand.setHours(s.h, s.m, 0, 0);
        if (cand > jstNow) return { cand, jstNow };
      }
    }
    return null;
  }
  function fmtNext({ cand, jstNow }) {
    const diffMin = Math.round((cand - jstNow) / 60000);
    const d0 = new Date(jstNow); d0.setHours(0, 0, 0, 0);
    const c0 = new Date(cand); c0.setHours(0, 0, 0, 0);
    const dayDiff = Math.round((c0 - d0) / 86400000);
    const wd = ["日", "月", "火", "水", "木", "金", "土"][cand.getDay()];
    const dayLabel = dayDiff === 0 ? "本日" : (dayDiff === 1 ? "明日" : `${cand.getMonth() + 1}/${cand.getDate()}(${wd})`);
    const rel = diffMin < 60 ? `約${diffMin}分後` : `約${Math.round(diffMin / 60)}時間後`;
    return `${dayLabel} ${cand.getHours()}:${pad(cand.getMinutes())}頃（${rel}）`;
  }

  function renderLeverage(lev) {
    $("dailyMove").textContent = "±" + lev.daily_move_pct + "%";
    $("levBull").textContent = "±" + lev.swing_bull_pct + "%";
    $("levBear").textContent = "±" + lev.swing_bear_pct + "%";
    $("decayNote").textContent = lev.decay_note;
    $("costNote").textContent = lev.cost_note;
    $("refBull").textContent = fmtPct(lev.today_bull_pct);
    $("refBear").textContent = fmtPct(lev.today_bear_pct);
  }

  function renderTerms() {
    const chips = [
      ["nikkei", "日経平均"], ["ma", "移動平均線"], ["golden", "ゴールデンクロス"],
      ["rsi14", "RSI"], ["macd", "MACD"], ["bb", "ボリンジャーバンド"],
      ["us", "米国株"], ["jpy", "ドル円"], ["fut", "日経先物"], ["overnight", "オーバーナイト"],
      ["volatility", "ボラティリティ"], ["decay", "減価"], ["leverage", "レバレッジ"],
      ["cost", "往復コスト"], ["cutoff", "申込締切"], ["nav", "基準価額"], ["prediction", "予測の仕組み"],
    ];
    const box = $("terms");
    chips.forEach(([k, label]) => {
      const c = document.createElement("button");
      c.className = "termchip"; c.textContent = label;
      c.addEventListener("click", () => openTerm(k));
      box.appendChild(c);
    });
  }

  /* ============================================================ 仕組み表示 */
  function updateMethodologyValues() {
    $("mThOver").textContent = params.threshold;
    $("mThUnder").textContent = params.threshold;
    $("mLb").textContent = "直近" + params.lookback + "年";
    $("mMin").textContent = params.minSamples;
    $("mWeights").innerHTML = DATA.indicators.map((i) => {
      const w = (params.weights[i.id] != null) ? params.weights[i.id] : i.weight;
      return `<span class="wt">${i.name}<b>${w.toFixed(1)}</b></span>`;
    }).join("");
  }

  /* ============================================================ 調整パネル */
  function defaultParams(cfg) {
    return {
      weights: Object.assign({}, cfg.weights),
      threshold: cfg.score_threshold,
      lookback: cfg.lookback_years,
      minSamples: cfg.min_samples,
    };
  }
  function loadParams(cfg) {
    const def = defaultParams(cfg);
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s) return {
        weights: Object.assign({}, def.weights, s.weights || {}),
        threshold: s.threshold ?? def.threshold,
        lookback: s.lookback ?? def.lookback,
        minSamples: s.minSamples ?? def.minSamples,
      };
    } catch (e) { /* localStorage 不可でも既定で動く */ }
    return def;
  }
  function saveParams() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch (e) { /* noop */ }
  }

  function buildAdjuster() {
    $("cLb").value = params.lookback;
    $("cMin").value = params.minSamples;
    $("cTh").value = params.threshold;
    $("vLb").textContent = params.lookback;
    $("vMin").textContent = params.minSamples;
    $("vTh").textContent = params.threshold;

    const box = $("wSliders"); box.innerHTML = "";
    DATA.indicators.forEach((ind) => {
      const w = (params.weights[ind.id] != null) ? params.weights[ind.id] : ind.weight;
      const row = document.createElement("label"); row.className = "ctl";
      row.innerHTML = `<span>${ind.name} <b>${w.toFixed(1)}</b></span>` +
        `<input type="range" min="0" max="3" step="0.1" value="${w}">`;
      const inp = row.querySelector("input"), b = row.querySelector("b");
      inp.addEventListener("input", () => {
        const val = parseFloat(inp.value);
        params.weights[ind.id] = val; b.textContent = val.toFixed(1); onChange();
      });
      box.appendChild(row);
    });

    bindRange("cLb", "vLb", (v) => { params.lookback = +v; });
    bindRange("cMin", "vMin", (v) => { params.minSamples = +v; });
    bindRange("cTh", "vTh", (v) => { params.threshold = +v; });
    $("resetBtn").addEventListener("click", resetParams);
  }
  function bindRange(inId, outId, apply) {
    $(inId).addEventListener("input", (e) => { apply(e.target.value); $(outId).textContent = e.target.value; onChange(); });
  }
  function onChange() { saveParams(); recompute(); updateMethodologyValues(); }
  function resetParams() {
    params = defaultParams(DATA.config);
    saveParams(); buildAdjuster(); recompute(); updateMethodologyValues();
  }

  /* ============================================================ 図形 */
  function drawSpark(hist, up) {
    if (!hist || hist.length < 2) return;
    const w = 100, h = 40, pad = 3;
    const cs = hist.map((p) => p.c);
    const min = Math.min(...cs), max = Math.max(...cs), rng = max - min || 1;
    const step = (w - pad * 2) / (cs.length - 1);
    const pts = cs.map((c, i) =>
      `${(pad + i * step).toFixed(2)},${(h - pad - ((c - min) / rng) * (h - pad * 2)).toFixed(2)}`);
    const color = up ? "var(--bull)" : "var(--bear)";
    const fill = up ? "rgba(255,77,82,.16)" : "rgba(59,155,255,.16)";
    const lastXY = pts[pts.length - 1].split(",");
    $("spark").innerHTML =
      `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
      `<polygon points="${pad},${h - pad} ${pts.join(" ")} ${w - pad},${h - pad}" fill="${fill}"/>` +
      `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${lastXY[0]}" cy="${lastXY[1]}" r="2.2" fill="${color}"/></svg>`;
  }

  function drawDonut(prob, side) {
    const r = 40, c = 2 * Math.PI * r, on = c * prob;
    const color = side === "bull" ? "var(--bull)" : side === "bear" ? "var(--bear)" : "var(--gold)";
    $("donut").innerHTML =
      `<svg viewBox="0 0 92 92" width="92" height="92">` +
      `<circle cx="46" cy="46" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="9"/>` +
      `<circle cx="46" cy="46" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"` +
      ` stroke-dasharray="${on.toFixed(2)} ${(c - on).toFixed(2)}"/></svg>` +
      `<div class="pct">${Math.round(prob * 100)}<span style="font-size:12px">%</span></div>`;
  }

  /* ============================================================ シート */
  let sheetOpen = false;
  function wireSheet() {
    $("backdrop").addEventListener("click", closeSheet);
    $("sheetClose").addEventListener("click", closeSheet);
    document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());
    document.body.addEventListener("click", (e) => {
      const t = e.target.closest("[data-term]");
      if (t) openTerm(t.getAttribute("data-term"));
    });
    let y0 = null;
    const sheet = $("sheet");
    sheet.addEventListener("touchstart", (e) => (y0 = e.touches[0].clientY), { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0 && sheet.scrollTop <= 0) sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener("touchend", (e) => {
      const dy = e.changedTouches[0].clientY - (y0 ?? e.changedTouches[0].clientY);
      sheet.style.transform = ""; if (dy > 90) closeSheet(); y0 = null;
    });
  }
  function fillSheet({ eyebrow, side, title, val, body, how }) {
    const eb = $("sheetEyebrow");
    eb.className = "sheet-eyebrow" + (side ? " " + side : "");
    eb.textContent = eyebrow || "";
    $("sheetTitle").textContent = title || "";
    $("sheetVal").textContent = val || "";
    $("sheetVal").style.display = val ? "" : "none";
    $("sheetBody").textContent = body || "";
    const howBox = $("sheetHow"); howBox.innerHTML = "";
    (how || []).forEach((r) => {
      const row = document.createElement("div");
      row.className = "how-row " + r.side;
      row.innerHTML = `<span class="k">${r.side === "bull" ? "赤・上げ" : "青・下げ"}</span><span class="t">${r.text}</span>`;
      howBox.appendChild(row);
    });
    openSheet();
  }
  function openIndicator(ind) {
    const g = window.GLOSSARY[ind.id] || {};
    fillSheet({ eyebrow: "指標", side: ind.signal, title: ind.name,
      val: `現在値 ${ind.display}　—　${ind.reading}`, body: g.body || ind.detail, how: g.how });
  }
  function openTerm(key) {
    const g = window.GLOSSARY[key]; if (!g) return;
    fillSheet({ eyebrow: g.eyebrow, side: g.side, title: g.title, body: g.body, how: g.how });
  }
  function openSheet() { $("backdrop").classList.add("open"); $("sheet").classList.add("open"); sheetOpen = true; }
  function closeSheet() {
    if (!sheetOpen) return;
    $("backdrop").classList.remove("open"); $("sheet").classList.remove("open");
    $("sheet").style.transform = ""; sheetOpen = false;
  }

  /* ============================================================ 整形 */
  function fmtNum(n) { return Number(n).toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtPct(n) { return (n > 0 ? "+" : "") + Number(n).toFixed(2) + "%"; }
})();
