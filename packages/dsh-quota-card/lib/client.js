/**
 * dsh-quota-card — Client half (browser bundle).
 *
 * Registered into the sidebar footer seat (`sidebar.footer.action`) as one
 * full-width card, ordered before Settings. The card's own stylesheet turns that
 * row into a column so the entries stack, and because the seat is a LIST slot a
 * fresh entry id adds a card beside the shipped entries instead of replacing
 * one.
 *
 * Contract (see README "Authoring contract"):
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) -> module.exports = { apply(ctx), inject: [...serviceNames] }
 * `inject` names CLIENT service names, supplied by the packages listed in
 * package.json `dsh.client.inject`:
 *   slots  <- @deepseek-ai/dsh-client-ui-renderer
 *   locale <- @deepseek-ai/dsh-client-locale
 * and @deepseek-ai/dsh-client-ui-sidebar declares the slot we write into.
 *
 * No JSX and no build step: `lib/` ships as installed.
 *
 * All data arrives from the Host half over `GET /quota-card/snapshot`. Nothing
 * here talks to DeepSeek and no credential ever reaches the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quota-card',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');

    var SNAPSHOT_URL = '/quota-card/snapshot';
    var POLL_MS = 60000;
    var TICK_MS = 5000;
    var COST_KEY = 'dsh-quota-card.showCost';
    var HEIGHT_KEY = 'dsh-quota-card.height';
    var STYLE_ID = 'dsh-quota-card-style';
    var CARD_ID = 'dsh-quota-card';

    /** Drag-to-resize bounds for the card body, in px. */
    var MIN_BODY_HEIGHT = 90;
    var MAX_BODY_HEIGHT = 680;

    /**
     * Vertical space the card spends OUTSIDE its scrollable body — the header row
     * and the resize strip. Auto height subtracts it from the space left in the
     * window, so the card never grows past the sidebar's clip and hides rows.
     */
    var CARD_CHROME = 56;

    /**
     * How far the "next peak morning" walk may look. It must clear the longest
     * holiday block: 春节 2026 runs 02-15..02-23, so a week is not enough.
     * Kept in sync with MAX_PEAK_WALK_DAYS in lib/pricing.js.
     */
    var MAX_PEAK_WALK_DAYS = 32;

    /** Required client services. */
    var inject = ['slots', 'locale'];

    // ── stylesheet ───────────────────────────────────────────────────────────
    // Selectors match the CSS-module SUFFIX only: the same package built into
    // the app and into the CLI carries different hashes, so a full class name
    // would silently match nothing. The `:not([class])` rule targets the host's
    // class-less `display: contents` outlet, so only the real entries get the
    // card frame. Everything else is scoped under the card id.
    var CSS = [
      '[class*="footerActions"]{flex-direction:column !important;align-items:stretch;gap:6px}',
      '[class*="footerActions"] > *:not([class]){border:0 !important;background:transparent !important;box-shadow:none !important}',
      '[class*="footerActions"] > *:not([class]) > *{border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28)) !important;',
      'border-radius:12px !important;background:var(--dsw-alias-bg-layer-1, transparent) !important;box-sizing:border-box}',
      '#' + CARD_ID + '{display:flex;flex-direction:column;gap:0;width:100%;box-sizing:border-box;',
      'font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary)}',
      '#' + CARD_ID + ' .dqc-head{display:flex;align-items:center;gap:6px;flex:none}',
      '#' + CARD_ID + ' .dqc-title{flex:1;min-width:0;font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#' + CARD_ID + ' .dqc-actions{display:flex;align-items:center;gap:4px;flex:none}',
      '#' + CARD_ID + ' .dqc-icon{appearance:none;border:0;background:transparent;padding:2px;margin:0;display:inline-flex;',
      'align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;line-height:0}',
      '#' + CARD_ID + ' .dqc-icon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))}',
      '#' + CARD_ID + ' .dqc-icon:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '#' + CARD_ID + ' .dqc-icon.is-active{color:var(--dsw-alias-brand-primary)}',
      '#' + CARD_ID + ' .dqc-body{display:flex;flex-direction:column;gap:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}',
      '#' + CARD_ID + ' .dqc-rows{display:flex;flex-direction:column;flex:none}',
      '#' + CARD_ID + ' .dqc-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:5px 0}',
      '#' + CARD_ID + ' .dqc-row + .dqc-row{border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))}',
      '#' + CARD_ID + ' .dqc-label{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '#' + CARD_ID + ' .dqc-value{font-weight:600;font-variant-numeric:tabular-nums;text-align:right;overflow:hidden;text-overflow:ellipsis}',
      '#' + CARD_ID + ' .dqc-value.is-balance{color:var(--dsw-alias-state-success-primary)}',
      '#' + CARD_ID + ' .dqc-value.is-error{color:var(--dsw-alias-state-error-primary);font-weight:500}',
      '#' + CARD_ID + ' .dqc-value.is-muted{color:var(--dsw-alias-label-secondary);font-weight:500;font-size:11px}',
      '#' + CARD_ID + ' .dqc-divider{border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));margin:4px 0 3px;flex:none}',
      '#' + CARD_ID + ' .dqc-note{color:var(--dsw-alias-label-secondary);font-size:11px;text-align:center;line-height:1.5}',
      '#' + CARD_ID + ' .dqc-note.is-clamp{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}',
      '#' + CARD_ID + ' .dqc-window{color:var(--dsw-alias-state-warn-primary);font-weight:600;text-align:center;',
      'font-size:12.5px;letter-spacing:.2px;font-variant-numeric:tabular-nums;line-height:1.5}',
      '#' + CARD_ID + ' .dqc-status{text-align:center;font-weight:600;font-size:11px;line-height:1.6}',
      '#' + CARD_ID + ' .dqc-status.is-peak{color:var(--dsw-alias-state-warn-primary)}',
      '#' + CARD_ID + ' .dqc-status.is-offpeak{color:var(--dsw-alias-state-success-primary)}',
      '#' + CARD_ID + ' .dqc-foot{font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center;opacity:.85;flex:none}',
      '#' + CARD_ID + ' .dqc-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:middle}',
      '#' + CARD_ID + ' .dqc-resize{flex:none;height:9px;margin-top:2px;cursor:ns-resize;border-radius:0 0 10px 10px;',
      'display:flex;align-items:center;justify-content:center;touch-action:none}',
      '#' + CARD_ID + ' .dqc-resize::after{content:"";width:26px;height:2px;border-radius:1px;',
      'background:var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,.4)))}',
      '#' + CARD_ID + ' .dqc-resize:hover::after{background:var(--dsw-alias-brand-primary)}',
      '#' + CARD_ID + '.is-resizing,#' + CARD_ID + '.is-resizing .dqc-resize{cursor:ns-resize}',
      '#' + CARD_ID + '.is-loading{opacity:.75}',
    ].join('\n');

    /** Insert or refresh the stylesheet; the host hot-swaps bundles in place. */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      var tag = document.getElementById(STYLE_ID);
      if (tag === null) {
        tag = document.createElement('style');
        tag.id = STYLE_ID;
        document.head.appendChild(tag);
      }
      if (tag.textContent !== CSS) tag.textContent = CSS;
    }

    // ── formatting ───────────────────────────────────────────────────────────
    // Mirrors the same-named helpers in lib/pricing.js, which this bundle cannot
    // import (it is a CommonJS-style factory with no ESM interop).

    /**
     * Compact token count: `999`, `1.2K`, `15.5M`, `1.05B`, `2.3T`.
     * Values below 1000 stay exact; larger ones keep at most three significant
     * digits, carrying into the next unit when rounding crosses 1000.
     */
    function formatTokens(value) {
      if (!isFinite(value)) return '--';
      var sign = value < 0 ? '-' : '';
      var abs = Math.abs(value);
      if (abs < 1000) return sign + String(Math.round(abs));
      var units = ['K', 'M', 'B', 'T'];
      var scaled = abs;
      var unit = -1;
      while (scaled >= 1000 && unit < units.length - 1) {
        scaled /= 1000;
        unit += 1;
      }
      var text = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
      if (text.indexOf('.') >= 0) text = text.replace(/0+$/, '').replace(/\.$/, '');
      // Carry 999.9K -> 1M so a value rounded at the unit boundary stays true.
      if (Number(text) >= 1000 && unit < units.length - 1) return sign + '1' + units[unit + 1];
      return sign + text + units[unit];
    }

    function formatPercent(rate) {
      if (rate === null || rate === undefined || !isFinite(rate)) return '--';
      return (rate * 100).toFixed(1) + '%';
    }

    function formatMoney(value, currency) {
      if (!isFinite(value)) return '--';
      var symbol = currency === 'USD' ? '$' : '\u00a5';
      var abs = Math.abs(value);
      if (abs === 0) return symbol + '0.00';
      if (abs < 0.01) return symbol + value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      return symbol + value.toFixed(2);
    }

    function formatDuration(ms) {
      if (!isFinite(ms) || ms < 0) return '--';
      var minutes = Math.max(0, Math.round(ms / 60000));
      if (minutes < 60) return String(minutes) + 'm';
      var hours = Math.floor(minutes / 60);
      var rest = minutes % 60;
      if (hours < 24) return rest === 0 ? String(hours) + 'h' : hours + 'h ' + rest + 'm';
      var days = Math.floor(hours / 24);
      var hourRest = hours % 24;
      return hourRest === 0 ? String(days) + 'd' : days + 'd ' + hourRest + 'h';
    }

    function pad2(value) {
      var text = String(value);
      return text.length < 2 ? '0' + text : text;
    }

    // ── peak / off-peak (local mirror of lib/pricing.js) ─────────────────────
    // Computed locally so the countdown and the peak/off-peak flip are exact
    // without waiting for the next poll. The rule and the holiday calendar come
    // from the snapshot, so the Host stays the single source of truth.

    var partFormatters = {};

    function partsFormatter(timeZone) {
      var cached = partFormatters[timeZone];
      if (cached === undefined) {
        cached = new Intl.DateTimeFormat('en-US', {
          timeZone: timeZone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        partFormatters[timeZone] = cached;
      }
      return cached;
    }

    /** Zone-local calendar fields, or null when the zone name is unusable. */
    function zoneParts(at, timeZone) {
      var fields;
      try {
        fields = partsFormatter(timeZone).formatToParts(new Date(at));
      } catch (error) {
        void error;
        return null;
      }
      var out = {};
      for (var i = 0; i < fields.length; i++) out[fields[i].type] = fields[i].value;
      var year = Number(out.year);
      var month = Number(out.month);
      var day = Number(out.day);
      var dayIso = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
      return {
        year: year,
        month: month,
        day: day,
        hours: Number(out.hour) % 24,
        minutes: Number(out.minute),
        dayIso: dayIso,
        monthDay: pad2(month) + '-' + pad2(day),
      };
    }

    /**
     * `HH:MM` (or `H:MM`) -> minutes since midnight. `24:00` is the accepted
     * end-of-day form (1440), matching the Host's canonical window shape;
     * anything outside the day is rejected so a bad window can never make the
     * card claim a nonsensical tier.
     */
    function toMinutes(text) {
      var match = /^(\d{1,2}):(\d{2})$/.exec(String(text));
      if (match === null) return null;
      var hours = Number(match[1]);
      var mins = Number(match[2]);
      if (mins > 59) return null;
      if (hours === 24 && mins === 0) return 1440;
      if (hours < 0 || hours > 23) return null;
      return hours * 60 + mins;
    }

    /** Accept `MM-DD` and `YYYY-MM-DD` holiday entries alike. */
    function monthDayOf(entry) {
      var text = String(entry);
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : text;
    }

    /**
     * Whether `entries` names the given zone-local day. `entries` is always ONE
     * year's flat `["MM-DD", …]` list (the Host already resolved the year — it
     * sends the running year's table, or an empty list when that year has none).
     * A `{Y: [...]}` map is recognized and ignored rather than misread as a list
     * of literal date strings.
     */
    function matchesDay(entries, parts) {
      if (!Array.isArray(entries)) return false;
      if (entries.length > 0 && /^\d{4}$/.test(String(entries[0]))) return false;
      for (var i = 0; i < entries.length; i++) if (monthDayOf(entries[i]) === parts.monthDay) return true;
      return false;
    }

    function windowsOf(config) {
      var windows = [];
      var pairs = Array.isArray(config.peakWindows) ? config.peakWindows : [];
      for (var i = 0; i < pairs.length; i++) {
        var start = toMinutes(pairs[i] && pairs[i].start);
        var end = toMinutes(pairs[i] && pairs[i].end);
        if (start === null || end === null || end <= start) continue;
        windows.push({ start: start, end: end });
      }
      windows.sort(function (a, b) {
        return a.start - b.start;
      });
      return windows;
    }

    function isPeakDay(parts, config) {
      if (matchesDay(config.holidays, parts)) return false; // holidays win out
      if ((config.peakDays || []).indexOf(parts.dayIso) >= 0) return true;
      return config.countMakeupAsPeak === true && matchesDay(config.makeupWorkdays, parts);
    }

    function minutesOf(parts) {
      return parts.hours * 60 + parts.minutes;
    }

    /**
     * The given minute of day, as an epoch instant on the parts' local day. The
     * zone offset is read at `at` (not at the target), which is exact for a zone
     * without a DST transition in that span — true for Asia/Shanghai since 1991.
     */
    function atMinuteOfDay(at, parts, timeZone, minuteOfDay) {
      var naive = Date.UTC(parts.year, parts.month - 1, parts.day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
      var seen = minutesOf(zoneParts(at, timeZone));
      return naive - (Date.UTC(parts.year, parts.month - 1, parts.day, Math.floor(seen / 60), seen % 60) - Math.floor(at / 60000) * 60000);
    }

    /**
     * The tier in force at `at`, when it next changes, and the day's character.
     * @returns {null|{peak:boolean,nextChangeAt:number|null,holiday:boolean,makeup:boolean,date:string,windows:object[]}}
     */
    function resolveTier(at, config) {
      var timeZone = config.timezone || 'Asia/Shanghai';
      var parts = zoneParts(at, timeZone);
      if (parts === null) return null;
      var windows = windowsOf(config);
      var minutes = minutesOf(parts);
      var peakDay = isPeakDay(parts, config);
      var inside = false;
      for (var i = 0; i < windows.length; i++) {
        if (minutes >= windows[i].start && minutes < windows[i].end) inside = true;
      }
      var peak = peakDay && inside;
      var next = null;
      // A rule with no window never changes tier. A rule with no peak DAY can
      // still be peak via `countMakeupAsPeak`, so that case must not exit here.
      if (windows.length === 0) {
        return {
          peak: peak,
          nextChangeAt: null,
          holiday: matchesDay(config.holidays, parts),
          makeup: matchesDay(config.makeupWorkdays, parts),
          date: parts.year + '-' + parts.monthDay,
          windows: windows,
        };
      }
      if (peak) {
        // Leaving peak: the nearest peak-window end today.
        var remaining = null;
        for (var j = 0; j < windows.length; j++) {
          if (minutes < windows[j].start || minutes >= windows[j].end) continue;
          var left = windows[j].end - minutes;
          if (left > 0 && (remaining === null || left < remaining)) remaining = left;
        }
        if (remaining !== null) next = at + remaining * 60000;
      } else {
        // Entering peak: a LATER window TODAY, but only when today is a peak
        // day. On a weekend or holiday a later window is not a tier change, so
        // fall through to the next peak day instead.
        if (peakDay) {
          var soonest = null;
          for (var k = 0; k < windows.length; k++) {
            var delta = windows[k].start - minutes;
            if (delta > 0 && (soonest === null || delta < soonest)) soonest = delta;
          }
          if (soonest !== null) next = at + soonest * 60000;
        }
        if (next === null) {
          // Next peak day. The walk clears the longest holiday block: 春节 2026
          // runs 02-15..02-23, so a single week is not enough.
          var cursorAt = at;
          var cursorParts = parts;
          for (var step = 0; step < MAX_PEAK_WALK_DAYS; step += 1) {
            var midnight = atMinuteOfDay(cursorAt, cursorParts, timeZone, 1440);
            var nextParts = zoneParts(midnight + 60000, timeZone);
            if (nextParts === null) break;
            cursorAt = midnight;
            cursorParts = nextParts;
            if (isPeakDay(nextParts, config)) {
              // `atMinuteOfDay` already resolves the exact local window start.
              next = atMinuteOfDay(cursorAt, nextParts, timeZone, windows[0].start);
              break;
            }
          }
        }
      }
      return {
        peak: peak,
        nextChangeAt: next,
        holiday: matchesDay(config.holidays, parts),
        makeup: matchesDay(config.makeupWorkdays, parts),
        date: parts.year + '-' + parts.monthDay,
        windows: windows,
      };
    }

    // ── i18n ─────────────────────────────────────────────────────────────────

    var zh = {
      title: '\u989d\u5ea6\u6982\u89c8',
      balance: '\u4f59\u989d',
      today: '\u4eca\u65e5\u7528\u91cf',
      month: '\u672c\u6708\u7528\u91cf',
      cacheHit: '\u7f13\u5b58\u547d\u4e2d',
      costToday: '\u4eca\u65e5\u4f30\u7b97',
      costMonth: '\u672c\u6708\u4f30\u7b97',
      lifetimeCost: '\u7d2f\u8ba1\u6d88\u8d39',
      lifetimeTokens: '\u7d2f\u8ba1\u7528\u91cf',
      sinceInstall: '\u81ea\u672c\u63d2\u4ef6\u5b89\u88c5\u8d77\u7d2f\u8ba1\uff08\u672c\u5730\u8d26\u672c\uff09',
      platformSource: '\u6765\u81ea DeepSeek \u5f00\u653e\u5e73\u53f0\u5386\u53f2\u8bb0\u5f55',
      tokensBilled: '\u8ba1\u8d39 token\uff08\u672a\u547d\u4e2d\u7f13\u5b58 + \u7f13\u5b58\u5199\u5165 + \u8f93\u51fa\uff09',
      tokensCached: '\u7f13\u5b58\u547d\u4e2d\u8bfb\u53d6\uff08\u4ec5\u7ea6 2% \u4ef7\uff09',
      tokensTotal: 'token \u603b\u548c\uff08\u542b\u7f13\u5b58\u8bfb\u53d6\uff09',
      requests: '\u6b21\u8bf7\u6c42',
      peakPeriod: '\u9ad8\u5cf0\u65f6\u6bb5\uff1a\u5468\u4e00\u81f3\u5468\u4e94',
      offPeakNote: '\uff08\u5176\u4f59\u4e3a\u7a7a\u95f2\u65f6\u6bb5\uff09',
      peakNow: '\u9ad8\u5cf0\u4e2d',
      offPeakNow: '\u7a7a\u95f2\u65f6\u6bb5',
      remaining: '\u5269\u4f59',
      discount: '5 \u6298',
      loading: '\u52a0\u8f7d\u4e2d\u2026',
      refresh: '\u5237\u65b0',
      toggleCost: '\u663e\u793a/\u9690\u85cf\u4f30\u7b97\u8d39\u7528',
      resize: '\u4e0a\u4e0b\u62d6\u52a8\u8c03\u6574\u5361\u7247\u9ad8\u5ea6\uff08\u53cc\u51fb\u6062\u590d\u81ea\u9002\u5e94\uff09',
      noApiKey: '\u672a\u914d\u7f6e API Key',
      noCredentials: '\u672a\u767b\u5f55 \u00b7 \u672a\u914d\u7f6e API Key',
      signedOut: '\u672a\u767b\u5f55',
      accountUnavailable: '\u8d26\u53f7\u51ed\u8bc1\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55',
      unavailable: '\u4e0d\u53ef\u7528',
      holidayToday: '\u4eca\u65e5\u4e3a\u6cd5\u5b9a\u8282\u5047\u65e5\uff0c\u5168\u5929\u6309\u7a7a\u95f2\u8ba1\u4ef7',
      makeupToday: '\u4eca\u65e5\u4e3a\u8c03\u4f11\u4e0a\u73ed\u65e5',
      stale: '\u6700\u8fd1\u4e00\u6b21\u5237\u65b0\u5931\u8d25\uff0c\u663e\u793a\u7684\u662f\u4e0a\u6b21\u6210\u529f\u7684\u6570\u636e',
      holidayTable: '\u8282\u5047\u65e5\u8868',
      unknown: '\u672a\u77e5',
      updatedAt: '\u66f4\u65b0\u4e8e',
    };

    var en = {
      title: 'Quota',
      balance: 'Balance',
      today: 'Today',
      month: 'This month',
      cacheHit: 'Cache hit',
      costToday: 'Today (est.)',
      costMonth: 'Month (est.)',
      lifetimeCost: 'Total spend',
      lifetimeTokens: 'Total tokens',
      sinceInstall: 'counted locally, since this plugin was installed',
      platformSource: 'from the DeepSeek platform account history',
      tokensBilled: 'Billed tokens (cache miss + cache write + output)',
      tokensCached: 'Cache-hit reads (billed at ~2%)',
      tokensTotal: 'Total tokens (including cache reads)',
      requests: 'requests',
      peakPeriod: 'Peak: Mon\u2013Fri',
      offPeakNote: '(all other hours are off-peak)',
      peakNow: 'Peak',
      offPeakNow: 'Off-peak',
      remaining: 'in',
      discount: '50% off',
      loading: 'Loading\u2026',
      refresh: 'Refresh',
      toggleCost: 'Show/hide the estimated cost',
      resize: 'Drag to resize the card (double click for auto height)',
      noApiKey: 'No API key configured',
      noCredentials: 'Not signed in \u00b7 no API key',
      signedOut: 'Not signed in',
      accountUnavailable: 'Account credential expired \u2014 sign in again',
      unavailable: 'Unavailable',
      holidayToday: 'Public holiday today \u2014 off-peak all day',
      makeupToday: 'Make-up working day today',
      stale: 'Last refresh failed; showing the previous reading',
      holidayTable: 'Holiday table',
      unknown: 'unknown',
      updatedAt: 'Updated',
    };

    // ── icons ────────────────────────────────────────────────────────────────

    var PATH_REFRESH = 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5H10';
    var PATH_GEAR = 'M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2Z'
      + 'M8 1.6l.6 1.5 1.6-.3.6 1.5 1.5.6-.3 1.6L13.4 8l-1.4 1.5.3 1.6-1.5.6-.6 1.5-1.6-.3L8 14.4l-.6-1.5-1.6.3-.6-1.5-1.5-.6.3-1.6L2.6 8'
      + 'l1.4-1.5-.3-1.6 1.5-.6.6-1.5 1.6.3L8 1.6Z';

    function svgIcon(path) {
      return react.createElement(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        react.createElement('path', { d: path }),
      );
    }

    // ── component ────────────────────────────────────────────────────────────

    function readCostPreference() {
      try {
        var raw = window.localStorage.getItem(COST_KEY);
        if (raw === '1') return true;
        if (raw === '0') return false;
      } catch (error) {
        void error;
      }
      return false;
    }

    /** The stored card height, or null for auto (hug the content). */
    function readStoredHeight() {
      try {
        var raw = window.localStorage.getItem(HEIGHT_KEY);
        if (raw === null) return null;
        var value = Number(raw);
        if (!isFinite(value)) return null;
        if (value < MIN_BODY_HEIGHT) return null;
        if (value > MAX_BODY_HEIGHT) return MAX_BODY_HEIGHT;
        return Math.round(value);
      } catch (error) {
        void error;
        return null;
      }
    }

    /** Wire error code -> dictionary key, for codes that have one. */
    function balanceErrorKey(code) {
      if (code === 'no-credentials') return 'noCredentials';
      if (code === 'no-api-key') return 'noApiKey';
      if (code === 'account-unavailable') return 'accountUnavailable';
      return null;
    }

    function QuotaCard(props) {
      var t = props.t;
      var snapshotState = react.useState(null);
      var snapshot = snapshotState[0];
      var setSnapshot = snapshotState[1];
      var statusState = react.useState('loading');
      var status = statusState[0];
      var setStatus = statusState[1];
      var detailState = react.useState('');
      var detail = detailState[0];
      var setDetail = detailState[1];
      var tickState = react.useState(0);
      var setTick = tickState[1];
      var costState = react.useState(readCostPreference);
      var showCost = costState[0];
      var setShowCost = costState[1];
      // null = auto height (fits the content); a number = the user's own size.
      var bodyState = react.useState(readStoredHeight);
      var bodyHeight = bodyState[0];
      var setBodyHeight = bodyState[1];
      var resizingState = react.useState(false);
      var resizing = resizingState[0];
      var setResizing = resizingState[1];
      var lastGoodRef = react.useRef(null);
      var mountedRef = react.useRef(true);
      var bodyRef = react.useRef(null);
      var heightRef = react.useRef(bodyHeight);
      heightRef.current = bodyHeight;
      /** The height auto mode currently renders at, so a drag starts where the card is. */
      var autoHeightRef = react.useRef(null);

      function load() {
        return fetch(SNAPSHOT_URL, { cache: 'no-store' })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then(function (data) {
            if (!mountedRef.current) return;
            if (!data || data.ok !== true) throw new Error('unexpected payload');
            lastGoodRef.current = data;
            setSnapshot(data);
            setStatus('ready');
            setDetail('');
          })
          .catch(function (error) {
            if (!mountedRef.current) return;
            // Keep the last good reading on screen instead of flashing an error.
            setStatus(lastGoodRef.current === null ? 'error' : 'stale');
            setDetail(String(error && error.message ? error.message : error));
          });
      }

      react.useEffect(function () {
        mountedRef.current = true;
        ensureStyle();
        load();
        var poll = window.setInterval(load, POLL_MS);
        var tick = window.setInterval(function () {
          setTick(function (value) {
            return value + 1;
          });
        }, TICK_MS);
        return function () {
          mountedRef.current = false;
          window.clearInterval(poll);
          window.clearInterval(tick);
        };
      }, []);

      function toggleCost() {
        var next = !showCost;
        setShowCost(next);
        try {
          window.localStorage.setItem(COST_KEY, next ? '1' : '0');
        } catch (error) {
          void error;
        }
      }

      /**
       * Drag the strip under the card to choose its height. The value is stored
       * locally so it survives reloads; dragging back down to the minimum
       * clears it and returns to auto height.
       */
      function startResize(event) {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        var startY = event.clientY;
        var current = heightRef.current;
        var auto = autoHeightRef.current;
        var startHeight = current ?? auto ?? MIN_BODY_HEIGHT;
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch (error) {
            void error;
          }
        }
        setResizing(true);
        var move = function (moveEvent) {
          // A drag owns the height from the first move on: drop the measured
          // auto height so the observer's inline style cannot fight the drag.
          autoHeightRef.current = null;
          var next = startHeight + (moveEvent.clientY - startY);
          if (next < MIN_BODY_HEIGHT) next = MIN_BODY_HEIGHT;
          if (next > MAX_BODY_HEIGHT) next = MAX_BODY_HEIGHT;
          setBodyHeight(Math.round(next));
        };
        var stop = function () {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
          setResizing(false);
          var settled = heightRef.current;
          try {
            // Dragging all the way down means "auto": forget the stored size.
            if (settled === null || settled <= MIN_BODY_HEIGHT) window.localStorage.removeItem(HEIGHT_KEY);
            else window.localStorage.setItem(HEIGHT_KEY, String(settled));
          } catch (error) {
            void error;
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
      }

      // With no stored height the card hugs its content, but it must never grow
      // past the bottom of the window: a tall card in a short window would
      // otherwise be clipped by the sidebar's own overflow, taking its rows out
      // of reach. Measuring the card's own bounds keeps the two goals apart.
      react.useEffect(function () {
        if (bodyHeight !== null) return undefined;
        var node = bodyRef.current;
        if (node === null || typeof ResizeObserver !== 'function') return undefined;
        var card = node.parentElement;
        if (card === null) return undefined;
        var observer = new ResizeObserver(function () {
          var cardTop = card.getBoundingClientRect().top;
          var available = Math.round(window.innerHeight - cardTop - CARD_CHROME);
          if (available < MIN_BODY_HEIGHT) available = MIN_BODY_HEIGHT;
          var next = Math.min(node.scrollHeight, available, MAX_BODY_HEIGHT);
          node.style.height = next + 'px';
          autoHeightRef.current = next;
        });
        observer.observe(node);
        return function () {
          observer.disconnect();
        };
      }, [bodyHeight]);

      var now = Date.now();
      var config = snapshot && snapshot.config ? snapshot.config : {};
      var timeZone = config.timezone || 'Asia/Shanghai';
      // No snapshot yet means no rule yet: do not claim a tier before the Host
      // has told us which rule is in force.
      var tier = snapshot === null ? null : resolveTier(now, config);
      var usage = snapshot && snapshot.usage ? snapshot.usage : {};
      var today = usage.today || null;
      var month = usage.month || null;
      var life = usage.lifetime || null;
      var platform = snapshot && snapshot.platform ? snapshot.platform : null;
      var balance = snapshot && snapshot.balance ? snapshot.balance : null;
      var showEstimatedCost = showCost || config.showCost === true;

      var balanceValue;
      var balanceClass = 'dqc-value is-balance';
      var balanceTitle;
      if (balance === null || balance === undefined) {
        balanceValue = status === 'loading' ? t('loading') : '--';
        balanceClass = 'dqc-value is-muted';
      } else if (balance.error !== undefined) {
        // A missing credential is a state, not a failure: keep it in the muted
        // color so the card does not shout at a correctly configured plugin.
        balanceClass = balance.error === 'account-unavailable' || balance.error === 'no-credentials' || balance.error === 'no-api-key'
          ? 'dqc-value is-muted'
          : 'dqc-value is-error';
        var errorKey = balanceErrorKey(balance.error);
        balanceValue = errorKey === null ? t('unavailable') + ' (' + balance.error + ')' : t(errorKey);
        if (balance.detail) balanceTitle = String(balance.detail);
        // A transient failure still shows the last good reading, marked stale.
        if (balance.stale) {
          balanceClass = 'dqc-value is-balance';
          balanceValue = formatMoney(balance.stale.balance, balance.stale.currency);
          balanceTitle = t('stale');
        }
      } else {
        balanceValue = formatMoney(balance.balance, balance.currency);
        if (balance.granted !== undefined || balance.toppedUp !== undefined) {
          balanceTitle = '\u8d60\u9001 ' + formatMoney(balance.granted || 0, balance.currency)
            + ' \u00b7 \u5145\u503c ' + formatMoney(balance.toppedUp || 0, balance.currency);
        }
      }

      var rows = [
        { key: 'balance', label: t('balance'), value: balanceValue, className: balanceClass, title: balanceTitle },
        { key: 'today', label: t('today'), value: today === null ? '--' : formatTokens(today.tokens) },
        { key: 'month', label: t('month'), value: month === null ? '--' : formatTokens(month.tokens) },
        { key: 'cache', label: t('cacheHit'), value: today === null ? '--' : formatPercent(today.cacheHitRate) },
      ];
      // Prefer the console's account-wide history when it is available; fall back
      // to the local ledger's own range, labelled so the difference is obvious.
      var hasPlatform = platform !== null && platform.error === undefined && platform.cost !== undefined;
      if (hasPlatform) {
        var platformSpan = (platform.oldestMonth || '?') + ' ~ ' + (platform.newestMonth || '?');
        // The raw token sum is dominated by cache reads (~98%), which are billed
        // at about a fiftieth of a cache miss. The headline shows the BILLED
        // tokens so the number beside the money means something, and the tooltip
        // breaks the total down.
        var billedTokens = platform.billed === undefined ? platform.tokens : platform.billed;
        rows.push({
          key: 'lifeCost',
          label: t('lifetimeCost'),
          value: formatMoney(platform.cost, platform.currency || 'CNY'),
          title: platformSpan + '\n' + t('platformSource'),
        });
        rows.push({
          key: 'lifeTokens',
          label: t('lifetimeTokens'),
          value: formatTokens(billedTokens),
          title: platformSpan + '\n' + t('platformSource')
            + '\n' + t('tokensBilled') + ': ' + formatTokens(billedTokens)
            + '\n' + t('tokensCached') + ': ' + formatTokens(platform.cacheHits || 0)
            + '\n' + t('tokensTotal') + ': ' + formatTokens(platform.tokens)
            + '\n' + formatTokens(platform.requests) + ' ' + t('requests'),
        });
      } else if (life !== null) {
        rows.push({
          key: 'lifeCost',
          label: t('lifetimeCost'),
          value: formatMoney(life.cost, 'CNY') + (life.costApproximate ? '*' : ''),
          title: (life.from || '--') + ' ~ ' + (life.to || '--') + '\n' + t('sinceInstall'),
        });
        rows.push({
          key: 'lifeTokens',
          label: t('lifetimeTokens'),
          value: formatTokens(life.tokens),
          title: (life.from || '--') + ' ~ ' + (life.to || '--') + '\n' + t('sinceInstall'),
        });
      }
      if (showEstimatedCost) {
        rows.push({
          key: 'costToday',
          label: t('costToday'),
          value: today === null ? '--' : formatMoney(today.cost, 'CNY') + (today.costApproximate ? '*' : ''),
        });
        rows.push({
          key: 'costMonth',
          label: t('costMonth'),
          value: month === null ? '--' : formatMoney(month.cost, 'CNY') + (month.costApproximate ? '*' : ''),
        });
      }

      var statusText;
      var statusClass = 'dqc-status';
      if (tier === null) {
        statusClass += ' is-offpeak';
        // Before the first snapshot we know neither the rule nor the tier.
        statusText = snapshot === null ? t('loading') : t('offPeakNow') + ' (' + t('unknown') + ')';
      } else {
        var left = tier.nextChangeAt === null ? '' : '\u00a0\u00b7\u00a0' + t('remaining') + ' ' + formatDuration(tier.nextChangeAt - now);
        if (tier.peak) {
          statusClass += ' is-peak';
          statusText = t('peakNow') + left;
        } else {
          statusClass += ' is-offpeak';
          statusText = t('offPeakNow') + '\u00a0(' + t('discount') + ')' + left;
        }
      }

      var windowText = '--';
      if (tier !== null && tier.windows.length > 0) {
        windowText = tier.windows
          .map(function (window) {
            return clockText(window.start) + '-' + clockText(window.end);
          })
          .join('\u00a0\u00a0');
      }

      // Everything except the header and the resize strip lives in one scrollable
      // body, so a user-chosen short height degrades to scrolling instead of
      // hiding rows.
      var bodyChildren = [
        react.createElement(
          'div',
          { className: 'dqc-rows', key: 'rows' },
          rows.map(function (row) {
            return react.createElement(
              'div',
              { className: 'dqc-row', key: row.key },
              [
                react.createElement('span', { className: 'dqc-label', key: 'label' }, row.label),
                react.createElement('span', { className: row.className, key: 'value', title: row.title }, row.value),
              ],
            );
          }),
        ),
        react.createElement('div', { className: 'dqc-divider', key: 'divider' }),
        react.createElement('div', { className: 'dqc-note', key: 'period' }, t('peakPeriod')),
        react.createElement('div', { className: 'dqc-window', key: 'window' }, windowText),
        react.createElement('div', { className: 'dqc-note', key: 'offpeak' }, t('offPeakNote')),
        react.createElement('div', { className: statusClass, key: 'status' }, statusText),
      ];
      if (tier !== null && tier.holiday) {
        bodyChildren.push(react.createElement('div', { className: 'dqc-note', key: 'holiday' }, t('holidayToday')));
      } else if (tier !== null && tier.makeup && config.countMakeupAsPeak === true) {
        bodyChildren.push(react.createElement('div', { className: 'dqc-note', key: 'makeup' }, t('makeupToday')));
      }
      if (typeof config.note === 'string' && config.note !== '') {
        bodyChildren.push(react.createElement('div', { className: 'dqc-note', key: 'note' }, config.note));
      }
      bodyChildren.push(
        react.createElement(
          'div',
          { className: 'dqc-foot', key: 'foot', title: detail },
          [
            react.createElement('span', { className: 'dqc-dot', key: 'dot', style: { background: dotColor(status) } }),
            react.createElement('span', { key: 'text' }, footText(t, config, status, detail)),
          ],
        ),
      );

      var bodyStyle = bodyHeight === null ? undefined : { height: bodyHeight + 'px', flex: 'none' };
      var children = [
        react.createElement(
          'div',
          { className: 'dqc-head', key: 'head' },
          [
            react.createElement('span', { className: 'dqc-title', key: 'title' }, t('title')),
            react.createElement(
              'div',
              { className: 'dqc-actions', key: 'actions' },
              [
                react.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dqc-icon',
                    key: 'refresh',
                    title: t('refresh'),
                    'aria-label': t('refresh'),
                    onClick: function () {
                      setStatus('loading');
                      load();
                    },
                  },
                  svgIcon(PATH_REFRESH),
                ),
                react.createElement(
                  'button',
                  {
                    type: 'button',
                    className: showEstimatedCost ? 'dqc-icon is-active' : 'dqc-icon',
                    key: 'gear',
                    title: t('toggleCost'),
                    'aria-label': t('toggleCost'),
                    'aria-pressed': showEstimatedCost,
                    onClick: toggleCost,
                  },
                  svgIcon(PATH_GEAR),
                ),
              ],
            ),
          ],
        ),
        react.createElement('div', { className: 'dqc-body', key: 'body', ref: bodyRef, style: bodyStyle }, bodyChildren),
        react.createElement('div', {
          className: 'dqc-resize',
          key: 'resize',
          role: 'separator',
          'aria-orientation': 'horizontal',
          'aria-label': t('resize'),
          title: t('resize'),
          onPointerDown: startResize,
          onDoubleClick: function () {
            // Double click returns to auto height: clear the stored size and let
            // the observer measure the content again.
            autoHeightRef.current = null;
            if (bodyRef.current !== null) bodyRef.current.style.height = '';
            setBodyHeight(null);
            try {
              window.localStorage.removeItem(HEIGHT_KEY);
            } catch (error) {
              void error;
            }
          },
        }),
      ];

      return react.createElement(
        'div',
        {
          id: CARD_ID,
          'data-plugin': 'dsh-quota-card',
          'data-status': status,
          'data-tier': tier === null ? 'unknown' : tier.peak ? 'peak' : 'off-peak',
          'data-height': bodyHeight === null ? 'auto' : String(bodyHeight),
          className: resizing ? 'is-resizing' : undefined,
        },
        children,
      );
    }

    /** Minutes since midnight -> `9:00` (the compact form the card shows). */
    function clockText(minutes) {
      var hours = Math.floor(minutes / 60);
      var rest = minutes % 60;
      return hours + ':' + pad2(rest);
    }

    function dotColor(status) {
      if (status === 'error') return 'var(--dsw-alias-state-error-primary)';
      if (status === 'stale') return 'var(--dsw-alias-state-warn-primary)';
      if (status === 'loading') return 'var(--dsw-alias-state-idle-primary)';
      return 'var(--dsw-alias-state-success-primary)';
    }

    function footText(t, config, status, detail) {
      if (status === 'error') return t('unavailable') + (detail ? ': ' + detail : '');
      if (status === 'stale') return t('stale');
      if (status === 'loading') return t('loading');
      if (config.holidayYear === null || config.holidayYear === undefined) {
        return t('holidayTable') + ': ' + t('unknown');
      }
      return t('updatedAt') + ' ' + new Date().toLocaleTimeString();
    }

    // ── registration ─────────────────────────────────────────────────────────

    function apply(ctx) {
      if (ctx === null || ctx === undefined) return;
      var slots = ctx.slots;
      if (slots === undefined || slots === null) return;

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          ensureStyle();
          return function () {
            var tag = document.getElementById(STYLE_ID);
            if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag);
          };
        }, 'dsh-quota-card: stylesheet');
      } else {
        ensureStyle();
      }

      if (ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.register === 'function') {
        var register = function () {
          return ctx.locale.register('dsh-quota-card', { zh: zh, en: en });
        };
        if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-quota-card: dictionaries');
        else register();
      }

      slots.inject('sidebar.footer.action', function () {
        return slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-quota-card', order: -1, locale: 'dsh-quota-card' },
          function (props) {
            // Rail mode is 56px wide and the card lives on words, so it stays out.
            if (props && props.wide === false) return null;
            var t = props && typeof props.t === 'function' ? props.t : function (key) { return key; };
            return react.createElement(QuotaCard, { t: t });
          },
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
