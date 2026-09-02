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

  const APP_VERSION = "1.8.0";
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
    renderSources(DATA.sources, DATA.generated_at, DATA.config.run_times_jst);
    renderCutoff();
    recompute();
    $("foot").textContent =
      `データ元: ${DATA.source}　/　テクニカルの機械的集計であり投資助言ではありません`;
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
    const v = computeVerdict(DATA.indicators, params.weights, params.threshold);
    renderVerdict(v);
    const p = computePrediction(
      DATA.pred_samples, DATA.prediction.key, params.lookback, params.minSamples);
    renderPrediction(p);
    const rules = computeBacktest(
      DATA.pred_samples, DATA.config.bt_order, params.weights, params.threshold, params.lookback);
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
    $("alNote").textContent = msg;
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

  function renderBacktest(rules, pred) {
    const sec = $("btSection");
    if (!rules || !rules.total) { if (sec) sec.style.display = "none"; return; }
    if (sec) sec.style.display = "";
    fillBtBlock("bt", rules);
    fillBtBlock("pb", pred);
    $("btBase").textContent = rules.baseline != null ? rules.baseline + "%" : "—";
    $("btNote").textContent =
      `直近${rules.lookback}年で検証。「ルールベース」は現在の重み・しきい値で、「予測」は各日その日より前のデータだけで（先読みなし）判定し、翌日の方向が当たった割合です。テクニカル中心の検証で、売買コストやレバレッジは含みません。過去の結果は将来を保証しません。`;
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
    if (!tr.resolved) {
      empty.textContent = tr.total_logged
        ? `記録を蓄積中（${tr.total_logged}件）。翌日の結果が出るごとに採点されます。`
        : "まだ記録がありません。明日以降、毎日の予測と結果がここにたまります。";
      empty.style.display = ""; list.innerHTML = "";
    } else {
      empty.style.display = "none";
      const mark = (c) => c === true ? '<span class="ok">○</span>' : (c === false ? '<span class="ng">×</span>' : "－");
      const rows = (tr.recent || []).filter((r) => r.next_ret != null).map((r) => {
        const rc = r.next_ret > 0 ? "up" : "down";
        return `<div class="tr-row"><span class="tr-d">${fmtMD(r.date)}</span>` +
          `<span class="tr-s read-${r.verdict_side}">${SIDE_JP[r.verdict_side] || "－"}</span>` +
          `<span class="tr-s read-${r.pred_side}">${SIDE_JP[r.pred_side] || "－"}</span>` +
          `<span class="tr-r num ${rc}">${(r.next_ret > 0 ? "+" : "") + r.next_ret}%</span>` +
          `<span class="tr-m">${mark(r.verdict_correct)}${mark(r.pred_correct)}</span></div>`;
      }).join("");
      list.innerHTML =
        `<div class="tr-row tr-hd"><span class="tr-d">日付</span><span class="tr-s">ルール</span>` +
        `<span class="tr-s">予測</span><span class="tr-r">翌日</span><span class="tr-m">的中</span></div>` + rows;
    }
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
