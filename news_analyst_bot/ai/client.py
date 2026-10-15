"""Клиент DeepSeek (OpenAI-совместимый API через официальный SDK openai).

Особенности:
* собственный retry (config.DEEPSEEK_RETRIES повторов с задержкой config.DEEPSEEK_RETRY_DELAY_SEC),
  поэтому у SDK отключены внутренние ретраи (max_retries=0);
* наружу никогда не бросает исключения — возвращает DeepSeekResult со статусом.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    RateLimitError,
)

import config
from ai import prompts

logger = logging.getLogger(__name__)


@dataclass
class DeepSeekResult:
    """Результат вызова DeepSeek."""

    status: str                        # "ok" | "error:<reason>"
    parsed: dict[str, Any] | None = None
    raw_response: str | None = None
    tokens: int | None = None
    duration_ms: int | None = None
    error: str | None = None           # короткая причина ошибки
    attempts: int = 0
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def extract_json(text: str) -> dict[str, Any]:
    """Достаёт JSON из ответа модели (в т.ч. если он обёрнут в ```json ... ```)."""
    if not text:
        raise ValueError("пустой ответ модели")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        data = json.loads(cleaned[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("JSON верхнего уровня должен быть объектом")
    return data


def describe_error(exc: Exception) -> str:
    """Короткий машиночитаемый код ошибки для отчёта в Telegram и БД."""
    if isinstance(exc, APITimeoutError):
        return "timeout"
    if isinstance(exc, APIConnectionError):
        return "connection_error"
    if isinstance(exc, AuthenticationError):
        return "auth_error"
    if isinstance(exc, RateLimitError):
        return "rate_limit"
    if isinstance(exc, APIStatusError):
        return f"http_{exc.status_code}"
    if isinstance(exc, (json.JSONDecodeError, ValueError)):
        return "invalid_json"
    return "unknown_error"


class DeepSeekClient:
    """Обёртка над AsyncOpenAI с base_url DeepSeek и ручным retry."""

    def __init__(self) -> None:
        self._client: AsyncOpenAI | None = None

    def _get_client(self) -> AsyncOpenAI:
        if self._client is None:
            self._client = AsyncOpenAI(
                api_key=config.DEEPSEEK_API_KEY,
                base_url=config.DEEPSEEK_BASE_URL,
                timeout=config.DEEPSEEK_TIMEOUT_SEC,
                max_retries=0,  # ретраи делаем сами
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None

    async def _call_api(self, user_prompt: str) -> tuple[str, int | None, int]:
        """Один запрос к API. Возвращает (текст ответа, токены, длительность мс)."""
        client = self._get_client()
        started = time.perf_counter()
        response = await client.chat.completions.create(
            model=config.DEEPSEEK_MODEL,
            messages=[
                {"role": "system", "content": prompts.SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=config.DEEPSEEK_TEMPERATURE,
            max_tokens=config.DEEPSEEK_MAX_TOKENS,
            response_format={"type": "json_object"},
        )
        duration_ms = int((time.perf_counter() - started) * 1000)
        content = response.choices[0].message.content or "" if response.choices else ""
        tokens = None
        if getattr(response, "usage", None) is not None:
            tokens = getattr(response.usage, "total_tokens", None)
        return content, tokens, duration_ms

    async def analyze(
        self,
        *,
        digest: str,
        window_start: str,
        window_end: str,
        key_rate: float,
        moex_value: float,
        moex_change: float,
        usdrub: float,
        cnyrub: float | None = None,
        eurrub: float | None = None,
        portfolio_text: str = "",
    ) -> DeepSeekResult:
        """Отправляет дайджест в DeepSeek и возвращает разобранный прогноз.

        cnyrub/eurrub — дополнительные курсы ЦБ (Часть 1), portfolio_text — блок
        открытых позиций Tinkoff (Часть 4). Оба параметра необязательные.
        """
        if not config.DEEPSEEK_API_KEY:
            logger.error("DEEPSEEK_API_KEY не задан — вызов DeepSeek невозможен")
            return DeepSeekResult(status="error:no_api_key", error="no_api_key")

        user_prompt = prompts.build_user_prompt(
            window_start=window_start,
            window_end=window_end,
            digest=digest,
            key_rate=key_rate,
            moex_value=moex_value,
            moex_change=moex_change,
            usdrub=usdrub,
            cnyrub=cnyrub,
            eurrub=eurrub,
            portfolio_text=portfolio_text,
        )

        attempts = config.DEEPSEEK_RETRIES + 1
        last_error = "unknown_error"
        last_duration: int | None = None
        last_raw: str | None = None
        tokens: int | None = None

        for attempt in range(1, attempts + 1):
            try:
                raw, tokens, last_duration = await self._call_api(user_prompt)
            except Exception as exc:
                last_error = describe_error(exc)
                logger.warning("DeepSeek: попытка %s/%s — ошибка API (%s): %s", attempt, attempts, last_error, exc)
            else:
                last_raw = raw
                try:
                    parsed = extract_json(raw)
                except (json.JSONDecodeError, ValueError) as exc:
                    last_error = "invalid_json"
                    logger.warning("DeepSeek: попытка %s/%s — не удалось разобрать JSON (%s)", attempt, attempts, exc)
                else:
                    logger.info("DeepSeek: ok, попытка %s/%s, токенов %s, %s мс", attempt, attempts, tokens, last_duration)
                    return DeepSeekResult(
                        status="ok",
                        parsed=parsed,
                        raw_response=raw,
                        tokens=tokens,
                        duration_ms=last_duration,
                        attempts=attempt,
                    )

            if attempt < attempts:
                await asyncio.sleep(config.DEEPSEEK_RETRY_DELAY_SEC)

        logger.error("DeepSeek: все %s попыток неуспешны, последняя причина — %s", attempts, last_error)
        return DeepSeekResult(
            status=f"error:{last_error}",
            error=last_error,
            raw_response=last_raw,
            tokens=tokens,
            duration_ms=last_duration,
            attempts=attempts,
        )
