"""Хендлеры Telegram-команд: /start, /now, /last, /stats, /accuracy, /portfolio,
/schedule, /help."""

from __future__ import annotations

import asyncio
import logging

from aiogram import Router
from aiogram.filters import Command, CommandStart
from aiogram.types import Message

from bot import notifier
from scheduler import jobs
from storage import db

logger = logging.getLogger(__name__)

router = Router(name="commands")

HELP_TEXT = "\n".join(
    [
        "<b>Команды:</b>",
        "/start — приветствие и текущее расписание",
        "/now — запустить анализ немедленно, вне расписания",
        "/last — последний прогноз из базы",
        "/stats — статистика за 7 дней",
        "/accuracy — точность прогнозов за 30 дней",
        "/portfolio — текущие позиции Tinkoff (только чтение)",
        "/schedule — расписание и время следующего запуска",
        "/help — этот список",
    ]
)


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    """Приветствие + текущее расписание."""
    logger.info("Команда /start от chat_id=%s", message.chat.id)
    text = "\n".join(
        [
            "🤖 <b>News Analyst Bot</b>",
            "Собираю экономические новости по российскому рынку из шести RSS-источников",
            "и присылаю краткий торговый прогноз от DeepSeek.",
            "",
            notifier.format_schedule(),
            "",
            HELP_TEXT,
        ]
    )
    await message.answer(text, disable_web_page_preview=True)


@router.message(Command("now"))
async def cmd_now(message: Message) -> None:
    """Запуск анализа вне расписания (те же блоки источников и DeepSeek)."""
    logger.info("Команда /now от chat_id=%s", message.chat.id)
    if jobs.is_analysis_running():
        await message.answer("⏳ Анализ уже выполняется, дождитесь готового отчёта.")
        return

    await message.answer("🚀 Запускаю анализ вне расписания. Отчёт придёт отдельным сообщением.")
    result = await jobs.run_analysis(message.bot, trigger="manual")
    if result is None:
        await message.answer("⚠️ Анализ не удался, подробности в bot.log.")


@router.message(Command("last"))
async def cmd_last(message: Message) -> None:
    """Последний прогноз из БД."""
    logger.info("Команда /last от chat_id=%s", message.chat.id)
    run = db.get_last_run()
    await message.answer(notifier.format_last_run(run), disable_web_page_preview=True)


@router.message(Command("stats"))
async def cmd_stats(message: Message) -> None:
    """Статистика за 7 дней."""
    logger.info("Команда /stats от chat_id=%s", message.chat.id)
    stats = db.get_stats(days=7)
    await message.answer(notifier.format_stats(stats), disable_web_page_preview=True)


@router.message(Command("accuracy"))
async def cmd_accuracy(message: Message) -> None:
    """Точность прогнозов за 30 дней (Часть 3)."""
    logger.info("Команда /accuracy от chat_id=%s", message.chat.id)
    stats = await asyncio.to_thread(db.get_prediction_stats)
    await message.answer(notifier.format_accuracy(stats), disable_web_page_preview=True)


@router.message(Command("portfolio"))
async def cmd_portfolio(message: Message) -> None:
    """Снимок позиций Tinkoff без анализа — удобно для проверки API (Часть 4)."""
    logger.info("Команда /portfolio от chat_id=%s", message.chat.id)
    await message.answer("💼 Запрашиваю портфель Tinkoff…", disable_web_page_preview=True)
    # force=True: ручной запрос всегда мимо 5-минутного кэша
    snapshot = await asyncio.to_thread(jobs.get_portfolio_snapshot, True)
    await message.answer(notifier.format_portfolio(snapshot), disable_web_page_preview=True)


@router.message(Command("schedule"))
async def cmd_schedule(message: Message) -> None:
    """Расписание и следующее время запуска."""
    logger.info("Команда /schedule от chat_id=%s", message.chat.id)
    await message.answer(notifier.format_schedule(), disable_web_page_preview=True)


@router.message(Command("help"))
async def cmd_help(message: Message) -> None:
    """Список команд."""
    logger.info("Команда /help от chat_id=%s", message.chat.id)
    await message.answer(HELP_TEXT, disable_web_page_preview=True)


@router.message()
async def cmd_unknown(message: Message) -> None:
    """Любой другой текст — подсказка."""
    await message.answer("Неизвестная команда.\n\n" + HELP_TEXT, disable_web_page_preview=True)
