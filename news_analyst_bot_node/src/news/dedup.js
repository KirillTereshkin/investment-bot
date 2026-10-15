/**
 * Дедупликация новостей (порт news/dedup.py).
 *
 * Два уровня:
 * 1. Точный — SHA1 от нормализованного заголовка (lowercase + без пунктуации).
 * 2. Нечёткий — Jaccard similarity по множествам слов, порог config.JACCARD_THRESHOLD.
 */

import crypto from 'node:crypto';

import * as config from '../config.js';
import { getLogger } from '../logger.js';

const logger = getLogger('news.dedup');

// Пунктуация и «мусорные» символы (кавычки-ёлочки, тире, многоточия и т.п.)
const PUNCT_RE = /[^\p{L}\p{N}_\s]/gu;
const WHITESPACE_RE = /\s+/gu;

/** Lowercase, убираем пунктуацию, схлопываем пробелы и «ё» → «е». */
export function normalizeTitle(title) {
  if (!title) return '';
  const text = String(title).toLowerCase().replace(/ё/g, 'е');
  return text.replace(PUNCT_RE, ' ').replace(WHITESPACE_RE, ' ').trim();
}

/** SHA1 от нормализованного заголовка. */
export function titleHash(normalizedTitle) {
  return crypto.createHash('sha1').update(String(normalizedTitle), 'utf8').digest('hex');
}

/** Множество слов заголовка (для Jaccard). */
export function words(normalizedTitle) {
  return new Set(String(normalizedTitle).split(/\s+/).filter(Boolean));
}

/** Коэффициент Жаккара для двух множеств слов. */
export function jaccardSimilarity(first, second) {
  if (!first || !second || first.size === 0 || second.size === 0) return 0;
  const union = new Set([...first, ...second]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of first) {
    if (second.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

/** Хранит уже принятые заголовки и определяет, является ли новый дубликатом. */
export class Deduplicator {
  constructor(threshold = null) {
    this.threshold = threshold === null || threshold === undefined ? config.JACCARD_THRESHOLD : threshold;
    this.hashes = new Set();
    this.tokenSets = [];
  }

  /** Возвращает [дубликат?, причина] — 'hash' | 'similarity' | 'empty' | null. */
  isDuplicate(title) {
    const normalized = normalizeTitle(title);
    if (!normalized) return [true, 'empty'];
    const digest = titleHash(normalized);
    if (this.hashes.has(digest)) return [true, 'hash'];
    const tokens = words(normalized);
    for (const known of this.tokenSets) {
      if (jaccardSimilarity(tokens, known) > this.threshold) return [true, 'similarity'];
    }
    this.hashes.add(digest);
    this.tokenSets.push(tokens);
    return [false, null];
  }
}

/** Возвращает [уникальные новости, сколько отброшено как дубликаты]. */
export function deduplicate(items) {
  const dedup = new Deduplicator();
  const unique = [];
  let dropped = 0;
  for (const item of items || []) {
    const [isDuplicate, reason] = dedup.isDuplicate(String((item && item.title) || ''));
    if (isDuplicate) {
      dropped += 1;
      if (dropped <= 10) logger.debug('Дубликат (%s): %s', reason, item && item.title);
      continue;
    }
    unique.push(item);
  }
  if (dropped) {
    logger.info('Дедупликация: %s дубликатов отброшено, осталось %s новостей', dropped, unique.length);
  }
  return [unique, dropped];
}
