"""Реальные рыночные данные: ЦБ РФ (курсы валют, ключевая ставка) и MOEX ISS (IMOEX, цены).

Логика по Части 1 ТЗ:
1. пробуем живой запрос к источнику (timeout config.MOEX_ISS_TIMEOUT_SEC,
   config.MOEX_ISS_RETRIES повторов с паузой config.MOEX_ISS_RETRY_DELAY_SEC);
2. если источник упал — берём последнее значение из SQLite (market_snapshots);
3. если и в базе пусто — fallback из config.py + WARNING в лог.

Ключевая ставка кэшируется на config.CBR_KEY_RATE_CACHE_HOURS (24 ч): меняется 8 раз в год.
Модуль синхронный (requests) — в async-коде вызывается через asyncio.to_thread.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable

import requests

import config
from storage import db

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": config.HTTP_USER_AGENT,
    "Accept": "application/json, application/xml, text/xml, text/html, */*",
}

# Имена источников в source_status (JSON в market_snapshots.source_status)
SOURCE_CBR_RATES = "cbr_rates"
SOURCE_MOEX_INDEX = "moex_index"
SOURCE_KEY_RATE = "key_rate"

# Сколько секунд держать один снимок в памяти процесса (за прогон данные берутся один раз)
SNAPSHOT_CACHE_TTL_SEC = 60


class FetchError(Exception):
    """Источник недоступен или отдал неразбираемый ответ (наружу из job не выходит)."""


def _to_float(value: Any) -> float | None:
    """Число из строки/числа: «14,00», «1 234,5», «-0.92%» → float."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("\u00a0", "").replace(" ", "").replace("%", "")
    text = text.replace(",", ".")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


_DATE_RE = re.compile(r"(\d{2})\.(\d{2})\.(\d{4})")


def _parse_cbr_date(value: Any) -> datetime | None:
    """Дата ЦБ РФ «15.10.2026» → aware datetime в МСК (иначе None)."""
    if not value:
        return None
    match = _DATE_RE.search(str(value))
    if not match:
        return None
    day, month, year = (int(part) for part in match.groups())
    try:
        return datetime(year, month, day, tzinfo=config.now_msk().tzinfo)
    except ValueError:
        return None


def _decode(response: requests.Response) -> str:
    """Декодирует тело ответа: UTF-8, затем windows-1251 (XML ЦБ РФ отдаёт в cp1251)."""
    content = response.content or b""
    if not content:
        raise FetchError("empty_response")
    for encoding in ("utf-8", "windows-1251"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode(response.encoding or "utf-8", errors="replace")


def _http_get(url: str, *, retries: int | None = None, timeout: int | None = None) -> requests.Response:
    """GET с повторами. Бросает FetchError с короткой причиной (timeout/http_500/...)."""
    attempts = (config.MOEX_ISS_RETRIES if retries is None else retries) + 1
    wait = config.MOEX_ISS_TIMEOUT_SEC if timeout is None else timeout
    reason = "unknown_error"

    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, timeout=wait, headers=HEADERS)
        except requests.exceptions.Timeout:
            reason = "timeout"
        except requests.RequestException as exc:
            reason = "connection_error"
            logger.warning("Запрос %s: сетевая ошибка (%s)", url, exc)
        else:
            if response.status_code >= 400:
                reason = f"http_{response.status_code}"
            else:
                return response

        if attempt < attempts:
            logger.warning(
                "Запрос %s: попытка %s/%s неудачна (%s), повтор через %s сек",
                url, attempt, attempts, reason, config.MOEX_ISS_RETRY_DELAY_SEC,
            )
            time.sleep(config.MOEX_ISS_RETRY_DELAY_SEC)

    raise FetchError(reason)


def _block_rows(block: Any) -> list[dict[str, Any]]:
    """MOEX ISS-блок {columns, data} → список словарей."""
    if not isinstance(block, dict):
        return []
    columns = block.get("columns") or []
    return [dict(zip(columns, row)) for row in (block.get("data") or [])]


def _first_row(block: Any) -> dict[str, Any]:
    rows = _block_rows(block)
    return rows[0] if rows else {}


# ---------------------------------------------------------------------------
# Источники: ЦБ РФ (курсы), MOEX ISS (индекс, цены), ЦБ РФ (ключевая ставка)
# ---------------------------------------------------------------------------
def fetch_cbr_rates() -> dict[str, float]:
    """Курсы USD/RUB, CNY/RUB, EUR/RUB с cbr-xml-daily.ru (зеркало официального XML ЦБ)."""
    response = _http_get(config.CBR_DAILY_URL)
    try:
        payload = json.loads(_decode(response))
    except ValueError as exc:
        raise FetchError("parse_error") from exc

    valute = payload.get("Valute")
    if not isinstance(valute, dict):
        raise FetchError("parse_error")

    rates: dict[str, float] = {}
    for code, key in (("USD", "usdrub"), ("CNY", "cnyrub"), ("EUR", "eurrub")):
        entry = valute.get(code)
        if not isinstance(entry, dict):
            continue
        nominal = _to_float(entry.get("Nominal")) or 1.0
        value = _to_float(entry.get("Value"))
        if value is None or not nominal:
            continue
        rates[key] = round(value / nominal, 4)

    if not rates:
        raise FetchError("parse_error")
    logger.info(
        "ЦБ РФ: курсы получены — USD/RUB %s, CNY/RUB %s, EUR/RUB %s",
        rates.get("usdrub"), rates.get("cnyrub"), rates.get("eurrub"),
    )
    return rates


def fetch_moex_index() -> dict[str, float]:
    """IMOEX с MOEX ISS (ключ не нужен, задержка ~15 минут).

    Значение — колонка CURRENTVALUE. Для изменения проверяются LASTCHANGEPRCNT
    (так в ТЗ, эта колонка есть у акций) и LASTCHANGEPRC (фактическое имя у индекса).
    """
    response = _http_get(f"{config.MOEX_ISS_INDEX_URL}?iss.meta=off")
    try:
        payload = json.loads(_decode(response))
    except ValueError as exc:
        raise FetchError("parse_error") from exc

    row = _first_row(payload.get("marketdata"))
    value = _to_float(row.get("CURRENTVALUE"))
    if value is None:
        value = _to_float(row.get("LASTVALUE"))
    if value is None:
        raise FetchError("parse_error")

    change = None
    for column in ("LASTCHANGEPRCNT", "LASTCHANGEPRC", "LASTCHANGETOOPENPRC"):
        change = _to_float(row.get(column))
        if change is not None:
            break

    logger.info("MOEX ISS: IMOEX=%s (%s%% за сутки)", value, change)
    return {"moex_value": value, "moex_change": change if change is not None else 0.0}


def fetch_ticker_price(ticker: str) -> float | None:
    """Текущая цена тикера с MOEX ISS: сначала акции (TQBR), затем фонды (TQTF).

    None означает «цену узнать не удалось» — идея сохраняется, но не проверяется.
    TODO(инструменты): ОФЗ, фьючерсы и валютные пары (CNY/RUB) на этих бордах не торгуются,
    для них нужны рынки bonds/forts/currency — отдельная доработка.
    """
    symbol = str(ticker or "").strip().upper()
    if not symbol:
        return None

    for board in config.MOEX_TICKER_BOARDS:
        url = config.MOEX_ISS_SHARES_URL.format(board=board, ticker=symbol) + "?iss.meta=off"
        try:
            payload = json.loads(_decode(_http_get(url)))
        except FetchError as exc:
            logger.warning("MOEX ISS: цена %s недоступна (%s)", symbol, exc)
            return None
        except ValueError:
            logger.warning("MOEX ISS: ответ по %s не является JSON", symbol)
            return None

        row = _first_row(payload.get("marketdata"))
        price = _to_float(row.get("LAST"))
        if price is None:
            price = _to_float(row.get("LCURRENTPRICE"))
        if price is None:
            price = _to_float(row.get("MARKETPRICE"))
        if price is not None:
            logger.info("MOEX ISS: цена %s (%s) = %s", symbol, board, price)
            return price

    logger.warning("MOEX ISS: цена %s не найдена на бордах %s", symbol, config.MOEX_TICKER_BOARDS)
    return None


_TICKER_TOKEN_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")


def extract_ticker(instrument: str | None) -> str | None:
    """Достаёт тикер MOEX из названия инструмента от модели.

    «SBER» → SBER, «GAZP (ао)» → GAZP, «ОФЗ 26238» → None, «CNY/RUB» → None
    (ОФЗ и валютные пары проверяются другим рынком, см. TODO в fetch_ticker_price).
    """
    text = str(instrument or "").strip().upper()
    if not text or "/" in text:
        return None
    token = re.split(r"[\s,;:()\[\]]+", text)[0].strip(".,!?—-+")
    return token if _TICKER_TOKEN_RE.match(token) else None


def parse_key_rate_xml(text: str) -> float | None:
    """Ключевая ставка из XML ЦБ РФ.

    Ожидаемая схема (https://www.cbr.ru/scripts/XML_key_rate.asp):
        <ValCurs ...><Record Date="15.10.2026" Rate="14.00"/>...</ValCurs>
    Парсер терпим к двум вариантам записи значения: атрибуты Date/Rate и вложенные
    узлы <Date>/<Rate>, и берёт запись с самой свежей датой.

    TODO(ставка): проверено 15.10.2026 — XML_key_rate.asp отдаёт HTML-страницу вместо XML,
    поэтому рабочей остаётся HTML-таблица (parse_key_rate_html). Код XML-ветки сохранён:
    как только ЦБ вернёт XML, ставка снова пойдёт из него без правок.
    """
    try:
        root = ET.fromstring(text.strip())
    except ET.ParseError:
        logger.warning("Ключевая ставка: XML не разобран (ответ не XML)")
        return None

    dated: list[tuple[datetime, float]] = []
    undated: list[float] = []
    for element in root.iter():
        rate = _to_float(element.get("Rate"))
        if rate is None:
            rate = _to_float(element.findtext("Rate"))
        if rate is None:
            continue
        date = _parse_cbr_date(element.get("Date") or element.findtext("Date"))
        if date is None:
            undated.append(rate)
        else:
            dated.append((date, rate))

    if dated:
        return max(dated, key=lambda pair: pair[0])[1]
    return undated[-1] if undated else None


_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
_CELL_RE = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.DOTALL | re.IGNORECASE)
_TAG_CLEAN_RE = re.compile(r"<[^>]+>")
_SPACES_RE = re.compile(r"\s+")


def parse_key_rate_html(text: str) -> float | None:
    """Ключевая ставка из HTML-таблицы https://www.cbr.ru/hd_base/KeyRate/.

    Фактическая структура строки: <tr><td>15.10.2026</td><td>14,00</td></tr>,
    первая строка таблицы — текущая ставка.
    """
    for row_html in _ROW_RE.findall(text):
        cells: list[str] = []
        for cell in _CELL_RE.findall(row_html):
            clean = _TAG_CLEAN_RE.sub(" ", cell).replace("&nbsp;", " ")
            cells.append(_SPACES_RE.sub(" ", clean).strip())
        if len(cells) < 2 or not _DATE_RE.fullmatch(cells[0]):
            continue
        rate = _to_float(cells[1])
        if rate is not None:
            return rate
    return None


def fetch_key_rate() -> tuple[float | None, str]:
    """Ключевая ставка ЦБ РФ: сначала XML-эндпоинт, затем HTML-таблица.

    Возвращает (ставка, имя сработавшего источника) — ("xml" | "html" | "").
    """
    sources = (
        ("xml", config.CBR_KEY_RATE_URL, parse_key_rate_xml),
        ("html", config.CBR_KEY_RATE_HTML_URL, parse_key_rate_html),
    )
    for source, url, parser in sources:
        try:
            text = _decode(_http_get(url))
        except FetchError as exc:
            logger.warning("Ключевая ставка (%s): источник недоступен (%s)", source, exc)
            continue
        rate = parser(text)
        if rate is None:
            logger.warning("Ключевая ставка (%s): ответ не разобран (%s)", source, url)
            continue
        logger.info("Ключевая ставка: %s%% (источник %s)", rate, source)
        return rate, source
    return None, ""


# ---------------------------------------------------------------------------
# Снимок рынка: живой опрос → SQLite → config fallback
# ---------------------------------------------------------------------------
@dataclass
class LiveQuotes:
    """Результат опроса источников; ошибки не бросаются наружу, а собираются здесь."""

    rates: dict[str, float] | None = None
    rates_error: str | None = None
    moex: dict[str, float] | None = None
    moex_error: str | None = None
    key_rate: float | None = None
    key_rate_source: str | None = None
    key_rate_error: str | None = None


@dataclass
class MarketSnapshot:
    """Снимок рыночного контекста: значения + откуда они взяты."""

    captured_at: datetime
    usdrub: float | None = None
    cnyrub: float | None = None
    eurrub: float | None = None
    moex_value: float | None = None
    moex_change: float | None = None
    key_rate: float | None = None
    source_status: dict[str, str] = field(default_factory=dict)
    stale_values: list[str] = field(default_factory=list)      # взято из SQLite (источник упал)
    fallback_values: list[str] = field(default_factory=list)   # взято из config.py

    def value(self, key: str) -> float:
        """Значение по ключу с подстановкой fallback из config.py."""
        return self.as_prompt_dict()[key]

    def as_prompt_dict(self) -> dict[str, float]:
        """Числа для промпта и payload: None всегда заменяется fallback'ом."""
        return {
            "key_rate": config.KEY_RATE if self.key_rate is None else self.key_rate,
            "moex_value": config.MOEX_VALUE if self.moex_value is None else self.moex_value,
            "moex_change": config.MOEX_CHANGE if self.moex_change is None else self.moex_change,
            "usdrub": config.USDRUB if self.usdrub is None else self.usdrub,
            "cnyrub": config.CNYRUB if self.cnyrub is None else self.cnyrub,
            "eurrub": config.EURRUB if self.eurrub is None else self.eurrub,
        }

    def as_row(self) -> dict[str, Any]:
        """Строка для market_snapshots и JSON в runs.market_snapshot."""
        values = self.as_prompt_dict()
        return {
            "captured_at": db.iso_seconds(self.captured_at),
            "usdrub": values["usdrub"],
            "cnyrub": values["cnyrub"],
            "eurrub": values["eurrub"],
            "moex_value": values["moex_value"],
            "moex_change_pct": values["moex_change"],
            "key_rate": values["key_rate"],
            "source_status": self.source_status,
            "stale_values": self.stale_values,
            "fallback_values": self.fallback_values,
        }

    def log_line(self) -> str:
        """Строка для лога: значения и статусы источников."""
        values = self.as_prompt_dict()
        return (
            f"IMOEX={values['moex_value']} ({values['moex_change']}%), "
            f"USD/RUB={values['usdrub']}, CNY/RUB={values['cnyrub']}, EUR/RUB={values['eurrub']}, "
            f"ставка={values['key_rate']}% | источники: {self.source_status}"
        )


def fetch_live_quotes() -> LiveQuotes:
    """Опрашивает все источники, гася ошибки: прогон не должен падать из-за котировок."""
    live = LiveQuotes()

    try:
        live.rates = fetch_cbr_rates()
    except FetchError as exc:
        live.rates_error = str(exc)
        logger.warning("ЦБ РФ: курсы валют недоступны (%s)", exc)
    except Exception as exc:  # noqa: BLE001 — котировки не роняют job
        live.rates_error = "unknown_error"
        logger.exception("ЦБ РФ: непредвиденная ошибка при получении курсов: %s", exc)

    try:
        live.moex = fetch_moex_index()
    except FetchError as exc:
        live.moex_error = str(exc)
        logger.warning("MOEX ISS: индекс недоступен (%s)", exc)
    except Exception as exc:  # noqa: BLE001
        live.moex_error = "unknown_error"
        logger.exception("MOEX ISS: непредвиденная ошибка при получении индекса: %s", exc)

    try:
        live.key_rate, live.key_rate_source = fetch_key_rate()
    except Exception as exc:  # noqa: BLE001
        live.key_rate_error = "unknown_error"
        logger.exception("ЦБ РФ: непредвиденная ошибка при получении ключевой ставки: %s", exc)
    if live.key_rate is None and live.key_rate_error is None:
        live.key_rate_error = "unavailable"

    return live


# Пары «поле снимка → колонка market_snapshots»
RATES_FIELDS = (("usdrub", "usdrub"), ("cnyrub", "cnyrub"), ("eurrub", "eurrub"))
INDEX_FIELDS = (("moex_value", "moex_value"), ("moex_change", "moex_change_pct"))


def _last_snapshot_row() -> dict[str, Any] | None:
    """Последний снимок из SQLite (или None, если база пуста/недоступна)."""
    try:
        return db.get_last_market_snapshot()
    except sqlite3.Error as exc:
        logger.warning("SQLite: не удалось прочитать market_snapshots (%s)", exc)
        return None


def _fill_from_previous(snapshot: MarketSnapshot, previous: dict[str, Any] | None) -> None:
    """Добивает пустые значения последним снимком из SQLite (Часть 1, п. 2)."""
    if not previous:
        return
    for attr, column in RATES_FIELDS + INDEX_FIELDS:
        if getattr(snapshot, attr) is not None:
            continue
        value = _to_float(previous.get(column))
        if value is None:
            continue
        setattr(snapshot, attr, value)
        snapshot.stale_values.append(attr)
        logger.warning(
            "Котировки: %s недоступно из API — используем последнее значение из SQLite (%s)",
            attr, value,
        )


def _fill_from_config(snapshot: MarketSnapshot) -> None:
    """Последний рубеж: значения из config.py + WARNING в лог (Часть 1, п. 3)."""
    fallbacks = {
        "usdrub": config.USDRUB,
        "cnyrub": config.CNYRUB,
        "eurrub": config.EURRUB,
        "moex_value": config.MOEX_VALUE,
        "moex_change": config.MOEX_CHANGE,
    }
    for attr, value in fallbacks.items():
        if getattr(snapshot, attr) is not None:
            continue
        setattr(snapshot, attr, float(value))
        snapshot.fallback_values.append(attr)
        logger.warning(
            "Котировки: %s недоступно ни в API, ни в SQLite — fallback config (%s)", attr, value,
        )


def _previous_source_status(previous: dict[str, Any] | None) -> dict[str, str]:
    """source_status прошлого снимка из SQLite (JSON-строка или уже словарь)."""
    if not previous:
        return {}
    raw = previous.get("source_status")
    if isinstance(raw, dict):
        return {str(key): str(value) for key, value in raw.items()}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {}
        if isinstance(parsed, dict):
            return {str(key): str(value) for key, value in parsed.items()}
    return {}


def _resolve_key_rate(
    snapshot: MarketSnapshot,
    previous: dict[str, Any] | None,
    live: LiveQuotes,
) -> None:
    """Ключевая ставка: кэш 24 ч в SQLite → живой запрос → просроченный кэш → config.

    Кэш считается доверенным только если в прошлом снимке ставка пришла из живого
    источника (source_status «ok...»/«cache»), а не была fallback-значением config:
    иначе одна неудачная попытка заморозила бы fallback на сутки.
    """
    previous_status = _previous_source_status(previous).get(SOURCE_KEY_RATE, "")
    cached_value = _to_float(previous.get("key_rate")) if previous else None
    cached_at = db.parse_iso(previous.get("captured_at")) if previous else None
    cache_trusted = previous_status.startswith("ok") or previous_status == "cache"

    if cache_trusted and cached_value is not None and cached_at is not None:
        age_hours = (snapshot.captured_at - cached_at).total_seconds() / 3600
        if age_hours <= config.CBR_KEY_RATE_CACHE_HOURS:
            snapshot.key_rate = cached_value
            snapshot.source_status[SOURCE_KEY_RATE] = "cache"
            logger.info(
                "Ключевая ставка из кэша SQLite: %s%% (обновлено %s, %.1f ч назад)",
                cached_value, cached_at.strftime("%d.%m.%Y %H:%M"), age_hours,
            )
            return

    if live.key_rate is not None:
        snapshot.key_rate = live.key_rate
        snapshot.source_status[SOURCE_KEY_RATE] = (
            f"ok:{live.key_rate_source}" if live.key_rate_source else "ok"
        )
        return

    if cache_trusted and cached_value is not None:
        snapshot.key_rate = cached_value
        snapshot.source_status[SOURCE_KEY_RATE] = "stale_cache"
        snapshot.stale_values.append("key_rate")
        logger.warning(
            "Ключевая ставка: источники недоступны (%s) — берём просроченный кэш из SQLite (%s)",
            live.key_rate_error, cached_value,
        )
        return

    snapshot.key_rate = float(config.KEY_RATE)
    snapshot.fallback_values.append("key_rate")
    snapshot.source_status[SOURCE_KEY_RATE] = f"error:{live.key_rate_error or 'unknown_error'}"
    logger.warning(
        "Ключевая ставка: источники недоступны (%s) и в SQLite нет доверенного значения — "
        "fallback config.KEY_RATE=%s%%",
        live.key_rate_error, snapshot.key_rate,
    )


def _safe_save(snapshot: MarketSnapshot) -> None:
    """Пишет снимок в market_snapshots; ошибка БД не должна ронять анализ."""
    row = snapshot.as_row()
    try:
        db.save_market_snapshot(
            captured_at=snapshot.captured_at,
            usdrub=row["usdrub"],
            cnyrub=row["cnyrub"],
            eurrub=row["eurrub"],
            moex_value=row["moex_value"],
            moex_change_pct=row["moex_change_pct"],
            key_rate=row["key_rate"],
            source_status=snapshot.source_status,
        )
    except sqlite3.Error as exc:
        logger.warning("SQLite: не удалось сохранить снимок рынка (%s)", exc)


def build_snapshot(
    fetch_live: Callable[[], LiveQuotes] | None = None,
    *,
    save: bool = True,
) -> MarketSnapshot:
    """Собирает снимок рынка по цепочке: живой источник → SQLite → config fallback.

    fetch_live подменяется в тестах; по умолчанию — реальный опрос ЦБ РФ и MOEX ISS.
    """
    fetcher = fetch_live or fetch_live_quotes
    snapshot = MarketSnapshot(captured_at=config.now_msk())
    previous = _last_snapshot_row()

    try:
        live = fetcher()
    except Exception as exc:  # noqa: BLE001 — даже неожиданная ошибка фетчера не роняет анализ
        logger.exception("Котировки: непредвиденная ошибка опроса источников: %s", exc)
        live = LiveQuotes(
            rates_error="unknown_error", moex_error="unknown_error", key_rate_error="unknown_error"
        )

    if live.rates:
        snapshot.usdrub = live.rates.get("usdrub")
        snapshot.cnyrub = live.rates.get("cnyrub")
        snapshot.eurrub = live.rates.get("eurrub")
        snapshot.source_status[SOURCE_CBR_RATES] = "ok"
    else:
        snapshot.source_status[SOURCE_CBR_RATES] = f"error:{live.rates_error or 'unknown_error'}"

    if live.moex:
        snapshot.moex_value = live.moex.get("moex_value")
        snapshot.moex_change = live.moex.get("moex_change")
        snapshot.source_status[SOURCE_MOEX_INDEX] = "ok"
    else:
        snapshot.source_status[SOURCE_MOEX_INDEX] = f"error:{live.moex_error or 'unknown_error'}"

    _fill_from_previous(snapshot, previous)
    _resolve_key_rate(snapshot, previous, live)
    _fill_from_config(snapshot)

    if save:
        _safe_save(snapshot)

    logger.info("Снимок рынка: %s", snapshot.log_line())
    if snapshot.fallback_values:
        logger.warning("Котировки: использованы fallback-значения из config: %s", snapshot.fallback_values)
    return snapshot


_cached_snapshot: MarketSnapshot | None = None


def get_snapshot(force: bool = False) -> MarketSnapshot:
    """Снимок рынка с коротким кэшем в памяти процесса (SNAPSHOT_CACHE_TTL_SEC).

    За один прогон анализ обращается к котировкам несколько раз — сеть дёргаем один раз.
    """
    global _cached_snapshot
    if not force and _cached_snapshot is not None:
        if (config.now_msk() - _cached_snapshot.captured_at).total_seconds() < SNAPSHOT_CACHE_TTL_SEC:
            return _cached_snapshot
    _cached_snapshot = build_snapshot()
    return _cached_snapshot


def reset_cache() -> None:
    """Сбрасывает кэш снимка в памяти процесса (нужно тестам и ручным проверкам)."""
    global _cached_snapshot
    _cached_snapshot = None
