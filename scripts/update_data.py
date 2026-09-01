#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
日経平均レバレッジ投信ダッシュボード用データ生成スクリプト
==========================================================
1. 日経平均株価(^N225 / stooq: ^nkx)の日足を取得
2. テクニカル指標を計算
3. ルールベースで「ブル / ベア / 様子見」を判定
4. 過去の類似局面から翌日上昇確率を推定（予測）
5. レバレッジ投信向けの期待変動・減価(decay)注意を計算
6. data/data.json に書き出す

GitHub Actions 上ではネットにアクセスできるので実データを取得する。
ローカル検証や取得失敗時は合成データ(is_sample=true)にフォールバックする。
"""
from __future__ import annotations

import io
import json
import sys
import argparse
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd

JST = timezone(timedelta(hours=9))

BULL_MULT = 4.3   # 楽天日経平均ブル4.3倍
BEAR_MULT = 3.8   # 楽天日経平均ベア3.8倍


# ----------------------------------------------------------------------------
# データ取得
# ----------------------------------------------------------------------------
def fetch_stooq() -> pd.DataFrame:
    """stooq から日経平均日足CSVを取得 (APIキー不要)。"""
    import requests
    url = "https://stooq.com/q/d/l/?s=^nkx&i=d"
    r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    if "Close" not in df.columns or len(df) < 200:
        raise ValueError("stooq: unexpected data")
    df = df.rename(columns=str.lower)
    df["date"] = pd.to_datetime(df["date"])
    df = df[["date", "open", "high", "low", "close", "volume"]].dropna(subset=["close"])
    return df.sort_values("date").reset_index(drop=True)


def fetch_yfinance() -> pd.DataFrame:
    """yfinance フォールバック。"""
    import yfinance as yf
    d = yf.download("^N225", period="5y", interval="1d", progress=False, auto_adjust=False)
    if d is None or len(d) < 200:
        raise ValueError("yfinance: unexpected data")
    d = d.reset_index()
    if isinstance(d.columns, pd.MultiIndex):
        d.columns = [c[0] for c in d.columns]
    d = d.rename(columns=str.lower)
    d = d[["date", "open", "high", "low", "close", "volume"]].dropna(subset=["close"])
    d["date"] = pd.to_datetime(d["date"])
    return d.sort_values("date").reset_index(drop=True)


def synthesize() -> pd.DataFrame:
    """取得できない場合の合成データ（構造検証・初期表示用）。"""
    rng = np.random.default_rng(20260901)
    n = 760  # 約3年
    dates = pd.bdate_range(end=datetime.now(JST).date(), periods=n)
    # 幾何ブラウン運動 + ゆるやかなトレンド + ボラのクラスタリング
    ret = rng.normal(0.0003, 0.012, n)
    ret += 0.004 * np.sin(np.linspace(0, 9 * np.pi, n))  # うねり
    price = 34000 * np.exp(np.cumsum(ret))
    close = price
    open_ = close * (1 + rng.normal(0, 0.004, n))
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.005, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.005, n)))
    vol = rng.integers(80_000, 220_000, n).astype(float)
    return pd.DataFrame({
        "date": dates, "open": open_, "high": high,
        "low": low, "close": close, "volume": vol,
    })


def load_data(force_sample: bool):
    if force_sample:
        return synthesize(), True, "サンプル（合成データ）"
    for fn, label in ((fetch_stooq, "stooq (^nkx)"), (fetch_yfinance, "Yahoo Finance (^N225)")):
        try:
            return fn(), False, label
        except Exception as e:  # noqa: BLE001
            print(f"[warn] {label} 取得失敗: {e}", file=sys.stderr)
    print("[warn] 全ての取得元で失敗。合成データにフォールバック", file=sys.stderr)
    return synthesize(), True, "サンプル（合成データ）"


# ----------------------------------------------------------------------------
# テクニカル指標
# ----------------------------------------------------------------------------
def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    delta = s.diff()
    up = delta.clip(lower=0.0)
    down = -delta.clip(upper=0.0)
    # Wilder 平滑化
    roll_up = up.ewm(alpha=1 / n, adjust=False).mean()
    roll_down = down.ewm(alpha=1 / n, adjust=False).mean()
    rs = roll_up / roll_down.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def macd(s: pd.Series, fast=12, slow=26, sig=9):
    line = ema(s, fast) - ema(s, slow)
    signal = ema(line, sig)
    return line, signal, line - signal


def bollinger(s: pd.Series, n=20, k=2.0):
    mid = sma(s, n)
    sd = s.rolling(n).std(ddof=0)
    upper, lower = mid + k * sd, mid - k * sd
    pct_b = (s - lower) / (upper - lower).replace(0, np.nan)
    return mid, upper, lower, pct_b


def stochastic(df: pd.DataFrame, n=9, d=3):
    low_n = df["low"].rolling(n).min()
    high_n = df["high"].rolling(n).max()
    k = 100 * (df["close"] - low_n) / (high_n - low_n).replace(0, np.nan)
    return k, k.rolling(d).mean()


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    c = df["close"]
    df = df.copy()
    df["sma5"] = sma(c, 5)
    df["sma25"] = sma(c, 25)
    df["sma75"] = sma(c, 75)
    df["sma200"] = sma(c, 200)
    df["rsi14"] = rsi(c, 14)
    df["macd"], df["macd_sig"], df["macd_hist"] = macd(c)
    df["bb_mid"], df["bb_up"], df["bb_low"], df["bb_pctb"] = bollinger(c)
    df["stoch_k"], df["stoch_d"] = stochastic(df)
    df["dev25"] = (c - df["sma25"]) / df["sma25"] * 100  # 25日移動平均乖離率(%)
    df["roc10"] = c.pct_change(10) * 100
    df["ret1"] = c.pct_change()
    df["fwd_ret1"] = c.shift(-1) / c - 1  # 翌日リターン（予測の教師）
    return df


# ----------------------------------------------------------------------------
# ルールベース判定
# ----------------------------------------------------------------------------
def indicator_signals(row: pd.Series) -> list[dict]:
    """各指標を強気(+)/弱気(-)/中立(0)に分類し、UI表示用メタも付与。"""
    c = row["close"]
    out = []

    # 1) トレンド（移動平均の並び）
    if row["sma5"] > row["sma25"] > row["sma75"]:
        sig, reading = "bull", "上昇トレンド"
    elif row["sma5"] < row["sma25"] < row["sma75"]:
        sig, reading = "bear", "下降トレンド"
    else:
        sig, reading = "neutral", "方向感なし"
    out.append(dict(id="trend", name="トレンド（移動平均の並び）", value=None,
                    display=reading, signal=sig, reading=reading, weight=2.0,
                    detail="短期(5日)・中期(25日)・長期(75日)の並び順で相場の向きを見ます。"
                           "上から短→中→長の順（パーフェクトオーダー）なら強い上昇、逆なら強い下降。"))

    # 2) ゴールデン/デッドクロス（5日 vs 25日）
    gap = (row["sma5"] - row["sma25"]) / row["sma25"] * 100
    if gap > 0:
        sig, reading = "bull", "短期>中期"
    elif gap < 0:
        sig, reading = "bear", "短期<中期"
    else:
        sig, reading = "neutral", "接近"
    out.append(dict(id="cross", name="移動平均クロス", value=round(gap, 2),
                    display=f"{gap:+.2f}%", signal=sig, reading=reading, weight=1.5,
                    detail="短期線が中期線を上抜けるのがゴールデンクロス（買いサイン）、"
                           "下抜けるのがデッドクロス（売りサイン）。数値は5日線と25日線の差(%)です。"))

    # 3) RSI
    v = row["rsi14"]
    if v >= 70:
        sig, reading = "bear", "買われすぎ"
    elif v <= 30:
        sig, reading = "bull", "売られすぎ（反発期待）"
    elif v >= 55:
        sig, reading = "bull", "強気"
    elif v <= 45:
        sig, reading = "bear", "弱気"
    else:
        sig, reading = "neutral", "中立"
    out.append(dict(id="rsi14", name="RSI (14)", value=round(v, 1),
                    display=f"{v:.1f}", signal=sig, reading=reading, weight=1.5,
                    detail="買われすぎ・売られすぎを0〜100で示す指標。一般に70以上で過熱（反落警戒）、"
                           "30以下で売られすぎ（反発期待）。50より上なら買い方優勢と見ます。"))

    # 4) MACD ヒストグラム
    h = row["macd_hist"]
    if h > 0 and row["macd"] > 0:
        sig, reading = "bull", "上昇の勢い"
    elif h < 0 and row["macd"] < 0:
        sig, reading = "bear", "下落の勢い"
    elif h > 0:
        sig, reading = "bull", "改善中"
    else:
        sig, reading = "bear", "悪化中"
    out.append(dict(id="macd", name="MACD", value=round(h, 1),
                    display=f"{h:+.1f}", signal=sig, reading=reading, weight=1.3,
                    detail="2本の移動平均の差から勢い（モメンタム）を見る指標。"
                           "MACDが signal線を上抜け・ヒストグラムがプラスなら上昇の勢い、逆なら下落の勢い。"))

    # 5) ボリンジャーバンド %b
    b = row["bb_pctb"]
    if b >= 1.0:
        sig, reading = "bear", "上限突破（過熱）"
    elif b <= 0.0:
        sig, reading = "bull", "下限突破（反発期待）"
    elif b >= 0.5:
        sig, reading = "bull", "中央より上"
    else:
        sig, reading = "bear", "中央より下"
    out.append(dict(id="bb", name="ボリンジャーバンド %b", value=round(float(b), 2),
                    display=f"{b:.2f}", signal=sig, reading=reading, weight=1.0,
                    detail="価格が変動幅（バンド）のどこにいるかを0〜1で表します。1超で上限突破＝過熱、"
                           "0未満で下限突破＝売られすぎ。0.5が移動平均（真ん中）です。"))

    # 6) ストキャスティクス
    k = row["stoch_k"]
    if k >= 80:
        sig, reading = "bear", "買われすぎ"
    elif k <= 20:
        sig, reading = "bull", "売られすぎ"
    elif k > row["stoch_d"]:
        sig, reading = "bull", "上向き"
    else:
        sig, reading = "bear", "下向き"
    out.append(dict(id="stoch", name="ストキャスティクス", value=round(k, 1),
                    display=f"{k:.1f}", signal=sig, reading=reading, weight=0.8,
                    detail="一定期間の高値・安値の中で現在値がどの位置かを見る指標。"
                           "80以上で買われすぎ、20以下で売られすぎ。%K が %D を上抜けると買いサイン。"))

    # 7) 25日移動平均乖離率
    dv = row["dev25"]
    if dv >= 5:
        sig, reading = "bear", "上に離れすぎ"
    elif dv <= -5:
        sig, reading = "bull", "下に離れすぎ（反発期待）"
    elif dv > 0:
        sig, reading = "bull", "平均より上"
    else:
        sig, reading = "bear", "平均より下"
    out.append(dict(id="dev25", name="25日移動平均乖離率", value=round(dv, 2),
                    display=f"{dv:+.2f}%", signal=sig, reading=reading, weight=1.0,
                    detail="価格が25日移動平均からどれだけ離れているか(%)。"
                           "プラスに大きすぎると反落、マイナスに大きすぎると反発しやすい（行き過ぎの目安）。"))

    return out


def aggregate(signals: list[dict]) -> dict:
    score_map = {"bull": 1, "bear": -1, "neutral": 0}
    total_w = sum(s["weight"] for s in signals)
    raw = sum(score_map[s["signal"]] * s["weight"] for s in signals)
    score = round(raw / total_w * 100)  # -100..+100
    n_bull = sum(1 for s in signals if s["signal"] == "bull")
    n_bear = sum(1 for s in signals if s["signal"] == "bear")

    if score >= 20:
        side, label = "bull", "ブル寄り"
    elif score <= -20:
        side, label = "bear", "ベア寄り"
    else:
        side, label = "neutral", "様子見"

    conviction = int(min(5, round(abs(score) / 20)))  # 0..5
    summary = f"{len(signals)}指標中 強気{n_bull} / 弱気{n_bear}。総合スコア {score:+d}。"
    return dict(side=side, label=label, score=score, conviction=conviction,
                n_bull=n_bull, n_bear=n_bear, summary=summary)


# ----------------------------------------------------------------------------
# 過去データからの予測（類似局面の翌日上昇率）
# ----------------------------------------------------------------------------
def historical_prediction(df: pd.DataFrame) -> dict:
    """
    現在の局面を「トレンド区分 × RSIゾーン × MACDヒスト符号」で分類し、
    過去の同じ組み合わせの日の【翌日リターン】を集計して上昇確率を出す。
    ルールベースの説明可能な予測。
    """
    d = df.dropna(subset=["sma75", "rsi14", "macd_hist", "fwd_ret1"]).copy()

    def regime(r):
        if r["sma5"] > r["sma25"] > r["sma75"]:
            return "up"
        if r["sma5"] < r["sma25"] < r["sma75"]:
            return "down"
        return "mid"

    def rsi_zone(v):
        if v >= 70:
            return "hot"
        if v <= 30:
            return "cold"
        if v >= 50:
            return "high"
        return "low"

    d["regime"] = d.apply(regime, axis=1)
    d["rzone"] = d["rsi14"].apply(rsi_zone)
    d["mh"] = np.where(d["macd_hist"] >= 0, "pos", "neg")
    d["key"] = d["regime"] + "|" + d["rzone"] + "|" + d["mh"]

    cur = d.iloc[-1]
    key = cur["key"]
    # 直近の行は翌日リターンが未確定なので学習からは除外
    hist = d.iloc[:-1]
    matched = hist[hist["key"] == key]

    n = int(len(matched))
    if n >= 8:
        up_prob = float((matched["fwd_ret1"] > 0).mean())
        avg_ret = float(matched["fwd_ret1"].mean() * 100)
        basis = "類似局面"
    else:
        # サンプル不足時はトレンド区分だけで広めに集計
        matched = hist[hist["regime"] == cur["regime"]]
        n = int(len(matched))
        up_prob = float((matched["fwd_ret1"] > 0).mean()) if n else 0.5
        avg_ret = float(matched["fwd_ret1"].mean() * 100) if n else 0.0
        basis = "トレンド区分"

    if up_prob >= 0.55:
        side, label = "bull", "ブル寄り"
    elif up_prob <= 0.45:
        side, label = "bear", "ベア寄り"
    else:
        side, label = "neutral", "五分五分"

    conf = "高" if n >= 40 else ("中" if n >= 15 else "低")
    note = (f"現在の局面（{ {'up':'上昇トレンド','down':'下降トレンド','mid':'もみ合い'}[cur['regime']] }・"
            f"RSI{ {'hot':'過熱','cold':'底値圏','high':'やや強','low':'やや弱'}[cur['rzone']] }・"
            f"MACD{'＋' if cur['mh']=='pos' else '−'}）と同じ状態は過去{n}回。"
            f"そのうち翌日上昇は{up_prob*100:.0f}%（{basis}ベース、サンプル信頼度：{conf}）。")

    return dict(side=side, label=label, up_probability=round(up_prob, 3),
                sample_size=n, avg_next_return_pct=round(avg_ret, 3),
                confidence=conf, basis=basis, note=note)


# ----------------------------------------------------------------------------
# レバレッジ投信向けの補足（期待変動・減価）
# ----------------------------------------------------------------------------
def leverage_block(df: pd.DataFrame, change_pct: float) -> dict:
    """1日で解約する運用向け。減価より『1日の振れ幅』と往復コストを重視する。"""
    # 直近20日の1日リターンの標準偏差(%) = 1日でどれだけ振れるかの目安
    daily_vol = float(df["ret1"].tail(20).std(ddof=0) * 100)
    ann_vol = daily_vol * np.sqrt(252)
    return dict(
        bull_mult=BULL_MULT, bear_mult=BEAR_MULT,
        hold_days=1,
        # 日経が1日で1σ動いたときの各ファンドの振れ幅
        daily_move_pct=round(daily_vol, 2),
        swing_bull_pct=round(daily_vol * BULL_MULT, 1),
        swing_bear_pct=round(daily_vol * BEAR_MULT, 1),
        # 参考: 本日の日経実績 × 倍率
        today_bull_pct=round(change_pct * BULL_MULT, 2),
        today_bear_pct=round(-change_pct * BEAR_MULT, 2),
        realized_vol_annual_pct=round(ann_vol, 1),
        decay_note="1日で解約する運用なら、減価（複数日の再計算で効く目減り）はほぼ発生しません。効くのは往復コストと、方向が当たるかどうかです。",
        cost_note="勝っても往復コスト（信託報酬の日割り・信託財産留保額・購入時手数料など）が差し引かれます。料率は目論見書で要確認。",
    )


# ----------------------------------------------------------------------------
# メイン
# ----------------------------------------------------------------------------
def build_payload(force_sample: bool) -> dict:
    raw, is_sample, source = load_data(force_sample)
    df = build_features(raw)
    last = df.iloc[-1]
    prev = df.iloc[-2]

    close = float(last["close"])
    prev_close = float(prev["close"])
    change = close - prev_close
    change_pct = change / prev_close * 100

    signals = indicator_signals(last)
    verdict = aggregate(signals)
    prediction = historical_prediction(df)
    leverage = leverage_block(df, change_pct)

    hist = df.tail(120)[["date", "close"]]
    history = [{"d": d.strftime("%Y-%m-%d"), "c": round(float(c), 2)}
               for d, c in zip(hist["date"], hist["close"])]

    return {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "is_sample": is_sample,
        "source": source,
        "index": {
            "name": "日経平均株価",
            "last": round(close, 2),
            "prev_close": round(prev_close, 2),
            "change": round(change, 2),
            "change_pct": round(change_pct, 2),
            "date": last["date"].strftime("%Y-%m-%d"),
            "history": history,
        },
        "verdict": verdict,
        "prediction": prediction,
        "leverage": leverage,
        "indicators": [
            {k: v for k, v in s.items() if k != "weight"} for s in signals
        ],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="合成データを強制使用（ローカル検証用）")
    ap.add_argument("--out", default="data/data.json")
    args = ap.parse_args()

    payload = build_payload(args.sample)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    tag = "SAMPLE" if payload["is_sample"] else "LIVE"
    print(f"[{tag}] {args.out} を書き出しました。"
          f" 判定={payload['verdict']['label']}({payload['verdict']['score']:+d}) "
          f"予測上昇確率={payload['prediction']['up_probability']*100:.0f}%")


if __name__ == "__main__":
    main()
