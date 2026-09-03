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

  const APP_VERSION = "1.12.1";
  let DATA = null, params = null, firstVerdict = true;

  document.addEventListener("DOMContentLoaded", init);

  async function loadData() {
    const res = await fetch("data/data.json?v=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    DATA = await res.json();
  }

  async function init() {
    wireSheet();
    renderTerms();
    wireRefresh();
    wireNews();
    wireRegime();
    wireTabs();
    $("appVer").textContent = "v" + APP_VERSION;
    try {
      await loadData();
    } catch (e) {
      $("freshness").innerHTML =
        '<div style="color:var(--gold)">データを読み込めません</div>' +
        '<div style="font-size:10px">data/data.json を確認してください</div>';
      console.error(e); return;
    }
    params = loadParams(DATA.config);
    renderAllData();
    buildAdjuster();
    wireSizing();
    wirePresets();
    updateMethodologyValues();
  }

  // DATA と params に依存する描画をまとめて実行（初回・手動更新の両方で使う）
  function renderAllData() {
    renderFreshness(DATA);
    renderIndex(DATA.index);
    renderLeverage(DATA.leverage);
    renderIndicators(DATA.indicators);
    renderOvernight(DATA.overnight);
    renderTrack(DATA.track_record);
    renderRegime();
    renderSources(DATA.sources, DATA.generated_at, DATA.config.run_times_jst);
    recompute();
    $("foot").textContent =
      `データ元: ${DATA.source}　/　テクニカルの機械的集計であり投資助言ではありません`;
  }

  function wireTabs() {
    const nav = document.getElementById("tabs"); if (!nav) return;
    const tabs = nav.querySelectorAll(".tab");
    const panes = document.querySelectorAll(".pane");
    const activate = (name) => {
      tabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === name));
      panes.forEach((p) => p.classList.toggle("show", p.getAttribute("data-tab") === name));
      try { localStorage.setItem("akaao_tab", name); } catch (e) { /* */ }
      window.scrollTo(0, 0);
    };
    tabs.forEach((t) => t.addEventListener("click", () => activate(t.getAttribute("data-tab"))));
    let init = "today";
    try { init = localStorage.getItem("akaao_tab") || "today"; } catch (e) { /* */ }
    if (![...tabs].some((t) => t.getAttribute("data-tab") === init)) init = "today";
    activate(init);
  }

  function wireNews() {
    const view = $("newsView");
    if (!view) return;
    const sync = () => {
      const on = location.hash === "#news";
      view.classList.toggle("open", on);
      view.setAttribute("aria-hidden", on ? "false" : "true");
      if (on) view.scrollTop = 0;
    };
    $("newsBtn").addEventListener("click", () => { location.hash = "news"; });
    $("newsBack").addEventListener("click", () => {
      if (history.length > 1) history.back(); else location.hash = "";
    });
    window.addEventListener("hashchange", sync);
    sync();
  }

  function wireRefresh() {
    const btn = $("refreshBtn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const st = $("refreshStatus");
      btn.disabled = true; btn.classList.add("loading");
      if (st) st.textContent = "取得中…";
      const before = DATA && DATA.generated_at;
      try {
        await loadData();
        renderAllData();
        if (st) st.textContent = (DATA.generated_at === before) ? "すでに最新です" : "最新に更新しました";
      } catch (e) {
        if (st) st.textContent = "再読み込みに失敗しました";
        console.error(e);
      } finally {
        btn.disabled = false; btn.classList.remove("loading");
        if (st) setTimeout(() => { st.textContent = ""; }, 4000);
      }
    });
  }

  /* ============================================================ 再計算コア */
  function recompute() {
    const regimeState = (DATA.regime && DATA.regime.state === "trend") ? "trend" : "range";
    const vWeights = params.regimeMode
      ? (regimeState === "trend" ? params.weightsTrend : params.weightsRange)
      : params.weights;
    const v = computeVerdict(DATA.indicators, vWeights, params.threshold);
    renderVerdict(v);
    const p = computePrediction(
      DATA.pred_samples, DATA.prediction.key, params.lookback, params.minSamples);
    renderPrediction(p);
    const rules = params.regimeMode
      ? computeBacktestRegime(DATA.pred_samples, DATA.config.bt_order, params.weightsTrend, params.weightsRange, params.threshold, params.lookback)
      : computeBacktest(DATA.pred_samples, DATA.config.bt_order, params.weights, params.threshold, params.lookback);
    const pred = computePredictionBacktest(DATA.pred_samples, params.minSamples, params.lookback);
    renderBacktest(rules, pred);
    const ov = DATA.overnight;
    const ovSide = (ov && ov.available && ov.prediction && ov.prediction.available) ? ov.prediction.side : null;
    renderAlign(v.side, p.side, ovSide);
    renderSizing(v);
  }

  const SIDE_JP = { bull: "ブル", bear: "ベア", neutral: "中立" };
  function renderAlign(vSide, pSide, ovSide) {
    const set = (id, side) => {
      const el = $(id); if (!el) return;
      el.textContent = side ? SIDE_JP[side] : "—";
      el.className = "read-" + (side || "neutral");
    };
    set("alRule", vSide); set("alPred", pSide); set("alOv", ovSide);
    const sides = [vSide, pSide, ovSide].filter((s) => s === "bull" || s === "bear");
    const nb = sides.filter((s) => s === "bull").length;
    const ns = sides.filter((s) => s === "bear").length;
    let msg;
    if (sides.length === 0) msg = "3つとも方向感なし。様子見が無難です。";
    else if (nb > 0 && ns === 0) msg = nb >= 3 ? "3つとも上向き。方向感が揃っています。" : `上向き寄り（${nb}つが上）。`;
    else if (ns > 0 && nb === 0) msg = ns >= 3 ? "3つとも下向き。方向感が揃っています。" : `下向き寄り（${ns}つが下）。`;
    else msg = "見解が分かれています。無理せず様子見も選択肢。";
    const _an = $("alNote"); if (_an) _an.textContent = msg;
  }

  // ルールベース判定の過去的中率（重み・しきい値・遡り年数に連動して再計算）
  const SIGVAL = { b: 1, s: -1, n: 0 };
  function computeBacktest(samples, order, weights, threshold, lookbackYears) {
    if (!order || !samples || !samples.length || !samples[0][3]) return null;
    const anchor = new Date(DATA.index.date + "T00:00:00");
    const cut = new Date(anchor); cut.setFullYear(cut.getFullYear() - lookbackYears);
    const cutStr = cut.toISOString().slice(0, 10);
    const totW = order.reduce((a, id) => a + (weights[id] != null ? weights[id] : 0), 0) || 1;
    let total = 0, up = 0, sig = 0, hit = 0, bn = 0, bh = 0, sn = 0, sh = 0;
    for (const row of samples) {
      if (row[0] < cutStr) continue;
      const str = row[3]; if (!str) continue;
      const fwd = row[2];
      let raw = 0;
      for (let i = 0; i < order.length; i++) raw += (SIGVAL[str[i]] || 0) * (weights[order[i]] != null ? weights[order[i]] : 0);
      const score = Math.round(raw / totW * 100);
      total++; if (fwd > 0) up++;
      if (score >= threshold) { sig++; bn++; if (fwd > 0) { hit++; bh++; } }
      else if (score <= -threshold) { sig++; sn++; if (fwd < 0) { hit++; sh++; } }
    }
    const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
    return {
      total, signals: sig, coverage: pct(sig, total), hit_rate: pct(hit, sig),
      bull_signals: bn, bull_hit: pct(bh, bn), bear_signals: sn, bear_hit: pct(sh, sn),
      baseline: pct(up, total), lookback: lookbackYears,
    };
  }

  // 予測のバックテスト：各日、その日より前のデータだけで予測して翌日と照合（ウォークフォワード）
  function computePredictionBacktest(samples, minSamples, lookbackYears) {
    if (!samples || !samples.length) return null;
    const anchor = new Date(DATA.index.date + "T00:00:00");
    const cut = new Date(anchor); cut.setFullYear(cut.getFullYear() - lookbackYears);
    const cutStr = cut.toISOString().slice(0, 10);
    const mkey = {}, ukey = {}, mreg = {}, ureg = {};  // その日より前の集計
    let total = 0, up = 0, sig = 0, hit = 0, bn = 0, bh = 0, sn = 0, sh = 0;
    for (const row of samples) {
      const key = row[1], fwd = row[2], reg = key.split("|")[0];
      if (row[0] >= cutStr) {   // 評価対象（直近 lookback 年）
        let n = mkey[key] || 0, u = ukey[key] || 0, rate;
        if (n >= minSamples) rate = u / n;
        else { const nr = mreg[reg] || 0, ur = ureg[reg] || 0; rate = nr ? ur / nr : 0.5; }
        const side = rate >= 0.55 ? "bull" : (rate <= 0.45 ? "bear" : "neutral");
        total++; if (fwd > 0) up++;
        if (side === "bull") { sig++; bn++; if (fwd > 0) { hit++; bh++; } }
        else if (side === "bear") { sig++; sn++; if (fwd < 0) { hit++; sh++; } }
      }
      mkey[key] = (mkey[key] || 0) + 1; if (fwd > 0) ukey[key] = (ukey[key] || 0) + 1;
      mreg[reg] = (mreg[reg] || 0) + 1; if (fwd > 0) ureg[reg] = (ureg[reg] || 0) + 1;
    }
    const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
    return {
      total, signals: sig, coverage: pct(sig, total), hit_rate: pct(hit, sig),
      bull_signals: bn, bull_hit: pct(bh, bn), bear_signals: sn, bear_hit: pct(sh, sn),
      baseline: pct(up, total), lookback: lookbackYears,
    };
  }

  // 自動最適化：ルールベースの的中率が最大になる 重み＋しきい値 を探索（座標上昇法）
  function optimizeParams() {
    const order = DATA.config.bt_order;
    const probe = computeBacktest(DATA.pred_samples, order, params.weights, params.threshold, params.lookback);
    const minSig = probe ? Math.max(30, Math.round(probe.total * 0.05)) : 30;
    const score = (w, th) => {
      const bt = computeBacktest(DATA.pred_samples, order, w, th, params.lookback);
      if (!bt || bt.signals < minSig || bt.hit_rate == null) return -1;
      return bt.hit_rate;
    };
    const w = Object.assign({}, params.weights);   // オーバーナイトの重みはそのまま
    let th = params.threshold;
    const wvals = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    const thvals = []; for (let t = 8; t <= 40; t += 2) thvals.push(t);
    for (let pass = 0; pass < 3; pass++) {
      for (const id of order) {
        let best = score(w, th), bestv = w[id];
        for (const v of wvals) { const s = score(Object.assign({}, w, { [id]: v }), th); if (s > best) { best = s; bestv = v; } }
        w[id] = bestv;
      }
      let best = score(w, th), bestth = th;
      for (const t of thvals) { const s = score(w, t); if (s > best) { best = s; bestth = t; } }
      th = bestth;
    }
    return { weights: w, threshold: th, ok: score(w, th) >= 0 };
  }

  // レジーム別バックテスト：各日の相場つき(row[4]=T/R)で重みセットを切り替える
  function computeBacktestRegime(samples, order, wT, wR, threshold, lookbackYears) {
    if (!order || !samples || !samples.length || !samples[0][3] || samples[0][4] == null) return null;
    const anchor = new Date(DATA.index.date + "T00:00:00");
    const cut = new Date(anchor); cut.setFullYear(cut.getFullYear() - lookbackYears);
    const cutStr = cut.toISOString().slice(0, 10);
    const totT = order.reduce((a, id) => a + (wT[id] != null ? wT[id] : 0), 0) || 1;
    const totR = order.reduce((a, id) => a + (wR[id] != null ? wR[id] : 0), 0) || 1;
    let total = 0, up = 0, sig = 0, hit = 0, bn = 0, bh = 0, sn = 0, sh = 0;
    for (const row of samples) {
      if (row[0] < cutStr) continue;
      const str = row[3]; if (!str) continue;
      const isT = row[4] === "T", w = isT ? wT : wR, totW = isT ? totT : totR, fwd = row[2];
      let raw = 0;
      for (let i = 0; i < order.length; i++) raw += (SIGVAL[str[i]] || 0) * (w[order[i]] != null ? w[order[i]] : 0);
      const score = Math.round(raw / totW * 100);
      total++; if (fwd > 0) up++;
      if (score >= threshold) { sig++; bn++; if (fwd > 0) { hit++; bh++; } }
      else if (score <= -threshold) { sig++; sn++; if (fwd < 0) { hit++; sh++; } }
    }
    const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
    return {
      total, signals: sig, coverage: pct(sig, total), hit_rate: pct(hit, sig),
      bull_hit: pct(bh, bn), bear_hit: pct(sh, sn), bull_signals: bn, bear_signals: sn,
      baseline: pct(up, total), lookback: lookbackYears,
    };
  }

  // レジーム切替を自動最適化（トレンド用・もみ合い用の2セット＋しきい値）
  function optimizeRegime() {
    const order = DATA.config.bt_order;
    const probe = computeBacktest(DATA.pred_samples, order, params.weights, params.threshold, params.lookback);
    const minSig = probe ? Math.max(30, Math.round(probe.total * 0.05)) : 30;
    const score = (wT, wR, th) => {
      const bt = computeBacktestRegime(DATA.pred_samples, order, wT, wR, th, params.lookback);
      if (!bt || bt.signals < minSig || bt.hit_rate == null) return -1;
      return bt.hit_rate;
    };
    const wT = Object.assign({}, PRESETS.trend.w), wR = Object.assign({}, PRESETS.contra.w);
    let th = params.threshold;
    const wvals = [0, 0.5, 1, 1.5, 2, 2.5, 3], thvals = []; for (let t = 8; t <= 40; t += 2) thvals.push(t);
    for (let pass = 0; pass < 3; pass++) {
      for (const id of order) { let best = score(wT, wR, th), bv = wT[id]; for (const v of wvals) { const s = score(Object.assign({}, wT, { [id]: v }), wR, th); if (s > best) { best = s; bv = v; } } wT[id] = bv; }
      for (const id of order) { let best = score(wT, wR, th), bv = wR[id]; for (const v of wvals) { const s = score(wT, Object.assign({}, wR, { [id]: v }), th); if (s > best) { best = s; bv = v; } } wR[id] = bv; }
      let best = score(wT, wR, th), bth = th; for (const t of thvals) { const s = score(wT, wR, t); if (s > best) { best = s; bth = t; } } th = bth;
    }
    return { weightsTrend: wT, weightsRange: wR, threshold: th, ok: score(wT, wR, th) >= 0 };
  }

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

  function renderBacktest(rules, pred) {
    const sec = $("btSection");
    if (!rules || !rules.total) { if (sec) sec.style.display = "none"; return; }
    if (sec) sec.style.display = "";
    fillBtBlock("bt", rules);
    fillBtBlock("pb", pred);
    $("btBase").textContent = rules.baseline != null ? rules.baseline + "%" : "—";
  }
  function fillBtBlock(pfx, bt) {
    if (!bt || !bt.total) {
      $(pfx + "Rate").textContent = "—"; $(pfx + "Delta").textContent = "";
      $(pfx + "Sub").textContent = "判定なし"; return;
    }
    $(pfx + "Rate").textContent = bt.hit_rate != null ? bt.hit_rate + "%" : "—";
    let d = null;
    if (bt.hit_rate != null && bt.baseline != null) d = Math.round((bt.hit_rate - bt.baseline) * 10) / 10;
    const de = $(pfx + "Delta");
    de.textContent = d != null ? "基準比 " + (d > 0 ? "+" : "") + d + "pt" : "";
    de.className = "bt-delta num " + (d > 0 ? "up" : (d < 0 ? "down" : ""));
    $(pfx + "Sub").innerHTML =
      `<span><i class="dot bull"></i>ブル <b>${bt.bull_hit != null ? bt.bull_hit + "%" : "—"}</b> <em>${bt.bull_signals}回</em></span>` +
      `<span><i class="dot bear"></i>ベア <b>${bt.bear_hit != null ? bt.bear_hit + "%" : "—"}</b> <em>${bt.bear_signals}回</em></span>` +
      `<span>判定 <b>${bt.coverage != null ? bt.coverage + "%" : "—"}</b></span>`;
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
    const predSec = $("ovPredSection"), factSec = $("ovSection");
    if (!ov || !ov.available) {
      if (predSec) predSec.style.display = "none";
      if (factSec) factSec.style.display = "none";
      return;
    }
    if (factSec) factSec.style.display = "";
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
      if (predSec) predSec.style.display = "";
    } else {
      if (predSec) predSec.style.display = "none";
    }
  }

  /* ============================================================ データ鮮度 */
  const pad = (n) => String(n).padStart(2, "0");
  const fmtMD = (iso) => { const [, m, d] = iso.split("-"); return `${+m}/${+d}`; };

  /* ---- 実績(フォワード) ---- */
  function renderTrack(tr) {
    const sec = $("trackSection"); if (!sec) return;
    if (!tr) { sec.style.display = "none"; return; }
    sec.style.display = "";
    $("trVer").textContent = tr.verdict_hit_rate != null ? tr.verdict_hit_rate + "%" : "—";
    $("trPred").textContent = tr.pred_hit_rate != null ? tr.pred_hit_rate + "%" : "—";
    $("trVerN").textContent = tr.verdict_n ? `（${tr.verdict_n}件）` : "";
    $("trPredN").textContent = tr.pred_n ? `（${tr.pred_n}件）` : "";
    const empty = $("trEmpty"), list = $("trList");
    const recent = tr.recent || [];
    if (!recent.length) {
      empty.style.display = ""; list.innerHTML = "";
      empty.textContent = "まだ記録がありません。明日以降、毎日の予測と結果がここにたまります。";
      return;
    }
    empty.style.display = tr.resolved ? "none" : "";
    if (!tr.resolved) empty.textContent = `記録を蓄積中（${tr.total_logged}件）。翌営業日の結果が出るごとに採点されます。`;
    const mark = (c) => c === true ? '<span class="ok">○</span>' : (c === false ? '<span class="ng">×</span>' : "－");
    const rows = recent.map((r) => {
      const vd = `<span class="tr-s read-${r.verdict_side}">${SIDE_JP[r.verdict_side] || "－"}</span>`;
      const pr = `<span class="tr-s read-${r.pred_side}">${SIDE_JP[r.pred_side] || "－"}</span>`;
      if (r.next_ret == null) {
        return `<div class="tr-row"><span class="tr-d">${fmtMD(r.date)}</span>${vd}${pr}` +
          `<span class="tr-r tr-wait">採点待ち</span><span class="tr-m">…</span></div>`;
      }
      const rc = r.next_ret > 0 ? "up" : "down";
      return `<div class="tr-row"><span class="tr-d">${fmtMD(r.date)}</span>${vd}${pr}` +
        `<span class="tr-r num ${rc}">${(r.next_ret > 0 ? "+" : "") + r.next_ret}%</span>` +
        `<span class="tr-m">${mark(r.verdict_correct)}${mark(r.pred_correct)}</span></div>`;
    }).join("");
    list.innerHTML =
      `<div class="tr-row tr-hd"><span class="tr-d">日付</span><span class="tr-s">ルール</span>` +
      `<span class="tr-s">予測</span><span class="tr-r">翌日</span><span class="tr-m">的中</span></div>` + rows;
  }

  /* ---- ポジションサイズ ---- */
  const SIZE_KEY = "akaao_sizing_v1";
  function loadSizing() { try { return JSON.parse(localStorage.getItem(SIZE_KEY)) || {}; } catch (e) { return {}; } }
  function saveSizing(o) { try { localStorage.setItem(SIZE_KEY, JSON.stringify(o)); } catch (e) { /* */ } }
  function renderSizing(verdict) {
    const capEl = $("szCapital"), riskEl = $("szRisk");
    if (!capEl) return;
    const cap = parseFloat((capEl.value || "").replace(/[^0-9.]/g, ""));
    const risk = parseFloat(riskEl.value) || 5;
    $("szRiskV").textContent = risk;
    const out = $("szOut");
    if (!cap || cap <= 0) { out.textContent = "総資金を入力すると、判定中のファンドに合わせた推奨ポジションと1日の想定損益を表示します。"; return; }
    const lev = DATA.leverage, side = verdict.side;
    const swing = side === "bear" ? lev.swing_bear_pct : lev.swing_bull_pct;
    const fund = side === "bear" ? "ベア3.8倍" : "ブル4.3倍";
    const riskYen = cap * risk / 100;
    const pos = swing > 0 ? Math.min(riskYen / (swing / 100), cap) : 0;
    const pl = pos * swing / 100;
    const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
    const sideNote = side === "neutral" ? "（今は様子見。参考としてブル側で概算）" : `（判定：${fund}）`;
    out.innerHTML =
      `<div class="sz-line"><span>リスク許容額</span><b>${yen(riskYen)}</b></div>` +
      `<div class="sz-line"><span>推奨ポジション上限の目安</span><b>${yen(pos)}</b><em>${Math.round(pos / cap * 100)}%</em></div>` +
      `<div class="sz-line"><span>その額の1日の想定損益</span><b>±${yen(pl)}</b><em>±${swing}%</em></div>` +
      `<div class="sz-side">${sideNote}　1日で${fund}が約±${swing}%動く前提の目安です。</div>`;
  }
  function wireSizing() {
    const capEl = $("szCapital"), riskEl = $("szRisk");
    if (!capEl) return;
    const s = loadSizing();
    if (s.capital) capEl.value = Number(s.capital).toLocaleString("ja-JP");
    if (s.risk) riskEl.value = s.risk;
    const onEdit = () => {
      const cap = parseFloat((capEl.value || "").replace(/[^0-9.]/g, ""));
      saveSizing({ capital: cap || 0, risk: parseFloat(riskEl.value) || 5 });
      renderSizing(computeVerdict(DATA.indicators, params.weights, params.threshold));
    };
    capEl.addEventListener("input", onEdit);
    capEl.addEventListener("blur", () => {
      const cap = parseFloat((capEl.value || "").replace(/[^0-9.]/g, ""));
      if (cap) capEl.value = cap.toLocaleString("ja-JP");
    });
    riskEl.addEventListener("input", onEdit);
  }

  /* ---- プリセット・タイプ診断 ---- */
  const PRESETS = {
    balanced: { name: "バランス型", threshold: 20,
      w: { trend: 2.0, cross: 1.5, rsi14: 1.5, macd: 1.3, bb: 1.0, stoch: 0.8, dev25: 1.0, us: 1.6, jpy: 1.2, fut: 1.0 } },
    trend: { name: "順張り型", threshold: 18,
      w: { trend: 2.5, cross: 2.0, rsi14: 0.8, macd: 1.8, bb: 0.6, stoch: 0.6, dev25: 0.6, us: 1.6, jpy: 1.2, fut: 1.0 } },
    contra: { name: "逆張り型", threshold: 22,
      w: { trend: 0.8, cross: 0.8, rsi14: 2.2, macd: 0.8, bb: 2.0, stoch: 1.6, dev25: 2.0, us: 1.2, jpy: 1.0, fut: 0.8 } },
    overseas: { name: "海外重視型", threshold: 18,
      w: { trend: 1.2, cross: 1.0, rsi14: 1.0, macd: 1.0, bb: 0.8, stoch: 0.6, dev25: 0.8, us: 2.5, jpy: 2.0, fut: 1.8 } },
  };
  function applyPreset(key, tweakTh) {
    const p = PRESETS[key]; if (!p) return;
    params.weights = Object.assign({}, params.weights, p.w);
    params.threshold = Math.min(40, Math.max(5, p.threshold + (tweakTh || 0)));
    saveParams(); buildAdjuster(); recompute(); updateMethodologyValues();
    $("presetStatus").textContent = `「${p.name}」を適用しました（しきい値 ±${params.threshold}）。`;
  }
  const QUIZ = [
    { q: "相場観は？", a: [["流れに乗る（順張り）", "trend"], ["行き過ぎの逆を取る（逆張り）", "contra"]] },
    { q: "重視する材料は？", a: [["日本のチャート", "tech"], ["前日の海外（米国・為替）", "overseas"]] },
    { q: "スタンスは？", a: [["積極的（多めに）", "-4"], ["慎重（厳選）", "+4"]] },
  ];
  function wirePresets() {
    document.querySelectorAll(".preset").forEach((b) => {
      b.addEventListener("click", () => applyPreset(b.getAttribute("data-preset"), 0));
    });
    const body = $("quizBody"); if (!body) return;
    const ans = {};
    QUIZ.forEach((item, qi) => {
      const row = document.createElement("div"); row.className = "quiz-q";
      row.innerHTML = `<div class="quiz-t">${qi + 1}. ${item.q}</div>`;
      const opts = document.createElement("div"); opts.className = "quiz-opts";
      item.a.forEach(([label, val]) => {
        const btn = document.createElement("button");
        btn.className = "quiz-opt"; btn.textContent = label;
        btn.addEventListener("click", () => {
          ans[qi] = val;
          opts.querySelectorAll(".quiz-opt").forEach((o) => o.classList.remove("sel"));
          btn.classList.add("sel");
          if (Object.keys(ans).length === QUIZ.length) {
            let key = ans[0] === "contra" ? "contra" : "trend";
            if (ans[1] === "overseas") key = "overseas";
            applyPreset(key, parseInt(ans[2], 10) || 0);
          }
        });
        opts.appendChild(btn);
      });
      row.appendChild(opts); body.appendChild(row);
    });
  }

  /* ---- レジーム切替（ADX） ---- */
  let lastRegimeOpt = null;
  function renderRegime() {
    const rg = DATA.regime, now = $("rgNow");
    if (now) {
      if (rg && rg.adx != null) {
        const st = rg.state === "trend" ? "トレンド相場" : "もみ合い相場";
        now.innerHTML = `現在：<b class="read-${rg.state === "trend" ? "bull" : "neutral"}">${st}</b>　ADX <b class="num">${rg.adx}</b>（境目 ${rg.cutoff}）`;
      } else now.textContent = "—";
    }
    const badge = $("rgModeBadge");
    if (badge) badge.textContent = params.regimeMode ? "　現在：切替ON" : "";
    const off = $("rgOff"); if (off) off.style.display = params.regimeMode ? "" : "none";
  }
  function wireRegime() {
    const t = $("rgTestBtn"); if (t) t.addEventListener("click", runRegimeTest);
    const a = $("rgApply"); if (a) a.addEventListener("click", applyRegime);
    const o = $("rgOff"); if (o) o.addEventListener("click", regimeOff);
  }
  function runRegimeTest() {
    const btn = $("rgTestBtn"), res = $("rgResult"), act = $("rgActions");
    btn.disabled = true; res.innerHTML = "両方を最適化して比較中…（数秒）";
    setTimeout(() => {
      const order = DATA.config.bt_order;
      const single = optimizeParams();
      const btS = single.ok ? computeBacktest(DATA.pred_samples, order, single.weights, single.threshold, params.lookback) : null;
      const reg = optimizeRegime();
      const btR = reg.ok ? computeBacktestRegime(DATA.pred_samples, order, reg.weightsTrend, reg.weightsRange, reg.threshold, params.lookback) : null;
      lastRegimeOpt = reg;
      if (!btS || !btR) { res.textContent = "十分な判定回数の設定が見つかりませんでした。遡り年数を増やしてください。"; btn.disabled = false; return; }
      const d = Math.round((btR.hit_rate - btS.hit_rate) * 10) / 10;
      const cls = d > 0 ? "up" : (d < 0 ? "down" : "");
      res.innerHTML =
        `<div class="rg-cmp">` +
          `<div class="rg-col"><div class="rg-lbl">切替なし<br>（単一・最適化後）</div><div class="rg-v num">${btS.hit_rate}%</div><div class="rg-sub">判定 ${btS.coverage}%</div></div>` +
          `<div class="rg-arrow">→</div>` +
          `<div class="rg-col"><div class="rg-lbl">ADXレジーム切替<br>（最適化後）</div><div class="rg-v num ${cls}">${btR.hit_rate}%</div><div class="rg-sub">判定 ${btR.coverage}%</div></div>` +
        `</div>` +
        `<div class="rg-delta ${cls}">差 ${d > 0 ? "+" : ""}${d}pt　<span>直近${params.lookback}年・単純上昇率 ${btS.baseline}%</span></div>`;
      act.style.display = "";
      btn.disabled = false;
    }, 30);
  }
  function applyRegime() {
    if (!lastRegimeOpt || !lastRegimeOpt.ok) return;
    params.regimeMode = true;
    params.weightsTrend = lastRegimeOpt.weightsTrend;
    params.weightsRange = lastRegimeOpt.weightsRange;
    params.threshold = lastRegimeOpt.threshold;
    saveParams(); recompute(); updateMethodologyValues(); renderRegime();
    const s = $("rgApplyStatus"); if (s) s.textContent = `レジーム切替をONにしました（しきい値 ±${params.threshold}）。判定・的中率に反映されています。`;
  }
  function regimeOff() {
    params.regimeMode = false; saveParams(); recompute(); updateMethodologyValues(); renderRegime();
    const s = $("rgApplyStatus"); if (s) s.textContent = "単一設定に戻しました。";
  }

  function renderSources(sources, genAt, runTimes) {
    const dt = new Date(genAt);
    const fetched = isNaN(dt) ? genAt
      : `${dt.getMonth() + 1}/${dt.getDate()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    const nx = nextRun(runTimes || ["08:00", "18:00", "20:00"]);
    const nextStr = nx ? fmtNextShort(nx) : "—";

    const box = $("srcRows");
    if (box) {
      box.innerHTML = "";
      (sources || []).forEach((s) => {
        const ok = s.ok !== false;
        const asof = ok && s.as_of ? fmtMD(s.as_of) + " 時点" : "取得できず";
        const row = document.createElement("div");
        row.className = "src-row";
        row.innerHTML =
          `<span class="src-dot ${ok ? "ok" : "ng"}"></span>` +
          `<div class="src-main">` +
            `<div class="src-l1"><span class="src-name">${s.name}</span><span class="src-prov">${s.provider || ""}</span></div>` +
            `<div class="src-l2">` +
              `<span class="src-tag">時点 <b class="num">${asof}</b></span>` +
              `<span class="src-tag">取得 <b class="num">${fetched}</b></span>` +
              `<span class="src-tag">次回 <b class="num">${nextStr}</b></span>` +
            `</div>` +
          `</div>`;
        box.appendChild(row);
      });
    }
    // 次回までのカウントダウン（相対）
    const cd = $("srcCountdown");
    if (cd) {
      if (nx) {
        const diffMin = Math.max(0, Math.round((nx.cand - nx.jstNow) / 60000));
        cd.textContent = diffMin < 60 ? `約${diffMin}分` : `約${Math.round(diffMin / 60)}時間`;
      } else cd.textContent = "—";
    }
  }

  // 次回実行の短い絶対表記（例: 本日 9:00頃 / 明日 8:00頃 / 9/8(月) 8:00頃）
  function fmtNextShort({ cand, jstNow }) {
    const d0 = new Date(jstNow); d0.setHours(0, 0, 0, 0);
    const c0 = new Date(cand); c0.setHours(0, 0, 0, 0);
    const dayDiff = Math.round((c0 - d0) / 86400000);
    const wd = ["日", "月", "火", "水", "木", "金", "土"][cand.getDay()];
    const dayLabel = dayDiff === 0 ? "本日" : (dayDiff === 1 ? "明日" : `${cand.getMonth() + 1}/${cand.getDate()}(${wd})`);
    return `${dayLabel} ${cand.getHours()}:${pad(cand.getMinutes())}頃`;
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
    if (!$("mThOver")) return;
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
      regimeMode: false,
      weightsTrend: Object.assign({}, PRESETS.trend.w),
      weightsRange: Object.assign({}, PRESETS.contra.w),
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
        regimeMode: s.regimeMode ?? false,
        weightsTrend: Object.assign({}, def.weightsTrend, s.weightsTrend || {}),
        weightsRange: Object.assign({}, def.weightsRange, s.weightsRange || {}),
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
    const opt = $("optBtn");
    if (opt) opt.addEventListener("click", runOptimize);
  }

  function runOptimize() {
    const btn = $("optBtn"), st = $("optStatus");
    const before = computeBacktest(DATA.pred_samples, DATA.config.bt_order, params.weights, params.threshold, params.lookback);
    btn.disabled = true; if (st) st.textContent = "探索中…";
    setTimeout(() => {
      const r = optimizeParams();
      if (!r.ok) { if (st) st.textContent = "十分な判定回数の設定が見つかりませんでした"; btn.disabled = false; return; }
      params.weights = r.weights; params.threshold = r.threshold;
      saveParams(); buildAdjuster(); recompute(); updateMethodologyValues();
      const after = computeBacktest(DATA.pred_samples, DATA.config.bt_order, params.weights, params.threshold, params.lookback);
      const b = before && before.hit_rate != null ? before.hit_rate : null;
      const a = after && after.hit_rate != null ? after.hit_rate : null;
      if (st) st.textContent = (b != null && a != null)
        ? `的中率 ${b}% → ${a}% ／ しきい値 ±${r.threshold} に更新` : "設定を更新しました";
      btn.disabled = false;
    }, 30);
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
      const m = e.target.closest("[data-method]");
      if (m) { openMethod(m.getAttribute("data-method")); return; }
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
  function fillSheet({ eyebrow, side, title, val, body, html, how }) {
    const eb = $("sheetEyebrow");
    eb.className = "sheet-eyebrow" + (side ? " " + side : "");
    eb.textContent = eyebrow || "";
    $("sheetTitle").textContent = title || "";
    $("sheetVal").textContent = val || "";
    $("sheetVal").style.display = val ? "" : "none";
    if (html != null) $("sheetBody").innerHTML = html;
    else $("sheetBody").textContent = body || "";
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
  function openMethod(kind) {
    if (kind === "rules") {
      const th = params.threshold;
      const chips = DATA.indicators.map((i) => {
        const w = (params.weights[i.id] != null) ? params.weights[i.id] : i.weight;
        return `<span class="wt">${i.name}<b>${Number(w).toFixed(1)}</b></span>`;
      }).join("");
      const html =
        `<p>テクニカル7指標に加え、オーバーナイト要因（米国株・ドル円・先物）も同じ仕組みで「強気(+1)／弱気(−1)／中立(0)」を投票し、指標ごとの重みを掛けて合計します。合計を −100〜+100 のスコアに正規化して判定します。</p>` +
        `<div class="formula">スコア ＝ Σ(各指標の投票 × 重み) ÷ Σ(重み) × 100</div>` +
        `<ul class="rules"><li>スコア ≧ ＋<b>${th}</b> → <span class="read-bull">ブル寄り</span></li>` +
        `<li>スコア ≦ −<b>${th}</b> → <span class="read-bear">ベア寄り</span></li>` +
        `<li>その間 → <span class="read-neutral">様子見</span></li></ul>` +
        `<div class="wtable">${chips}</div>` +
        `<p class="mnote">重み・しきい値は「設定」タブの「数字を調整」で変えられます。</p>`;
      fillSheet({ eyebrow: "仕組み", title: "ルールベース判定はどう出している？", html });
    } else {
      const lb = params.lookback, ms = params.minSamples;
      const html =
        `<p>今日の相場を〈トレンド区分 × RSIゾーン × MACD符号〉で分類し、<b>直近${lb}年</b>で同じ状態だった日の「翌日の値動き」を集計。上昇した割合を上昇確率として表示します。</p>` +
        `<ul class="rules"><li>トレンド区分：移動平均の並び（上昇／下降／もみ合い）</li>` +
        `<li>RSIゾーン：過熱(≧70)／やや強(≧50)／やや弱(>30)／底値圏(≦30)</li>` +
        `<li>MACD符号：ヒストグラムの ＋／−</li></ul>` +
        `<p>同じ状態が <b>${ms}</b> 回に満たないときは、条件をトレンド区分だけに広げて集計します。サンプルが多いほど信頼度は上がります（40回以上で「高」）。</p>` +
        `<p class="mnote">遡り年数・最小サンプル数は「設定」タブで調整できます。別枠で「オーバーナイト予測」（前夜の米国株×ドル円が同じだった翌営業日の上昇率）も出しています。</p>`;
      fillSheet({ eyebrow: "仕組み", title: "過去データからの予測はどう出している？", html });
    }
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
