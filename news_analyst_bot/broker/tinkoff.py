"""Tinkoff Invest API: счета и открытые позиции — только чтение (Часть 4).

Жёсткие ограничения:
* вызываются исключительно read-only методы (UsersService/GetAccounts,
  OperationsService/GetPortfolio, InstrumentsService/GetInstrumentBy) —
  post_order / cancel_order / sandbox в коде отсутствуют;
* токен только из .env (config.TINKOFF_INVEST_TOKEN), никаких хардкодов;
* по умолчанию работа идёт через REST T-Invest API обычным requests: PyPI-пакет
  tinkoff-investments удалён, поэтому дополнительных библиотек не требуется;
  gRPC-SDK остаётся опциональным (TINKOFF_TRANSPORT=sdk, если он у вас стоит);
* нет токена / API недоступен / сеть отвалилась — бот продолжает работать без
  блока «По вашим позициям»;
* публичные функции никогда не бросают исключений — наружу отдаётся PortfolioSnapshot
  со статусом (для строки «💼 Tinkoff: ...» в Telegram и для лога).
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Protocol

import requests

import config
from storage import db

logger = logging.getLogger(__name__)

# Статусы портфеля (идут в текст сообщения и в runs.tinkoff_status)
STATUS_OK = "ok"
STATUS_NO_TOKEN = "no_token"
STATUS_LIBRARY_MISSING = "library_missing"
STATUS_TOKEN_EXPIRED = "token_expired"
STATUS_TIMEOUT = "timeout"
STATUS_RATE_LIMITED = "rate_limited"
STATUS_ERROR = "error"

# Код ошибки API «токен неактуален»: живёт 3 месяца с последнего использования
TOKEN_EXPIRED_CODE = "40003"

# HTTP-коды REST, при которых запрос имеет смысл повторить
RETRYABLE_HTTP_CODES = frozenset({429, 500, 502, 503, 504})

CACHE_KEY_PORTFOLIO = "tinkoff_portfolio"
CACHE_KEY_FIGI_MAP = "tinkoff_figi_ticker"

# REST-метод: POST {host}/rest/tinkoff.public.invest.api.contract.v1.<Service>/<Method>
REST_API_PREFIX = "/rest/tinkoff.public.invest.api.contract.v1."
REST_USERS_SERVICE = "UsersService"
REST_OPERATIONS_SERVICE = "OperationsService"
REST_INSTRUMENTS_SERVICE = "InstrumentsService"
REST_ID_TYPE_FIGI = "INSTRUMENT_ID_TYPE_FIGI"
REST_ID_TYPE_UID = "INSTRUMENT_ID_TYPE_UID"

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


# ---------------------------------------------------------------------------
# Разбор ответов API (работает и с объектами SDK, и со словарями REST)
# ---------------------------------------------------------------------------
def _field(source: Any, *names: str, default: Any = None) -> Any:
    """Поле из dict (REST: camelCase или snake_case) либо из объекта (SDK).

    Имена перебираются по порядку — один и тот же код читает ответы gRPC-gateway
    (`totalPortfolioValue`) и объекты SDK (`total_portfolio_value`).
    """
    if source is None:
        return default
    for name in names:
        if isinstance(source, dict):
            if source.get(name) is not None:
                return source[name]
        else:
            value = getattr(source, name, None)
            if value is not None:
                return value
    return default


def _safe_float(value: Any) -> float | None:
    """float из числа или строки («100» — так int64 приходит в proto3-JSON)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def quotation_to_float(value: Any) -> float | None:
    """Quotation/MoneyValue (объект SDK или dict REST) → float (units + nano / 1e9).

    Отрицательные значения приходят как units < 0 и nano < 0, поэтому обычная
    сумма работает: -1 + (-500 000 000 / 1e9) = -1.5.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return _safe_float(value)
    units = _field(value, "units")
    nano = _field(value, "nano")
    if units is None and nano is None:
        return None
    return (_safe_float(units) or 0.0) + (_safe_float(nano) or 0.0) / 1_000_000_000


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
            return (
                "💼 Tinkoff: ⏭️ SDK не установлен — он нужен только для "
                "TINKOFF_TRANSPORT=sdk (по умолчанию работает REST)"
            )
        if self.status == STATUS_TOKEN_EXPIRED:
            return "💼 Tinkoff: ❌ токен истёк, обновите TINKOFF_INVEST_TOKEN"
        if self.status == STATUS_TIMEOUT:
            return "💼 Tinkoff: ❌ timeout — прогноз без учёта позиций"
        if self.status == STATUS_RATE_LIMITED:
            return "💼 Tinkoff: ⏳ лимит запросов к API (429) — прогноз без учёта позиций"
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


# ---------------------------------------------------------------------------
# Счета
# ---------------------------------------------------------------------------
@dataclass
class AccountInfo:
    """Счёт клиента (UsersService/GetAccounts)."""

    id: str
    type: str = ""
    name: str = ""
    status: str = ""
    access_level: str = ""


def parse_account(raw: Any) -> AccountInfo | None:
    """Ответ API → AccountInfo (None, если в записи нет идентификатора)."""
    account_id = str(_field(raw, "id", default="") or "")
    if not account_id:
        return None
    return AccountInfo(
        id=account_id,
        type=str(_field(raw, "type", default="") or ""),
        name=str(_field(raw, "name", default="") or ""),
        status=str(_field(raw, "status", default="") or ""),
        access_level=str(_field(raw, "accessLevel", "access_level", default="") or ""),
    )


def pick_account(accounts: list[AccountInfo], preferred: str | None = None) -> AccountInfo:
    """Аккаунт для портфеля: TINKOFF_ACCOUNT_ID → первый брокерский → первый открытый (Часть 4)."""
    if not accounts:
        raise TinkoffUnavailable(STATUS_ERROR, "нет доступных счетов")

    if preferred:
        for account in accounts:
            if account.id == str(preferred):
                return account
        logger.warning(
            "Tinkoff: TINKOFF_ACCOUNT_ID=%s не найден — берём первый брокерский", preferred
        )

    opened = [account for account in accounts if "OPEN" in account.status.upper()] or accounts
    # Тип «TINKOFF» — в новых версиях API/SDK, FULL access — в старых
    for account in opened:
        if account.type.upper() == "ACCOUNT_TYPE_TINKOFF":
            return account
    for account in opened:
        if "TINKOFF" in account.type.upper():
            return account
    for account in opened:
        if "FULL" in account.access_level.upper():
            return account
    return opened[0]


class TinkoffTransport(Protocol):
    """Минимальный read-only интерфейс API, который нужен боту."""

    name: str

    def __enter__(self) -> "TinkoffTransport":
        """Открывает соединение (REST — ничего, SDK — gRPC-канал)."""

    def __exit__(self, *exc_info: Any) -> bool:
        """Закрывает соединение."""

    def accounts(self) -> list[Any]:
        """Счета клиента (UsersService/GetAccounts)."""

    def portfolio(self, account_id: str) -> Any:
        """Портфель по счёту (OperationsService/GetPortfolio)."""

    def instrument(self, *, figi: str, uid: str) -> Any:
        """Инструмент по FIGI/UID (InstrumentsService/GetInstrumentBy)."""

    def close(self) -> None:
        """Освобождает ресурсы транспорта."""


# ---------------------------------------------------------------------------
# Транспорт 1 (по умолчанию): REST T-Invest API — нужен только requests
# ---------------------------------------------------------------------------
class RestTransport:
    """REST T-Invest API (gRPC-gateway) поверх requests — без дополнительных библиотек.

    Эндпоинты `POST {host}/rest/tinkoff.public.invest.api.contract.v1.<Service>/<Method>`
    живы на обоих контурах (invest-public-api.tbank.ru и invest-public-api.tinkoff.ru):
    на неверный токен отвечают `401 {"code":16,"description":"40003"}`.
    Ответы — proto3-JSON: int64 (`units`) приходят строками, имена полей camelCase,
    на вход принимаются и snake_case.
    """

    name = "rest"

    def __init__(self, token: str, base_urls: Any = None, session: Any = None) -> None:
        self._token = token
        urls = [base_urls] if isinstance(base_urls, str) else (base_urls or config.TINKOFF_API_BASE_URLS)
        self._base_urls = [str(url).rstrip("/") for url in urls if url]
        self._session = session
        self._owns_session = session is None

    # ------------------------------------------------------------ HTTP-сессия
    def _http(self) -> Any:
        """requests.Session, создаётся один раз; внедрённую снаружи (тесты) не трогаем."""
        if self._session is None:
            session = requests.Session()
            session.headers.update({"User-Agent": config.HTTP_USER_AGENT})
            self._session = session
            self._owns_session = True
        return self._session

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _call(self, service: str, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        """POST read-only метода: таймаут, повторы, переключение на резервный хост."""
        attempts = config.TINKOFF_RETRIES + 1
        last_status = STATUS_ERROR
        last_reason = ""

        for attempt in range(1, attempts + 1):
            for base in list(self._base_urls):
                url = f"{base}{REST_API_PREFIX}{service}/{method}"
                try:
                    response = self._http().post(
                        url,
                        json=payload,
                        headers=self._headers(),
                        timeout=config.TINKOFF_TIMEOUT_SEC,
                    )
                except requests.exceptions.Timeout as exc:
                    last_status, last_reason = STATUS_TIMEOUT, f"timeout: {exc}"
                    logger.warning("Tinkoff REST: %s — %s", method, last_reason)
                    continue
                except requests.exceptions.RequestException as exc:
                    last_status, last_reason = STATUS_ERROR, f"{base}: {exc}"
                    logger.warning(
                        "Tinkoff REST: хост %s недоступен (%s) — пробую резервный", base, exc
                    )
                    self._demote(base)
                    continue

                if response.status_code == 200:
                    return self._decode(response)

                error = self._http_error(response)
                if response.status_code not in RETRYABLE_HTTP_CODES:
                    raise error            # 400/401/403/404 — повторять бессмысленно
                # Последняя ошибка запоминается вместе со статусом: после исчерпания
                # повторов наружу уходит именно она (429 → rate_limited, 5xx → error)
                last_status, last_reason = error.status, error.reason
                logger.warning(
                    "Tinkoff REST: %s — HTTP %s: %s", method, response.status_code, error.reason
                )

            if attempt < attempts:
                logger.warning(
                    "Tinkoff REST: попытка %s/%s неудачна (%s), повтор через %s сек",
                    attempt, attempts, last_reason, config.TINKOFF_RETRY_DELAY_SEC,
                )
                time.sleep(config.TINKOFF_RETRY_DELAY_SEC)

        raise TinkoffUnavailable(last_status, last_reason or "неизвестная ошибка REST API")

    @staticmethod
    def _decode(response: Any) -> dict[str, Any]:
        """Тело ответа → dict (некорректный JSON превращается в понятный статус)."""
        try:
            data = response.json()
        except ValueError as exc:
            raise TinkoffUnavailable(STATUS_ERROR, f"некорректный JSON от API: {exc}") from exc
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _http_error(response: Any) -> TinkoffUnavailable:
        """HTTP-ошибка REST → статус: 401/403/40003 — токен, 429 — лимит, 5xx — сбой сервиса."""
        description = ""
        message = ""
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            description = str(body.get("description") or body.get("code") or "")
            message = str(body.get("message") or "")
        if not message:
            message = (getattr(response, "text", "") or "")[:200]

        lowered = message.lower()
        if response.status_code == 429 or "resource_exhausted" in lowered:
            return TinkoffUnavailable(STATUS_RATE_LIMITED, "слишком много запросов к API (429)")
        if TOKEN_EXPIRED_CODE in (description, message) or "token is not active" in lowered:
            return TinkoffUnavailable(STATUS_TOKEN_EXPIRED, "токен истёк (40003)")
        if response.status_code in (401, 403):
            return TinkoffUnavailable(
                STATUS_TOKEN_EXPIRED, f"токен не принят: {message or response.status_code}"
            )
        if response.status_code >= 500:
            return TinkoffUnavailable(STATUS_ERROR, f"HTTP {response.status_code} — сервис недоступен")
        return TinkoffUnavailable(
            STATUS_ERROR, f"HTTP {response.status_code}: {message or description or 'ошибка API'}"
        )

    def _demote(self, base: str) -> None:
        """Сбойный хост — в конец списка, чтобы следующий запрос ушёл на резервный."""
        if base in self._base_urls and len(self._base_urls) > 1:
            self._base_urls.remove(base)
            self._base_urls.append(base)

    # --------------------------------------------------------------- read-only
    def accounts(self) -> list[Any]:
        """UsersService/GetAccounts — список счетов клиента."""
        response = self._call(REST_USERS_SERVICE, "GetAccounts", {})
        return list(_field(response, "accounts", default=[]) or [])

    def portfolio(self, account_id: str) -> dict[str, Any]:
        """OperationsService/GetPortfolio — позиции по счёту в рублях."""
        return self._call(
            REST_OPERATIONS_SERVICE, "GetPortfolio", {"accountId": account_id, "currency": "RUB"}
        )

    def instrument(self, *, figi: str, uid: str) -> dict[str, Any]:
        """InstrumentsService/GetInstrumentBy — тикер и название по FIGI/UID."""
        response = self._call(
            REST_INSTRUMENTS_SERVICE,
            "GetInstrumentBy",
            {"idType": REST_ID_TYPE_FIGI if figi else REST_ID_TYPE_UID, "id": figi or uid},
        )
        return _field(response, "instrument", default={}) or {}

    # ---------------------------------------------------------------- контекст
    def __enter__(self) -> "RestTransport":
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        self.close()
        return False

    def close(self) -> None:
        """Закрывает только собственную HTTP-сессию (внедрённую из тестов — не трогает)."""
        if self._session is not None and self._owns_session:
            self._session.close()
            self._session = None


def classify_error(exc: Exception | None) -> TinkoffUnavailable:
    """Исключение SDK/сети → статус для Telegram и лога."""
    text = str(exc or "")
    code = str(getattr(exc, "code", "") or "")
    lowered = text.lower()
    if TOKEN_EXPIRED_CODE in text or TOKEN_EXPIRED_CODE in code or "token is not active" in lowered:
        return TinkoffUnavailable(STATUS_TOKEN_EXPIRED, "токен истёк (40003)")
    if "timeout" in lowered or "deadline" in lowered or "timed out" in lowered:
        return TinkoffUnavailable(STATUS_TIMEOUT, "timeout")
    if "unauthenticated" in lowered or "permission denied" in lowered:
        return TinkoffUnavailable(STATUS_TOKEN_EXPIRED, text or "токен не принят")
    if "resource exhausted" in lowered:
        return TinkoffUnavailable(STATUS_RATE_LIMITED, "слишком много запросов к API")
    return TinkoffUnavailable(STATUS_ERROR, text or type(exc).__name__)


# ---------------------------------------------------------------------------
# Транспорт 2 (опция): gRPC-SDK tinkoff-investments, если он установлен вручную
# ---------------------------------------------------------------------------
class SdkTransport:
    """Опциональный транспорт через официальный SDK.

    PyPI-пакет `tinkoff-investments` удалён, поэтому SDK нет в requirements: режим
    TINKOFF_TRANSPORT=sdk нужен тем, у кого библиотека уже установлена, например
    `pip install git+https://github.com/RussianInvestments/invest-python.git`.
    """

    name = "sdk"

    def __init__(self, token: str) -> None:
        self._token = token
        self._client: Any = None
        self._instrument_id_type: Any = None

    # ------------------------------------------------------------ подключение
    @staticmethod
    def load_sdk() -> tuple[Any, Any]:
        """Ленивый импорт SDK → (Client, InstrumentIdType).

        Локального пакета `tinkoff` в проекте нет специально: папка интеграции
        называется broker/, иначе одноимённая папка перекрывала бы библиотеку.
        """
        try:
            from tinkoff.invest import Client, InstrumentIdType
        except ImportError as exc:
            raise TinkoffUnavailable(
                STATUS_LIBRARY_MISSING, f"нет библиотеки tinkoff-investments ({exc})"
            ) from exc
        return Client, InstrumentIdType

    def __enter__(self) -> "SdkTransport":
        client_cls, instrument_id_type = self.load_sdk()
        self._instrument_id_type = instrument_id_type
        client = client_cls(self._token)
        if hasattr(client, "__enter__"):
            client.__enter__()
        self._client = client
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        self.close()
        return False

    def close(self) -> None:
        """Закрывает gRPC-канал SDK."""
        client, self._client = self._client, None
        if client is not None and hasattr(client, "__exit__"):
            try:
                client.__exit__(None, None, None)
            except Exception:  # noqa: BLE001 — закрытие канала не критично
                logger.debug("Tinkoff SDK: ошибка при закрытии клиента", exc_info=True)

    def _api(self) -> Any:
        """Открытый SDK-клиент (иначе — понятный статус вместо AttributeError)."""
        if self._client is None:
            raise TinkoffUnavailable(STATUS_ERROR, "SDK-клиент не инициализирован")
        return self._client


    # --------------------------------------------------------- вызовы методов
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

        raise classify_error(last_exc)

    # --------------------------------------------------------------- read-only
    def accounts(self) -> list[Any]:
        """users.get_accounts — список счетов клиента."""
        response = self._call(self._api().users.get_accounts)
        return list(getattr(response, "accounts", None) or [])

    def portfolio(self, account_id: str) -> Any:
        """operations.get_portfolio — позиции по счёту."""
        return self._call(self._api().operations.get_portfolio, account_id=account_id)

    def instrument(self, *, figi: str, uid: str) -> Any:
        """instruments.get_instrument_by — тикер и название по FIGI/UID."""
        id_type = (
            self._instrument_id_type.INSTRUMENT_ID_TYPE_FIGI
            if figi
            else self._instrument_id_type.INSTRUMENT_ID_TYPE_UID
        )
        response = self._call(
            self._api().instruments.get_instrument_by, id_type=id_type, id=figi or uid
        )
        return getattr(response, "instrument", None)


# ---------------------------------------------------------------------------
# Клиент: транспорт + кэш в SQLite + статусы
# ---------------------------------------------------------------------------
def build_transport(token: str) -> Any:
    """Транспорт по config.TINKOFF_TRANSPORT: rest (по умолчанию) или sdk."""
    mode = (config.TINKOFF_TRANSPORT or "rest").strip().lower()
    if mode == "sdk":
        return SdkTransport(token)
    if mode != "rest":
        logger.info("Tinkoff: неизвестное значение TINKOFF_TRANSPORT=%r — использую REST", mode)
    return RestTransport(token)


class TinkoffPortfolioClient:
    """Read-only клиент Tinkoff Invest с кэшем позиций и маппинга FIGI→тикер в SQLite."""

    def __init__(self, token: str | None = None, transport: Any = None) -> None:
        self._token = config.TINKOFF_INVEST_TOKEN if token is None else token
        self._transport = transport

    @property
    def token(self) -> str | None:
        return self._token

    @property
    def transport(self) -> Any:
        """Транспорт API (создаётся лениво); имя транспорта идёт в лог."""
        if self._transport is None:
            self._transport = build_transport(self._token or "")
        return self._transport

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
        """Счета → портфель → (при необходимости) инструменты. Только read-only методы."""
        transport = self.transport
        positions: list[Position] = []
        account_id = ""
        total_value: float | None = None

        try:
            with transport:
                parsed = [parse_account(raw) for raw in transport.accounts()]
                account = pick_account(
                    [item for item in parsed if item is not None], config.TINKOFF_ACCOUNT_ID
                )
                account_id = account.id
                portfolio = transport.portfolio(account_id)
                for raw in _field(portfolio, "positions", default=[]) or []:
                    position = self._parse_position(raw, transport)
                    if position is not None:
                        positions.append(position)
                total_value = self._total_value(portfolio, positions)
        except TinkoffUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 — сеть/grpc/некорректный токен
            raise classify_error(exc) from exc

        logger.info(
            "Tinkoff: портфель получен (%s) — счет %s, позиций %s, стоимость %s",
            transport.name, account_id, len(positions), total_value,
        )
        return PortfolioSnapshot(
            positions=positions,
            total_value=total_value,
            account_id=account_id,
            status=STATUS_OK,
        )


    @staticmethod
    def _total_value(portfolio: Any, positions: list[Position]) -> float | None:
        """Стоимость портфеля: total_portfolio_value из API → сумма позиций."""
        api_total = quotation_to_float(
            _field(
                portfolio,
                "totalPortfolioValue",
                "total_portfolio_value",
                "totalAmountPortfolio",
                "total_amount_portfolio",
            )
        )
        if api_total is not None:
            return api_total
        values = [position.value for position in positions if position.value is not None]
        return sum(values) if values else None

    def _parse_position(self, raw: Any, transport: Any) -> Position | None:
        """Позиция API → Position. Тикер берётся из позиции, иначе по FIGI/UID через API."""
        figi = str(_field(raw, "figi", default="") or "")
        instrument_uid = str(_field(raw, "instrumentUid", "instrument_uid", default="") or "")
        if not figi and not instrument_uid:
            logger.warning("Tinkoff: позиция без FIGI и UID — пропущена")
            return None

        instrument_type = str(_field(raw, "instrumentType", "instrument_type", default="") or "")
        quantity = quotation_to_float(_field(raw, "quantity")) or 0.0
        if quantity == 0:
            logger.debug("Tinkoff: нулевая позиция %s — пропущена", figi or instrument_uid)
            return None

        ticker = str(_field(raw, "ticker", default="") or "")
        name = str(_field(raw, "name", default="") or "")
        if ticker:
            self._remember_instrument(figi or instrument_uid, ticker, name)
        else:
            ticker, name = self._resolve_ticker(transport, figi=figi, uid=instrument_uid)
        if not ticker:
            logger.warning(
                "Tinkoff: тикер не определён (figi=%s, uid=%s, тип=%s) — позиция пропущена",
                figi or "—", instrument_uid or "—", instrument_type or "—",
            )
            return None

        average = _field(raw, "averagePositionPrice", "average_position_price")
        currency = str(_field(average, "currency", default="") or "rub").lower()

        return Position(
            figi=figi or instrument_uid,
            ticker=ticker,
            name=name,
            instrument_type=instrument_type,
            quantity=quantity,
            average_price=quotation_to_float(average),
            current_price=quotation_to_float(_field(raw, "currentPrice", "current_price")),
            currency=currency,
        )

    def _resolve_ticker(self, transport: Any, *, figi: str, uid: str) -> tuple[str, str]:
        """Тикер и название инструмента по FIGI/UID; маппинг кэшируется в SQLite.

        В ТЗ описан путь «PortfolioPosition → FIGI → тикер»: у REST-ответа тикер
        чаще уже есть в позиции, но для старых версий/типов инструментов он
        запрашивается отдельно и запоминается на TINKOFF_FIGI_CACHE_TTL_SEC.
        """
        key = figi or uid
        if not key:
            return "", ""
        mapping = self._figi_map()
        cached = mapping.get(key)
        if isinstance(cached, dict) and cached.get("ticker"):
            return str(cached["ticker"]), str(cached.get("name") or "")

        instrument = transport.instrument(figi=figi, uid=uid)
        ticker = str(_field(instrument, "ticker", default="") or "")
        name = str(_field(instrument, "name", default="") or "")
        if not ticker:
            return "", ""
        self._remember_instrument(key, ticker, name)
        return ticker, name


    def _remember_instrument(self, key: str, ticker: str, name: str = "") -> None:
        """Сохраняет FIGI/UID → тикер в кэш SQLite (TTL — TINKOFF_FIGI_CACHE_TTL_SEC)."""
        if not key or not ticker:
            return
        mapping = self._figi_map()
        current = mapping.get(key)
        if (
            isinstance(current, dict)
            and current.get("ticker") == ticker
            and current.get("name") == name
        ):
            return
        mapping[key] = {"ticker": ticker, "name": name}
        try:
            db.cache_set(CACHE_KEY_FIGI_MAP, mapping)
        except sqlite3.Error as exc:
            logger.warning("Tinkoff: не удалось закэшировать FIGI→тикер (%s)", exc)

    @staticmethod
    def _figi_map() -> dict[str, Any]:
        """Кэш FIGI→тикер из SQLite (пустой словарь, если кэша нет или он протух)."""
        try:
            cached = db.cache_get(CACHE_KEY_FIGI_MAP, ttl_sec=config.TINKOFF_FIGI_CACHE_TTL_SEC)
        except sqlite3.Error as exc:
            logger.warning("Tinkoff: кэш FIGI недоступен (%s)", exc)
            return {}
        return cached if isinstance(cached, dict) else {}


# ---------------------------------------------------------------------------
# Публичный API модуля (то, что вызывают scheduler/jobs.py, bot/handlers.py)
# ---------------------------------------------------------------------------
_client: TinkoffPortfolioClient | None = None


def get_client() -> TinkoffPortfolioClient:
    """Единый клиент на процесс (пересоздаётся при смене токена в config)."""
    global _client
    if _client is None or _client.token != config.TINKOFF_INVEST_TOKEN:
        _client = TinkoffPortfolioClient()
    return _client


def reset_client() -> None:
    """Сбрасывает закэшированный клиент (тесты, смена токена в .env)."""
    global _client
    _client = None


def get_portfolio_snapshot(force: bool = False) -> PortfolioSnapshot:
    """Снимок портфеля для планировщика и команды /portfolio. Исключений не бросает."""
    return get_client().get_portfolio_snapshot(force=force)


def get_portfolio() -> PortfolioSnapshot:
    """Имя из ТЗ — полный алиас get_portfolio_snapshot()."""
    return get_portfolio_snapshot()
