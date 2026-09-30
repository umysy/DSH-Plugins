/**
 * dsh-quota-card — logic tests.
 *
 * These cover the pure logic only (no Host, no browser, no network), which is
 * everything the plugin computes on its own:
 *   - peak/off-peak rule and its exact boundaries, weekends, holidays, and the
 *     degrade path when the holiday table has no entry for the running year
 *   - countdown to the next tier change
 *   - cache-hit-rate denominators
 *   - the formatting the card shows
 *   - ledger aggregation across the Beijing day/month/year boundary
 *   - cost estimation, including a request that straddles a tier boundary
 *
 * Run with:  node --test test
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { clockToMinutes, minutesToClock, normalizeConfig, toPublicConfig } from '../lib/config.js';
import { createLedger } from '../lib/ledger.js';
import {
  addTotals,
  cacheHitRate,
  estimateCost,
  formatDuration,
  formatMoney,
  formatPercent,
  formatTokens,
  priceForModel,
  resolveTier,
  shiftDays,
  totalTokens,
  zoneDateString,
  zoneMonthString,
  zoneParts,
} from '../lib/pricing.js';

const ZONE = 'Asia/Shanghai';

/** Beijing wall-clock instant -> epoch ms (Beijing has been UTC+8 all year since 1991). */
const bj = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

/** A config comparable to what `normalizeConfig` produces. */
const CONFIG = normalizeConfig({}, 2026);

// ── formatting ────────────────────────────────────────────────────────────────

test('formatTokens keeps small counts exact and compacts large ones', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1200), '1.2K');
  assert.equal(formatTokens(15_500_000), '15.5M');
  assert.equal(formatTokens(20_400_000), '20.4M');
  assert.equal(formatTokens(1_050_000_000), '1.05B');
  // A value that rounds across a unit boundary must carry, not render "1000K".
  assert.equal(formatTokens(999_999), '1M');
  assert.equal(formatTokens(-1200), '-1.2K');
  assert.equal(formatTokens(Number.NaN), '--');
});

test('formatPercent and formatMoney render the card labels', () => {
  assert.equal(formatPercent(0.9923), '99.2%');
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(null), '--');
  assert.equal(formatMoney(9.66, 'CNY'), '\u00a59.66');
  assert.equal(formatMoney(0, 'CNY'), '\u00a50.00');
  assert.equal(formatMoney(0.0032, 'CNY'), '\u00a50.0032');
  assert.equal(formatMoney(12.5, 'USD'), '$12.50');
  assert.equal(formatMoney(Number.NaN, 'CNY'), '--');
});

test('formatDuration renders minutes, hours, and days', () => {
  assert.equal(formatDuration(45 * 60_000), '45m');
  assert.equal(formatDuration(80 * 60_000), '1h 20m');
  assert.equal(formatDuration(120 * 60_000), '2h');
  assert.equal(formatDuration(51 * 60 * 60_000), '2d 3h');
  assert.equal(formatDuration(-1), '--');
});

// ── peak / off-peak ───────────────────────────────────────────────────────────

test('2026-09-30 (Wednesday) follows the official peak windows', () => {
  const cases = [
    [8, 59, false],
    [9, 0, true],
    [11, 59, true],
    [12, 0, false], // 12:00-14:00 is off-peak
    [13, 59, false],
    [14, 0, true],
    [17, 59, true],
    [18, 0, false],
    [23, 59, false],
  ];
  for (const [hour, minute, expected] of cases) {
    const tier = resolveTier(bj(2026, 9, 30, hour, minute), CONFIG);
    assert.equal(tier.peak, expected, `${hour}:${String(minute).padStart(2, '0')} should be ${expected ? 'peak' : 'off-peak'}`);
  }
});

test('Saturday and Sunday are off-peak all day', () => {
  for (const day of [26, 27]) {
    assert.equal(resolveTier(bj(2026, 9, day, 10, 0), CONFIG).peak, false, `2026-09-${day} 10:00`);
    assert.equal(resolveTier(bj(2026, 9, day, 15, 0), CONFIG).peak, false, `2026-09-${day} 15:00`);
  }
});

test('statutory holidays are off-peak all day', () => {
  // 2026-10-01 (Thursday) is National Day; 09:00 and 15:00 would be peak on a
  // normal Thursday.
  assert.equal(resolveTier(bj(2026, 10, 1, 9, 0), CONFIG).peak, false);
  assert.equal(resolveTier(bj(2026, 10, 1, 15, 0), CONFIG).peak, false);
  const holiday = resolveTier(bj(2026, 10, 1, 15, 0), CONFIG);
  assert.equal(holiday.holiday, true);
  // Control: the following week is a normal working Thursday.
  assert.equal(resolveTier(bj(2026, 10, 8, 15, 0), CONFIG).peak, true);
});

test('an unknown year degrades to the weekday-only rule', () => {
  const bare = normalizeConfig({ holidays: {} }, 2026);
  const tier = resolveTier(bj(2026, 10, 1, 10, 0), bare);
  assert.equal(tier.peak, true, 'without a holiday table a Thursday is peak');
  assert.equal(tier.holiday, false);
});

test('调休 weekends are off-peak by default and peak when configured', () => {
  // 2026-09-20 is a Sunday, listed as a make-up working day.
  assert.equal(resolveTier(bj(2026, 9, 20, 10, 0), CONFIG).peak, false);
  const strict = normalizeConfig({ countMakeupAsPeak: true }, 2026);
  assert.equal(resolveTier(bj(2026, 9, 20, 10, 0), strict).peak, true);
  // Both readings agree that the make-up day is not a holiday.
  assert.equal(resolveTier(bj(2026, 9, 20, 10, 0), strict).holiday, false);
});

test('nextChangeAt points at the real boundary minute', () => {
  const noonish = resolveTier(bj(2026, 9, 30, 13, 30), CONFIG);
  assert.equal(noonish.peak, false);
  assert.equal(zoneParts(noonish.nextChangeAt, ZONE).hours * 60 + zoneParts(noonish.nextChangeAt, ZONE).minutes, 14 * 60);
  assert.ok(noonish.nextChangeAt > bj(2026, 9, 30, 13, 30));

  const inPeak = resolveTier(bj(2026, 9, 30, 9, 30), CONFIG);
  assert.equal(inPeak.peak, true);
  assert.equal(zoneParts(inPeak.nextChangeAt, ZONE).hours * 60 + zoneParts(inPeak.nextChangeAt, ZONE).minutes, 12 * 60);

  // After the last window the next change is the next working morning at 09:00.
  const evening = resolveTier(bj(2026, 9, 30, 20, 0), CONFIG);
  assert.equal(evening.peak, false);
  const target = zoneParts(evening.nextChangeAt, ZONE);
  assert.equal(target.date, '2026-10-08', '2026-10-01..07 are the National Day holiday');
  assert.equal(target.hours * 60 + target.minutes, 9 * 60);
});

test('nextChangeAt on a weekend skips to the next working morning', () => {
  // 2026-09-26 is a Saturday (and 中秋节), 2026-09-27 a Sunday: neither has a
  // later window that could change the tier, so the countdown must name the
  // next peak morning instead of a same-day window start.
  for (const [day, hour] of [[26, 8], [26, 10], [26, 15], [27, 10]]) {
    const tier = resolveTier(bj(2026, 9, day, hour, 0), CONFIG);
    assert.equal(tier.peak, false, `2026-09-${day} ${hour}:00 is off-peak`);
    const target = zoneParts(tier.nextChangeAt, ZONE);
    assert.equal(target.date, '2026-09-28', `2026-09-${day} ${hour}:00 -> Monday`);
    assert.equal(target.hours * 60 + target.minutes, 9 * 60);
  }
});

test('a rule with no peak day never changes tier', () => {
  const never = normalizeConfig({ peakDays: [] }, 2026);
  const tier = resolveTier(bj(2026, 9, 30, 10, 0), never);
  assert.equal(tier.peak, false);
  assert.equal(tier.nextChangeAt, null);
});

test('a make-up weekend stays peak even with peakDays empty', () => {
  // 2026-09-20 is a 调休 Sunday. With peakDays: [] the DAY list is empty, yet
  // countMakeupAsPeak still makes this a peak day, so the tier must change at
  // 12:00 rather than reporting "never".
  const makeupOnly = normalizeConfig({ peakDays: [], countMakeupAsPeak: true }, 2026);
  const tier = resolveTier(bj(2026, 9, 20, 10, 0), makeupOnly);
  assert.equal(tier.peak, true);
  assert.notEqual(tier.nextChangeAt, null);
  const target = zoneParts(tier.nextChangeAt, ZONE);
  assert.equal(target.date, '2026-09-20');
  assert.equal(target.hours * 60 + target.minutes, 12 * 60);
});

test('the countdown clears the nine-day Spring Festival block', () => {
  // 2026-02-15..02-23 is 春节 (9 days) and 02-14 is only a make-up day, so a
  // one-week walk is not enough. The next peak morning is 02-24 09:00.
  const evening = resolveTier(bj(2026, 2, 13, 20, 0), CONFIG);
  assert.equal(evening.peak, false);
  const target = zoneParts(evening.nextChangeAt, ZONE);
  assert.equal(target.date, '2026-02-24');
  assert.equal(target.hours * 60 + target.minutes, 9 * 60);
  // Inside the block the answer is the same.
  const inside = resolveTier(bj(2026, 2, 17, 10, 0), CONFIG);
  assert.equal(inside.peak, false);
  assert.equal(zoneParts(inside.nextChangeAt, ZONE).date, '2026-02-24');
});

test('a year with no holiday table does not inherit another year\u2019s dates', () => {
  // The built-in table covers 2026 only. 2027-01-01 is a Friday, so under the
  // weekday-only degrade it must be PEAK — never off-peak via 2026's 元旦 dates.
  const config = normalizeConfig({}, 2027);
  const newYear = resolveTier(bj(2027, 1, 1, 10, 0), config);
  assert.equal(newYear.date, '2027-01-01');
  assert.equal(newYear.peak, true, '2027 must not inherit the 2026 table');
  assert.equal(newYear.holiday, false);
  assert.equal(toPublicConfig(config, 2027).holidayYear, null);
});

test('an invalid holidays value falls back to the built-in table', () => {
  for (const bad of [42, null, 'nonsense', { 春节: 7 }]) {
    const config = normalizeConfig({ holidays: bad }, 2026);
    assert.equal(config.holidays['2026']?.length, 33, `holidays: ${JSON.stringify(bad)}`);
  }
  // An explicit empty map or list is intentional and clears the table.
  assert.deepEqual(normalizeConfig({ holidays: {} }, 2026).holidays, {});
  assert.deepEqual(normalizeConfig({ holidays: [] }, 2026).holidays, {});
});

test('custom peak windows and days are honoured', () => {
  const custom = normalizeConfig({ peakWindows: [['20:00', '22:00']], peakDays: [6] }, 2026);
  assert.equal(resolveTier(bj(2026, 9, 30, 20, 30), custom).peak, false, 'Wednesday is not in peakDays');
  // 2026-09-19 is a plain Saturday (not a holiday), so it is a real peak day
  // under peakDays: [6].
  assert.equal(resolveTier(bj(2026, 9, 19, 20, 30), custom).peak, true, 'Saturday 20:30 is');
  assert.equal(resolveTier(bj(2026, 9, 19, 22, 0), custom).peak, false);
});

// ── time zones and calendar buckets ───────────────────────────────────────────

test('zone bucketing is independent of the machine time zone', () => {
  // 2026-09-30T23:30Z is already 2026-10-01 07:30 in Beijing.
  const at = Date.UTC(2026, 8, 30, 23, 30);
  assert.equal(zoneDateString(at, ZONE), '2026-10-01');
  assert.equal(zoneMonthString(at, ZONE), '2026-10');
  assert.equal(zoneDateString(at, 'UTC'), '2026-09-30');
});

test('shiftDays preserves the Beijing wall-clock time', () => {
  const at = bj(2026, 9, 30, 13, 45);
  const shifted = shiftDays(at, 1, ZONE);
  const parts = zoneParts(shifted, ZONE);
  assert.equal(parts.date, '2026-10-01');
  assert.equal(parts.hours, 13);
  assert.equal(parts.minutes, 45);
});

// ── cache-hit rate ────────────────────────────────────────────────────────────

test('cacheHitRate divides by all three input classes', () => {
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, requests: 1 }), null);
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 0, requests: 1 }), 0.9);
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 0, requests: 1 }), 1);
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100, outputTokens: 0, requests: 1 }), 0);
  // The screenshot's 99.2% shape: a big cached prefix, a small fresh tail.
  const rate = cacheHitRate({ inputTokens: 80_000, cacheReadTokens: 15_420_000, cacheWriteTokens: 0, outputTokens: 90_000, requests: 12 });
  assert.equal(formatPercent(rate), '99.5%');
});

test('totalTokens and addTotals treat the input classes as disjoint', () => {
  const a = { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 7, requests: 1 };
  const b = { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, requests: 1 };
  assert.equal(totalTokens(a), 42);
  const sum = addTotals(a, b);
  assert.deepEqual(sum, { inputTokens: 11, cacheReadTokens: 22, cacheWriteTokens: 8, outputTokens: 11, requests: 2 });
});

// ── cost estimate ─────────────────────────────────────────────────────────────

test('priceForModel matches exactly, by prefix, and by fallback', () => {
  const exact = priceForModel('deepseek-flash', CONFIG.prices);
  assert.equal(exact.exact, true);
  assert.equal(exact.matched, 'deepseek-flash');

  const dated = priceForModel('deepseek-flash-2026-09-10', CONFIG.prices);
  assert.equal(dated.exact, false);
  assert.equal(dated.matched, 'deepseek-flash');
  assert.equal(dated.price.output, 8);

  const unknown = priceForModel('some-other-model', CONFIG.prices);
  assert.equal(unknown.exact, false);
  assert.equal(unknown.matched, 'deepseek-flash');
});

test('estimateCost prices each tier at its own rate', () => {
  const mega = 1_000_000;
  const entries = [
    { model: 'deepseek-flash', tier: 'peak', totals: { inputTokens: mega, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, requests: 1 } },
    { model: 'deepseek-flash', tier: 'offPeak', totals: { inputTokens: mega, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, requests: 1 } },
  ];
  const { total, approximate } = estimateCost(entries, CONFIG);
  // 1M uncached input costs ¥2 at peak and ¥1 off-peak.
  assert.equal(total, 3);
  assert.equal(approximate, false);
});

test('estimateCost flags a model resolved by prefix match', () => {
  const entries = [
    { model: 'deepseek-flash-2026-09-10', tier: 'peak', totals: { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, requests: 1 } },
  ];
  assert.equal(estimateCost(entries, CONFIG).approximate, true);
});

// ── ledger ────────────────────────────────────────────────────────────────────

test('ledger buckets by Beijing day, month, and year', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-card-'));
  const filePath = join(dir, 'usage.json');
  let clock = bj(2026, 9, 30, 10, 0);
  const ledger = createLedger({ config: CONFIG, filePath, now: () => clock });

  const usage = (hit, miss, out) => ({ inputTokens: miss, cacheReadTokens: hit, cacheWriteTokens: 0, outputTokens: out });
  ledger.record({ at: clock, model: 'deepseek-flash', usage: usage(1000, 100, 50) });
  ledger.record({ at: clock, model: 'deepseek-flash', usage: usage(2000, 200, 60) });

  let today = ledger.today();
  assert.equal(today.date, '2026-09-30');
  assert.equal(today.tokens, 1000 + 100 + 2000 + 200 + 110);
  assert.equal(today.totals.requests, 2);
  assert.equal(formatPercent(today.cacheHitRate), '90.9%');

  // Next month: the same ledger, a fresh bucket.
  clock = bj(2026, 10, 1, 10, 0);
  ledger.record({ at: clock, model: 'deepseek-flash', usage: usage(10, 20, 30) });
  today = ledger.today();
  assert.equal(today.date, '2026-10-01');
  assert.equal(today.tokens, 60);
  assert.equal(ledger.month().month, '2026-10');
  assert.equal(ledger.month().tokens, 60);

  // Previous month is still readable at a later instant.
  clock = bj(2026, 10, 15, 10, 0);
  assert.equal(ledger.month().month, '2026-10');
  assert.equal(ledger.month().tokens, 60);

  await ledger.flush();
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(Object.keys(raw.days).sort(), ['2026-09-30', '2026-10-01']);
});

test('ledger separates peak from off-peak usage of the same day', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-card-'));
  const ledger = createLedger({ config: CONFIG, filePath: join(dir, 'usage.json'), now: () => Date.now() });
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

  ledger.record({ at: bj(2026, 9, 30, 10, 0), model: 'deepseek-flash', usage }); // peak
  ledger.record({ at: bj(2026, 9, 30, 20, 0), model: 'deepseek-flash', usage }); // off-peak

  const today = ledger.today(bj(2026, 9, 30, 21, 0));
  assert.equal(today.peak, 1_000_000);
  assert.equal(today.offPeak, 1_000_000);
  // ¥2 at peak + ¥1 off-peak for 1M uncached input each.
  assert.equal(Number(today.cost.toFixed(4)), 3);
  await ledger.flush();
});

test('ledger keeps purpose-tagged calls out of the headline numbers only by tagging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-card-'));
  let clock = bj(2026, 9, 30, 10, 0);
  const ledger = createLedger({ config: CONFIG, filePath: join(dir, 'usage.json'), now: () => clock });
  const usage = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
  ledger.record({ at: clock, model: 'deepseek-flash', usage, purpose: 'conversation' });
  ledger.record({ at: clock, model: 'deepseek-flash', usage, purpose: 'session-title' });
  const today = ledger.today();
  assert.equal(today.totals.requests, 2);
  assert.equal(ledger.diagnostics().recorded, 2);
  await ledger.flush();
});

test('a corrupt ledger is quarantined and the plugin keeps working', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-card-'));
  const filePath = join(dir, 'usage.json');
  await writeFile(filePath, '{ this is not json', 'utf8');
  const ledger = createLedger({ config: CONFIG, filePath, now: () => bj(2026, 9, 30, 10, 0) });

  await ledger.load();
  assert.equal(ledger.today().tokens, 0);
  assert.equal(ledger.diagnostics().degraded, true);
  const files = await readdir(dir);
  assert.ok(files.some((entry) => entry.startsWith('usage.json.corrupt-')), 'the bad file is preserved, not overwritten');

  ledger.record({ at: bj(2026, 9, 30, 10, 0), model: 'deepseek-flash', usage: { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 } });
  await ledger.flush();
  const reread = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(reread.days['2026-09-30'].models['deepseek-flash'].peak.inputTokens, 5);
  // The plugin reports both the failure and the fact that it recovered. Two
  // writes happen: `record()` flushes immediately (lastFlushAt is still 0), and
  // the explicit `flush()` forces another.
  assert.equal(ledger.diagnostics().degraded, true);
  assert.equal(ledger.diagnostics().recovered, true);
  assert.equal(ledger.diagnostics().flushes, 2);
});

test('a ledger round-trips through disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-card-'));
  const filePath = join(dir, 'usage.json');
  const at = bj(2026, 9, 30, 10, 0);
  const first = createLedger({ config: CONFIG, filePath, now: () => at });
  first.record({ at, model: 'deepseek-flash', usage: { inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 2 } });
  await first.flush();

  const second = createLedger({ config: CONFIG, filePath, now: () => at });
  await second.load();
  const today = second.today();
  assert.equal(today.tokens, 13);
  assert.equal(today.totals.inputTokens, 7);
  assert.equal(today.totals.cacheReadTokens, 3);
  await second.flush();
});

// ── config ────────────────────────────────────────────────────────────────────

test('normalizeConfig ignores garbage and keeps the defaults', () => {
  const config = normalizeConfig({ peakWindows: 'nonsense', peakDays: [99, 1, 1], peakMultiplier: -3, prices: null, note: 42 }, 2026);
  assert.equal(config.peakWindows.length, 2);
  assert.deepEqual(config.peakDays, [1]);
  assert.equal(config.peakMultiplier, 2);
  assert.ok(Object.keys(config.prices).length >= 2);
  assert.equal(config.note, '');
  assert.equal(config.timezone, 'Asia/Shanghai');
});

test('the DEFAULT config carries the built-in holiday table and survives toPublicConfig', () => {
  // This is the shipped configuration (no `holidays` key in cordis.patch.yml),
  // so it is the one that must never throw and must never lose the table.
  const config = normalizeConfig({}, 2026);
  assert.deepEqual(Object.keys(config.holidays), ['2026']);
  assert.equal(config.holidays['2026'].length, 33, '7 festivals, 33 days off in 2026');
  assert.ok(config.holidays['2026'].includes('02-17'), 'spring festival day 1');
  assert.ok(config.holidays['2026'].includes('10-07'), 'national day last day');
  assert.equal(config.holidays['2027'], undefined, 'no table for 2027');
  assert.equal(config.makeupWorkdays['2026'].length, 6);

  const publicConfig = toPublicConfig(config, 2026);
  assert.equal(publicConfig.holidayYear, 2026);
  assert.equal(publicConfig.holidays.length, 33);
  assert.ok(publicConfig.holidays.includes('01-01'));
  // A year with no table reports it instead of pretending to have one.
  assert.equal(toPublicConfig(config, 2027).holidayYear, null);
  assert.deepEqual(toPublicConfig(config, 2027).holidays, []);
});

test('the built-in table turns a statutory holiday off-peak', () => {
  // 2026-10-01 is National Day; it is a Thursday, whose 09:00 and 15:00 windows
  // would otherwise be peak.
  const config = normalizeConfig({}, 2026);
  assert.equal(resolveTier(bj(2026, 10, 1, 9, 0), config).peak, false);
  assert.equal(resolveTier(bj(2026, 10, 1, 15, 0), config).peak, false);
  assert.equal(resolveTier(bj(2026, 10, 1, 15, 0), config).holiday, true);
  // 2026-02-17 is 春节; also a Tuesday.
  assert.equal(resolveTier(bj(2026, 2, 17, 10, 0), config).peak, false);
  assert.equal(resolveTier(bj(2026, 2, 17, 10, 0), config).holiday, true);
  // Control: 2026-09-30 is a normal Wednesday.
  assert.equal(resolveTier(bj(2026, 9, 30, 10, 0), config).peak, true);
});

test('normalizeConfig accepts the documented config shapes', () => {
  const config = normalizeConfig(
    {
      peakWindows: [['09:00', '12:00'], ['14:00', '18:00'], ['18:00', '18:00']],
      peakDays: [1, 2, 3, 4, 5],
      holidays: { 春节: ['02-17'] },
      prices: { 'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 } },
      showCost: true,
    },
    2026,
  );
  assert.equal(config.peakWindows.length, 2, 'a zero-length window is dropped');
  assert.deepEqual(config.holidays, { 2026: ['02-17'] });
  assert.equal(config.showCost, true);
  const publicConfig = toPublicConfig(config, 2026);
  assert.deepEqual(publicConfig.holidays, ['02-17']);
  assert.equal(publicConfig.holidayYear, 2026);
  assert.equal(publicConfig.peakWindows[0].start, '09:00');
});

test('toPublicConfig reports a missing holiday year instead of pretending', () => {
  const config = normalizeConfig({ holidays: {} }, 2026);
  const publicConfig = toPublicConfig(config, 2026);
  assert.equal(publicConfig.holidayYear, null);
  assert.deepEqual(publicConfig.holidays, []);
});

test('the account seam fields have defaults and reject garbage', () => {
  const base = normalizeConfig({}, 2026);
  assert.equal(base.locale, 'zh_CN');
  assert.ok(base.clientVersion.length > 0);
  assert.equal(base.balancePollMs, 60000);

  const custom = normalizeConfig({ locale: 'en_US', clientVersion: 'x/1', balancePollMs: 5000 }, 2026);
  assert.equal(custom.locale, 'en_US');
  assert.equal(custom.clientVersion, 'x/1');
  assert.equal(custom.balancePollMs, 5000);

  // Garbage falls back rather than reaching the account seam.
  const garbage = normalizeConfig({ locale: 42, clientVersion: {}, balancePollMs: -1 }, 2026);
  assert.equal(garbage.locale, base.locale);
  assert.equal(garbage.clientVersion, base.clientVersion);
  assert.equal(garbage.balancePollMs, base.balancePollMs);
});

test('clock helpers round-trip in the canonical zero-padded form', () => {
  assert.equal(minutesToClock(0), '00:00');
  assert.equal(minutesToClock(540), '09:00');
  assert.equal(minutesToClock(12 * 60), '12:00');
  assert.equal(minutesToClock(14 * 60), '14:00');
  assert.equal(minutesToClock(23 * 60 + 59), '23:59');
  assert.equal(minutesToClock(24 * 60), '24:00');
  assert.equal(minutesToClock(-5), '00:00');
  assert.equal(clockToMinutes('09:00'), 540);
  assert.equal(clockToMinutes('9:05'), 545);
  assert.equal(clockToMinutes('24:00'), 1440);
  assert.equal(clockToMinutes('24:30'), undefined);
  assert.equal(clockToMinutes('25:00'), undefined);
  assert.equal(clockToMinutes('nonsense'), undefined);
  // Every normalized window is zero-padded, so a config written by hand reads
  // back exactly as written.
  const config = normalizeConfig({ peakWindows: [['9:00', '12:00']] }, 2026);
  assert.equal(config.peakWindows[0].start, '09:00');
  assert.equal(config.peakWindows[0].end, '12:00');
  assert.equal(config.peakWindows[0].startMinutes, 540);
  // A window may end at midnight, but not start there.
  const late = normalizeConfig({ peakWindows: [['22:00', '24:00'], ['00:00', '00:00']] }, 2026);
  assert.equal(late.peakWindows.length, 1, 'the zero-length window is dropped');
  assert.equal(late.peakWindows[0].endMinutes, 1440);
});

test('the account seam fields have defaults and reject garbage', () => {
  const base = normalizeConfig({}, 2026);
  assert.equal(base.locale, 'zh_CN');
  assert.ok(base.clientVersion.length > 0);
  assert.equal(base.balancePollMs, 60000);

  const custom = normalizeConfig({ locale: 'en_US', clientVersion: 'x/1', balancePollMs: 5000 }, 2026);
  assert.equal(custom.locale, 'en_US');
  assert.equal(custom.clientVersion, 'x/1');
  assert.equal(custom.balancePollMs, 5000);

  // Garbage falls back rather than reaching the account seam.
  const garbage = normalizeConfig({ locale: 42, clientVersion: {}, balancePollMs: -1 }, 2026);
  assert.equal(garbage.locale, base.locale);
  assert.equal(garbage.clientVersion, base.clientVersion);
  assert.equal(garbage.balancePollMs, base.balancePollMs);
});

// ── ledger ordering ───────────────────────────────────────────────────────────

test('a record that lands before the initial read still merges with the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-card-'));
  const filePath = join(dir, 'usage.json');
  const at = bj(2026, 9, 30, 10, 0);

  const seed = createLedger({ config: CONFIG, filePath, now: () => at });
  seed.record({ at, model: 'deepseek-flash', usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } });
  await seed.flush();

  // A fresh process records immediately, without awaiting the load first.
  const restarted = createLedger({ config: CONFIG, filePath, now: () => at });
  restarted.record({ at, model: 'deepseek-flash', usage: { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } });
  await restarted.flush();

  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  const bucket = raw.days['2026-09-30'].models['deepseek-flash'].peak;
  assert.equal(bucket.inputTokens, 15, 'the earlier reading survived the restart');
  assert.equal(bucket.requests, 2);
  assert.equal(restarted.loaded(), true);
});

test('today() and month() are empty until something is recorded or loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-card-'));
  const at = bj(2026, 9, 30, 10, 0);
  const ledger = createLedger({ config: CONFIG, filePath: join(dir, 'usage.json'), now: () => at });
  assert.equal(ledger.today().tokens, 0);
  assert.equal(ledger.today().cacheHitRate, null);
  assert.equal(ledger.month().tokens, 0);
  assert.equal(ledger.diagnostics().loaded, false);
  await ledger.load();
  assert.equal(ledger.diagnostics().loaded, true);
  await ledger.flush();
});
