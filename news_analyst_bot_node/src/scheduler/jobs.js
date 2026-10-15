/**
 * Планировщик и главный сценарий анализа (порт scheduler/jobs.py).
 *
 * Здесь живут задания:
 * * runAnalysis — сбор новостей → дедупликация → дайджест → котировки → портфель Tinkoff →
 *   DeepSeek → запись в SQLite (runs + predictions) → отправка сообщения в Telegram;
 * * checkPredictions — ежедневная в 21:00 МСК проверка отработки идей по MOEX ISS.
 */

import * as config from '../config.js';
import { getLogger } from '../logger.js';
import { DeepSeekClient } from '../ai/client.js';
import * as notifier from '../bot/notifier.js';
import * as tinkoff from '../broker/tinkoff.js';
import * as quotes from '../market/quotes.js';
import * as collector from '../news/collector.js';
import { deduplicate } from '../news/dedup.js';
import * as horizon from '../predictions/horizon.js';
import * as db from '../storage/db.js';
import { CronScheduler, nextRunTime, scheduleHuman } from './cron.js';

const logger = getLogger('scheduler.jobs');

// Анализ выполняется строго по одному: /now во время планового прогона не запустится
let _analysisRunning = false;
const _deepseek = new DeepSeekClient();

export { nextRunTime, scheduleHuman };

/** True, если анализ уже выполняется (аналог asyncio.Lock.locked()). */
export function isAnalysisRunning() {
  return _analysisRunning;
}

/** CronTrigger на ровные часы МСК (а не interval — так привязка к HH:00). */
export function buildTriggerSpec() {
  return {
    hour: config.ANALYSIS_HOURS.map((hour) => String(hour)).join(','),
    minute: 0,
    timezone: config.TIMEZONE,
  };
}

/** CronTrigger ежедневной проверки идей (по умолчанию 21:00 МСК). */
export function buildCheckTriggerSpec() {
  return {
    hour: config.PREDICTION_CHECK_HOUR,
    minute: config.PREDICTION_CHECK_MINUTE,
    timezone: config.TIMEZONE,
  };
}

/** Создаёт планировщик: анализ по расписанию + ежедневная проверка идей. */
export function setupScheduler(bot) {
  const scheduler = new CronScheduler({ timezone: config.TIMEZONE });
  scheduler.addJob({
    id: 'hourly_analysis',
    hours: config.ANALYSIS_HOURS,
    minute: 0,
    handler: () => runAnalysis(bot, 'schedule'),
    misfireGraceSec: 300,
    coalesce: true,
    maxInstances: 1,
  });
  scheduler.addJob({
    id: 'daily_prediction_check',
    hours: [config.PREDICTION_CHECK_HOUR],
    minute: config.PREDICTION_CHECK_MINUTE,
    handler: () => checkPredictions(bot),
    misfireGraceSec: 3600,
    coalesce: true,
    maxInstances: 1,
  });
  return scheduler;
}

/**
 * Снимок рыночного контекста для промпта (реальные данные, Часть 1).
 *
 * Порядок источников внутри market/quotes.js: живой запрос (MOEX ISS, ЦБ РФ) →
 * последний снимок из SQLite → fallback из config.js. Ошибки источников не
 * бросаются наружу: они превращаются в статусы и предупреждения в логе.
 */
export async function getMarketSnapshot() {
  const snapshot = await quotes.getSnapshot();
  return snapshot.asPromptDict();
}

/** Портфель Tinkoff (только чтение). Без токена — статус no_token, без падения. */
export async function getPortfolioSnapshot(force = false) {
  return tinkoff.getPortfolioSnapshot({ force });
}

/**
 * Создаёт записи predictions по идеям прогона (Часть 3).
 *
 * Цена входа берётся с MOEX ISS; если её узнать не удалось — entry_price = null,
 * идея сохраняется, но в проверку не попадёт (см. db.getPredictionsDue).
 * Инструменты без тикера MOEX (ОФЗ, валютные пары) пропускаются.
 */
export async function createPredictionsForRun(runId, parsed, createdAt) {
  const ideas =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.идеи : null;
  if (!Array.isArray(ideas) || ideas.length === 0) return 0;

  const prices = new Map();
  const items = [];

  for (const idea of ideas) {
    if (!idea || typeof idea !== 'object' || Array.isArray(idea)) continue;
    const instrument = String(idea.инструмент || '').trim();
    const ticker = quotes.extractTicker(instrument);
    if (!ticker) {
      logger.info('Прогнозы: %r — не тикер MOEX, в проверку не попадает', instrument);
      continue;
    }
    if (!prices.has(ticker)) prices.set(ticker, await quotes.fetchTickerPrice(ticker));

    const horizonText = String(idea.горизонт || '').trim();
    items.push({
      ticker,
      instrument,
      direction: horizon.normalizeDirection(idea.направление),
      confidence: String(idea.уверенность || '').trim(),
      horizon: horizonText,
      entry_price: prices.get(ticker),
      check_at: horizon.computeCheckAt(createdAt, horizonText),
    });
  }

  if (items.length === 0) return 0;

  try {
    return db.savePredictions(runId, createdAt, items);
  } catch (exc) {
    // БД не должна ронять прогон
    logger.exception('Не удалось сохранить предсказания: %s', exc);
    return 0;
  }
}

/**
 * Проверка отработки идей (Часть 3, ежедневно 21:00 МСК).
 *
 * Для идей, у которых наступил check_at, берём текущую цену с MOEX ISS, определяем
 * фактическое направление (±1% — «боковик») и пишем hit: 1 — сбылось, 0 — нет,
 * null — «наблюдать» (не считается ни попаданием, ни промахом).
 */
export async function checkPredictions(bot) {
  const now = config.nowMsk();
  const due = db.getPredictionsDue(now);
  if (!due || due.length === 0) {
    logger.info(
      'Проверка идей: на %s МСК проверять нечего',
      config.strftimeMsk(now, '%d.%m.%Y %H:%M'),
    );
    return { checked: 0, skipped: 0, results: [] };
  }

  const results = [];
  let skipped = 0;

  for (const row of due) {
    const ticker = String(row.ticker || '');
    const entryPrice = row.entry_price;
    const price = ticker ? await quotes.fetchTickerPrice(ticker) : null;
    const realized = horizon.classifyMove(entryPrice, price);
    if (realized === null) {
      skipped += 1;
      logger.warning(
        'Проверка идей: id=%s (%s) — нет цены для сравнения, вернёмся к ней позже',
        row.id,
        ticker || '—',
      );
      continue;
    }

    const direction = horizon.normalizeDirection(row.direction);
    const hit = horizon.isHit(direction, realized);
    db.updatePredictionResult(Number(row.id), {
      priceAtCheck: price,
      realizedDirection: realized,
      hit,
    });
    results.push({
      ticker,
      direction,
      entry_price: entryPrice,
      price_at_check: price,
      realized_direction: realized,
      hit,
      change_pct: horizon.movePct(entryPrice, price),
    });
  }

  logger.info('Проверка идей завершена: проверено %s, отложено %s', results.length, skipped);
  if (results.length > 0) {
    await notifier.sendMessage(bot, notifier.formatPredictionsCheck(results));
  }
  return { checked: results.length, skipped, results };
}

/**
 * Точка входа для планировщика и команды /now.
 *
 * Возвращает результат прогона или null, если анализ уже идёт / упал целиком.
 */
export async function runAnalysis(bot, trigger = 'schedule') {
  if (_analysisRunning) {
    logger.warning('Анализ уже выполняется — запуск (%s) пропущен', trigger);
    return null;
  }

  _analysisRunning = true;
  try {
    return await runAnalysisOnce(bot, trigger);
  } catch (exc) {
    // непредвиденная ошибка — уведомляем владельца
    logger.exception('Анализ не удался: %s', exc);
    await notifier.sendMessage(bot, `⚠️ <b>Анализ не удался:</b> ${notifier.esc(exc)}`);
    return null;
  } finally {
    _analysisRunning = false;
  }
}

/** Сколько идей вернула модель (0, если их нет или сигналов нет). */
export function countIdeas(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
  if (parsed.сигналов_нет) return 0;
  const ideas = parsed.идеи;
  return Array.isArray(ideas) ? ideas.length : 0;
}

/** Полный цикл одного прогона анализа. */
async function runAnalysisOnce(bot, trigger) {
  const startedAt = config.nowMsk();
  const windowEnd = startedAt;
  const windowStart = new Date(windowEnd.getTime() - config.NEWS_WINDOW_MINUTES * 60000);
  logger.info(
    'Анализ (%s) начат в %s МСК, окно новостей %s — %s МСК',
    trigger,
    config.strftimeMsk(startedAt, '%H:%M:%S'),
    config.formatHhmm(windowStart),
    config.formatHhmm(windowEnd),
  );

  // 1-2. Сбор источников
  const [sources, rawItems] = await collector.collectAll(windowStart, windowEnd);

  // 3. Дедупликация
  const [uniqueItems, dropped] = deduplicate(rawItems);

  // 4. Дайджест
  const digest = collector.buildDigest(uniqueItems);
  const digestLines = String(digest)
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim()).length;
  logger.info(
    'Новостей собрано: %s, после дедупликации: %s (дубликатов %s), строк в дайджесте: %s',
    rawItems.length,
    uniqueItems.length,
    dropped,
    digestLines,
  );

  let deepseekStatus = 'skipped';
  let deepseekError = null;
  let tokens = null;
  let durationMs = null;
  let parsed = null;
  let rawResponse = null;

  // 5. Котировки (Часть 1) и портфель Tinkoff (Часть 4)
  const snapshot = await quotes.getSnapshot();
  const market = snapshot.asPromptDict();
  logger.info('Рыночный контекст: %s', snapshot.logLine());

  const portfolio = await tinkoff.getPortfolioSnapshot();
  if (portfolio.ok) {
    logger.info(
      'Tinkoff: позиций %s, стоимость %s',
      portfolio.positions.length,
      portfolio.totalValue,
    );
  }
  const tinkoffStatusText = portfolio.statusText();

  // 6. DeepSeek — вызываем только если есть что анализировать
  if (uniqueItems.length > 0) {
    logger.info('Отправка дайджеста в DeepSeek (%s)', config.DEEPSEEK_MODEL);
    const response = await _deepseek.analyze({
      digest,
      windowStart: config.formatHhmm(windowStart),
      windowEnd: config.formatHhmm(windowEnd),
      keyRate: market.key_rate,
      moexValue: market.moex_value,
      moexChange: market.moex_change,
      usdrub: market.usdrub,
      cnyrub: market.cnyrub,
      eurrub: market.eurrub,
      portfolioText: portfolio.promptText(),
    });
    deepseekStatus = response.status;
    deepseekError = response.error;
    tokens = response.tokens;
    durationMs = response.duration_ms;
    parsed = response.parsed;
    rawResponse = response.raw_response;
  } else {
    logger.warning('Новостей за окно нет — DeepSeek не вызывается');
  }

  const ideasCount = countIdeas(parsed);
  const signalPresent = ideasCount > 0;

  // 7. Сохраняем прогон в SQLite
  const finishedAt = config.nowMsk();
  let runId = null;
  try {
    runId = db.saveRun({
      startedAt,
      finishedAt,
      sourcesStatus: sources,
      deepseekStatus,
      deepseekTokens: tokens,
      deepseekDurationMs: durationMs,
      digest,
      rawResponse,
      parsedJson: parsed,
      signalPresent,
      tinkoffStatus: tinkoffStatusText,
      marketSnapshot: snapshot.asRow(),
    });
  } catch (exc) {
    // БД не должна ронять отправку прогноза
    logger.exception('Не удалось сохранить прогон в SQLite: %s', exc);
  }

  // 8. Идеи прогона → predictions для последующей проверки отработки (Часть 3)
  let predictionsCreated = 0;
  if (signalPresent && deepseekStatus === 'ok') {
    predictionsCreated = await createPredictionsForRun(runId, parsed, finishedAt);
    if (predictionsCreated) {
      logger.info('Прогнозы: создано %s записей для проверки', predictionsCreated);
    }
  }

  // 9. Отправляем сообщение владельцу
  const payload = {
    run_id: runId,
    trigger,
    started_at: startedAt,
    finished_at: finishedAt,
    window_start: windowStart,
    window_end: windowEnd,
    sources,
    news_total: rawItems.length,
    news_unique: uniqueItems.length,
    dedup_dropped: dropped,
    digest,
    digest_lines: digestLines,
    deepseek_status: deepseekStatus,
    deepseek_error: deepseekError,
    tokens,
    duration_ms: durationMs,
    parsed,
    raw_response: rawResponse,
    ideas_count: ideasCount,
    signal_present: signalPresent,
    market,
    market_status: snapshot.source_status,
    market_stale_values: snapshot.stale_values,
    market_fallback_values: snapshot.fallback_values,
    tinkoff_status: tinkoffStatusText,
    tinkoff_status_code: portfolio.status,
    tinkoff_positions: portfolio.positions.length,
    tinkoff_total_value: portfolio.totalValue,
    predictions_created: predictionsCreated,
  };

  await notifier.sendMessage(bot, notifier.buildAnalysisMessage(payload));
  const elapsedSec = (finishedAt.getTime() - startedAt.getTime()) / 1000;
  logger.info(
    'Анализ завершён за %s сек: новостей %s, DeepSeek %s, идей %s, id=%s',
    notifier.pyFixed(elapsedSec, 1),
    uniqueItems.length,
    deepseekStatus,
    ideasCount,
    runId,
  );
  return payload;
}
