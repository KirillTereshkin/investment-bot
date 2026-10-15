"""Дедупликация новостей.

Два уровня:
1. Точный — SHA1 от нормализованного заголовка (lowercase + без пунктуации).
2. Нечёткий — Jaccard similarity по множествам слов, порог config.JACCARD_THRESHOLD.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import Any, Iterable

import config

logger = logging.getLogger(__name__)

# Пунктуация и «мусорные» символы (кавычки-ёлочки, тире, многоточия и т.п.)
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WHITESPACE_RE = re.compile(r"\s+", re.UNICODE)


def normalize_title(title: str) -> str:
    """Lowercase, убираем пунктуацию, схлопываем пробелы и «ё» → «е»."""
    if not title:
        return ""
    text = title.lower().replace("ё", "е")
    text = _PUNCT_RE.sub(" ", text)
    return _WHITESPACE_RE.sub(" ", text).strip()


def title_hash(normalized_title: str) -> str:
    """SHA1 от нормализованного заголовка."""
    return hashlib.sha1(normalized_title.encode("utf-8")).hexdigest()


def words(normalized_title: str) -> set[str]:
    """Множество слов заголовка (для Jaccard)."""
    return {word for word in normalized_title.split() if word}


def jaccard_similarity(first: set[str], second: set[str]) -> float:
    """Коэффициент Жаккара для двух множеств слов."""
    if not first or not second:
        return 0.0
    union = first | second
    if not union:
        return 0.0
    return len(first & second) / len(union)


class Deduplicator:
    """Хранит уже принятые заголовки и определяет, является ли новый дубликатом."""

    def __init__(self, threshold: float | None = None) -> None:
        self.threshold = config.JACCARD_THRESHOLD if threshold is None else threshold
        self._hashes: set[str] = set()
        self._token_sets: list[set[str]] = []

    def is_duplicate(self, title: str) -> tuple[bool, str | None]:
        """Возвращает (дубликат?, причина) — 'hash' | 'similarity' | None."""
        normalized = normalize_title(title)
        if not normalized:
            return True, "empty"
        digest = title_hash(normalized)
        if digest in self._hashes:
            return True, "hash"
        tokens = words(normalized)
        for known in self._token_sets:
            if jaccard_similarity(tokens, known) > self.threshold:
                return True, "similarity"
        self._hashes.add(digest)
        self._token_sets.append(tokens)
        return False, None


def deduplicate(items: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Возвращает (уникальные новости, сколько отброшено как дубликаты)."""
    dedup = Deduplicator()
    unique: list[dict[str, Any]] = []
    dropped = 0
    for item in items:
        is_dup, reason = dedup.is_duplicate(str(item.get("title", "")))
        if is_dup:
            dropped += 1
            if dropped <= 10:
                logger.debug("Дубликат (%s): %s", reason, item.get("title"))
            continue
        unique.append(item)
    if dropped:
        logger.info("Дедупликация: %s дубликатов отброшено, осталось %s новостей", dropped, len(unique))
    return unique, dropped
