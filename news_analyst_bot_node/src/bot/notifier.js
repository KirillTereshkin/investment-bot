/**
 * Формирование и отправка сообщений в Telegram (порт bot/notifier.py).
 *
 * Все ответы модели проходят через esc() (html.escape(quote=False)), поэтому
 * parse_mode=HTML безопасен. Отправка никогда не бросает исключений наружу:
 * ошибки пишутся в лог и превращаются в False.
 */

import * as config from '../config.js';
import { getLogger } from '../logger.js';
import { nextRunTime } from '../scheduler/cron.js';
import { TelegramApiError, TelegramBadRequest } from './telegram.js';

const logger = getLogger('bot.notifier');

export const SEPARATOR = '━'.repeat(20);
export const IDEA_TEXT_LIMIT = 500;
export const MODEL_TEXT_LIMIT = 300;

const TAG_RE = /<[^>]+>/g;

export const STATUS_ICONS = { ok: '✅', empty: '⚠️', error: '❌' };

// Человекочитаемые причины падения источников
export const REASON_LABELS = {
  timeout: 'timeout',
  connection_error: 'нет соединения',
  parse_error: 'parse_error',
  unknown_error: 'ошибка',
  empty_response: 'пустой ответ',
  empty: 'пусто',
};

// Человекочитаемые причины ошибок DeepSeek
export const DEEPSEEK_REASON_LABELS = {
  timeout: 'таймаут',
  connection_error: 'нет соединения',
  auth_error: 'неверный API-ключ',
  rate_limit: 'превышен лимит запросов',
  invalid_json: 'ответ модели не является JSON',
  no_api_key: 'DEEPSEEK_API_KEY не задан',
  unknown_error: 'неизвестная ошибка',
};

// Риски в блоке предупреждений по позициям (Часть 4)
export const RISK_ICONS = { негативно: '⚠️', позитивно: '✅', нейтрально: '➖' };

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** Как str(value) в Python (None → «None»), чтобы esc() совпадал с оригиналом. */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value instanceof Error) return value.message;
  if (typeof value === 'object') return pyRepr(value);
  return String(value);
}

/** Приближение repr() Python для словарей/списков — модель может вернуть объект. */
function pyRepr(value) {
  if (Array.isArray(value)) return `[${value.map((item) => pyRepr(item)).join(', ')}]`;
  if (value instanceof Date) return config.mskIso(value);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`);
    return `{${entries.join(', ')}}`;
  }
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return pyStr(value);
}

/** html.escape(text, quote=False): только &, < и >. */
function htmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** html.unescape для того, что реально встречается в наших текстах. */
function htmlUnescape(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => safeFromCodePoint(parseInt(hex, 16), match))
    .replace(/&#(\d+);/g, (match, digits) => safeFromCodePoint(parseInt(digits, 10), match))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeFromCodePoint(code, fallback) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** Список код-поинтов — len() и срезы в Python считают именно их. */
function codePoints(text) {
  return Array.from(String(text));
}

/** Экранирование произвольного текста для parse_mode=HTML. */
export function esc(value) {
  return htmlEscape(pyStr(value));
}

/** Превращает текст с HTML-разметкой в плоский (для повторной отправки без разметки). */
export function stripHtml(text) {
  return htmlUnescape(String(text).replace(TAG_RE, ''));
}

/** Обрезает длинный текст, сохраняя читаемость. */
export function short(value, limit) {
  const text =
    value === null || value === undefined ? '' : pyStr(value).split(/\s+/).filter(Boolean).join(' ');
  const points = codePoints(text);
  if (points.length <= limit) return text;
  return points.slice(0, limit - 1).join('').replace(/[\s\u00a0]+$/, '') + '…';
}

export function reasonLabel(reason) {
  if (!reason) return 'ошибка';
  const text = String(reason);
  if (text.startsWith('http_')) return 'http ' + text.slice(5);
  return REASON_LABELS[text] ?? text;
}

export function deepseekReasonLabel(reason) {
  if (!reason) return 'неизвестная ошибка';
  const text = String(reason);
  if (text.startsWith('http_')) return 'http ' + text.slice(5);
  return DEEPSEEK_REASON_LABELS[text] ?? text;
}

/**
 * Округление «половина к чётному» с фиксированной точностью — как f"{x:.Nf}"
 * в Python (нужно для процентов и длительностей в сообщениях).
 */
export function pyFixed(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const factor = 10 ** digits;
  const scaled = number * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded;
  if (Math.abs(diff - 0.5) < 1e-9) rounded = floor % 2 === 0 ? floor : floor + 1;
  else rounded = Math.round(scaled);
  let text = Math.abs(rounded / factor).toFixed(digits);
  if (rounded < 0 || number < 0) text = `-${text}`;
  return text;
}

/** Знаковый процент: f"{x:+.1f}%" в Python. */
export function signedPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '+' : ''}${pyFixed(number, 1)}%`;
}

/**
 * Разбивает длинное сообщение на части по строкам (лимит Telegram — 4096).
 * Длинные строки без переносов режутся по лимиту.
 */
export function splitMessage(text, limit = null) {
  const maxLen = limit === null || limit === undefined ? config.TELEGRAM_MAX_MESSAGE_LEN : limit;
  if (codePoints(text).length <= maxLen) return [text];

  const chunks = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (codePoints(candidate).length <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    let rest = line;
    while (codePoints(rest).length > maxLen) {
      chunks.push(codePoints(rest).slice(0, maxLen).join(''));
      rest = codePoints(rest).slice(maxLen).join('');
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Отправляет сообщение владельцу бота. Возвращает True, если отправка удалась. */
export async function sendMessage(bot, text, chatId = null) {
  const target = chatId || config.TELEGRAM_CHAT_ID;
  if (!target) {
    logger.error('TELEGRAM_CHAT_ID не задан — сообщение не отправлено');
    return false;
  }

  let delivered = true;
  for (const chunk of splitMessage(text)) {
    try {
      await bot.sendMessage(target, chunk, { parseMode: 'HTML', disableWebPagePreview: true });
    } catch (exc) {
      if (exc instanceof TelegramBadRequest) {
        // Обычно причина — невалидная разметка: отправляем как plain-текст
        logger.warning('Telegram отклонил HTML-разметку (%s), повтор без разметки', exc.message);
        try {
          await bot.sendMessage(target, stripHtml(chunk), { disableWebPagePreview: true });
        } catch (inner) {
          if (inner instanceof TelegramApiError) {
            logger.error('Не удалось отправить сообщение в Telegram: %s', inner.message);
            delivered = false;
          } else {
            throw inner;
          }
        }
      } else if (exc instanceof TelegramApiError) {
        logger.error('Ошибка отправки в Telegram: %s', exc.message);
        delivered = false;
      } else {
        throw exc;
      }
    }
  }
  return delivered;
}

/** Ближайшее время запуска в формате HH:MM (МСК). */
export function nextRunHhmm(now = null) {
  return config.formatHhmm(nextRunTime(now));
}

/** 48.4 → «48%»; None → «—» (f"{float(value):.0f}%" в Python). */
function pctText(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${pyFixed(number, 0)}%`;
}

/** 45230 → «45 230 ₽» (None → «—»): f"{value:,.0f}".replace(",", " "). */
function moneyText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const fixed = pyFixed(value, 0);
  const negative = fixed.startsWith('-');
  const body = negative ? fixed.slice(1) : fixed;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '-' : ''}${grouped} ₽`;
}

/** Блок статусов источников. */
function formatSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const okCount = list.filter((source) => source && source.status === 'ok').length;
  const lines = [`📡 <b>Источники (${okCount}/${list.length} ok):</b>`];
  for (const source of list) {
    const status = source ? source.status : null;
    const icon = STATUS_ICONS[status] ?? '❔';
    const name = esc(source && source.source !== undefined ? source.source : 'unknown');
    if (status === 'ok') {
      lines.push(`${icon} ${name} — ${source.count ?? 0}`);
    } else if (status === 'empty') {
      lines.push(`${icon} ${name} — пусто`);
    } else {
      lines.push(`${icon} ${name} — ${esc(reasonLabel(source ? source.reason : null))}`);
    }
  }
  return lines.join('\n');
}

/** Строка статуса DeepSeek. */
function formatDeepseek(result) {
  const status = String(result.deepseek_status ?? '').trim();
  if (status === 'ok') {
    const tokens = result.tokens;
    const tokensText = tokens === null || tokens === undefined ? 'токены н/д' : `${pyStr(tokens)} токенов`;
    const durationMs = result.duration_ms;
    const durationText =
      durationMs === null || durationMs === undefined ? '—' : `${pyFixed(durationMs / 1000, 1)} сек`;
    return `🧠 DeepSeek: ok | ${tokensText} | ${durationText}`;
  }
  if (status === 'skipped') {
    return '🧠 DeepSeek: ⏭️ не вызывался (новостей за окно нет)';
  }
  const reason = status.includes(':') ? status.split(':').slice(1).join(':') : status;
  return (
    `🧠 DeepSeek: ❌ ошибка после ${config.DEEPSEEK_RETRIES} ретраев — ` +
    `"${esc(deepseekReasonLabel(reason))}"`
  );
}

/**
 * Блок «⚠️ По вашим позициям» из поля «предупреждения_по_позициям».
 *
 * Пустой список, если модель не вернула предупреждений — блок в сообщение не попадает.
 */
function formatPositionWarnings(parsed) {
  const warnings = parsed.предупреждения_по_позициям;
  if (!Array.isArray(warnings) || warnings.length === 0) return [];

  const lines = [];
  for (const warning of warnings.slice(0, 5)) {
    if (!warning || typeof warning !== 'object' || Array.isArray(warning)) continue;
    const instrument = short(warning.инструмент ?? '—', 60) || '—';
    const risk = short(warning.риск ?? 'риск', 40) || 'риск';
    const position = short(warning.позиция ?? '', 60);
    const reason = short(warning.обоснование ?? '', IDEA_TEXT_LIMIT);

    let head = `• ${instrument} — ${risk}`;
    if (position) head += ` (${position})`;
    if (reason) head += `: ${reason}`;
    lines.push(esc(head));

    const recommendation = short(warning.рекомендация ?? '', IDEA_TEXT_LIMIT);
    if (recommendation) lines.push(`  Рекомендация: ${esc(recommendation)}`);
  }

  if (lines.length === 0) return [];
  return ['⚠️ <b>По вашим позициям:</b>', ...lines];
}

/** Блок идей из ответа модели (максимум 4 идеи, как требует промпт). */
function formatIdeas(parsed) {
  const ideas = parsed.идеи;
  if (!Array.isArray(ideas)) return [];

  const lines = [];
  let index = 0;
  for (const idea of ideas.slice(0, 4)) {
    index += 1;
    if (!idea || typeof idea !== 'object' || Array.isArray(idea)) continue;
    const instrument = short(idea.инструмент ?? '—', 60) || '—';
    const direction = short(idea.направление ?? '—', 40) || '—';
    const horizon = short(idea.горизонт ?? '', 40);
    const confidence = short(idea.уверенность ?? '—', 40) || '—';

    let head = `${index}. ${instrument} — ${direction}`;
    if (horizon) head += `, ${horizon}`;
    head += `, уверенность: ${confidence}`;
    lines.push(`<b>${esc(head)}</b>`);

    const justification = short(idea.обоснование ?? '', IDEA_TEXT_LIMIT);
    if (justification) lines.push(`   ${esc(justification)}`);

    const cancelTrigger = short(idea.триггер_отмены ?? '', IDEA_TEXT_LIMIT);
    if (cancelTrigger) lines.push(`   ⚠️ Отмена: ${esc(cancelTrigger)}`);
  }
  return lines;
}

/** Тело сообщения: прогноз, идеи, урок дня — или причина отсутствия прогноза. */
function formatBody(result) {
  const status = String(result.deepseek_status ?? '').trim();

  if (status === 'skipped') return 'Новостей за окно нет.';

  if (status !== 'ok') {
    const reason = status.includes(':') ? status.split(':').slice(1).join(':') : status;
    return `❌ Прогноз не получен: ${esc(deepseekReasonLabel(reason))}`;
  }

  const raw = result.parsed;
  const parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const lines = [];

  const summary = short(parsed.резюме_рынка ?? '', MODEL_TEXT_LIMIT);
  if (summary) lines.push(`📈 <b>Рынок:</b> ${esc(summary)}`);

  const ideas = formatIdeas(parsed);
  const noSignals = Boolean(parsed.сигналов_нет);

  lines.push('');
  if (ideas.length > 0 && !noSignals) {
    lines.push('🎯 <b>Идеи:</b>');
    lines.push(...ideas);
  } else {
    lines.push('Сигналов нет. Рынок без значимых новостей за окно.');
  }

  const lesson = short(parsed.урок_дня ?? '', MODEL_TEXT_LIMIT);
  if (lesson) {
    lines.push('');
    lines.push(`📌 <b>Урок дня:</b> ${esc(lesson)}`);
  }

  const warnings = formatPositionWarnings(parsed);
  if (warnings.length > 0) {
    lines.push('');
    lines.push(...warnings);
  }

  return lines.join('\n');
}

/** Собирает итоговое сообщение анализа по формату проекта. */
export function buildAnalysisMessage(result) {
  const windowStart = config.toMsk(result.window_start);
  const windowEnd = config.toMsk(result.window_end);
  const sources = Array.isArray(result.sources) ? result.sources : [];

  const blocks = [];

  const failed = sources.filter((source) => source && source.status === 'error').length;
  if (sources.length > 0 && failed * 2 > sources.length) {
    blocks.push('⚠️ <b>Больше половины источников недоступно, прогноз может быть неполным.</b>');
    blocks.push('');
  }

  blocks.push(
    `📊 <b>Анализ за ${config.formatHhmm(windowStart)}–${config.formatHhmm(windowEnd)} МСК ` +
      `(${config.strftimeMsk(windowEnd, '%d.%m.%Y')})</b>`,
  );
  blocks.push('');
  blocks.push(formatSources(sources));
  blocks.push('');
  blocks.push(formatDeepseek(result));
  blocks.push('');
  const tinkoffLine = result.tinkoff_status;
  if (tinkoffLine) {
    blocks.push(esc(tinkoffLine));
    blocks.push('');
  }
  blocks.push(SEPARATOR);
  blocks.push(formatBody(result));
  blocks.push('');
  blocks.push(SEPARATOR);
  blocks.push(`⏭️ Следующий анализ в ${nextRunHhmm()} МСК`);

  return blocks.join('\n');
}

/** Безопасный json.loads для значений из БД. */
function loadJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Приводит значение из БД к Date (datetime/ISO-строка/epoch). */
function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000);
  return config.parseIso(value);
}

/** Текст для команды /last. */
export function formatLastRun(run) {
  if (!run) return '📭 Прогонов ещё не было. Запустите /now.';

  const lines = [`🕓 <b>Последний прогон:</b> ${esc(run.started_at || '—')}`, ''];

  const tokens = run.deepseek_tokens;
  const duration = run.deepseek_duration_ms;
  const durationText = duration ? `${pyFixed(duration / 1000, 1)} сек` : '—';
  lines.push(
    `🧠 DeepSeek: ${esc(run.deepseek_status || '—')}` +
      ` | токенов: ${tokens === null || tokens === undefined ? '—' : tokens}` +
      ` | ${durationText}`,
  );

  if (run.tinkoff_status) lines.push(esc(run.tinkoff_status));

  const sources = loadJson(run.sources_status, []);
  if (Array.isArray(sources) && sources.length > 0) {
    lines.push('');
    lines.push(formatSources(sources));
  }

  const digest = run.digest || '';
  const digestLines = String(digest)
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim()).length;
  lines.push('');
  lines.push(`📄 Дайджест: ${digestLines} строк`);

  lines.push('');
  lines.push(SEPARATOR);
  lines.push(
    formatBody({
      deepseek_status: run.deepseek_status || '',
      parsed: loadJson(run.parsed_json, null),
    }),
  );
  return lines.join('\n');
}

/** Текст для команды /schedule и /start. */
export function formatSchedule() {
  const hours = config.ANALYSIS_HOURS.map((hour) => `${String(hour).padStart(2, '0')}:00`).join(', ');
  return [
    `🗓 <b>Расписание:</b> ${hours} МСК, ежедневно`,
    `⏭️ Следующий запуск: <b>${nextRunHhmm()} МСК</b>`,
    `🪟 Окно сбора новостей: ${config.NEWS_WINDOW_MINUTES} минут`,
    `🌍 Таймзона: ${config.TIMEZONE}`,
  ].join('\n');
}

/** Сообщение при старте бота (требование ТЗ). */
export function formatStartupMessage() {
  const hours = config.ANALYSIS_HOURS.map((hour) => String(hour)).join(',');
  return (
    '🤖 <b>Бот запущен.</b>\n' +
    `Следующий анализ в ${nextRunHhmm()} МСК.\n` +
    `Расписание: ${hours}.`
  );
}

/** Текст для команды /accuracy — точность прогнозов за N дней (Часть 3). */
export function formatAccuracy(stats) {
  const lines = [`📊 <b>Точность прогнозов за ${stats.days ?? 30} дней</b>`, ''];

  const evaluated = Math.trunc(Number(stats.evaluated) || 0);
  lines.push(`Всего идей: ${stats.total ?? 0}`);
  lines.push(`Отработано: ${evaluated}`);
  lines.push(`Точность общая: ${pctText(stats.accuracy)}`);

  if (evaluated) {
    const byConfidence = stats.by_confidence || {};
    const ordered = ['высокая', 'средняя', 'низкая'];
    const rest = Object.keys(byConfidence).filter((level) => !ordered.includes(level));
    lines.push('');
    lines.push('<b>По уверенности:</b>');
    for (const level of [...ordered, ...rest]) {
      const bucket = byConfidence[level];
      if (!bucket || Object.keys(bucket).length === 0) continue;
      lines.push(
        `• ${esc(level)}: ${pctText(bucket.accuracy)} ` +
          `(${bucket.hit ?? 0}/${bucket.evaluated ?? 0})`,
      );
    }

    const tickers = stats.by_ticker || [];
    if (Array.isArray(tickers) && tickers.length > 0) {
      lines.push('');
      lines.push('<b>Топ тикеров:</b>');
      for (const item of tickers) {
        const icon = Number(item.accuracy || 0) >= 50 ? '✅' : '❌';
        lines.push(
          `${icon} ${esc(item.ticker)} — ${pctText(item.accuracy)} ` +
            `(${item.hit ?? 0}/${item.evaluated ?? 0})`,
        );
      }
    }
  } else {
    lines.push('');
    lines.push('Пока нечего оценивать: ни одна идея ещё не отработала горизонт.');
  }

  if (stats.watchlisted) {
    lines.push('');
    lines.push(`👀 «Наблюдать» (в точность не входят): ${stats.watchlisted}`);
  }
  if (stats.no_entry_price) {
    lines.push(`❔ Без цены входа (не проверяются): ${stats.no_entry_price}`);
  }

  lines.push('');
  lines.push(`⏳ Ожидают проверки: ${stats.pending ?? 0}`);
  return lines.join('\n');
}

/**
 * Текст для команды /portfolio: снимок позиций Tinkoff без анализа.
 *
 * snapshot — broker/tinkoff.js PortfolioSnapshot (duck-typing, чтобы notifier не тянул SDK).
 */
export function formatPortfolio(snapshot) {
  const ok = Boolean(snapshot && snapshot.ok);
  const positions = (snapshot && snapshot.positions) || [];

  const lines = ['💼 <b>Портфель Tinkoff</b>', '', esc(snapshot.statusText())];

  if (!ok) {
    if (snapshot.error) lines.push(`Причина: ${esc(snapshot.error)}`);
    lines.push('');
    lines.push('Работаем без контекста позиций — прогнозы идут как раньше.');
    return lines.join('\n');
  }

  if (positions.length === 0) {
    lines.push('');
    lines.push('Открытых позиций нет.');
    return lines.join('\n');
  }

  lines.push('');
  for (const position of positions) lines.push(position.asTelegramLine());

  const total = snapshot.totalValue;
  if (total) {
    lines.push('');
    lines.push(`Итого: <b>${moneyText(total)}</b>`);
  }
  return lines.join('\n');
}

/** Итог ежедневной проверки идей (Часть 3). */
export function formatPredictionsCheck(results) {
  const list = Array.isArray(results) ? results : [];
  const hits = list.filter((item) => item && item.hit === 1).length;
  const misses = list.filter((item) => item && item.hit === 0).length;

  const lines = ['🔍 <b>Проверка идей</b>', ''];
  for (const item of list) {
    let icon = '👀';
    if (item.hit === 1) icon = '✅';
    else if (item.hit === 0) icon = '❌';
    const change = item.change_pct;
    const changeText = typeof change === 'number' && Number.isFinite(change) ? signedPct(change) : '—';
    lines.push(
      `${icon} ${esc(item.ticker)} — ${esc(item.direction)} → ` +
        `${esc(item.realized_direction)} (${changeText})`,
    );
  }

  lines.push('');
  lines.push(`Итог: сбылось ${hits}, не сбылось ${misses} из ${list.length}`);
  return lines.join('\n');
}

export function formatStats(stats) {
  const since = asDate(stats.since);
  let header = `📊 <b>Статистика за ${stats.days ?? 7} дней</b>`;
  if (since) header += ` (с ${config.strftimeMsk(since, '%d.%m.%Y %H:%M')} МСК)`;

  const lines = [
    header,
    '',
    `Прогонов: <b>${stats.total_runs ?? 0}</b>`,
    `С идеями: ${stats.with_ideas ?? 0}`,
    `«Сигналов нет»: ${stats.no_signal ?? 0}`,
    `Пропущено (новостей не было): ${stats.deepseek_skipped ?? 0}`,
    `Ошибок DeepSeek: ${stats.deepseek_errors ?? 0}`,
    `Падений источников: ${stats.source_failures ?? 0}`,
    `Прогонов с деградацией (упало >50% источников): ${stats.degraded_runs ?? 0}`,
  ];

  const failedSources = stats.failed_sources || {};
  const entries = Object.entries(failedSources);
  if (entries.length > 0) {
    lines.push('');
    lines.push('<b>Падения по источникам:</b>');
    for (const [name, count] of entries.sort((first, second) => second[1] - first[1])) {
      lines.push(`• ${esc(name)} — ${count}`);
    }
  }

  return lines.join('\n');
}
