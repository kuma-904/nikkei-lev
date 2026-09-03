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

# --- 予測・判定の既定パラメータ（サイト側で調整可能。ここが初期値） ---
LOOKBACK_YEARS = 5    # 予測で遡る年数（直近N年に限定）
MIN_SAMPLES = 8       # 類似局面がこれ未満なら区分を広げる
SHIP_YEARS = 8        # サイトのスライダー用に出荷するサンプル履歴の年数
SCORE_THRESHOLD = 20  # |スコア| がこれ以上で ブル寄り/ベア寄り
ORDER_CUTOFF = "15:20"  # 楽天ブル4.3倍/ベア3.8倍の購入申込締切（引け15:30の10分前）
ADX_CUTOFF = 23         # ADXがこれ以上→トレンド相場、未満→もみ合い


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


# ----------------------------------------------------------------------------
# オーバーナイト要因（米国株・ドル円・日経先物）
# ----------------------------------------------------------------------------
def _stooq_close(symbol: str) -> pd.DataFrame:
    import requests
    r = requests.get(f"https://stooq.com/q/d/l/?s={symbol}&i=d",
                     timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text)).rename(columns=str.lower)
    if "close" not in df.columns or len(df) < 50:
        raise ValueError(symbol)
    df["date"] = pd.to_datetime(df["date"])
    return df[["date", "close"]].dropna().sort_values("date").reset_index(drop=True)


def _yf_close(symbol: str, period: str = "8y") -> pd.DataFrame:
    import yfinance as yf
    d = yf.download(symbol, period=period, interval="1d", progress=False, auto_adjust=False)
    if d is None or len(d) < 50:
        raise ValueError(symbol)
    d = d.reset_index()
    if isinstance(d.columns, pd.MultiIndex):
        d.columns = [c[0] for c in d.columns]
    d = d.rename(columns=str.lower)
    d["date"] = pd.to_datetime(d["date"])
    return d[["date", "close"]].dropna().sort_values("date").reset_index(drop=True)


def _fetch_aux(stooq_sym: str, yf_sym: str):
    for label, fn in ((f"stooq {stooq_sym}", lambda: _stooq_close(stooq_sym)),
                      (f"Yahoo {yf_sym}", lambda: _yf_close(yf_sym))):
        try:
            return fn(), label
        except Exception as e:  # noqa: BLE001
            print(f"[warn] aux {label}: {e}", file=sys.stderr)
    return None, None


def load_aux(is_sample: bool, nk: pd.DataFrame):
    """米国株(S&P500)・ドル円・日経先物を取得。失敗した系列は None（自動で無効化）。
    (frames, providers) を返す。"""
    if is_sample:
        rng = np.random.default_rng(7)
        n = len(nk)
        mk = lambda arr: pd.DataFrame({"date": nk["date"].values, "close": arr})
        spx = 4200 * np.exp(np.cumsum(rng.normal(0.0004, 0.011, n)))
        jpy = 145 * np.exp(np.cumsum(rng.normal(0.0, 0.005, n)))
        fut = nk["close"].values * (1 + rng.normal(0, 0.002, n))
        frames = {"spx": mk(spx), "usdjpy": mk(jpy), "futures": mk(fut)}
        prov = {"spx": "サンプル", "usdjpy": "サンプル", "futures": "サンプル"}
        return frames, prov
    spx, spx_p = _fetch_aux("^spx", "^GSPC")
    jpy, jpy_p = _fetch_aux("usdjpy", "JPY=X")
    fut, fut_p = None, None
    try:
        fut = _yf_close("NIY=F", "5y")  # CME 日経225先物（EOD・任意）
        fut_p = "Yahoo NIY=F"
    except Exception as e:  # noqa: BLE001
        print(f"[warn] futures NIY=F: {e}", file=sys.stderr)
    return ({"spx": spx, "usdjpy": jpy, "futures": fut},
            {"spx": spx_p, "usdjpy": jpy_p, "futures": fut_p})


def attach_overnight(df: pd.DataFrame, aux: dict) -> pd.DataFrame:
    """各日経日Dに《その前に確定していた》米国・ドル円の1日リターンを紐付ける。
    merge_asof(backward, exact=False) で D より前の直近の海外終値を割り当て、先読みを防ぐ。"""
    d = df.copy()
    d["nk_ret"] = d["close"].pct_change() * 100
    for key, col in (("spx", "us_ret"), ("usdjpy", "jpy_ret")):
        f = aux.get(key)
        if f is None:
            d[col] = np.nan
            continue
        f = f.copy()
        f[col] = f["close"].pct_change() * 100
        d = pd.merge_asof(d.sort_values("date"),
                          f[["date", col]].dropna().sort_values("date"),
                          on="date", direction="backward", allow_exact_matches=False)
    return d.reset_index(drop=True)


def current_overnight(aux: dict, nk_close: float):
    """最新（＝直近の夜）の米国株・ドル円リターンと、先物の現物比プレミアムを返す。"""
    def last_ret(frame):
        if frame is None or len(frame) < 2:
            return float("nan")
        return float((frame["close"].pct_change() * 100).iloc[-1])
    us = last_ret(aux.get("spx"))
    jpy = last_ret(aux.get("usdjpy"))
    fut = aux.get("futures")
    prem = float("nan")
    if fut is not None and len(fut):
        prem = (float(fut["close"].iloc[-1]) - nk_close) / nk_close * 100
    return us, jpy, prem


def overnight_signals(us: float, jpy: float, prem: float) -> list[dict]:
    """判定に加えるオーバーナイト票（米国株・ドル円・先物）。"""
    out = []
    if not np.isnan(us):
        if us >= 0.15:
            sig, reading = "bull", "前日プラス"
        elif us <= -0.15:
            sig, reading = "bear", "前日マイナス"
        else:
            sig, reading = "neutral", "ほぼ横ばい"
        out.append(dict(id="us", name="米国株（前日S&P500）", value=round(us, 2),
                        display=f"{us:+.2f}%", signal=sig, reading=reading, weight=1.6,
                        group="overnight",
                        detail="前日の米国市場(S&P500)の騰落。日本株は米国株の影響を強く受け、"
                               "前日の米国上昇は翌日の日経の追い風、下落は向かい風になりやすい。"))
    if not np.isnan(jpy):
        if jpy >= 0.10:
            sig, reading = "bull", "円安方向"
        elif jpy <= -0.10:
            sig, reading = "bear", "円高方向"
        else:
            sig, reading = "neutral", "ほぼ横ばい"
        out.append(dict(id="jpy", name="ドル円（前日）", value=round(jpy, 2),
                        display=f"{jpy:+.2f}%", signal=sig, reading=reading, weight=1.2,
                        group="overnight",
                        detail="前日のドル円の動き。円安(ドル円上昇)は輸出企業の採算改善期待から"
                               "日経の追い風、円高は向かい風になりやすい。"))
    if not np.isnan(prem):
        if prem >= 0.10:
            sig, reading = "bull", "現物より高い"
        elif prem <= -0.10:
            sig, reading = "bear", "現物より安い"
        else:
            sig, reading = "neutral", "ほぼ同水準"
        out.append(dict(id="fut", name="日経先物 vs 現物", value=round(prem, 2),
                        display=f"{prem:+.2f}%", signal=sig, reading=reading, weight=1.0,
                        group="overnight",
                        detail="日経先物が現物(現在の日経平均)より高いか安いか。先物が高ければ市場は"
                               "上を見ている目安。ただしEOD(日足)のため夜間の最新値ではない点に注意。"))
    return out


def _dir(x: float, dead: float = 0.10) -> str:
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "0"
    return "+" if x >= dead else ("-" if x <= -dead else "0")


def overnight_prediction(d: pd.DataFrame, us: float, jpy: float,
                         lookback_years: int = LOOKBACK_YEARS,
                         min_samples: int = MIN_SAMPLES) -> dict:
    """前夜の米国株×ドル円の方向が今と同じだった《翌営業日の日経》の上昇率を集計。
    先読みなし（前夜の海外→当日の日経 の対応で学習）。"""
    dd = d.dropna(subset=["us_ret", "jpy_ret", "nk_ret"]).copy()
    if len(dd) < 30 or (np.isnan(us) and np.isnan(jpy)):
        return {"available": False}
    dd["ukey"] = dd["us_ret"].apply(_dir) + dd["jpy_ret"].apply(_dir)
    cur = _dir(us) + _dir(jpy)

    last_date = dd.iloc[-1]["date"]
    cutoff = last_date - pd.DateOffset(years=lookback_years)
    hist = dd[dd["date"] >= cutoff]

    matched = hist[hist["ukey"] == cur]
    n = int(len(matched))
    basis = "米国株×ドル円"
    if n < min_samples:
        matched = hist[hist["us_ret"].apply(_dir) == _dir(us)]
        n = int(len(matched))
        basis = "米国株のみ"

    up = float((matched["nk_ret"] > 0).mean()) if n else 0.5
    avg = float(matched["nk_ret"].mean()) if n else 0.0
    if up >= 0.55:
        side, label = "bull", "ブル寄り"
    elif up <= 0.45:
        side, label = "bear", "ベア寄り"
    else:
        side, label = "neutral", "五分五分"
    conf = "高" if n >= 40 else ("中" if n >= 15 else "低")
    US_JP = {"+": "上昇", "-": "下落", "0": "横ばい"}
    JPY_JP = {"+": "円安", "-": "円高", "0": "横ばい"}
    note = (f"前日に米国株{US_JP[_dir(us)]}・ドル円{JPY_JP[_dir(jpy)]}となった翌営業日、"
            f"日経が上昇したのは直近{lookback_years}年で{n}回中{up*100:.0f}%（{basis}、信頼度{conf}）。")
    return {"available": True, "side": side, "label": label,
            "up_probability": round(up, 3), "sample_size": n,
            "avg_next_return_pct": round(avg, 3), "confidence": conf, "note": note}


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


def adx(df: pd.DataFrame, n=14) -> pd.Series:
    """ADX（トレンドの強さ）。高いほどトレンド相場、低いほどもみ合い。"""
    h, l, c = df["high"], df["low"], df["close"]
    up, dn = h.diff(), -l.diff()
    plus_dm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    tr = pd.concat([(h - l), (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / n, adjust=False).mean().replace(0, np.nan)
    plus_di = 100 * plus_dm.ewm(alpha=1 / n, adjust=False).mean() / atr
    minus_di = 100 * minus_dm.ewm(alpha=1 / n, adjust=False).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean()


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
    df["adx"] = adx(df, 14)
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


def aggregate(signals: list[dict], threshold: int = SCORE_THRESHOLD) -> dict:
    score_map = {"bull": 1, "bear": -1, "neutral": 0}
    total_w = sum(s["weight"] for s in signals)
    raw = sum(score_map[s["signal"]] * s["weight"] for s in signals)
    score = round(raw / total_w * 100)  # -100..+100
    n_bull = sum(1 for s in signals if s["signal"] == "bull")
    n_bear = sum(1 for s in signals if s["signal"] == "bear")

    if score >= threshold:
        side, label = "bull", "ブル寄り"
    elif score <= -threshold:
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
REGIME_JP = {"up": "上昇トレンド", "down": "下降トレンド", "mid": "もみ合い"}
RZONE_JP = {"hot": "過熱", "cold": "底値圏", "high": "やや強", "low": "やや弱"}


def classify(df: pd.DataFrame) -> pd.DataFrame:
    """各日を トレンド区分 × RSIゾーン × MACD符号 に分類して key 列を付ける。"""
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
    return d


def historical_prediction(d: pd.DataFrame,
                          lookback_years: int = LOOKBACK_YEARS,
                          min_samples: int = MIN_SAMPLES) -> dict:
    """
    現在の局面と同じ状態だった《直近 lookback_years 年》の日の翌日リターンを集計。
    サイト側の JS と同じロジック（初期値もここと揃える）。
    """
    cur = d.iloc[-1]
    key = cur["key"]

    # 直近の行は翌日リターン未確定 → 学習から除外。さらに直近N年に限定
    hist = d.iloc[:-1]
    cutoff = cur["date"] - pd.DateOffset(years=lookback_years)
    hist = hist[hist["date"] >= cutoff]

    matched = hist[hist["key"] == key]
    n = int(len(matched))
    if n >= min_samples:
        basis = "類似局面"
    else:
        matched = hist[hist["regime"] == cur["regime"]]
        n = int(len(matched))
        basis = "トレンド区分"

    up_prob = float((matched["fwd_ret1"] > 0).mean()) if n else 0.5
    avg_ret = float(matched["fwd_ret1"].mean() * 100) if n else 0.0

    if up_prob >= 0.55:
        side, label = "bull", "ブル寄り"
    elif up_prob <= 0.45:
        side, label = "bear", "ベア寄り"
    else:
        side, label = "neutral", "五分五分"

    conf = "高" if n >= 40 else ("中" if n >= 15 else "低")
    note = (f"直近{lookback_years}年で、同じ状態（{REGIME_JP[cur['regime']]}・"
            f"RSI{RZONE_JP[cur['rzone']]}・MACD{'＋' if cur['mh']=='pos' else '−'}）"
            f"だった日は{n}回。そのうち翌日上昇は{up_prob*100:.0f}%"
            f"（{basis}ベース、サンプル信頼度：{conf}）。")

    return dict(side=side, label=label, up_probability=round(up_prob, 3),
                sample_size=n, avg_next_return_pct=round(avg_ret, 3),
                confidence=conf, basis=basis, note=note,
                key=key, lookback_years=lookback_years)


BT_ORDER = ["trend", "cross", "rsi14", "macd", "bb", "stoch", "dev25"]  # バックテスト対象のテクニカル7指標


def _sig_string(row: pd.Series) -> str:
    """その日の7指標シグナルを b(強気)/s(弱気)/n(中立) の文字列に符号化。"""
    sig = {s["id"]: s["signal"] for s in indicator_signals(row)}
    m = {"bull": "b", "bear": "s", "neutral": "n"}
    return "".join(m[sig[i]] for i in BT_ORDER)


def build_pred_samples(d: pd.DataFrame, ship_years: int = SHIP_YEARS) -> list:
    """サイトが遡り年数・重み・しきい値を変えて再計算できるよう、直近 ship_years 年の
    [日付, key, 翌日リターン%, 7指標シグナル文字列] を出荷する。"""
    last_date = d.iloc[-1]["date"]
    cutoff = last_date - pd.DateOffset(years=ship_years)
    s = d.iloc[:-1]
    s = s[s["date"] >= cutoff]
    out = []
    for _, row in s.iterrows():
        areg = "T" if (pd.notna(row.get("adx")) and row["adx"] >= ADX_CUTOFF) else "R"
        out.append([row["date"].strftime("%Y-%m-%d"), row["key"],
                    round(float(row["fwd_ret1"]) * 100, 3), _sig_string(row), areg])
    return out


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
def _correct(side: str, ret: float):
    if side == "bull":
        return bool(ret > 0)
    if side == "bear":
        return bool(ret < 0)
    return None  # 様子見/五分五分は採点しない


def summarize_track(log: list) -> dict:
    resolved = [r for r in log if r.get("next_ret") is not None]
    vd = [r for r in resolved if r.get("verdict_correct") is not None]
    pr = [r for r in resolved if r.get("pred_correct") is not None]
    pct = lambda xs: round(sum(1 for r in xs if r) / len(xs) * 100, 1) if xs else None
    keys = ("date", "close", "verdict_side", "pred_side", "ov_side",
            "next_ret", "verdict_correct", "pred_correct")
    recent = [{k: r.get(k) for k in keys} for r in log[-12:][::-1]]
    return {
        "resolved": len(resolved),
        "verdict_hit_rate": pct([r["verdict_correct"] for r in vd]), "verdict_n": len(vd),
        "pred_hit_rate": pct([r["pred_correct"] for r in pr]), "pred_n": len(pr),
        "since": log[0]["date"] if log else None,
        "total_logged": len(log),
        "recent": recent,
    }


def synth_track_record() -> dict:
    """サンプル表示用の合成フォワード実績。"""
    rng = np.random.default_rng(3)
    log = []
    base = 34000.0
    d0 = datetime.now(JST).date()
    for i in range(16):
        base *= (1 + rng.normal(0.0005, 0.011))
        ret = round(float(rng.normal(0.05, 1.1)), 3)
        vs = rng.choice(["bull", "bear", "neutral"], p=[0.4, 0.4, 0.2])
        ps = rng.choice(["bull", "bear", "neutral"], p=[0.35, 0.35, 0.3])
        log.append({
            "date": (d0 - timedelta(days=(16 - i) * 1)).strftime("%Y-%m-%d"),
            "close": round(base, 2), "verdict_side": vs, "pred_side": ps,
            "ov_side": rng.choice(["bull", "bear", "neutral"]),
            "next_ret": ret, "verdict_correct": _correct(vs, ret), "pred_correct": _correct(ps, ret),
        })
    return summarize_track(log)


def resolve_and_log(df: pd.DataFrame, verdict: dict, prediction: dict, overnight: dict,
                    is_sample: bool, path: str) -> dict:
    """実運用の予測ログを更新（追記＋結果判明分の採点）して、フォワード実績サマリを返す。
    バックテスト（過去当てはめ）と違い、実際に出した予測の的中を日々ためる“独自DB”。"""
    if is_sample:
        return synth_track_record()

    import os
    log = []
    if os.path.exists(path):
        try:
            log = json.load(open(path, encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"[warn] predictions.json 読込失敗: {e}", file=sys.stderr)
            log = []
    by_date = {r["date"]: r for r in log if "date" in r}

    last = df.iloc[-1]
    tdate = last["date"].strftime("%Y-%m-%d")
    rec = by_date.get(tdate, {"date": tdate})
    ov_side = (overnight.get("prediction") or {}).get("side") if overnight.get("available") else None
    rec.update({
        "close": round(float(last["close"]), 2),
        "verdict_side": verdict["side"], "verdict_score": verdict["score"],
        "pred_side": prediction["side"], "pred_prob": prediction["up_probability"],
        "ov_side": ov_side,
    })
    rec.setdefault("next_ret", None)
    rec.setdefault("verdict_correct", None)
    rec.setdefault("pred_correct", None)
    by_date[tdate] = rec

    # 結果の採点：記録日の翌営業日の終値が判明していれば埋める
    dates = list(df["date"])
    close_by = {d.strftime("%Y-%m-%d"): float(c) for d, c in zip(df["date"], df["close"])}
    pos = {d.strftime("%Y-%m-%d"): i for i, d in enumerate(dates)}
    for d, r in by_date.items():
        if r.get("next_ret") is None and d in pos and pos[d] + 1 < len(dates):
            nd = dates[pos[d] + 1].strftime("%Y-%m-%d")
            ret = (close_by[nd] / close_by[d] - 1) * 100
            r["next_ret"] = round(ret, 3)
            r["verdict_correct"] = _correct(r.get("verdict_side"), ret)
            r["pred_correct"] = _correct(r.get("pred_side"), ret)

    log = [by_date[d] for d in sorted(by_date.keys())]
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(log, f, ensure_ascii=False, indent=1)
    except Exception as e:  # noqa: BLE001
        print(f"[warn] predictions.json 書込失敗: {e}", file=sys.stderr)
    return summarize_track(log)


def build_payload(force_sample: bool, pred_log_path: str = "data/predictions.json") -> dict:
    raw, is_sample, source = load_data(force_sample)
    df = build_features(raw)
    last = df.iloc[-1]
    prev = df.iloc[-2]

    close = float(last["close"])
    prev_close = float(prev["close"])
    change = close - prev_close
    change_pct = change / prev_close * 100

    signals = indicator_signals(last)
    for s in signals:
        s["group"] = "tech"

    # --- オーバーナイト要因（米国株・ドル円・先物） ---
    aux, providers = load_aux(is_sample, raw)
    d_over = attach_overnight(df, aux)
    us_now, jpy_now, fut_prem = current_overnight(aux, close)
    ov_signals = overnight_signals(us_now, jpy_now, fut_prem)
    ov_pred = overnight_prediction(d_over, us_now, jpy_now)

    signals_all = signals + ov_signals
    verdict = aggregate(signals_all)
    d_class = classify(df)
    prediction = historical_prediction(d_class)
    pred_samples = build_pred_samples(d_class)
    leverage = leverage_block(df, change_pct)

    hist = df.tail(120)[["date", "close"]]
    history = [{"d": d.strftime("%Y-%m-%d"), "c": round(float(c), 2)}
               for d, c in zip(hist["date"], hist["close"])]

    def clean(x):
        return None if (x is None or (isinstance(x, float) and np.isnan(x))) else x

    config = {
        "lookback_years": LOOKBACK_YEARS,
        "min_samples": MIN_SAMPLES,
        "ship_years": SHIP_YEARS,
        "score_threshold": SCORE_THRESHOLD,
        "order_cutoff": ORDER_CUTOFF,
        "adx_cutoff": ADX_CUTOFF,
        "run_times_jst": sorted([f"{h:02d}:10" for h in range(8, 21)] + ["15:03"]),  # 平日 8:10〜20:10 毎時+15:03
        "bt_order": BT_ORDER,  # バックテストの指標順（サイト側の再計算用）
        "weights": {s["id"]: s["weight"] for s in signals_all},
    }

    def _asof(frame):
        return frame["date"].iloc[-1].strftime("%Y-%m-%d") if (frame is not None and len(frame)) else None

    sources = [
        {"name": "日経平均", "as_of": last["date"].strftime("%Y-%m-%d"),
         "provider": source, "ok": True},
        {"name": "米国株(S&P500)", "as_of": _asof(aux.get("spx")),
         "provider": providers.get("spx"), "ok": aux.get("spx") is not None},
        {"name": "ドル円", "as_of": _asof(aux.get("usdjpy")),
         "provider": providers.get("usdjpy"), "ok": aux.get("usdjpy") is not None},
        {"name": "日経先物", "as_of": _asof(aux.get("futures")),
         "provider": providers.get("futures") or "Yahoo NIY=F", "ok": aux.get("futures") is not None},
    ]
    overnight = {
        "available": bool(ov_signals),
        "us_ret_pct": clean(round(us_now, 2) if not np.isnan(us_now) else None),
        "jpy_ret_pct": clean(round(jpy_now, 2) if not np.isnan(jpy_now) else None),
        "fut_premium_pct": clean(round(fut_prem, 2) if not np.isnan(fut_prem) else None),
        "prediction": ov_pred,
    }

    track_record = resolve_and_log(df, verdict, prediction, overnight, is_sample, pred_log_path)

    adx_now = float(last["adx"]) if pd.notna(last["adx"]) else None
    regime = {
        "adx": round(adx_now, 1) if adx_now is not None else None,
        "state": ("trend" if (adx_now is not None and adx_now >= ADX_CUTOFF) else "range"),
        "cutoff": ADX_CUTOFF,
    }

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
        "overnight": overnight,
        "regime": regime,
        "leverage": leverage,
        "config": config,
        "sources": sources,
        "track_record": track_record,
        "pred_samples": pred_samples,
        "indicators": [dict(s) for s in signals_all],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="合成データを強制使用（ローカル検証用）")
    ap.add_argument("--out", default="data/data.json")
    ap.add_argument("--pred-out", default="data/predictions.json")
    args = ap.parse_args()

    payload = build_payload(args.sample, args.pred_out)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    tag = "SAMPLE" if payload["is_sample"] else "LIVE"
    print(f"[{tag}] {args.out} を書き出しました。"
          f" 判定={payload['verdict']['label']}({payload['verdict']['score']:+d}) "
          f"予測上昇確率={payload['prediction']['up_probability']*100:.0f}%")


if __name__ == "__main__":
    main()
