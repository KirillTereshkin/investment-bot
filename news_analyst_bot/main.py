"""Точка входа проекта: логирование, БД, бот, планировщик.

Запуск: python main.py
"""

from __future__ import annotations

import asyncio
import logging
import sys
from logging.handlers import RotatingFileHandler

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

import config
from bot import notifier
from bot.handlers import router
from scheduler.jobs import next_run_time, schedule_human, setup_scheduler
from storage import db

logger = logging.getLogger("news_analyst_bot")


def setup_logging() -> None:
    """Логи уровня INFO в stdout и в файл bot.log (с ротацией)."""
    formatter = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(config.LOG_LEVEL)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    root.addHandler(stream_handler)

    try:
        file_handler = RotatingFileHandler(
            config.LOG_PATH,
            maxBytes=5_000_000,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError as exc:  # например, нет прав на запись
        root.warning("Не удалось открыть файл лога %s: %s", config.LOG_PATH, exc)

    # Глушим избыточные логи сторонних библиотек
    for noisy in ("aiogram.event", "httpx", "httpcore", "apscheduler.executors.default", "openai._base_client"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def validate_config() -> None:
    """Проверяем, что все секреты заполнены, иначе падаем с понятным текстом."""
    required = {
        "TELEGRAM_BOT_TOKEN": config.TELEGRAM_BOT_TOKEN,
        "TELEGRAM_CHAT_ID": config.TELEGRAM_CHAT_ID,
        "DEEPSEEK_API_KEY": config.DEEPSEEK_API_KEY,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise SystemExit(
            "Не заполнены переменные окружения: "
            + ", ".join(missing)
            + ".\nСкопируйте .env.example в .env и заполните значения."
        )


async def main() -> None:
    setup_logging()
    validate_config()
    db.init_db()

    bot = Bot(
        token=config.TELEGRAM_BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dispatcher = Dispatcher()
    dispatcher.include_router(router)

    scheduler = setup_scheduler(bot)
    scheduler.start()

    upcoming = next_run_time()
    logger.info(
        "Расписание: %s МСК. Следующий анализ в %s МСК",
        schedule_human(), upcoming.strftime("%H:%M"),
    )
    await bot.get_me()  # проверяем токен и получаем профиль бота до старта

    # Уведомление о запуске: в лог и в Telegram
    await notifier.send_message(bot, notifier.format_startup_message())

    try:
        await dispatcher.start_polling(bot)
    finally:
        scheduler.shutdown(wait=False)
        await bot.session.close()
        logger.info("Бот остановлен")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.getLogger("news_analyst_bot").info("Остановка по Ctrl+C")
    except SystemExit as exc:
        # SystemExit с текстом (например, из validate_config) печатаем и выходим с кодом 1
        if exc.code in (0, None):
            raise SystemExit(0) from None
        logging.getLogger("news_analyst_bot").info("Запуск прерван: %s", exc.code)
        sys.exit(exc.code)
