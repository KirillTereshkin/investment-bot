"""Tinkoff Invest API: счета и открытые позиции — только чтение (Часть 4).

Жёсткие ограничения:
* вызываются исключительно read-only методы (users.get_accounts, operations.get_portfolio,
  instruments.get_instrument_by) — post_order / cancel_order / sandbox в коде отсутствуют;
* токен только из .env (config.TINKOFF_INVEST_TOKEN), никаких хардкодов;
* библиотека tinkoff-investments импортируется лениво: если её нет или токен не задан,
  бот продолжает работать без блока «По вашим позициям»;
* публичные функции никогда не бросают исключений — наружу отдаётся PortfolioSnapshot
  со статусом (для строки «💼 Tinkoff: ...» в Telegram и для лога).
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

import config
from storage import db

logger = logging.getLogger(__name__)

# Статусы портфеля (идут в текст сообщения и в runs.tinkoff_status)
STATUS_OK = "ok"
STATUS_NO_TOKEN = "no_token"
STATUS_LIBRARY_MISSING = "library_missing"
STATUS_TOKEN_EXPIRED = "token_expired"
STATUS_TIMEOUT = "timeout"
STATUS_ERROR = "error"

# Код ошибки API «токен неактуален»: живёт 3 месяца с последнего использования
TOKEN_EXPIRED_CODE = "40003"

CACHE_KEY_PORTFOLIO = "tinkoff_portfolio"
CACHE_KEY_FIGI_MAP = "tinkoff_figi_ticker"

INSTRUMENT_TYPE_TITLES = {
    "share": "акция",
    "currency": "валюта",
    "bond": "облигация",
    "etf": "фонд",
    "futures": "фьючерс",
}

MONEY_SIGNS = {"rub": "₽", "usd": "$", "eur": "€", "cny": "¥"}


class TinkoffUnavailable(Exception):
    """API недоступен (нет токена/библиотеки/сеть) — наружу превращается в статус."""

    def __init__(self, status: str, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def quotation_to_float(value: Any) -> float | None:
    """Quotation/MoneyValue из SDK → float (units + nano / 1e9).

    Отрицательные значения приходят как units < 0 и nano < 0, поэтому обычная
    сумма работает: -1 + (-500 000 000 / 1e9) = -1.5.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    units = getattr(value, "units", None)
    nano = getattr(value, "nano", None)
    if units is None and nano is None:
        return None
    return float(units or 0) + float(nano or 0) / 1_000_000_000


def _fmt_qty(value: float) -> str:
    """100.0 → «100», 12.5 → «12.5»."""
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def _fmt_money(value: float | None, currency: str = "RUB") -> str:
    """45 230 ₽ — разряды через пробел."""
    if value is None:
        return "—"
    sign = MONEY_SIGNS.get(str(currency).lower(), "")
    return f"{value:,.0f}".replace(",", " ") + (f" {sign}" if sign else "")


@dataclass
class Position:
    """Открытая позиция в портфеле."""

    figi: str
    ticker: str
    name: str = ""
    instrument_type: str = ""
    quantity: float = 0.0
    average_price: float | None = None
    current_price: float | None = None
    currency: str = "rub"

    @property
    def pnl_pct(self) -> float | None:
        """Изменение позиции в процентах от средней цены."""
        if not self.average_price or self.current_price is None:
            return None
        return (self.current_price - self.average_price) / self.average_price * 100

    @property
    def value(self) -> float | None:
        """Текущая стоимость позиции."""
        if self.current_price is None:
            return None
        return self.current_price * self.quantity

    @property
    def type_title(self) -> str:
        """Человекочитаемый тип инструмента."""
        return INSTRUMENT_TYPE_TITLES.get(self.instrument_type, self.instrument_type or "инструмент")

    def as_prompt_line(self) -> str:
        """Строка для блока «Мои открытые позиции» в промпте DeepSeek.

        Формат как в ТЗ: «SBER: 100 шт, средняя 285.50 ₽, текущая 292.30 ₽ (+2.4%)».
        """
        line = f"{self.ticker}: {_fmt_qty(self.quantity)} шт"
        if self.average_price is not None:
            line += f", средняя {self.average_price:.2f} ₽"
        if self.current_price is not None:
            line += f", текущая {self.current_price:.2f} ₽"
        pnl = self.pnl_pct
        if pnl is not None:
            line += f" ({pnl:+.1f}%)"
        return line

    def as_telegram_line(self) -> str:
        """Строка для команды /portfolio."""
        line = f"• <b>{self.ticker}</b> — {_fmt_qty(self.quantity)} шт"
        if self.average_price is not None:
            line += f", средняя {self.average_price:.2f} ₽"
        if self.current_price is not None:
            line += f" → {self.current_price:.2f} ₽"
        pnl = self.pnl_pct
        if pnl is not None:
            line += f" ({pnl:+.1f}%)"
        return line


def _plural_positions(count: int) -> str:
    """«1 позиция / 2 позиции / 5 позиций»."""
    if count % 100 in (11, 12, 13, 14):
        return "позиций"
    tail = count % 10
    if tail == 1:
        return "позиция"
    if tail in (2, 3, 4):
        return "позиции"
    return "позиций"


@dataclass
class PortfolioSnapshot:
    """Снимок портфеля: позиции + статус. Исключения не бросает никогда."""

    positions: list[Position] = field(default_factory=list)
    total_value: float | None = None
    account_id: str | None = None
    status: str = STATUS_NO_TOKEN
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == STATUS_OK

    def status_text(self) -> str:
        """Строка статуса для сообщения анализа (формат из Части 4/5)."""
        if self.status == STATUS_OK:
            count = len(self.positions)
            return (
                f"💼 Tinkoff: ok | {count} {_plural_positions(count)}, "
                f"{_fmt_money(self.total_value)}"
            )
        if self.status == STATUS_NO_TOKEN:
            return "💼 Tinkoff: ⏭️ не настроен — TINKOFF_INVEST_TOKEN не задан"
        if self.status == STATUS_LIBRARY_MISSING:
            return "💼 Tinkoff: ⏭️ библиотека не установлена — pip install tinkoff-investments"
        if self.status == STATUS_TOKEN_EXPIRED:
            return "💼 Tinkoff: ❌ токен истёк, обновите TINKOFF_INVEST_TOKEN"
        if self.status == STATUS_TIMEOUT:
            return "💼 Tinkoff: ❌ timeout — прогноз без учёта позиций"
        return f"💼 Tinkoff: ❌ ошибка — {self.error or 'неизвестная'} — прогноз без учёта позиций"

    def prompt_text(self) -> str:
        """Блок «Мои открытые позиции» для промпта. Пусто, если позиций нет."""
        if not self.ok or not self.positions:
            return ""
        lines = ["Мои открытые позиции:"]
        lines.extend(f"- {position.as_prompt_line()}" for position in self.positions)
        if self.total_value is not None:
            lines.append("")
            lines.append(f"Общая стоимость портфеля: {_fmt_money(self.total_value)}")
        return "\n".join(lines)

    def as_cache_payload(self) -> dict[str, Any]:
        """JSON для таблицы cache."""
        return {
            "positions": [asdict(position) for position in self.positions],
            "total_value": self.total_value,
            "account_id": self.account_id,
        }

    @classmethod
    def from_cache_payload(cls, payload: Any) -> "PortfolioSnapshot | None":
        """Восстанавливает снимок из кэша SQLite (None, если данные битые)."""
        if not isinstance(payload, dict):
            return None
        positions: list[Position] = []
        for item in payload.get("positions") or []:
            if not isinstance(item, dict):
                continue
            allowed = {key: item[key] for key in item if key in Position.__dataclass_fields__}
            try:
                positions.append(Position(**allowed))
            except TypeError:
                logger.warning("Tinkoff: некорректная запись в кэше позиций, пропускаем")
        total_value = payload.get("total_value")
        account_id = payload.get("account_id")
        return cls(
            positions=positions,
            total_value=float(total_value) if isinstance(total_value, (int, float)) else None,
            account_id=str(account_id) if account_id else None,
            status=STATUS_OK,
        )


class TinkoffPortfolioClient:
    """Read-only клиент Tinkoff Invest с кэшем позиций и маппинга FIGI→тикер в SQLite."""

    def __init__(self, token: str | None = None) -> None:
        self._token = config.TINKOFF_INVEST_TOKEN if token is None else token

    @property
    def token(self) -> str | None:
        return self._token

    # ------------------------------------------------------------------ SDK
    @staticmethod
    def _load_sdk() -> tuple[Any, Any]:
        """Ленивый импорт SDK → (Client, InstrumentIdType).

        Локального пакета `tinkoff` в проекте нет специально: папка интеграции
        называется broker/, иначе одноимённая папка перекрыла бы библиотеку.
        """
        try:
            from tinkoff.invest import Client, InstrumentIdType
        except ImportError as exc:
            raise TinkoffUnavailable(
                STATUS_LIBRARY_MISSING, f"нет библиотеки tinkoff-investments ({exc})"
            ) from exc
        return Client, InstrumentIdType

    @staticmethod
    def _classify(exc: Exception | None) -> TinkoffUnavailable:
        """Превращает исключение SDK в статус для Telegram и лога."""
        text = str(exc or "")
        code = str(getattr(exc, "code", "") or "")
        lowered = text.lower()
        if TOKEN_EXPIRED_CODE in text or TOKEN_EXPIRED_CODE in code or "token is not active" in lowered:
            return TinkoffUnavailable(STATUS_TOKEN_EXPIRED, "токен истёк (40003)")
        if "timeout" in lowered or "deadline" in lowered or "timed out" in lowered:
            return TinkoffUnavailable(STATUS_TIMEOUT, "timeout")
        return TinkoffUnavailable(STATUS_ERROR, text or type(exc).__name__)

    def _call(self, method: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        """Вызов метода SDK с таймаутом и повторами (config.TINKOFF_RETRIES + 1 попыток).

        timeout передаётся в gRPC-вызов как keyword. Если конкретная версия SDK его
        не принимает (TypeError), вызов повторяется без таймаута — чтобы не терять функцию.
        """
        attempts = config.TINKOFF_RETRIES + 1
        last_exc: Exception | None = None

        for attempt in range(1, attempts + 1):
            try:
                return method(*args, timeout=config.TINKOFF_TIMEOUT_SEC, **kwargs)
            except TypeError as exc:
                logger.warning("Tinkoff SDK не принимает timeout= (%s) — вызываю без таймаута", exc)
                try:
                    return method(*args, **kwargs)
                except Exception as inner:  # noqa: BLE001 — классифицируем ниже
                    last_exc = inner
            except Exception as exc:  # noqa: BLE001 — наружу отдаём статус, а не исключение
                last_exc = exc

            if attempt < attempts:
                logger.warning(
                    "Tinkoff: попытка %s/%s неудачна (%s), повтор через %s сек",
                    attempt, attempts, last_exc, config.TINKOFF_RETRY_DELAY_SEC,
                )
                time.sleep(config.TINKOFF_RETRY_DELAY_SEC)

        raise self._classify(last_exc)

    # ------------------------------------------------------------ портфель
    def get_portfolio_snapshot(self, force: bool = False) -> PortfolioSnapshot:
        """Снимок портфеля. Никогда не бросает исключений — только статус."""
        if not self._token:
            logger.warning("Tinkoff: TINKOFF_INVEST_TOKEN не задан — работаем без позиций")
            return PortfolioSnapshot(status=STATUS_NO_TOKEN)

        if not force:
            cached = self._cached_portfolio()
            if cached is not None:
                return cached

        try:
            snapshot = self._fetch_portfolio()
        except TinkoffUnavailable as exc:
            logger.warning("Tinkoff: %s (%s) — прогноз без учёта позиций", exc.status, exc.reason)
            return PortfolioSnapshot(status=exc.status, error=exc.reason)

        self._save_cache(snapshot)
        return snapshot

    def _cached_portfolio(self) -> PortfolioSnapshot | None:
        """Позиции из кэша SQLite, если запись свежее config.TINKOFF_POSITIONS_CACHE_TTL_SEC."""
        try:
            payload = db.cache_get(CACHE_KEY_PORTFOLIO, ttl_sec=config.TINKOFF_POSITIONS_CACHE_TTL_SEC)
        except sqlite3.Error as exc:
            logger.warning("Tinkoff: кэш позиций недоступен (%s)", exc)
            return None
        snapshot = PortfolioSnapshot.from_cache_payload(payload)
        if snapshot is None:
            return None
        logger.info("Tinkoff: позиции из кэша SQLite (%s шт)", len(snapshot.positions))
        return snapshot

    def _save_cache(self, snapshot: PortfolioSnapshot) -> None:
        """Кэширует успешный снимок позиций (TTL — 5 минут)."""
        try:
            db.cache_set(CACHE_KEY_PORTFOLIO, snapshot.as_cache_payload())
        except sqlite3.Error as exc:
            logger.warning("Tinkoff: не удалось закэшировать позиции (%s)", exc)

    # ----------------------------------------------------------------- API
    def _fetch_portfolio(self) -> PortfolioSnapshot:
        """Запросы к API: счета → портфель → инструменты. Только read-only методы."""
        Client, InstrumentIdType = self._load_sdk()
        positions: list[Position] = []
        account_id = ""
        total_value: float | None = None

        try:
            with Client(self._token) as client:
                account_id = self._select_account(client)
                portfolio = self._call(client.operations.get_portfolio, account_id=account_id)
                for raw in getattr(portfolio, "positions", None) or []:
                    position = self._build_position(client, InstrumentIdType, raw)
                    if position is not None:
                        positions.append(position)

                api_total = getattr(portfolio, "total_portfolio_value", None)
                if api_total is None:
                    api_total = getattr(portfolio, "total_amount_portfolio", None)
                total_value = quotation_to_float(api_total)
        except TinkoffUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 — сеть/grpc/некорректный токен
            raise self._classify(exc) from exc

        if total_value is None:
            values = [position.value for position in positions if position.value is not None]
            total_value = sum(values) if values else None

        logger.info(
            "Tinkoff: портфель получен — счет %s, позиций %s, стоимость %s",
            account_id, len(positions), total_value,
        )
        return PortfolioSnapshot(
            positions=positions,
            total_value=total_value,
            account_id=account_id,
            status=STATUS_OK,
        )

    @staticmethod
    def _select_account(client: Any) -> str:
        """Аккаунт для портфеля: TINKOFF_ACCOUNT_ID или первый брокерский (Часть 4)."""
        response = client.users.get_accounts(timeout=config.TINKOFF_TIMEOUT_SEC)
        accounts = getattr(response, "accounts", None) or []
        if not accounts:
            raise TinkoffUnavailable(STATUS_ERROR, "нет доступных счетов")

        if config.TINKOFF_ACCOUNT_ID:
            for account in accounts:
                if str(getattr(account, "id", "")) == str(config.TINKOFF_ACCOUNT_ID):
                    return str(account.id)
            logger.warning(
                "Tinkoff: TINKOFF_ACCOUNT_ID=%s не найден — берём первый брокерский",
                config.TINKOFF_ACCOUNT_ID,
            )

        # Тип «TINKOFF» — в новых версиях SDK, FULL access — в старых
        for account in accounts:
            if "TINKOFF" in str(getattr(account, "type", "")).upper():
                return str(account.id)
        for account in accounts:
            if "FULL" in str(getattr(account, "access_level", "")).upper():
                return str(account.id)
        return str(accounts[0].id)

    def _build_position(self, client: Any, instrument_id_type: Any, raw: Any) -> Position | None:
        """Позиция API → Position (тикер подтягивается по FIGI, маппинг кэшируется)."""
        instrument_type = str(getattr(raw, "instrument_type", "") or "")
        figi = str(getattr(raw, "figi", "") or "")
        instrument_uid = str(getattr(raw, "instrument_uid", "") or "")

        ticker, name = self._resolve_ticker(
            client, instrument_id_type, figi=figi, uid=instrument_uid
        )
        if not ticker:
            logger.warning(
                "Tinkoff: не удалось определить тикер (figi=%s, uid=%s, тип=%s) — позиция пропущена",
                figi or "—", instrument_uid or "—", instrument_type or "—",
            )
            return None

        average = getattr(raw, "average_position_price", None)
        currency = str(getattr(average, "currency", "") or "rub").lower()

        return Position(
            figi=figi or instrument_uid,
            ticker=ticker,
            name=name,
            instrument_type=instrument_type,
            quantity=quotation_to_float(getattr(raw, "quantity", None)) or 0.0,
            average_price=quotation_to_float(average),
            current_price=quotation_to_float(getattr(raw, "current_price", None)),
            currency=currency,
        )

    def _resolve_ticker(
        self,
        client: Any,
        instrument_id_type: Any,
        *,
        figi: str,
        uid: str,
    ) -> tuple[str, str]:
        """Тикер и название инструмента по FIGI/UID. Маппинг кэшируется в SQLite."""
        key = figi or uid
        if not key:
            return "", ""

        mapping = self._figi_map()
        cached = mapping.get(key)
        if isinstance(cached, dict) and cached.get("ticker"):
            return str(cached["ticker"]), str(cached.get("name") or "")

        id_type = (
            instrument_id_type.INSTRUMENT_ID_TYPE_FIGI
            if figi
            else instrument_id_type.INSTRUMENT_ID_TYPE_UID
        )
        response = self._call(client.instruments.get_instrument_by, id_type=id_type, id=key)
        instrument = getattr(response, "instrument", None)
        ticker = str(getattr(instrument, "ticker", "") or "")
        name = str(getattr(instrument, "name", "") or "")
        if not ticker:
            return "", ""

        mapping[key] = {"ticker": ticker, "name": name}
        try:
            db.cache_set(CACHE_KEY_FIGI_MAP, mapping)
        except sqlite3.Error as exc:
            logger.warning("Tinkoff: не удалось закэшировать FIGI→тикер (%s)", exc)
        return ticker, name

    @staticmethod
    def _figi_map() -> dict[str, Any]:
        """Кэш FIGI→тикер из SQLite (пустой словарь, если кэша нет)."""
        try:
            cached = db.cache_get(CACHE_KEY_FIGI_MAP, ttl_sec=config.TINKOFF_FIGI_CACHE_TTL_SEC)
        except sqlite3.Error as exc:
            logger.warning("Tinkoff: кэш FIGI недоступен (%s)", exc)
            return {}
        return cached if isinstance(cached, dict) else {}


_client: TinkoffPortfolioClient | None = None


def get_client() -> TinkoffPortfolioClient:
    """Единый клиент на процесс (пересоздаётся при смене токена в config)."""
    global _client
    if _client is None or _client.token != config.TINKOFF_INVEST_TOKEN:
        _client = TinkoffPortfolioClient()
    return _client


def get_portfolio_snapshot(force: bool = False) -> PortfolioSnapshot:
    """Снимок портфеля для планировщика и команды /portfolio (синхронно)."""
    return get_client().get_portfolio_snapshot(force=force)


def reset_client() -> None:
    """Сбрасывает singleton клиента (тесты, смена токена)."""
    global _client
    _client = None
