/**
 * Расписание запусков — замена APScheduler (CronTrigger) из scheduler/jobs.py.
 *
 * В Python-версии использовались AsyncIOScheduler + CronTrigger с misfire_grace_time,
 * coalesce и max_instances. Здесь это собственный шедулер на setTimeout: время
 * следующего срабатывания считается по «настенным» московским часам
 * (config.mskWallDate), после запуска задача планируется заново.
 *
 * Сохранены свойства, на которые опирается проект:
 *   * misfire_grace_time — слишком поздний запуск (процесс «спал») пропускается,
 *     а не выполняется пачкой;
 *   * coalesce — пропущенные срабатывания схлопываются в одно;
 *   * max_instances=1 — задача не стартует, пока предыдущая ещё выполняется.
 *
 * Отдельный модуль нужен, чтобы notifier и jobs брали время следующего запуска
 * без циклического импорта (в Python это решалось ленивым импортом внутри функции).
 */

import * as config from '../config.js';
import { getLogger } from '../logger.js';

const logger = getLogger('scheduler.cron');

/**
 * Ближайший момент «hour:minute» по МСК строго после now.
 *
 * hours — список часов (например, [10, 12, 14, 16, 18, 20]), как в
 * CronTrigger(hour="10,12,...", minute=0): если ни один час сегодня уже не
 * подходит, берётся первый час следующего дня.
 */
export function nextOccurrence(hours, minute = 0, now = null) {
  const current = now || config.nowMsk();
  const list = [...hours].map((hour) => Number(hour)).sort((first, second) => first - second);
  if (list.length === 0) throw new Error('nextOccurrence: список часов пуст');

  const parts = config.mskParts(current);
  for (const hour of list) {
    const candidate = config.mskWallDate(parts.year, parts.month, parts.day, hour, minute, 0);
    if (candidate.getTime() > current.getTime()) return candidate;
  }
  return config.mskWallDate(parts.year, parts.month, parts.day + 1, list[0], minute, 0);
}

/** Ближайшее время планового анализа (МСК) — как jobs.next_run_time в Python. */
export function nextRunTime(now = null) {
  return nextOccurrence(config.ANALYSIS_HOURS, 0, now);
}

/** Расписание в виде «10, 12, 14, 16, 18, 20». */
export function scheduleHuman() {
  return config.ANALYSIS_HOURS.map((hour) => String(hour)).join(', ');
}

/**
 * Планировщик заданий по расписанию.
 *
 * job — {id, hours, minute, handler, misfireGraceSec, coalesce, maxInstances}.
 */
export class CronScheduler {
  constructor({ timezone = config.TIMEZONE } = {}) {
    this.timezone = timezone;
    this.jobs = new Map();
    this.running = false;
  }

  /** Добавляет задачу (аналог scheduler.add_job). */
  addJob({
    id,
    hours = null,
    hour = null,
    minute = 0,
    handler,
    misfireGraceSec = 0,
    coalesce = true,
    maxInstances = 1,
  }) {
    if (typeof handler !== 'function') {
      throw new TypeError(`addJob(${id}): handler должен быть функцией`);
    }
    const list = (hours === null ? [hour] : hours).map((value) => Number(value));
    this.jobs.set(id, {
      id,
      hours: list,
      minute: Number(minute) || 0,
      handler,
      misfireGraceSec,
      coalesce,
      maxInstances,
      running: 0,
      nextRun: null,
      timer: null,
    });
    return this;
  }

  /** Момент следующего срабатывания задачи (null, если задачи нет). */
  nextRunOf(id, now = null) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return nextOccurrence(job.hours, job.minute, now);
  }

  /** Запускает планировщик и ставит таймеры на все задачи. */
  start() {
    if (this.running) return this;
    this.running = true;
    for (const job of this.jobs.values()) this._schedule(job);
    return this;
  }

  /** Останавливает планировщик (аналог scheduler.shutdown(wait=False)). */
  shutdown() {
    this.running = false;
    for (const job of this.jobs.values()) {
      if (job.timer !== null) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }
    return this;
  }

  /** Считает время следующего запуска и ставит таймер. */
  _schedule(job) {
    const now = config.nowMsk();
    const next = nextOccurrence(job.hours, job.minute, now);
    job.nextRun = next;
    const delayMs = Math.max(0, next.getTime() - now.getTime());
    logger.info(
      'Задача %s: следующий запуск в %s МСК (через %.0f сек)',
      job.id,
      config.formatHhmm(next),
      delayMs / 1000,
    );
    job.timer = setTimeout(() => {
      void this._fire(job, next);
    }, delayMs);
    if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
  }

  /** Срабатывание задачи: проверяем опоздание/наложение и планируем следующий запуск. */
  async _fire(job, scheduledAt) {
    job.timer = null;
    if (!this.running) return;

    const latenessSec = (Date.now() - scheduledAt.getTime()) / 1000;
    if (job.misfireGraceSec > 0 && latenessSec > job.misfireGraceSec) {
      logger.warning(
        'Задача %s опоздала на %.0f сек (лимит %s) — запуск пропущен',
        job.id,
        latenessSec,
        job.misfireGraceSec,
      );
    } else if (job.maxInstances !== null && job.running >= job.maxInstances) {
      logger.warning('Задача %s уже выполняется — запуск пропущен', job.id);
    } else {
      job.running += 1;
      try {
        await job.handler();
      } catch (exc) {
        logger.exception('Задача %s упала: %s', job.id, exc);
      } finally {
        job.running -= 1;
      }
    }

    if (this.running) this._schedule(job);
  }
}
