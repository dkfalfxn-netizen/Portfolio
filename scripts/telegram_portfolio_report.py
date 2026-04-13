import os
from datetime import datetime

import requests


TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
TELEGRAM_API_BASE = "https://api.telegram.org"


def send_telegram_msg(message: str) -> dict:
    if not TELEGRAM_TOKEN or not CHAT_ID:
        raise ValueError("환경변수 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID를 설정해 주세요.")

    url = f"{TELEGRAM_API_BASE}/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
    }

    response = requests.post(url, json=payload, timeout=10)
    response.raise_for_status()
    data = response.json()

    if not data.get("ok"):
        raise RuntimeError(f"텔레그램 전송 실패: {data}")
    return data


def format_money(amount: float) -> str:
    return f"${amount:,.0f}"


def get_display_name(stock: dict) -> str:
    market = str(stock.get("market", "")).upper()
    country = str(stock.get("country", "")).upper()
    is_korean_stock = bool(stock.get("is_korean_stock")) or market in {
        "KRX",
        "KOSPI",
        "KOSDAQ",
    } or country in {"KR", "KOR", "KOREA"}

    if is_korean_stock:
        return (
            stock.get("stock_name_kr")
            or stock.get("korean_name")
            or stock.get("name_kr")
            or stock.get("display_name")
            or stock.get("name")
            or stock.get("ticker")
            or "UNKNOWN"
        )

    return stock.get("display_name") or stock.get("name") or stock.get("ticker") or "UNKNOWN"


def format_portfolio_report(
    portfolio_data: list[dict],
    total_value: float | None = None,
    signal_data: dict | None = None,
) -> str:
    now = datetime.now().strftime("%m/%d")

    if not portfolio_data:
        return (
            f"📊 일일 포트폴리오 브리핑 ({now})\n"
            "💰 총 평가금액: 데이터 없음\n\n"
            "🚨 [주요 변동 타겟] (±2% 이상)\n"
            "· 특이 변동 종목 없음\n\n"
            "📂 [섹터별 현황]\n"
            "· 데이터 없음\n\n"
            "🛰️ [기술적 시그널 포착]\n"
            "⚠️ RSI 과매수(>=70): 없음\n"
            "⚠️ RSI 과매도(<=30): 없음\n"
            "🔄 MACD 골든크로스: 없음"
        )

    total_change = sum(d["change_pct"] for d in portfolio_data) / len(portfolio_data)
    if total_value is None:
        total_value = sum(d["price"] for d in portfolio_data)
    summary = f"📊 일일 포트폴리오 브리핑 ({now})\n"
    summary += f"💰 총 평가금액: {format_money(total_value)} ({total_change:+.1f}% {'🔺' if total_change > 0 else '📉'})\n\n"

    movers = [d for d in portfolio_data if abs(d["change_pct"]) >= 2.0]
    movers_text = "🚨 [주요 변동 타겟] (±2% 이상)\n"
    if movers:
        for m in movers:
            movers_text += f"· {get_display_name(m)}: ${m['price']:,} ({m['change_pct']:+.1f}%)\n"
    else:
        movers_text += "· 특이 변동 종목 없음\n"

    sectors: dict[str, list[dict]] = {}
    for d in portfolio_data:
        sectors.setdefault(d["sector"], []).append(d)

    sector_text = "\n📂 [섹터별 현황]"
    for sector, stocks in sectors.items():
        sector_text += f"\n{sector}\n"
        for s in stocks:
            sector_text += f"· {get_display_name(s)}: ${s['price']:,} ({s['change_pct']:+.1f}%)\n"

    signal_data = signal_data or {}
    overbought = signal_data.get("rsi_overbought", [])
    oversold = signal_data.get("rsi_oversold", [])
    macd_golden = signal_data.get("macd_golden_cross", [])
    signal_text = "\n\n🛰️ [기술적 시그널 포착]\n"
    signal_text += f"⚠️ RSI 과매수(>=70): {', '.join(overbought) if overbought else '없음'}\n"
    signal_text += f"⚠️ RSI 과매도(<=30): {', '.join(oversold) if oversold else '없음'}\n"
    signal_text += f"🔄 MACD 골든크로스: {', '.join(macd_golden) if macd_golden else '없음'}"

    return summary + movers_text + sector_text + signal_text


if __name__ == "__main__":
    sample_data = [
        {"name": "QQQ", "price": 440.12, "change_pct": 2.1, "sector": "🤖 AI / Tech"},
        {"name": "SPYM", "price": 65.20, "change_pct": 1.8, "sector": "🤖 AI / Tech"},
        {"name": "POWR", "price": 32.10, "change_pct": -0.5, "sector": "🤖 AI / Tech"},
        {"name": "ITA", "price": 132.10, "change_pct": 0.5, "sector": "🛡️ Defense / Aero"},
        {"name": "SHLD", "price": 28.40, "change_pct": 0.1, "sector": "🛡️ Defense / Aero"},
        {"name": "NLR", "price": 85.40, "change_pct": -0.2, "sector": "⚡ Energy / Utilities"},
        {"name": "XLU", "price": 64.20, "change_pct": 0.8, "sector": "⚡ Energy / Utilities"},
        {"name": "XLE", "price": 92.34, "change_pct": -2.5, "sector": "⚡ Energy / Utilities"},
        {"name": "GLD", "price": 220.50, "change_pct": 0.8, "sector": "🥇 Safe Assets"},
    ]
    sample_signals = {
        "rsi_overbought": [],
        "rsi_oversold": ["XLE (28)"],
        "macd_golden_cross": ["ITA"],
    }

    message = format_portfolio_report(
        sample_data,
        total_value=124_500,
        signal_data=sample_signals,
    )
    try:
        result = send_telegram_msg(message)
        print(f"전송 성공: message_id={result.get('result', {}).get('message_id')}")
    except Exception as exc:
        print(f"전송 실패: {exc}")
