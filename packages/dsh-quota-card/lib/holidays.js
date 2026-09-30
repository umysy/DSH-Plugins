/**
 * dsh-quota-card — Chinese statutory holiday table.
 *
 * DeepSeek's official peak/off-peak rule reads:
 *   "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
 *    excluding Chinese public holidays. All other hours are off-peak, including
 *    weekends and Chinese public holidays in full."
 * So a statutory holiday is off-peak all day, and a weekend is off-peak all day.
 *
 * Source for 2026: 国务院办公厅关于2026年部分节假日安排的通知（国办发明电〔2025〕7号，
 * 2025-11-04）— https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 *
 * SHAPE IS LOAD-BEARING: both maps are `{ "YYYY": ["MM-DD", …] }`. The dates are
 * flat per year because that is exactly what `lib/config.js` normalizes user
 * config into and what `lib/pricing.js` `pickYear()`/`expandDates()` consume. A
 * festival-keyed nesting here would silently disable the whole table, so keep it
 * flat and let the comments below carry the festival names.
 *
 * Refresh each November, when the State Council publishes the next year's
 * notice. While the running year is missing the rule degrades to
 * "weekdays only", and the card says so in its footer.
 */

/** Where each year's dates came from, for the README and for review. */
export const HOLIDAY_SOURCES = {
  '2026': 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
};

/** Statutory days off: off-peak all day. */
export const HOLIDAYS = {
  '2026': [
    // 元旦 3d
    '01-01', '01-02', '01-03',
    // 春节 9d
    '02-15', '02-16', '02-17', '02-18', '02-19', '02-20', '02-21', '02-22', '02-23',
    // 清明节 3d
    '04-04', '04-05', '04-06',
    // 劳动节 5d
    '05-01', '05-02', '05-03', '05-04', '05-05',
    // 端午节 3d
    '06-19', '06-20', '06-21',
    // 中秋节 3d
    '09-25', '09-26', '09-27',
    // 国庆节 7d
    '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07',
  ],
};

/**
 * 调休 (make-up) weekends that are working days. The official pricing text
 * states the rule purely in weekday terms and does not mention them, so by
 * default this plugin does NOT treat them as peak. Set `countMakeupAsPeak: true`
 * in the plugin config to follow official billing if you observe peak rates on
 * those days.
 */
export const MAKEUP_WORKDAYS = {
  '2026': ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10'],
};
