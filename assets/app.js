/* 赤青ナビ フロントエンド
   data/data.json を読み込み、判定・予測・指標を描画。
   指標カード/用語チップのタップで解説シートを開く。 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SIDE_JP = { bull: "ブル寄り", bear: "ベア寄り", neutral: "様子見" };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    wireSheet();
    renderTerms();
    try {
      const res = await fetch("data/data.json?v=" + Date.now());
      if (!res.ok) throw new Error("HTTP " + res.status);
      render(await res.json());
    } catch (e) {
      $("freshness").innerHTML =
        '<div style="color:var(--gold)">データを読み込めません</div>' +
        '<div style="font-size:10px">data/data.json を確認してください</div>';
      console.error(e);
    }
  }

  /* ------------------------------------------------------------ 描画 */
  function render(d) {
    renderFreshness(d);
    renderVerdict(d);
    renderIndex(d.index);
    renderPrediction(d.prediction);
    renderIndicators(d.indicators);
    renderLeverage(d.leverage);
    $("foot").textContent =
      `データ元: ${d.source}　/　テクニカルの機械的集計であり投資助言ではありません`;
  }

  function renderFreshness(d) {
    const dt = new Date(d.generated_at);
    const stamp = isNaN(dt) ? d.generated_at :
      `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
    let html = `<div>更新 <b>${stamp}</b></div>`;
    if (d.is_sample) html += `<span class="badge-sample">サンプルデータ</span>`;
    $("freshness").innerHTML = html;
  }

  function renderVerdict(d) {
    const v = d.verdict;
    const el = $("verdict");
    el.classList.remove("is-bull", "is-bear", "is-neutral");
    el.classList.add("is-" + v.side);

    $("callSide").textContent = v.label;
    $("callScore").textContent = (v.score > 0 ? "+" : "") + v.score;
    $("callSummary").textContent = v.summary;

    // 綱引きマーカー: score -100..+100 → 位置 0..100%
    const pos = (v.score + 100) / 2;
    const marker = $("tugMarker");
    if (reduce) marker.style.left = pos + "%";
    else { marker.style.left = "50%"; requestAnimationFrame(() => setTimeout(() => (marker.style.left = pos + "%"), 60)); }

    // 確信度ピップ
    const pips = $("pips");
    pips.innerHTML = "";
    for (let i = 0; i < 5; i++) {
      const p = document.createElement("div");
      p.className = "pip" + (i < v.conviction ? " on" : "");
      pips.appendChild(p);
    }

    // 買う候補チップ: 勝ち側をハイライト
    const lev = d.leverage;
    $("bullMove").textContent = "1日 ±" + lev.swing_bull_pct + "%";
    $("bearMove").textContent = "1日 ±" + lev.swing_bear_pct + "%";
    $("pickBull").classList.toggle("active", v.side === "bull");
    $("pickBear").classList.toggle("active", v.side === "bear");
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
    $("predNote").textContent = p.note;
    $("predMeta").innerHTML = [
      `<span class="chipstat">類似局面 <b>${p.sample_size}回</b></span>`,
      `<span class="chipstat">翌日平均 <b>${fmtPct(p.avg_next_return_pct)}</b></span>`,
      `<span class="chipstat">信頼度 <b>${p.confidence}</b></span>`,
    ].join("");
  }

  function renderIndicators(list) {
    const grid = $("grid");
    grid.innerHTML = "";
    list.forEach((ind) => {
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
      ["volatility", "ボラティリティ"], ["decay", "減価"], ["leverage", "レバレッジ"],
      ["cost", "往復コスト"], ["cutoff", "申込締切"], ["nav", "基準価額"], ["prediction", "予測の仕組み"],
    ];
    const box = $("terms");
    chips.forEach(([k, label]) => {
      const c = document.createElement("button");
      c.className = "termchip";
      c.textContent = label;
      c.addEventListener("click", () => openTerm(k));
      box.appendChild(c);
    });
  }

  /* ------------------------------------------------------------ 図形 */
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
    $("spark").innerHTML =
      `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
      `<polygon points="${pad},${h - pad} ${pts.join(" ")} ${w - pad},${h - pad}" fill="${fill}"/>` +
      `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${pts[pts.length - 1].split(",")[0]}" cy="${pts[pts.length - 1].split(",")[1]}" r="2.2" fill="${color}"/>` +
      `</svg>`;
  }

  function drawDonut(prob, side) {
    const r = 40, c = 2 * Math.PI * r, on = c * prob;
    const color = side === "bull" ? "var(--bull)" : side === "bear" ? "var(--bear)" : "var(--gold)";
    $("donut").innerHTML =
      `<svg viewBox="0 0 92 92" width="92" height="92">` +
      `<circle cx="46" cy="46" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="9"/>` +
      `<circle cx="46" cy="46" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"` +
      ` stroke-dasharray="${on.toFixed(2)} ${(c - on).toFixed(2)}"/>` +
      `</svg><div class="pct">${Math.round(prob * 100)}<span style="font-size:12px">%</span></div>`;
  }

  /* ------------------------------------------------------------ シート */
  let sheetOpen = false;
  function wireSheet() {
    $("backdrop").addEventListener("click", closeSheet);
    $("sheetClose").addEventListener("click", closeSheet);
    document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());
    // ヘッダ等の data-term を委譲で拾う
    document.body.addEventListener("click", (e) => {
      const t = e.target.closest("[data-term]");
      if (t) openTerm(t.getAttribute("data-term"));
    });
    // 下スワイプで閉じる
    let y0 = null;
    const sheet = $("sheet");
    sheet.addEventListener("touchstart", (e) => (y0 = e.touches[0].clientY), { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0 && sheet.scrollTop <= 0) sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener("touchend", (e) => {
      const dy = (e.changedTouches[0].clientY - (y0 ?? e.changedTouches[0].clientY));
      sheet.style.transform = "";
      if (dy > 90) closeSheet();
      y0 = null;
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
    const howBox = $("sheetHow");
    howBox.innerHTML = "";
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
    fillSheet({
      eyebrow: "指標", side: ind.signal, title: ind.name,
      val: `現在値 ${ind.display}　—　${ind.reading}`,
      body: g.body || ind.detail, how: g.how,
    });
  }

  function openTerm(key) {
    const g = window.GLOSSARY[key];
    if (!g) return;
    fillSheet({ eyebrow: g.eyebrow, side: g.side, title: g.title, body: g.body, how: g.how });
  }

  function openSheet() {
    $("backdrop").classList.add("open");
    $("sheet").classList.add("open");
    sheetOpen = true;
  }
  function closeSheet() {
    if (!sheetOpen) return;
    $("backdrop").classList.remove("open");
    $("sheet").classList.remove("open");
    $("sheet").style.transform = "";
    sheetOpen = false;
  }

  /* ------------------------------------------------------------ 整形 */
  function fmtNum(n) {
    return Number(n).toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    return (n > 0 ? "+" : "") + Number(n).toFixed(2) + "%";
  }
})();
