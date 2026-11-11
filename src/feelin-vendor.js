/**
 * vendored: feelin —— 这是第三方代码，**不要手改**。
 *
 * 版本：feelin@8.2.0
 * 许可：MIT（完整文本见仓库根 THIRD-PARTY.md，随包分发）
 * 来源：npm pack feelin@8.2.0（https://github.com/camunda/feelin）
 * tarball shasum：78793b2e6372a5dcb0fd2215eceaafd6f8088798
 * tarball integrity：sha512-o/oUBp7hzcsupV3Pf+Kn+43y+gul/sSVqYYkJq9+hkYuFuBfk0rocy//H2goKlWJJbuONnE59Iqb4U34VyZpjA==
 * 打包：esbuild@0.28.2 --bundle --format=esm --platform=neutral（未压缩）
 * 依赖闭包（版本已锁定；各包许可与版权见 THIRD-PARTY.md）：@lezer/common@1.5.5（MIT）、@lezer/highlight@1.2.5（MIT）、@lezer/lr@1.4.12（MIT）、lezer-feel@3.0.1（MIT）、min-dash@5.1.0（MIT）、temporal-polyfill@1.0.8（MIT）、temporal-spec@1.0.1（Apache-2.0）、temporal-utils@1.0.4（MIT）
 *
 * 重新生成：node scripts/vendor-bpmn.mjs（升级改脚本顶部的 VENDORED / CLOSURE 常量）
 * 校验产物：node scripts/vendor-bpmn.mjs --check
 *
 * 本仓库对它只做 bundle，未修改其逻辑；如需打补丁，请在此头部写明 patch 内容，
 * 并同步更新 scripts/vendor-bpmn.mjs，保证「重新生成」仍能复现。
 */

// The MIT License (MIT)
//
// Copyright (c) 2019-present Nico Rehwaldt
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// node_modules/temporal-polyfill/chunks/root.js
var NativeTemporal = globalThis.Temporal;

// node_modules/temporal-utils/dist/errorMessages.js
var expectedPositive = (entityName, num) => `Non-positive ${entityName}: ${num}`;
var expectedFinite = (entityName, num) => `Non-finite ${entityName}: ${num}`;
var forbiddenBigIntToNumber = (entityName) => `Cannot convert bigint to ${entityName}`;
var invalidObject = "Invalid object";
var numberOutOfRange = (entityName, val, min, max) => invalidEntity(entityName, val) + `; must be between ${min}-${max}`;
var invalidEntity = (fieldName, val) => `Invalid ${fieldName}: ${val}`;

// node_modules/temporal-utils/dist/utils.js
var nanoInMicro = 1e3;
var nanoInMilli = 1e6;
var nanoInSec = 1e9;
var nanoInMinute = 6e10;
var nanoInHour = 36e11;
function normalizeOptions(options) {
  if (options === void 0) {
    return /* @__PURE__ */ Object.create(null);
  }
  return requireObjectLike(options);
}
function toFiniteNumber(arg, entityName = "number") {
  if (typeof arg === "bigint") {
    throw new TypeError(forbiddenBigIntToNumber(entityName));
  }
  arg = Number(arg);
  if (!Number.isFinite(arg)) {
    throw new RangeError(expectedFinite(entityName, arg));
  }
  return arg;
}
function toIntegerWithTrunc(arg, entityName) {
  return Math.trunc(toFiniteNumber(arg, entityName)) || 0;
}
function toPositiveIntegerWithTruncation(arg, entityName) {
  return requireNumberIsPositive(toIntegerWithTrunc(arg, entityName), entityName);
}
function requireNumberIsPositive(num, entityName = "number") {
  if (num <= 0) {
    throw new RangeError(expectedPositive(entityName, num));
  }
  return num;
}
function constrainToRange(num, min, max) {
  return Math.min(Math.max(num, min), max);
}
function isObjectLike(arg) {
  return arg !== null && (typeof arg === "object" || typeof arg === "function");
}
function requireObjectLike(arg) {
  if (!isObjectLike(arg)) {
    throw new TypeError(invalidObject);
  }
  return arg;
}

// node_modules/temporal-polyfill/chunks/internal.js
var invalidEntity2 = invalidEntity;
var missingField = (fieldName) => `Missing ${fieldName}`;
var invalidBag = "Invalid bag";
var invalidChoice = (fieldName, val, choiceMap) => invalidEntity(fieldName, val) + "; must be " + Object.keys(choiceMap).join();
var forbiddenValueOf = "Cannot use valueOf";
var invalidCallingContext = "Invalid calling context";
var missingYear = (allowEra) => "Missing year" + (allowEra ? "/era/eraYear" : "");
var invalidLeapMonth = "Invalid leap month";
var invalidCalendar = (calendarId) => invalidEntity("Calendar", calendarId);
var exoticCalendarRequired = (calendarId, remedy) => `Unknown calendar ${calendarId}; might need ${remedy}`;
var invalidTimeZone = (calendarId) => invalidEntity("TimeZone", calendarId);
var outOfBoundsDate = "Out-of-bounds date";
var failedParse = (s) => `Cannot parse: ${s}`;
var constrainToRange2 = constrainToRange;
var isObjectLike2 = isObjectLike;
function throwRangeError(message) {
  throw new RangeError(message);
}
function throwTypeError(message) {
  throw new TypeError(message);
}
function clampProp(props, propName, min, max, overflow) {
  return clampEntity(propName, ((props2, propName2) => {
    const propVal = props2[propName2];
    return void 0 === propVal && throwTypeError(missingField(propName2)), propVal;
  })(props, propName), min, max, overflow);
}
function clampEntity(entityName, num, min, max, overflow, choices) {
  const clamped = constrainToRange2(num, min, max);
  return overflow && num !== clamped && throwRangeError(((entityName2, val, min2, max2, choices2) => choices2 ? numberOutOfRange(entityName2, choices2[val], choices2[min2], choices2[max2]) : numberOutOfRange(entityName2, val, min2, max2))(entityName, num, min, max, choices)), clamped;
}
function memoize(generator, MapClass = Map, maxSize = 1e4) {
  const map = new MapClass();
  return (key, ...otherArgs) => {
    if (map.has(key)) {
      return map.get(key);
    }
    map.size >= maxSize && map.clear();
    const val = generator(key, ...otherArgs);
    return map.set(key, val), val;
  };
}
var createNameDescriptors = (name2) => createPropDescriptors({
  name: name2
}, 1);
var createPropDescriptors = (propVals, readonly) => mapProps((value) => ({
  value,
  configurable: 1,
  writable: !readonly
}), propVals);
var createStringTagDescriptors = (value) => ({
  [Symbol.toStringTag]: {
    value,
    configurable: 1
  }
});
function mapProps(transformer, props) {
  const res = {};
  for (const propName in props) {
    res[propName] = transformer(props[propName], propName);
  }
  return res;
}
function zipPropsConst(propNames, propVal) {
  const res = {};
  for (const propName of propNames) {
    res[propName] = propVal;
  }
  return res;
}
function createPropGetters(propNames) {
  const getters = {};
  for (const propName of propNames) {
    getters[propName] = (slots) => slots[propName];
  }
  return getters;
}
function pluckProps(propNames, props, dest = /* @__PURE__ */ Object.create(null)) {
  for (const propName of propNames) {
    dest[propName] = props[propName];
  }
  return dest;
}
function allPropsEqual(propNames, props0, props1) {
  for (const propName of propNames) {
    if (props0[propName] !== props1[propName]) {
      return 0;
    }
  }
  return 1;
}
function zeroOutProps(propNames, clearUntilI, props) {
  const copy = {
    ...props
  };
  for (let i = 0; i < clearUntilI; i++) {
    copy[propNames[i]] = 0;
  }
  return copy;
}
function bindArgs(f, ...boundArgs) {
  return (...dynamicArgs) => f(...boundArgs, ...dynamicArgs);
}
function noop() {
}
function capitalize(s) {
  return s[0].toUpperCase() + s.substring(1);
}
function sortStrings(...strss) {
  return [].concat(...strss).sort();
}
function createRegExp(meat) {
  return new RegExp(`^${meat}$`);
}
function parseSubsecNano(fracStr) {
  return parseInt(fracStr.padEnd(9, "0"));
}
function parseInt0(s) {
  return void 0 === s ? 0 : parseInt(s);
}
function padNumber(digits, num) {
  return String(num).padStart(digits, "0");
}
var padNumber2 = /* @__PURE__ */ bindArgs(padNumber, 2);
function compareNumbers(a, b) {
  return Math.sign(a - b);
}
function compareBigInts(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function divFloorBigInt(num, denom) {
  const whole = num / denom;
  return num % denom < 0n ? whole - 1n : whole;
}
function divModFloorBigInt(num, divisor) {
  const quotient = divFloorBigInt(num, divisor);
  return [quotient, num - quotient * divisor];
}
function divModFloor(num, divisor) {
  return [Math.floor(num / divisor), modFloor(num, divisor)];
}
function modFloor(num, divisor) {
  return (num % divisor + divisor) % divisor;
}
function divTrunc(num, divisor) {
  return Math.trunc(num / divisor) || 0;
}
function modTrunc(num, divisor) {
  return num % divisor || 0;
}
function fabricateNearHalfFraction(halfCompare, sign = 1) {
  return sign * (0.5 + halfCompare / 5);
}
function hasHalf(num) {
  return 0.5 === Math.abs(num % 1);
}
var isoCalendarId = "iso8601";
var gregoryCalendarId = "gregory";
var gregoryEraOrigins = {
  "bce": -1,
  "ce": 0
};
function normalizeEraName(era) {
  const normalized = era.normalize("NFD").toLowerCase().replace(/[^a-z0-9]/g, "");
  return "bc" === normalized || "b" === normalized ? "bce" : "ad" === normalized || "a" === normalized ? "ce" : normalized;
}
var isoCalendarImpl = void 0;
var gregoryCalendarImpl = 0;
function getCalendarSlotId(calendar) {
  return calendar === isoCalendarImpl ? "iso8601" : 0 === calendar ? "gregory" : calendar.id;
}
var monthCodeRegExp = /^M(\d{2})(L?)$/;
function parseMonthCode(monthCode) {
  const m = monthCodeRegExp.exec(monthCode);
  return m || throwRangeError(((monthCode2) => `Invalid monthCode: ${monthCode2}`)(monthCode)), [parseInt(m[1]), Boolean(m[2])];
}
function formatMonthCode(monthCodeNumber, isLeapMonth) {
  return "M" + padNumber2(monthCodeNumber) + (isLeapMonth ? "L" : "");
}
function monthCodeNumberToMonth(monthCodeNumber, isLeapMonth, leapMonth) {
  return monthCodeNumber + (isLeapMonth || leapMonth && monthCodeNumber >= leapMonth ? 1 : 0);
}
var unitNameMap = {
  nanosecond: 0,
  microsecond: 1,
  millisecond: 2,
  second: 3,
  minute: 4,
  hour: 5,
  day: 6,
  week: 7,
  month: 8,
  year: 9
};
var unitNamesAsc = /* @__PURE__ */ Object.keys(unitNameMap);
var nanoInMicro2 = nanoInMicro;
var nanoInMilli2 = nanoInMilli;
var nanoInSec2 = nanoInSec;
var nanoInMinute2 = nanoInMinute;
var nanoInHour2 = nanoInHour;
var nanoInUtcDay = 864e11;
var unitNanoMap = [1, nanoInMicro2, nanoInMilli2, nanoInSec2, nanoInMinute2, nanoInHour2, nanoInUtcDay];
var bigNanoInMicro = /* @__PURE__ */ BigInt(nanoInMicro2);
var bigNanoInMilli = /* @__PURE__ */ BigInt(nanoInMilli2);
var bigNanoInSec = /* @__PURE__ */ BigInt(nanoInSec2);
var bigNanoInMinute = /* @__PURE__ */ BigInt(nanoInMinute2);
var bigNanoInHour = /* @__PURE__ */ BigInt(nanoInHour2);
var bigNanoInUtcDay = /* @__PURE__ */ BigInt(nanoInUtcDay);
function divideBigNanoToExactNumber(bigNano, divisorNano) {
  const days = Number(bigNano / bigNanoInUtcDay);
  const timeNano = Number(bigNano % bigNanoInUtcDay);
  return days * (nanoInUtcDay / divisorNano) + (Math.trunc(timeNano / divisorNano) + timeNano % divisorNano / divisorNano);
}
var timeFieldNamesAsc = /* @__PURE__ */ unitNamesAsc.slice(0, 6);
var timeGetters = /* @__PURE__ */ createPropGetters(timeFieldNamesAsc);
var yearFieldNamesAsc = ["year"];
var dayFieldNamesAsc = ["day"];
var calendarDateFieldNamesAsc = ["day", "month", "year"];
var offsetFieldNames = ["offset"];
var timeZoneFieldNames = ["timeZone"];
var eraYearFieldNames = ["era", "eraYear"];
var allYearFieldNames = ["era", "eraYear", "year"];
var monthFieldNames = ["month", "monthCode"];
var monthDayFieldNames = ["day", "month", "monthCode"];
var timeFieldNamesAlpha = /* @__PURE__ */ sortStrings(timeFieldNamesAsc);
var yearFieldNamesWithEraAlpha = /* @__PURE__ */ sortStrings(eraYearFieldNames, yearFieldNamesAsc);
var yearMonthFieldNamesAlpha = /* @__PURE__ */ sortStrings(monthFieldNames, yearFieldNamesAsc);
var yearMonthFieldNamesWithEraAlpha = /* @__PURE__ */ sortStrings(eraYearFieldNames, yearMonthFieldNamesAlpha);
var yearMonthCodeFieldNamesAlpha = /* @__PURE__ */ sortStrings(["monthCode"], yearFieldNamesAsc);
var yearMonthCodeFieldNamesWithEraAlpha = /* @__PURE__ */ sortStrings(eraYearFieldNames, yearMonthCodeFieldNamesAlpha);
var monthCodeDayFieldNamesAlpha = /* @__PURE__ */ sortStrings(dayFieldNamesAsc, ["monthCode"]);
var dateFieldNamesAlpha = /* @__PURE__ */ sortStrings(dayFieldNamesAsc, yearMonthFieldNamesAlpha);
var dateFieldNamesWithEraAlpha = /* @__PURE__ */ sortStrings(dayFieldNamesAsc, eraYearFieldNames, yearMonthFieldNamesAlpha);
var dateTimeFieldNamesAlpha = /* @__PURE__ */ sortStrings(dateFieldNamesAlpha, timeFieldNamesAsc);
var dateTimeFieldNamesWithEraAlpha = /* @__PURE__ */ sortStrings(dateFieldNamesWithEraAlpha, timeFieldNamesAsc);
var dateTimeAndOffsetFieldNamesAlpha = /* @__PURE__ */ sortStrings(dateFieldNamesAlpha, timeFieldNamesAsc, offsetFieldNames);
var dateTimeAndOffsetFieldNamesWithEraAlpha = /* @__PURE__ */ sortStrings(dateFieldNamesWithEraAlpha, timeFieldNamesAsc, offsetFieldNames);
var dateTimeAndZoneFieldNamesAlpha = /* @__PURE__ */ sortStrings(dateFieldNamesAlpha, timeFieldNamesAsc, offsetFieldNames, timeZoneFieldNames);
var dateTimeAndZoneFieldNamesWithEraAlpha = /* @__PURE__ */ sortStrings(dateFieldNamesWithEraAlpha, timeFieldNamesAsc, offsetFieldNames, timeZoneFieldNames);
var yearMonthCodeDayFieldNamesAlpha = /* @__PURE__ */ sortStrings(dayFieldNamesAsc, yearMonthCodeFieldNamesAlpha);
var yearMonthCodeDayFieldNamesWithEraAlpha = /* @__PURE__ */ sortStrings(dayFieldNamesAsc, eraYearFieldNames, yearMonthCodeFieldNamesAlpha);
var timeFieldDefaults = /* @__PURE__ */ zipPropsConst(timeFieldNamesAsc, 0);
function validateTimeFields(timeFields) {
  return constrainTimeFields(timeFields, 1), timeFields;
}
var maxValues = {
  hour: 23,
  minute: 59,
  second: 59
};
function constrainTimeFields(timeFields, overflow) {
  const constrainedFields = {};
  for (const fieldName of timeFieldNamesAsc) {
    constrainedFields[fieldName] = clampEntity(fieldName, timeFields[fieldName], 0, maxValues[fieldName] || 999, overflow);
  }
  return constrainedFields;
}
function timeFieldsToNano(timeFields) {
  return timeFieldsToSec(timeFields) * nanoInSec2 + timeFieldsToSubsecNano(timeFields);
}
function timeFieldsToMilli(timeFields) {
  return 1e3 * timeFieldsToSec(timeFields) + timeFields.millisecond;
}
function timeFieldsToSec(timeFields) {
  return 3600 * timeFields.hour + 60 * timeFields.minute + timeFields.second;
}
function timeFieldsToSubsecNano(timeFields) {
  return timeFields.millisecond * nanoInMilli2 + timeFields.microsecond * nanoInMicro2 + timeFields.nanosecond;
}
function nanoToTimeAndDay(nano) {
  const [dayDelta, timeNano] = divModFloor(nano, nanoInUtcDay);
  return [nanoToTimeFields(timeNano), dayDelta];
}
function nanoToTimeFields(timeNano) {
  const [timeMilli, nanoAfterMilli] = divModFloor(timeNano, nanoInMilli2);
  const [microsecond, nanosecond] = divModFloor(nanoAfterMilli, nanoInMicro2);
  return milliToTimeFields(timeMilli, microsecond, nanosecond);
}
function milliToTimeFields(timeMilli, microsecond = 0, nanosecond = 0) {
  const [hour, milliAfterHour] = divModFloor(timeMilli, 36e5);
  const [minute, milliAfterMinute] = divModFloor(milliAfterHour, 6e4);
  const [second, millisecond] = divModFloor(milliAfterMinute, 1e3);
  return {
    hour,
    minute,
    second,
    millisecond,
    microsecond,
    nanosecond
  };
}
function epochNanoToSecMod(epochNano) {
  const [epochSec, nano] = divModFloorBigInt(epochNano, bigNanoInSec);
  return [Number(epochSec), Number(nano)];
}
function epochNanoToMilli(epochNano) {
  return Number(divFloorBigInt(epochNano, bigNanoInMilli));
}
function isoDateTimeToEpochNano(isoDateTime) {
  return isoDateToEpochNano(isoDateTime) + BigInt(timeFieldsToNano(isoDateTime));
}
function isoDateTimeToEpochMilli(isoDateTime) {
  return isoDateToEpochMilli(isoDateTime) + timeFieldsToMilli(isoDateTime);
}
function isoDateToEpochNano(isoDate) {
  return BigInt(isoDateToEpochDays(isoDate)) * bigNanoInUtcDay;
}
function isoDateToEpochMilli(isoDate) {
  return 864e5 * isoDateToEpochDays(isoDate);
}
function isoDateToEpochDays(isoDate) {
  return isoPartsToEpochDays(isoDate.year, isoDate.month, isoDate.day);
}
function isoPartsToEpochDays(isoYear, isoMonth = 1, isoDay = 1) {
  const monthIndex = isoMonth - 1;
  return isoYear += Math.floor(monthIndex / 12), isoMonth = modFloor(monthIndex, 12), Date.UTC(isoYear % 400 - 400, isoMonth, 0) / 864e5 + 146097 * (divTrunc(isoYear, 400) + 1) + isoDay;
}
function epochNanoToIsoDateTime(epochNano) {
  const [epochDays, nanoAfterDay] = divModFloorBigInt(epochNano, bigNanoInUtcDay);
  return {
    ...epochDaysToIsoDate(Number(epochDays)),
    ...nanoToTimeFields(Number(nanoAfterDay))
  };
}
function epochDaysToIsoDate(epochDays) {
  const legacyDate = new Date(864e5 * modFloor(epochDays, 146097));
  return {
    year: legacyDate.getUTCFullYear() + 400 * Math.floor(epochDays / 146097),
    month: legacyDate.getUTCMonth() + 1,
    day: legacyDate.getUTCDate()
  };
}
var isoEpochFirstLeapYear = 1972;
function computeIsoMonthCodeParts(month) {
  return [month, 0];
}
function computeIsoYearMonthFieldsForMonthDay(monthCodeNumber, isLeapMonth) {
  if (!isLeapMonth) {
    return {
      year: 1972,
      month: monthCodeNumber
    };
  }
}
function computeIsoFieldsFromParts(year, month, day) {
  return {
    year,
    month,
    day
  };
}
function computeIsoDaysInMonth(year, month) {
  switch (month) {
    case 2:
      return computeIsoInLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
  }
  return 31;
}
function computeIsoDaysInYear(year) {
  return computeIsoInLeapYear(year) ? 366 : 365;
}
function computeIsoInLeapYear(year) {
  return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
}
function addIsoMonths(year, month, monthDelta) {
  return year += divTrunc(monthDelta, 12), (month += modTrunc(monthDelta, 12)) < 1 ? (year--, month += 12) : month > 12 && (year++, month -= 12), {
    year,
    month
  };
}
function diffIsoMonthSlots(year0, month0, year1, month1) {
  return 12 * (year1 - year0) + month1 - month0;
}
function computeIsoDayOfWeek(isoDate) {
  return modFloor(isoPartsToEpochDays(isoDate.year, isoDate.month, isoDate.day) + 4, 7) || 7;
}
function computeIsoDayOfYear(isoDate) {
  return isoPartsToEpochDays(isoDate.year, isoDate.month, isoDate.day) - isoPartsToEpochDays(isoDate.year) + 1;
}
function computeIsoWeekFields(isoDate) {
  let yearOfWeek = isoDate.year;
  let weekOfYear = Math.floor((computeIsoDayOfYear(isoDate) - computeIsoDayOfWeek(isoDate) + 10) / 7);
  let weeksInYear = computeIsoWeeksInYear(yearOfWeek);
  return weekOfYear < 1 ? weekOfYear = weeksInYear = computeIsoWeeksInYear(--yearOfWeek) : weekOfYear > weeksInYear && (weekOfYear = 1, weeksInYear = computeIsoWeeksInYear(++yearOfWeek)), {
    weekOfYear,
    yearOfWeek,
    De: weeksInYear
  };
}
function computeIsoWeeksInYear(year) {
  const y0DayOfWeek = computeIsoDayOfWeek({
    year,
    month: 1,
    day: 1
  });
  return 4 === y0DayOfWeek || 3 === y0DayOfWeek && computeIsoInLeapYear(year) ? 53 : 52;
}
function computeGregoryEraFields({ year }) {
  return year < 1 ? {
    era: "bce",
    eraYear: 1 - year
  } : {
    era: "ce",
    eraYear: year
  };
}
function validateIsoDateTimeFields(isoDateTime) {
  return validateIsoDateFields(isoDateTime), validateTimeFields(isoDateTime);
}
function validateIsoDateFields(isoInternals) {
  return constrainIsoDateFields(isoInternals, 1), isoInternals;
}
function constrainIsoDateFields(isoDate, overflow) {
  const { year } = isoDate;
  const month = clampProp(isoDate, "month", 1, 12, overflow);
  return {
    year,
    month,
    day: clampProp(isoDate, "day", 1, computeIsoDaysInMonth(year, month), overflow)
  };
}
function computeCalendarDateFields(calendar, isoDate) {
  return calendar ? calendar.de(isoDate) : isoDate;
}
function computeCalendarMonthCodeParts(calendar, year, month) {
  return calendar ? calendar.L(year, month) : computeIsoMonthCodeParts(month);
}
function computeCalendarEraFields(calendar, isoDate) {
  return 0 === calendar ? computeGregoryEraFields(isoDate) : calendar && calendar.h?.(isoDate) || {};
}
function computeCalendarIsoFieldsFromParts(calendar, year, month, day) {
  return calendar ? calendar.fe(year, month, day) : computeIsoFieldsFromParts(year, month, day);
}
function computeCalendarMonthsInYearForYear(calendar, year) {
  return calendar ? calendar.j(year) : 12;
}
function computeCalendarDaysInMonthForYearMonth(calendar, year, month) {
  return calendar ? calendar.o(year, month) : computeIsoDaysInMonth(year, month);
}
function computeCalendarMonthCode(calendar, isoDate) {
  const { year, month } = computeCalendarDateFields(calendar, isoDate);
  const [monthCodeNumber, isLeapMonth] = computeCalendarMonthCodeParts(calendar, year, month);
  return formatMonthCode(monthCodeNumber, isLeapMonth);
}
function computeCalendarInLeapYear(calendar, isoDate) {
  const { year } = computeCalendarDateFields(calendar, isoDate);
  return calendar ? calendar.q(year) : computeIsoInLeapYear(year);
}
function computeCalendarMonthsInYear(calendar, isoDate) {
  const { year } = computeCalendarDateFields(calendar, isoDate);
  return computeCalendarMonthsInYearForYear(calendar, year);
}
function computeCalendarDaysInMonth(calendar, isoDate) {
  const { year, month } = computeCalendarDateFields(calendar, isoDate);
  return computeCalendarDaysInMonthForYearMonth(calendar, year, month);
}
function computeCalendarDaysInYear(calendar, isoDate) {
  const { year } = computeCalendarDateFields(calendar, isoDate);
  return calendar ? calendar.i(year) : computeIsoDaysInYear(year);
}
function computeCalendarDayOfYear(calendar, isoDate) {
  if (!calendar) {
    return computeIsoDayOfYear(isoDate);
  }
  const { year } = computeCalendarDateFields(calendar, isoDate);
  const yearStartIsoDate = computeCalendarIsoFieldsFromParts(calendar, year, 1, 1);
  return isoDateToEpochDays(isoDate) - isoDateToEpochDays(yearStartIsoDate) + 1;
}
function computeCalendarWeekOfYear(calendar, isoDate) {
  return calendar === isoCalendarImpl ? computeIsoWeekFields(isoDate).weekOfYear : void 0;
}
function computeCalendarYearOfWeek(calendar, isoDate) {
  return calendar === isoCalendarImpl ? computeIsoWeekFields(isoDate).yearOfWeek : void 0;
}
var durationFieldNamesAsc = /* @__PURE__ */ unitNamesAsc.map((unitName) => unitName + "s");
var durationGetters = /* @__PURE__ */ createPropGetters(durationFieldNamesAsc);
var durationFieldNamesAlpha = /* @__PURE__ */ sortStrings(durationFieldNamesAsc);
var durationTimeFieldNamesAsc = /* @__PURE__ */ durationFieldNamesAsc.slice(0, 6);
var durationDateFieldNamesAsc = /* @__PURE__ */ durationFieldNamesAsc.slice(6);
var durationCalendarFieldNamesAsc = /* @__PURE__ */ durationDateFieldNamesAsc.slice(1);
var durationFieldDefaults = /* @__PURE__ */ zipPropsConst(durationFieldNamesAsc, 0);
var durationTimeFieldDefaults = /* @__PURE__ */ zipPropsConst(durationTimeFieldNamesAsc, 0);
var clearDurationFields = /* @__PURE__ */ bindArgs(zeroOutProps, durationFieldNamesAsc);
function requirePropDefined(optionName, optionVal) {
  return null == optionVal && throwRangeError(missingField(optionName)), optionVal;
}
var requireString = /* @__PURE__ */ bindArgs(requireType, "string");
function requireType(typeName2, arg, entityName = typeName2) {
  return typeof arg !== typeName2 && throwTypeError(invalidEntity2(entityName, arg)), arg;
}
function requireNumberIsInteger(num, entityName = "number") {
  return Number.isInteger(num) || throwRangeError(((entityName2, num2) => `Non-integer ${entityName2}: ${num2}`)(entityName, num)), num || 0;
}
function toString(arg) {
  return "symbol" == typeof arg && throwTypeError("Cannot convert Symbol to string"), String(arg);
}
function toPrimitiveWithStringHint(arg) {
  if (!isObjectLike(arg)) {
    return arg;
  }
  const exoticToPrimitive = arg[Symbol.toPrimitive];
  if (null != exoticToPrimitive) {
    "function" != typeof exoticToPrimitive && throwTypeError();
    const primitive = Reflect.apply(exoticToPrimitive, arg, ["string"]);
    return isObjectLike(primitive) && throwTypeError(), primitive;
  }
  return Date.prototype[Symbol.toPrimitive].call(arg, "string");
}
function toBigInt(bi) {
  return "boolean" == typeof bi ? BigInt(bi ? 1 : 0) : "string" == typeof bi ? BigInt(bi) : ("bigint" != typeof bi && throwTypeError(`Invalid bigint: ${bi}`), bi);
}
function toStrictInteger(arg, entityName) {
  return requireNumberIsInteger(toFiniteNumber(arg, entityName), entityName);
}
var smallestUnitStr = "smallestUnit";
var overflowMap = {
  constrain: 0,
  reject: 1
};
var epochDisambigMap = {
  compatible: 0,
  reject: 1,
  earlier: 2,
  later: 3
};
var offsetDisambigMap = {
  reject: 0,
  use: 1,
  prefer: 2,
  ignore: 3
};
var calendarDisplayMap = {
  auto: 0,
  never: 1,
  critical: 2,
  always: 3
};
var timeZoneDisplayMap = {
  auto: 0,
  never: 1,
  critical: 2
};
var offsetDisplayMap = {
  auto: 0,
  never: 1
};
var roundingModeMap = {
  floor: 0,
  halfFloor: 1,
  ceil: 2,
  halfCeil: 3,
  trunc: 4,
  halfTrunc: 5,
  expand: 6,
  halfExpand: 7,
  halfEven: 8
};
var roundingModeFuncs = [Math.floor, (num) => hasHalf(num) ? Math.floor(num) : Math.round(num), Math.ceil, (num) => hasHalf(num) ? Math.ceil(num) : Math.round(num), Math.trunc, (num) => hasHalf(num) ? Math.trunc(num) || 0 : Math.round(num), (num) => num < 0 ? Math.floor(num) : Math.ceil(num), (num) => Math.sign(num) * Math.round(Math.abs(num)) || 0, (num) => hasHalf(num) ? (num = Math.trunc(num) || 0) + num % 2 : Math.round(num)];
var directionMap = {
  previous: -1,
  next: 1
};
function coerceRoundingIncInteger(options) {
  const roundingInc = options.roundingIncrement;
  if (void 0 === roundingInc) {
    return 1;
  }
  const integer = toIntegerWithTrunc(roundingInc, "roundingIncrement");
  return (integer < 1 || integer > 10 ** 9) && throwRangeError(invalidEntity2("roundingIncrement", integer)), integer;
}
function coerceFractionalSecondDigits(options) {
  let subsecDigits = options.fractionalSecondDigits;
  if (void 0 !== subsecDigits) {
    if ("number" != typeof subsecDigits) {
      if ("auto" === toString(subsecDigits)) {
        return;
      }
      throwRangeError(invalidEntity2("fractionalSecondDigits", subsecDigits));
    }
    subsecDigits = clampEntity("fractionalSecondDigits", Math.floor(subsecDigits), 0, 9, 1);
  }
  return subsecDigits;
}
function coerceUnitOption(optionName, options, minUnit = 0, ensureDefined) {
  let unitStr = options[optionName];
  if (void 0 === unitStr) {
    return ensureDefined ? minUnit : void 0;
  }
  if (unitStr = toString(unitStr), "auto" === unitStr) {
    return ensureDefined ? minUnit : null;
  }
  let unit = unitNameMap[unitStr];
  return void 0 === unit && (unit = durationFieldNamesAsc.indexOf(unitStr)), unit < 0 && throwRangeError(invalidChoice(optionName, unitStr, unitNameMap)), unit;
}
function coerceChoiceOption(optionName, enumNameMap, options, defaultChoice = 0) {
  const enumArg = options[optionName];
  if (void 0 === enumArg) {
    return defaultChoice;
  }
  const enumStr = toString(enumArg);
  const enumNum = enumNameMap[enumStr];
  return void 0 === enumNum && throwRangeError(invalidChoice(optionName, enumStr, enumNameMap)), enumNum;
}
var coerceSmallestUnit = /* @__PURE__ */ bindArgs(coerceUnitOption, smallestUnitStr);
var coerceLargestUnit = /* @__PURE__ */ bindArgs(coerceUnitOption, "largestUnit");
var coerceTotalUnit = /* @__PURE__ */ bindArgs(coerceUnitOption, "unit");
var coerceOverflow = /* @__PURE__ */ bindArgs(coerceChoiceOption, "overflow", overflowMap);
var coerceEpochDisambig = /* @__PURE__ */ bindArgs(coerceChoiceOption, "disambiguation", epochDisambigMap);
var coerceOffsetDisambig = /* @__PURE__ */ bindArgs(coerceChoiceOption, "offset", offsetDisambigMap);
var coerceCalendarDisplay = /* @__PURE__ */ bindArgs(coerceChoiceOption, "calendarName", calendarDisplayMap);
var coerceTimeZoneDisplay = /* @__PURE__ */ bindArgs(coerceChoiceOption, "timeZoneName", timeZoneDisplayMap);
var coerceOffsetDisplay = /* @__PURE__ */ bindArgs(coerceChoiceOption, "offset", offsetDisplayMap);
var coerceRoundingMode = /* @__PURE__ */ bindArgs(coerceChoiceOption, "roundingMode", roundingModeMap);
var coerceDirection = /* @__PURE__ */ bindArgs(coerceChoiceOption, "direction", directionMap);
function normalizeOptionsOrString(options, optionName) {
  return "string" == typeof options ? ((optionName2, optionVal) => {
    const res = /* @__PURE__ */ Object.create(null);
    return res[optionName2] = optionVal, res;
  })(optionName, options) : requireObjectLike(options);
}
function validateRoundingInc(roundingInc, smallestUnit, allowManyLargeUnits, solarMode) {
  const upUnitNano = solarMode ? nanoInUtcDay : unitNanoMap[smallestUnit + 1];
  if (upUnitNano) {
    const incNano = roundingInc * unitNanoMap[smallestUnit];
    (upUnitNano % incNano || !solarMode && incNano === upUnitNano) && throwRangeError(invalidEntity2("roundingIncrement", roundingInc));
  } else {
    !allowManyLargeUnits && roundingInc > 1 && throwRangeError(invalidEntity2("roundingIncrement", roundingInc));
  }
  return roundingInc;
}
function validateUnitRange(optionName, unit, minUnit, maxUnit) {
  return null != unit && clampEntity(optionName, unit, minUnit, maxUnit, 1, unitNamesAsc), unit;
}
function checkLargestSmallestUnit(largestUnit, smallestUnit) {
  smallestUnit > largestUnit && throwRangeError("smallestUnit > largestUnit");
}
function refineDiffOptions(roundingModeInvert, options, defaultLargestUnit, maxUnit = 9, minUnit = 0, defaultRoundingMode = 4) {
  options = normalizeOptions(options);
  let largestUnit = coerceLargestUnit(options, minUnit);
  let roundingInc = coerceRoundingIncInteger(options);
  let roundingMode = coerceRoundingMode(options, defaultRoundingMode);
  let smallestUnit = coerceSmallestUnit(options, minUnit, 1);
  return largestUnit = validateUnitRange("largestUnit", largestUnit, minUnit, maxUnit), smallestUnit = validateUnitRange(smallestUnitStr, smallestUnit, minUnit, maxUnit), null == largestUnit ? largestUnit = Math.max(defaultLargestUnit, smallestUnit) : checkLargestSmallestUnit(largestUnit, smallestUnit), roundingInc = validateRoundingInc(roundingInc, smallestUnit, 1), roundingModeInvert && (roundingMode = ((roundingMode2) => roundingMode2 < 4 ? (roundingMode2 + 2) % 4 : roundingMode2)(roundingMode)), [largestUnit, smallestUnit, roundingInc, roundingMode];
}
function refineRoundingOptions(options, maxUnit = 6, solarMode) {
  let roundingInc = coerceRoundingIncInteger(options = normalizeOptionsOrString(options, smallestUnitStr));
  const roundingMode = coerceRoundingMode(options, 7);
  let smallestUnit = coerceSmallestUnit(options);
  return smallestUnit = requirePropDefined(smallestUnitStr, smallestUnit), smallestUnit = validateUnitRange(smallestUnitStr, smallestUnit, 0, maxUnit), roundingInc = validateRoundingInc(roundingInc, smallestUnit, void 0, solarMode), [smallestUnit, roundingInc, roundingMode];
}
function combineDateAndTime(isoDate, time2) {
  return pluckProps(calendarDateFieldNamesAsc, isoDate, pluckProps(timeFieldNamesAsc, time2));
}
var epochNanoMax = /* @__PURE__ */ BigInt(1e8) * bigNanoInUtcDay;
var epochNanoMin = /* @__PURE__ */ BigInt(-1e8) * bigNanoInUtcDay;
var plainDateEpochNanoMin = epochNanoMin - bigNanoInUtcDay;
function checkIsoYearMonthInBounds(isoDate) {
  const isoYearMonthIndex = 12 * isoDate.year + isoDate.month;
  return (isoYearMonthIndex < -3261848 || isoYearMonthIndex > 3309129) && throwRangeError(outOfBoundsDate), isoDate;
}
function checkIsoDateInBounds(isoDate, allowPlainDateLowerEdge = 1) {
  const epochNano = isoDateToEpochNano(isoDate);
  return (epochNano < (allowPlainDateLowerEdge ? plainDateEpochNanoMin : epochNanoMin) || epochNano > epochNanoMax) && throwRangeError(outOfBoundsDate), isoDate;
}
function checkIsoDateTimeInBounds(isoDateTime) {
  return checkIsoDateTimeEpochNanoInBounds(isoDateTimeToEpochNano(isoDateTime)), isoDateTime;
}
function checkIsoDateTimeEpochNanoInBounds(epochNano) {
  return (epochNano <= plainDateEpochNanoMin || epochNano >= epochNanoMax + bigNanoInUtcDay) && throwRangeError(outOfBoundsDate), epochNano;
}
function checkEpochNanoInBounds(epochNano) {
  return (epochNano < epochNanoMin || epochNano > epochNanoMax) && throwRangeError(outOfBoundsDate), epochNano;
}
function isoDateTimeAndOffsetToEpochNano(isoDateTime, offsetNano) {
  return checkEpochNanoInBounds(isoDateToEpochNano(isoDateTime) + BigInt(timeFieldsToNano(isoDateTime) - offsetNano));
}
function roundNumberToInc(num, roundingInc, roundingMode) {
  return roundWithMode(num / roundingInc, roundingMode) * roundingInc || 0;
}
function roundWithMode(num, roundingMode) {
  return roundingModeFuncs[roundingMode](num);
}
function totalRelativeUnit(wholeValue, sign, endEpochNano, moveValueToEpochNano) {
  const unitWindow = clampRelativeUnitValue(wholeValue, sign, moveValueToEpochNano, endEpochNano);
  return interpolateRelativeUnitWindow(unitWindow, Number(endEpochNano - unitWindow.N) / Number(unitWindow.te - unitWindow.N));
}
function roundRelativeUnitWindow(unitWindow, endEpochNano, roundingInc, roundingMode) {
  return roundNumberToInc(interpolateRelativeUnitWindow(unitWindow, computeEpochNanoFrac(endEpochNano, unitWindow.N, unitWindow.te)), roundingInc, roundingMode);
}
function clampRelativeUnitValue(startValue, valueDelta, moveValueToEpochNano, epochNanoProgress) {
  let unitWindow = computeRelativeUnitWindow(startValue, valueDelta, moveValueToEpochNano);
  return ((epochNanoProgress2, epochNano0, epochNano1, sign) => sign > 0 ? epochNano0 <= epochNanoProgress2 && epochNanoProgress2 <= epochNano1 : epochNano1 <= epochNanoProgress2 && epochNanoProgress2 <= epochNano0)(epochNanoProgress, unitWindow.N, unitWindow.te, Math.sign(valueDelta)) || (unitWindow = computeRelativeUnitWindow(startValue + valueDelta, valueDelta, moveValueToEpochNano)), unitWindow;
}
function computeRelativeUnitWindow(startValue, valueDelta, moveValueToEpochNano) {
  const endValue = startValue + valueDelta;
  return {
    ve: startValue,
    pe: endValue,
    N: moveValueToEpochNano(startValue),
    te: moveValueToEpochNano(endValue)
  };
}
function interpolateRelativeUnitWindow(unitWindow, fraction) {
  return unitWindow.ve + fraction * (unitWindow.pe - unitWindow.ve);
}
function computeEpochNanoFrac(epochNanoProgress, epochNano0, epochNano1) {
  const denomBig = epochNano1 - epochNano0;
  const numeratorBig = epochNanoProgress - epochNano0;
  if (!numeratorBig) {
    return 0;
  }
  const absNumerator = numeratorBig < 0n ? -numeratorBig : numeratorBig;
  const absDenom = denomBig < 0n ? -denomBig : denomBig;
  const fracSign = compareBigInts(numeratorBig, 0n) === compareBigInts(denomBig, 0n) ? 1 : -1;
  return compareBigInts(absNumerator, absDenom) <= 0 ? absNumerator === absDenom ? fracSign : fabricateNearHalfFraction(compareBigInts(2n * absNumerator, absDenom), fracSign) : Number(numeratorBig) / Number(denomBig);
}
function createEpochNanoSlots(epochNano) {
  return {
    epochNanoseconds: epochNano
  };
}
function createZonedEpochNanoSlots(epochNano, timeZone, calendar) {
  return {
    calendar,
    timeZone,
    epochNanoseconds: epochNano
  };
}
function createDateTimeSlots(isoDateTime, calendar) {
  return pluckProps(timeFieldNamesAsc, isoDateTime, createDateSlots(isoDateTime, calendar));
}
function createDateSlots(isoDate, calendar) {
  return pluckProps(calendarDateFieldNamesAsc, isoDate, {
    calendar
  });
}
function createTimeSlots(time2) {
  return pluckProps(timeFieldNamesAsc, time2);
}
function createDurationSlots(durationFields) {
  return pluckProps(durationFieldNamesAsc, durationFields, {
    sign: computeDurationSign(durationFields)
  });
}
function roundZonedEpochSlotsToUnit(slots, smallestUnit, roundingInc, roundingMode) {
  return createZonedEpochNanoSlots(6 === smallestUnit ? roundZonedEpochToDay(slots, roundingMode) : roundZonedEpochToTime(slots, smallestUnit, roundingInc, roundingMode), slots.timeZone, slots.calendar);
}
function computeZonedHoursInDay(slots) {
  const [epochNano0, epochNano1] = computeZonedDayEpochInterval(slots);
  return divideBigNanoToExactNumber(epochNano1 - epochNano0, nanoInHour2);
}
function computeZonedStartOfDay(slots) {
  const { timeZone, calendar } = slots;
  return createZonedEpochNanoSlots(getStartOfDayInstantFor(timeZone, combineDateAndTime(zonedEpochSlotsToIso(slots), timeFieldDefaults)), timeZone, calendar);
}
function roundRelativeDuration(durationFields, endEpochNano, largestUnit, smallestUnit, roundingInc, roundingMode, relativeOps, isZoned2) {
  if (0 === smallestUnit && 1 === roundingInc) {
    return durationFields;
  }
  const sign = computeDurationSign(durationFields) || 1;
  const nudgeFunc = isUniformUnit(smallestUnit, isZoned2) ? isZoned2 && smallestUnit < 6 && largestUnit >= 6 ? nudgeZonedTimeDuration : nudgeDayTimeDuration : nudgeRelativeDuration;
  let [roundedDurationFields, roundedEpochNano, grewBigUnit] = nudgeFunc(sign, durationFields, endEpochNano, largestUnit, smallestUnit, roundingInc, roundingMode, relativeOps);
  return grewBigUnit && 7 !== smallestUnit && (roundedDurationFields = ((durationFields2, endEpochNano2, largestUnit2, smallestUnit2, sign2, relativeOps2) => {
    for (let currentUnit = smallestUnit2 + 1; currentUnit <= largestUnit2; currentUnit++) {
      if (7 === currentUnit && 7 !== largestUnit2) {
        continue;
      }
      const baseDurationFields = clearDurationFields(currentUnit, durationFields2);
      baseDurationFields[durationFieldNamesAsc[currentUnit]] += sign2;
      const thresholdCompare = compareBigInts(endEpochNano2, moveRelativeMarkerToEpochNano(relativeOps2, baseDurationFields));
      if (thresholdCompare && thresholdCompare !== sign2) {
        break;
      }
      durationFields2 = baseDurationFields;
    }
    return durationFields2;
  })(roundedDurationFields, roundedEpochNano, largestUnit, Math.max(6, smallestUnit), sign, relativeOps)), roundedDurationFields;
}
function roundDayTimeDurationByInc(durationFields, nanoInc, roundingMode) {
  const maxUnit = Math.max(Math.min(getMaxDurationUnit(durationFields), 6), 3);
  return nanoToDurationDayTimeFields(roundBigNanoToInc(durationDayTimeToBigNano(durationFields), BigInt(nanoInc), roundingMode), maxUnit);
}
function roundZonedEpochToDay(slots, roundingMode) {
  const [epochNano0, epochNano1] = computeZonedDayEpochInterval(slots);
  return roundZonedEpochToBounds(slots.epochNanoseconds, epochNano0, epochNano1, roundingMode);
}
function roundZonedEpochToTime(slots, smallestUnit, roundingInc, roundingMode) {
  if (0 === smallestUnit && 1 === roundingInc) {
    return slots.epochNanoseconds;
  }
  const isoDateTime = zonedEpochSlotsToIso(slots);
  return getInstantPreferringOffset(slots.timeZone, roundDateTimeToUnit(isoDateTime, smallestUnit, roundingInc, roundingMode), isoDateTime.offsetNanoseconds);
}
function roundDateTimeToUnit(isoDateTime, smallestUnit, roundingInc, roundingMode) {
  return roundDateTimeToInc(isoDateTime, computeNanoInc(smallestUnit, roundingInc), roundingMode, unitNanoMap[smallestUnit + 1]);
}
function roundTimeToUnit(timeFields, smallestUnit, roundingInc, roundingMode) {
  return roundTimeToInc(timeFields, computeNanoInc(smallestUnit, roundingInc), roundingMode, unitNanoMap[smallestUnit + 1]);
}
function roundDateTimeToInc(isoDateTime, nanoInc, roundingMode, spanNano) {
  const [roundedTimeFields, dayDelta] = roundTimeToInc(isoDateTime, nanoInc, roundingMode, spanNano);
  const roundedIsoDateTime = combineDateAndTime(moveDateByDays(isoDateTime, dayDelta), roundedTimeFields);
  return checkIsoDateTimeInBounds(roundedIsoDateTime), roundedIsoDateTime;
}
function roundTimeToInc(timeFields, nanoInc, roundingMode, spanNano = nanoInUtcDay) {
  const timeNano = timeFieldsToNano(timeFields);
  const remainderNano = timeNano % spanNano;
  return nanoToTimeAndDay(timeNano - remainderNano + roundNumberToInc(remainderNano, nanoInc, roundingMode));
}
function nudgeRelativeDuration(sign, durationFields, endEpochNano, _largestUnit, smallestUnit, roundingInc, roundingMode, relativeOps) {
  const smallestUnitFieldName = durationFieldNamesAsc[smallestUnit];
  const baseDurationFields = clearDurationFields(smallestUnit, durationFields);
  7 === smallestUnit && (durationFields = {
    ...durationFields,
    weeks: durationFields.weeks + Math.trunc(durationFields.days / 7)
  });
  const truncedVal = divTrunc(durationFields[smallestUnitFieldName], roundingInc) * roundingInc;
  const nudgeWindow = clampRelativeUnitValue(truncedVal, roundingInc * sign, (value) => (baseDurationFields[smallestUnitFieldName] = value, moveRelativeMarkerToEpochNano(relativeOps, baseDurationFields)), endEpochNano);
  const roundedVal = roundRelativeUnitWindow(nudgeWindow, endEpochNano, roundingInc, roundingMode);
  return baseDurationFields[smallestUnitFieldName] = roundedVal, [baseDurationFields, roundedVal === nudgeWindow.pe ? nudgeWindow.te : nudgeWindow.N, roundedVal !== truncedVal];
}
function nudgeZonedTimeDuration(sign, durationFields, _endEpochNano, _largestUnit, smallestUnit, roundingInc, roundingMode, relativeOps) {
  const timeNano = Number(durationTimeToBigNano(durationFields));
  const nanoInc = computeNanoInc(smallestUnit, roundingInc);
  let roundedTimeNano = roundNumberToInc(timeNano, nanoInc, roundingMode);
  const dateDurationFields = {
    ...durationFields,
    ...durationTimeFieldDefaults
  };
  const dayEpochNano0 = relativeOps.X(dateDurationFields);
  const dayEpochNano1 = relativeOps.X({
    ...dateDurationFields,
    days: dateDurationFields.days + sign
  });
  const daySpanNano = Number(dayEpochNano1 - dayEpochNano0);
  Math.sign(daySpanNano) !== sign && throwRangeError("Out-of-bounds TimeZone gap");
  const beyondDayNano = roundedTimeNano - daySpanNano;
  let dayDelta = 0;
  let nudgedEpochNano;
  beyondDayNano && Math.sign(beyondDayNano) !== sign ? nudgedEpochNano = dayEpochNano0 + BigInt(roundedTimeNano) : (dayDelta += sign, roundedTimeNano = roundNumberToInc(beyondDayNano, nanoInc, roundingMode), nudgedEpochNano = dayEpochNano1 + BigInt(roundedTimeNano));
  const durationTimeFields = nanoToDurationTimeFields(roundedTimeNano);
  return [{
    ...durationFields,
    ...durationTimeFields,
    days: durationFields.days + dayDelta
  }, nudgedEpochNano, Boolean(dayDelta)];
}
function nudgeDayTimeDuration(sign, durationFields, endEpochNano, largestUnit, smallestUnit, roundingInc, roundingMode) {
  const bigNano = durationDayTimeToBigNano(durationFields);
  const roundedBigNano = roundBigNanoToInc(bigNano, computeBigNanoInc(smallestUnit, roundingInc), roundingMode);
  const nanoDiff = roundedBigNano - bigNano;
  const expandedBigUnit = Math.sign(Number(roundedBigNano / bigNanoInUtcDay) - Number(bigNano / bigNanoInUtcDay)) === sign;
  const roundedDayTimeFields = nanoToDurationDayTimeFields(roundedBigNano, Math.min(largestUnit, 6));
  return [{
    ...durationFields,
    ...roundedDayTimeFields
  }, endEpochNano + nanoDiff, expandedBigUnit];
}
function computeZonedDayEpochInterval(slots) {
  const { timeZone } = slots;
  const isoDateTime0 = combineDateAndTime(zonedEpochSlotsToIso(slots), timeFieldDefaults);
  const isoDateTime1 = combineDateAndTime(moveDateByDays(isoDateTime0, 1), timeFieldDefaults);
  return [getStartOfDayInstantFor(timeZone, isoDateTime0), getStartOfDayInstantFor(timeZone, isoDateTime1)];
}
function roundZonedEpochToBounds(epochNano, epochNano0, epochNano1, roundingMode) {
  return roundWithMode(computeEpochNanoFrac(epochNano < epochNano1 ? epochNano : epochNano1 - 1n, epochNano0, epochNano1), roundingMode) ? epochNano1 : epochNano0;
}
function roundToMinute(offsetNano) {
  return roundNumberToInc(offsetNano, nanoInMinute2, 7);
}
function roundBigNanoToInc(bigNano, bigNanoInc, roundingMode) {
  return roundBigNanoToIncWithTail(bigNano, bigNanoInc, roundingMode, bigNano / bigNanoInc % 2n);
}
function roundBigNanoToDayOriginInc(bigNano, bigNanoInc, roundingMode) {
  const [day, timeNano] = divModFloorBigInt(bigNano, bigNanoInUtcDay);
  const dayOriginNano = day * bigNanoInUtcDay;
  return dayOriginNano + roundBigNanoToIncWithTail(timeNano, bigNanoInc, roundingMode, dayOriginNano / bigNanoInc + timeNano / bigNanoInc & 1n);
}
function roundBigNanoToIncWithTail(bigNano, bigNanoInc, roundingMode, quotientTail) {
  const quotient = bigNano / bigNanoInc;
  const remainder = bigNano % bigNanoInc;
  let fraction = 0;
  remainder && (fraction = fabricateNearHalfFraction(compareBigInts(2n * (remainder < 0n ? -remainder : remainder), bigNanoInc), Math.sign(Number(remainder))));
  const roundedTail = roundWithMode(Number(quotientTail) + fraction, roundingMode);
  return (quotient - quotientTail + BigInt(roundedTail)) * bigNanoInc;
}
function computeNanoInc(smallestUnit, roundingInc) {
  return unitNanoMap[smallestUnit] * roundingInc;
}
function computeBigNanoInc(smallestUnit, roundingInc) {
  return BigInt(unitNanoMap[smallestUnit]) * BigInt(roundingInc);
}
var zonedEpochSlotsToIso = /* @__PURE__ */ memoize(_zonedEpochSlotsToIso, WeakMap);
function _zonedEpochSlotsToIso(slots) {
  const { epochNanoseconds, timeZone } = slots;
  const offsetNanoseconds = timeZone.B(epochNanoseconds);
  return {
    ...epochNanoToIsoDateTime(epochNanoseconds + BigInt(offsetNanoseconds)),
    offsetNanoseconds
  };
}
function getInstantPreferringOffset(timeZone, isoDateTime, offsetNano) {
  return getMatchingInstantFor(timeZone, isoDateTime, offsetNano, 2, 0);
}
function getMatchingInstantFor(timeZone, isoDateTime, offsetNano, offsetDisambig = 0, epochDisambig = 0, epochFuzzy, hasZ) {
  if (hasZ || void 0 !== offsetNano && 1 === offsetDisambig) {
    return isoDateTimeAndOffsetToEpochNano(isoDateTime, offsetNano || 0);
  }
  const possibleEpochNanos = timeZone.O(isoDateTime);
  if (void 0 !== offsetNano && 3 !== offsetDisambig) {
    checkIsoDateInBounds(isoDateTime, 0);
    const matchingEpochNano = ((possibleEpochNanos2, isoDateTime2, offsetNano2, fuzzy) => {
      const zonedEpochNano = isoDateTimeToEpochNano(isoDateTime2);
      fuzzy && (offsetNano2 = roundToMinute(offsetNano2));
      for (const possibleEpochNano of possibleEpochNanos2) {
        let possibleOffsetNano = Number(zonedEpochNano - possibleEpochNano);
        if (fuzzy && (possibleOffsetNano = roundToMinute(possibleOffsetNano)), possibleOffsetNano === offsetNano2) {
          return possibleEpochNano;
        }
      }
    })(possibleEpochNanos, isoDateTime, offsetNano, epochFuzzy);
    if (void 0 !== matchingEpochNano) {
      return matchingEpochNano;
    }
    0 === offsetDisambig && throwRangeError("Invalid TimeZone offset");
  }
  return getSingleInstantFor(timeZone, isoDateTime, epochDisambig, possibleEpochNanos);
}
function getSingleInstantFor(timeZone, isoDateTime, disambig = 0, possibleEpochNanos = timeZone.O(isoDateTime)) {
  if (1 === possibleEpochNanos.length) {
    return possibleEpochNanos[0];
  }
  if (1 === disambig && throwRangeError("Ambiguous offset"), possibleEpochNanos.length) {
    return possibleEpochNanos[3 === disambig ? 1 : 0];
  }
  const zonedEpochNano = isoDateTimeToEpochNano(isoDateTime);
  const gapNano = ((timeZone2, zonedEpochNano2) => {
    const startOffsetNano = timeZone2.B(zonedEpochNano2 - bigNanoInUtcDay);
    return ((gapNano2) => (gapNano2 > nanoInUtcDay && throwRangeError("Out-of-bounds TimeZone gap"), gapNano2))(timeZone2.B(zonedEpochNano2 + bigNanoInUtcDay) - startOffsetNano);
  })(timeZone, zonedEpochNano);
  const shiftedIsoDateTime = epochNanoToIsoDateTime(zonedEpochNano + BigInt(gapNano * (2 === disambig ? -1 : 1)));
  return (possibleEpochNanos = timeZone.O(shiftedIsoDateTime))[2 === disambig ? 0 : possibleEpochNanos.length - 1];
}
function getStartOfDayInstantFor(timeZone, isoDateTime) {
  const possibleEpochNanos = timeZone.O(isoDateTime);
  if (possibleEpochNanos.length) {
    return possibleEpochNanos[0];
  }
  const zonedEpochNanoDayBefore = isoDateTimeToEpochNano(isoDateTime) - bigNanoInUtcDay;
  return timeZone.C(zonedEpochNanoDayBefore, 1);
}
function moveYearMonth(calendar, isoDate, durationSlots, overflow = 0) {
  computeDurationSign(durationSlots) && clampEntity("unit", getMaxDurationUnit(durationSlots), 8, 9, 1, durationFieldNamesAsc);
  const first = checkIsoDateInBounds(moveToStartOfMonth(calendar, isoDate));
  return moveToStartOfMonth(calendar, moveDate(calendar, first, durationSlots, overflow));
}
function moveZonedEpochSlots(slots, durationFields, overflow = 0) {
  const { calendar, epochNanoseconds: epochNano, timeZone } = slots;
  const timeOnlyNano = durationTimeToBigNano(durationFields);
  let movedEpochNano = epochNano;
  if (durationHasDateParts(durationFields)) {
    const isoDateTime = zonedEpochSlotsToIso(slots);
    movedEpochNano = getSingleInstantFor(timeZone, combineDateAndTime(moveDate(calendar, isoDateTime, {
      ...durationFields,
      ...durationTimeFieldDefaults
    }, overflow), isoDateTime)) + timeOnlyNano;
  } else {
    movedEpochNano += timeOnlyNano;
  }
  return {
    ...slots,
    epochNanoseconds: checkEpochNanoInBounds(movedEpochNano)
  };
}
function moveDateTime(calendar, isoDateTime, durationFields, overflow = 0) {
  const [movedTimeFields, dayDelta] = moveTime(isoDateTime, durationFields);
  return checkIsoDateTimeInBounds(combineDateAndTime(moveDate(calendar, isoDateTime, {
    ...durationFields,
    ...durationTimeFieldDefaults,
    days: durationFields.days + dayDelta
  }, overflow), movedTimeFields));
}
function moveTime(timeFields, durationFields) {
  return moveTimeByNano(timeFields, durationTimeToBigNano(durationFields));
}
function moveEpochNano(epochNano, durationFields) {
  return moveEpochNanoByNano(epochNano, (clampEntity("unit", getMaxDurationUnit(fields = durationFields), 0, 5, 1, durationFieldNamesAsc), durationTimeToBigNano(fields)));
  var fields;
}
function moveDate(calendar, isoDate, durationFields, overflow = 0) {
  let { years, months, weeks, days } = durationFields;
  let movedIsoDate;
  if (days += Number(durationTimeToBigNano(durationFields) / bigNanoInUtcDay), years || months) {
    movedIsoDate = moveDateByCalendarUnits(calendar, isoDate, years, months, overflow);
  } else {
    if (!weeks && !days) {
      return isoDate;
    }
    movedIsoDate = isoDate;
  }
  return (weeks || days) && (movedIsoDate = moveDateByDays(movedIsoDate, 7 * weeks + days)), checkIsoDateInBounds(movedIsoDate);
}
function moveToStartOfMonth(calendar, isoDate) {
  return moveDateByDays(isoDate, 1 - computeCalendarDateFields(calendar, isoDate).day);
}
function moveDateByCalendarUnits(calendar, isoDate, years, months, overflow) {
  const dateParts = computeCalendarDateFields(calendar, isoDate);
  let { year, month, day } = dateParts;
  if (years) {
    const [monthCodeNumber, isLeapMonth] = computeCalendarMonthCodeParts(calendar, year, month);
    year += years, month = resolveMonthInMovedYear(calendar, monthCodeNumber, isLeapMonth, calendar ? calendar.p(year) : void 0, overflow), month = clampEntity("month", month, 1, computeCalendarMonthsInYearForYear(calendar, year), overflow);
  }
  if (months) {
    const yearMonthParts = addCalendarMonths(calendar, year, month, months);
    ({ year, month } = yearMonthParts);
  }
  return day = clampEntity("day", day, 1, computeCalendarDaysInMonthForYearMonth(calendar, year, month), overflow), computeCalendarIsoFieldsFromParts(calendar, year, month, day);
}
function addCalendarMonths(calendar, year, month, monthDelta) {
  return calendar ? calendar.ae(year, month, monthDelta) : addIsoMonths(year, month, monthDelta);
}
function resolveMonthInMovedYear(calendar, monthCodeNumber, isLeapMonth, targetLeapMonth, overflow) {
  if (isLeapMonth) {
    const leapMonthMeta = calendar ? calendar.l : void 0;
    if (void 0 !== targetLeapMonth && (leapMonthMeta < 0 || targetLeapMonth === monthCodeNumber + 1)) {
      return targetLeapMonth;
    }
    if (1 === overflow && throwRangeError(invalidLeapMonth), leapMonthMeta < 0) {
      return -leapMonthMeta;
    }
  }
  return monthCodeNumberToMonth(monthCodeNumber, 0, targetLeapMonth);
}
function moveTimeByNano(timeFields, durationBigNano) {
  const durDays = Number(durationBigNano / bigNanoInUtcDay);
  const durTimeNano = Number(durationBigNano % bigNanoInUtcDay);
  const [newTimeFields, overflowDays] = nanoToTimeAndDay(timeFieldsToNano(timeFields) + durTimeNano);
  return [newTimeFields, durDays + overflowDays];
}
function moveEpochNanoByNano(epochNano, deltaNano) {
  return checkEpochNanoInBounds(epochNano + deltaNano);
}
function moveDateByDays(isoDate, days) {
  return days ? epochDaysToIsoDate(isoDateToEpochDays(isoDate) + days) : isoDate;
}
function getCommonCalendar(a, b) {
  return getCalendarSlotId(a) !== getCalendarSlotId(b) && throwRangeError("Mismatching Calendars"), a;
}
function getCommonTimeZone(a, b) {
  return a.m !== b.m && throwRangeError("Mismatching TimeZones"), a;
}
function getZonedTimeZoneId(slots) {
  return slots.timeZone.id;
}
function diffZonedDateTimesRounded(calendar, startZoned, endZoned, largestUnit, smallestUnit, roundingInc, roundingMode) {
  return largestUnit < 6 ? diffEpochNanosRounded(startZoned.epochNanoseconds, endZoned.epochNanoseconds, largestUnit, smallestUnit, roundingInc, roundingMode) : ((calendar2, startZoned2, endZoned2, largestUnit2, smallestUnit2, roundingInc2, roundingMode2) => {
    const timeZone = getCommonTimeZone(startZoned2.timeZone, endZoned2.timeZone);
    const endEpochNano = endZoned2.epochNanoseconds;
    if (endEpochNano === startZoned2.epochNanoseconds) {
      return durationFieldDefaults;
    }
    let durationFields;
    return durationFields = diffZonedEpochsExact(timeZone, calendar2, startZoned2, endZoned2, largestUnit2), durationFields = roundRelativeDuration(durationFields, endEpochNano, largestUnit2, smallestUnit2, roundingInc2, roundingMode2, createZonedRelativeOps(calendar2, timeZone, startZoned2), 1), durationFields;
  })(calendar, startZoned, endZoned, largestUnit, smallestUnit, roundingInc, roundingMode);
}
function diffDateTimesRounded(calendar, startIsoDateTime, endIsoDateTime, largestUnit, smallestUnit, roundingInc, roundingMode) {
  return largestUnit <= 6 ? diffEpochNanosRounded(isoDateTimeToEpochNano(startIsoDateTime), isoDateTimeToEpochNano(endIsoDateTime), largestUnit, smallestUnit, roundingInc, roundingMode) : ((calendar2, startIsoDateTime2, endIsoDateTime2, largestUnit2, smallestUnit2, roundingInc2, roundingMode2) => {
    const endEpochNano = isoDateTimeToEpochNano(endIsoDateTime2);
    const sign = compareBigInts(endEpochNano, isoDateTimeToEpochNano(startIsoDateTime2));
    if (!sign) {
      return durationFieldDefaults;
    }
    let durationFields;
    return durationFields = diffDateTimesBig(calendar2, startIsoDateTime2, endIsoDateTime2, sign, largestUnit2), durationFields = roundRelativeDuration(durationFields, endEpochNano, largestUnit2, smallestUnit2, roundingInc2, roundingMode2, ((calendar3, origin) => ({
      ne: isoDateTimeToEpochNano(origin),
      X: (duration2) => isoDateTimeToEpochNano(combineDateAndTime(moveDate(calendar3, origin, duration2), origin))
    }))(calendar2, startIsoDateTime2)), durationFields;
  })(calendar, startIsoDateTime, endIsoDateTime, largestUnit, smallestUnit, roundingInc, roundingMode);
}
function diffYearMonthsRounded(calendar, startIsoDate, endIsoDate, largestUnit, smallestUnit, roundingInc, roundingMode) {
  const firstOfMonth0 = moveToStartOfMonth(calendar, startIsoDate);
  const firstOfMonth1 = moveToStartOfMonth(calendar, endIsoDate);
  return compareIsoDates(firstOfMonth0, firstOfMonth1) ? diffDateCalendarUnitsRounded(calendar, checkIsoDateInBounds(firstOfMonth0), checkIsoDateInBounds(firstOfMonth1), largestUnit, smallestUnit, roundingInc, roundingMode, 8) : durationFieldDefaults;
}
function diffDatesRounded(calendar, startIsoDate, endIsoDate, largestUnit, smallestUnit, roundingInc, roundingMode, smallestPrecision = 6) {
  return 6 === largestUnit ? diffEpochNanosRounded(isoDateToEpochNano(startIsoDate), isoDateToEpochNano(endIsoDate), largestUnit, smallestUnit, roundingInc, roundingMode) : diffDateCalendarUnitsRounded(calendar, startIsoDate, endIsoDate, largestUnit, smallestUnit, roundingInc, roundingMode, smallestPrecision);
}
function diffTimesRounded(plainTimeSlots0, plainTimeSlots1, largestUnit, smallestUnit, roundingInc, roundingMode) {
  const timeDiffNano = roundNumberToInc(timeFieldsToNano(plainTimeSlots1) - timeFieldsToNano(plainTimeSlots0), computeNanoInc(smallestUnit, roundingInc), roundingMode);
  return {
    ...durationFieldDefaults,
    ...nanoToDurationTimeFields(timeDiffNano, largestUnit)
  };
}
function diffDateCalendarUnitsRounded(calendar, startIsoDate, endIsoDate, largestUnit, smallestUnit, roundingInc, roundingMode, smallestPrecision = 6) {
  const endEpochNano = isoDateToEpochNano(endIsoDate);
  if (!compareIsoDates(startIsoDate, endIsoDate)) {
    return durationFieldDefaults;
  }
  let durationFields;
  return durationFields = diffCalendarDates(calendar, startIsoDate, endIsoDate, largestUnit), smallestUnit === smallestPrecision && 1 === roundingInc || (durationFields = roundRelativeDuration(durationFields, endEpochNano, largestUnit, smallestUnit, roundingInc, roundingMode, createDateRelativeOps(calendar, startIsoDate))), durationFields;
}
function diffEpochNanosRounded(startEpochNano, endEpochNano, largestUnit, smallestUnit, roundingInc, roundingMode) {
  return {
    ...durationFieldDefaults,
    ...nanoToDurationDayTimeFields(roundBigNanoToInc(endEpochNano - startEpochNano, computeBigNanoInc(smallestUnit, roundingInc), roundingMode), largestUnit)
  };
}
function diffZonedEpochsExact(timeZone, calendar, startZoned, endZoned, largestUnit) {
  return largestUnit < 6 ? {
    ...durationFieldDefaults,
    ...nanoToDurationDayTimeFields(endZoned.epochNanoseconds - startZoned.epochNanoseconds, largestUnit)
  } : ((timeZone2, startZoned2, endZoned2) => {
    const sign = compareBigInts(endZoned2.epochNanoseconds, startZoned2.epochNanoseconds);
    if (!sign) {
      return durationFieldDefaults;
    }
    if (!compareIsoDates(zonedEpochSlotsToIso(startZoned2), zonedEpochSlotsToIso(endZoned2))) {
      return {
        ...durationFieldDefaults,
        ...nanoToDurationDayTimeFields(endZoned2.epochNanoseconds - startZoned2.epochNanoseconds, 5)
      };
    }
    const [startIsoDateTime, endIsoDate, remainderNano] = prepareZonedEpochDiff(timeZone2, startZoned2, endZoned2, sign);
    return {
      ...(start = startIsoDateTime, end = endIsoDate, diffCalendarDates(calendar, start, end, largestUnit)),
      ...nanoToDurationTimeFields(remainderNano)
    };
    var start, end;
  })(timeZone, startZoned, endZoned);
}
function diffDateTimesExact(calendar, startIsoDateTime, endIsoDateTime, largestUnit) {
  const startEpochNano = isoDateTimeToEpochNano(startIsoDateTime);
  const endEpochNano = isoDateTimeToEpochNano(endIsoDateTime);
  const sign = compareBigInts(endEpochNano, startEpochNano);
  return sign ? largestUnit <= 6 ? {
    ...durationFieldDefaults,
    ...nanoToDurationDayTimeFields(endEpochNano - startEpochNano, largestUnit)
  } : diffDateTimesBig(calendar, startIsoDateTime, endIsoDateTime, sign, largestUnit) : durationFieldDefaults;
}
function diffDateTimesBig(calendar, startIsoDateTime, endIsoDateTime, sign, largestUnit) {
  let diffEndDate = endIsoDateTime;
  let timeNano = timeFieldsToNano(endIsoDateTime) - timeFieldsToNano(startIsoDateTime);
  return Math.sign(timeNano) === -sign && (diffEndDate = moveDateByDays(endIsoDateTime, -sign), timeNano += nanoInUtcDay * sign), {
    ...diffCalendarDates(calendar, startIsoDateTime, diffEndDate, largestUnit),
    ...nanoToDurationTimeFields(timeNano)
  };
}
function prepareZonedEpochDiff(timeZone, startZoned, endZoned, sign) {
  const startIsoDate = zonedEpochSlotsToIso(startZoned);
  const endIsoDate = zonedEpochSlotsToIso(endZoned);
  const endEpochNano = endZoned.epochNanoseconds;
  let dayCorrection = 0;
  const timeDiffNano = timeFieldsToNano(endIsoDate) - timeFieldsToNano(startIsoDate);
  Math.sign(timeDiffNano) === -sign && dayCorrection++;
  const maxDayCorrection = sign > 0 ? 2 : 1;
  for (; ; dayCorrection++) {
    const midIsoDate = moveDateByDays(endIsoDate, dayCorrection * -sign);
    const midEpochNano = getSingleInstantFor(timeZone, combineDateAndTime(midIsoDate, startIsoDate));
    if (dayCorrection === maxDayCorrection || compareBigInts(endEpochNano, midEpochNano) !== -sign) {
      return [startIsoDate, midIsoDate, Number(endEpochNano - midEpochNano)];
    }
  }
}
function diffCalendarDates(calendar, startIsoDate, endIsoDate, largestUnit) {
  if (largestUnit <= 7) {
    return ((asWeeks, start, end) => {
      const days = countIsoDays(start, end);
      return asWeeks ? {
        ...durationFieldDefaults,
        weeks: divTrunc(days, 7),
        days: modTrunc(days, 7)
      } : {
        ...durationFieldDefaults,
        days
      };
    })(7 === largestUnit, startIsoDate, endIsoDate);
  }
  const yearMonthDayStart = computeCalendarDateFields(calendar, startIsoDate);
  const yearMonthDayEnd = computeCalendarDateFields(calendar, endIsoDate);
  if (8 === largestUnit) {
    const { year: year02, month: month02, day: day02 } = yearMonthDayStart;
    const { year: year12, month: month12, day: day12 } = yearMonthDayEnd;
    const sign = Math.sign(compareNumbers(year12, year02) || compareNumbers(month12, month02) || countIsoDays(startIsoDate, endIsoDate));
    let months = 0;
    let days = 0;
    if (sign) {
      months = calendar ? calendar.ee(year02, month02, year12, month12) : diffIsoMonthSlots(year02, month02, year12, month12);
      let anchorIsoDate = moveDateByCalendarUnits(calendar, startIsoDate, 0, months, 0);
      sign * compareNumbers(day02, day12) > 0 && (months -= sign, anchorIsoDate = moveDateByCalendarUnits(calendar, startIsoDate, 0, months, 0)), days = countIsoDays(anchorIsoDate, endIsoDate);
    }
    return {
      ...durationFieldDefaults,
      months,
      days
    };
  }
  const { year: year0, month: month0, day: day0 } = yearMonthDayStart;
  let { year: year1, month: month1, day: day1 } = yearMonthDayEnd;
  let yearDiff = year1 - year0;
  let monthDiff = month1 - month0;
  let dayDiff = day1 - day0;
  if (yearDiff || monthDiff) {
    const sign = Math.sign(yearDiff || monthDiff);
    let daysInMonth1 = computeCalendarDaysInMonthForYearMonth(calendar, year1, month1);
    let dayCorrect = 0;
    if (Math.sign(day1 - day0) === -sign) {
      const origDaysInMonth1 = daysInMonth1;
      const yearMonthParts = addCalendarMonths(calendar, year1, month1, -sign);
      ({ year: year1, month: month1 } = yearMonthParts), yearDiff = year1 - year0, monthDiff = month1 - month0, daysInMonth1 = computeCalendarDaysInMonthForYearMonth(calendar, year1, month1), dayCorrect = sign < 0 ? -origDaysInMonth1 : daysInMonth1;
    }
    if (dayDiff = day1 - Math.min(day0, daysInMonth1) + dayCorrect, yearDiff) {
      const [monthCodeNumber0, isLeapMonth0] = computeCalendarMonthCodeParts(calendar, year0, month0);
      const [monthCodeNumber1, isLeapMonth1] = computeCalendarMonthCodeParts(calendar, year1, month1);
      const leapMonthMeta = calendar ? calendar.l : void 0;
      if (monthDiff = void 0 !== leapMonthMeta && isLeapMonth0 && !isLeapMonth1 && (leapMonthMeta < 0 ? sign > 0 && monthCodeNumber1 === -leapMonthMeta : sign < 0 && monthCodeNumber1 === monthCodeNumber0) ? 0 : monthCodeNumber1 - monthCodeNumber0 || Number(isLeapMonth1) - Number(isLeapMonth0), Math.sign(monthDiff) === -sign) {
        const monthCorrect = sign < 0 && -computeCalendarMonthsInYearForYear(calendar, year1);
        year1 -= sign, yearDiff = year1 - year0, monthDiff = month1 - resolveMonthInMovedYear(calendar, monthCodeNumber0, isLeapMonth0, calendar ? calendar.p(year1) : void 0, 0) + (monthCorrect || computeCalendarMonthsInYearForYear(calendar, year1));
      } else if (calendar) {
        const month0Projected = resolveMonthInMovedYear(calendar, monthCodeNumber0, isLeapMonth0, calendar.p(year1), 0);
        monthDiff = calendar.ee(year1, month0Projected, year1, month1);
      }
    }
  }
  return {
    ...durationFieldDefaults,
    years: yearDiff,
    months: monthDiff,
    days: dayDiff
  };
}
function compareIsoDates(isoDate0, isoDate1) {
  return compareNumbers(isoDate0.year, isoDate1.year) || compareNumbers(isoDate0.month, isoDate1.month) || compareNumbers(isoDate0.day, isoDate1.day);
}
function countIsoDays(startIsoDate, endIsoDate) {
  return isoDateToEpochDays(endIsoDate) - isoDateToEpochDays(startIsoDate);
}
function spanRelativeDuration(relativeToSlots, durationFields, largestUnit) {
  return isZonedEpochSlots(relativeToSlots) ? ((relativeToSlots2, durationFields2, largestUnit2) => {
    const { calendar, timeZone } = relativeToSlots2;
    const endSlots = moveZonedEpochSlots(relativeToSlots2, durationFields2);
    return [diffZonedEpochsExact(timeZone, calendar, relativeToSlots2, endSlots, largestUnit2), endSlots.epochNanoseconds, createZonedRelativeOps(calendar, timeZone, relativeToSlots2)];
  })(relativeToSlots, durationFields, largestUnit) : ((relativeToSlots2, durationFields2, largestUnit2) => {
    const { calendar } = relativeToSlots2;
    const origin = checkIsoDateTimeInBounds(combineDateAndTime(relativeToSlots2, timeFieldDefaults));
    const end = moveDateTime(calendar, origin, durationFields2);
    return [diffDateTimesExact(calendar, origin, end, largestUnit2), isoDateTimeToEpochNano(end), createDateRelativeOps(calendar, relativeToSlots2)];
  })(relativeToSlots, durationFields, largestUnit);
}
function moveRelativeEndpointToEpochNano(relativeToSlots, durationFields) {
  return isZonedEpochSlots(relativeToSlots) ? moveZonedEpochSlots(relativeToSlots, durationFields).epochNanoseconds : isoDateTimeToEpochNano(moveDateTime(relativeToSlots.calendar, combineDateAndTime(relativeToSlots, timeFieldDefaults), durationFields));
}
function moveRelativeMarkerToEpochNano(relativeOps, dateDuration) {
  return durationHasDateParts(dateDuration) ? relativeOps.X(dateDuration) : relativeOps.ne;
}
function createZonedRelativeOps(calendar, timeZone, slots) {
  const origin = zonedEpochSlotsToIso(slots);
  return {
    ne: slots.epochNanoseconds,
    X: (duration2) => getSingleInstantFor(timeZone, combineDateAndTime(moveDate(calendar, origin, duration2), origin))
  };
}
function createDateRelativeOps(calendar, origin) {
  return {
    ne: isoDateToEpochNano(origin),
    X: (duration2) => isoDateToEpochNano(moveDate(calendar, origin, duration2))
  };
}
function isZonedEpochSlots(slots) {
  return "timeZone" in slots;
}
function isUniformUnit(unit, isZoned2) {
  return unit <= 6 - (isZoned2 ? 1 : 0);
}
function nanoToGivenFields(nano, largestUnit, fieldNames) {
  const fields = {};
  for (let unit = largestUnit; unit >= 0; unit--) {
    const divisor = unitNanoMap[unit];
    fields[fieldNames[unit]] = divTrunc(nano, divisor), nano = modTrunc(nano, divisor);
  }
  return fields;
}
var maxDurationSeconds = 2 ** 53;
function addDurationsWithoutRelativeTo(doSubtract, slots, otherSlots) {
  const maxUnit = Math.max(getMaxDurationUnit(slots), getMaxDurationUnit(otherSlots));
  return clampEntity("unit", maxUnit, 0, 6, 1, durationFieldNamesAsc), ((doSubtract2, slots2, otherSlots2, maxUnit2) => createDurationSlots(validateDurationFields(((a, b, largestUnit, doSubtract3) => {
    const combined = durationDayTimeToBigNano(a) + durationDayTimeToBigNano(b) * BigInt(doSubtract3 ? -1 : 1);
    return Number.isFinite(Number(combined / bigNanoInUtcDay)) || throwRangeError(outOfBoundsDate), {
      ...durationFieldDefaults,
      ...nanoToDurationDayTimeFields(combined, largestUnit)
    };
  })(slots2, otherSlots2, maxUnit2, doSubtract2))))(doSubtract, slots, otherSlots, maxUnit);
}
function roundDuration(refineRelativeTo, slots, options) {
  const durationLargestUnit = getMaxDurationUnit(slots);
  const [largestUnit, smallestUnit, roundingInc, roundingMode, relativeToSlots] = ((options2, defaultLargestUnit, refineRelativeTo2) => {
    options2 = normalizeOptionsOrString(options2, smallestUnitStr);
    let largestUnit2 = coerceLargestUnit(options2);
    const relativeToInternals = refineRelativeTo2(options2.relativeTo);
    let roundingInc2 = coerceRoundingIncInteger(options2);
    const roundingMode2 = coerceRoundingMode(options2, 7);
    let smallestUnit2 = coerceSmallestUnit(options2);
    return void 0 === largestUnit2 && void 0 === smallestUnit2 && throwRangeError("Required smallestUnit or largestUnit"), null == smallestUnit2 && (smallestUnit2 = 0), null == largestUnit2 && (largestUnit2 = Math.max(smallestUnit2, defaultLargestUnit)), checkLargestSmallestUnit(largestUnit2, smallestUnit2), roundingInc2 = validateRoundingInc(roundingInc2, smallestUnit2, 1), roundingInc2 > 1 && smallestUnit2 > 5 && largestUnit2 !== smallestUnit2 && throwRangeError("For calendar units with roundingIncrement > 1, use largestUnit = smallestUnit"), [largestUnit2, smallestUnit2, roundingInc2, roundingMode2, relativeToInternals];
  })(options, durationLargestUnit, refineRelativeTo);
  if (!relativeToSlots && Math.max(durationLargestUnit, largestUnit) <= 6) {
    return createDurationSlots(validateDurationFields(((durationFields, largestUnit2, smallestUnit2, roundingInc2, roundingMode2) => {
      const roundedBigNano = roundBigNanoToInc(durationDayTimeToBigNano(durationFields), computeBigNanoInc(smallestUnit2, roundingInc2), roundingMode2);
      return {
        ...durationFieldDefaults,
        ...nanoToDurationDayTimeFields(roundedBigNano, largestUnit2)
      };
    })(slots, largestUnit, smallestUnit, roundingInc, roundingMode)));
  }
  relativeToSlots || throwRangeError("Missing relativeTo");
  const isZoned2 = isZonedEpochSlots(relativeToSlots);
  if (!slots.sign && (!isZoned2 || largestUnit < 6)) {
    return slots;
  }
  const [balancedDuration, endEpochNano, relativeOps] = spanRelativeDuration(relativeToSlots, slots, largestUnit);
  return createDurationSlots(roundRelativeDuration(balancedDuration, endEpochNano, largestUnit, smallestUnit, roundingInc, roundingMode, relativeOps, isZoned2));
}
function absDuration(slots) {
  return -1 === slots.sign ? negateDuration(slots) : slots;
}
function negateDuration(slots) {
  return createDurationSlots(negateDurationFields(slots));
}
function negateDurationFields(fields) {
  const res = {};
  for (const fieldName of durationFieldNamesAsc) {
    res[fieldName] = -1 * fields[fieldName] || 0;
  }
  return res;
}
function computeDurationSign(fields, fieldNames = durationFieldNamesAsc) {
  let sign = 0;
  for (const fieldName of fieldNames) {
    const fieldSign = Math.sign(fields[fieldName]);
    fieldSign && (sign && sign !== fieldSign && throwRangeError("Cannot mix duration signs"), sign = fieldSign);
  }
  return sign;
}
function validateDurationFields(fields) {
  for (const calendarUnit of durationCalendarFieldNamesAsc) {
    validateDurationCalendarUnit(calendarUnit, fields[calendarUnit]);
  }
  const bigNano = durationDayTimeToBigNano(fields);
  return validateDurationTimeUnit(Number(bigNano / bigNanoInSec)), fields;
}
function validateDurationCalendarUnit(unit, value) {
  return clampEntity(unit, value, -4294967295, 4294967295, 1);
}
function validateDurationTimeUnit(n) {
  Number.isSafeInteger(n) || throwRangeError("Out-of-bounds duration");
}
function durationDayTimeToBigNano(fields) {
  return BigInt(fields.days) * bigNanoInUtcDay + durationTimeToBigNano(fields);
}
function durationTimeToBigNano(fields) {
  return BigInt(fields.hours) * bigNanoInHour + BigInt(fields.minutes) * bigNanoInMinute + durationSubMinuteToBigNano(fields);
}
function durationSubMinuteToBigNano(fields) {
  return BigInt(fields.seconds) * bigNanoInSec + BigInt(fields.milliseconds) * bigNanoInMilli + BigInt(fields.microseconds) * bigNanoInMicro + BigInt(fields.nanoseconds);
}
function nanoToDurationDayTimeFields(bigNano, largestUnit = 6) {
  const days = Number(bigNano / bigNanoInUtcDay);
  const timeNano = Number(bigNano % bigNanoInUtcDay);
  const unitNano = unitNanoMap[largestUnit];
  const largestUnitVal = largestUnit <= 3 ? Number(bigNano / BigInt(unitNano)) : days * (nanoInUtcDay / unitNano) + divTrunc(timeNano, unitNano);
  Number.isFinite(largestUnitVal) || throwRangeError(outOfBoundsDate), largestUnit <= 3 && Math.abs(largestUnitVal) / (nanoInSec2 / unitNanoMap[largestUnit]) >= maxDurationSeconds && throwRangeError(outOfBoundsDate);
  const dayTimeFields = nanoToGivenFields(timeNano, largestUnit, durationFieldNamesAsc);
  return dayTimeFields[durationFieldNamesAsc[largestUnit]] = largestUnitVal, dayTimeFields;
}
function nanoToDurationTimeFields(nano, largestUnit = 5) {
  return nanoToGivenFields(nano, largestUnit, durationFieldNamesAsc);
}
function durationHasDateParts(fields) {
  return Boolean(computeDurationSign(fields, durationDateFieldNamesAsc));
}
function getMaxDurationUnit(fields) {
  let unit = 9;
  for (; unit > 0 && !fields[durationFieldNamesAsc[unit]]; unit--) {
  }
  return unit;
}
function compareZonedEpochSlots(zonedEpochSlots0, zonedEpochSlots1) {
  return compareBigInts(zonedEpochSlots0.epochNanoseconds, zonedEpochSlots1.epochNanoseconds);
}
function compareDurations(refineRelativeTo, durationSlots0, durationSlots1, options) {
  const relativeToSlots = refineRelativeTo(normalizeOptions(options).relativeTo);
  const maxUnit = Math.max(getMaxDurationUnit(durationSlots0), getMaxDurationUnit(durationSlots1));
  return allPropsEqual(durationFieldNamesAsc, durationSlots0, durationSlots1) ? 0 : isUniformUnit(maxUnit, relativeToSlots && isZonedEpochSlots(relativeToSlots)) ? compareBigInts(durationDayTimeToBigNano(durationSlots0), durationDayTimeToBigNano(durationSlots1)) : (relativeToSlots || throwRangeError("Missing relativeTo"), compareBigInts(moveRelativeEndpointToEpochNano(relativeToSlots, durationSlots0), moveRelativeEndpointToEpochNano(relativeToSlots, durationSlots1)));
}
function compareIsoDateTimeFields(isoDateTime0, isoDateTime1) {
  return compareIsoDateFields(isoDateTime0, isoDateTime1) || compareTimeFields(isoDateTime0, isoDateTime1);
}
function compareIsoDateFields(isoDate0, isoDate1) {
  return compareNumbers(isoDateToEpochDays(isoDate0), isoDateToEpochDays(isoDate1));
}
function compareTimeFields(timeFields0, timeFields1) {
  return compareNumbers(timeFieldsToNano(timeFields0), timeFieldsToNano(timeFields1));
}
function instantsEqual(instantSlots0, instantSlots1) {
  return !compareZonedEpochSlots(instantSlots0, instantSlots1);
}
function zonedDateTimesEqual(zonedDateTimeSlots0, zonedDateTimeSlots1) {
  return !compareZonedEpochSlots(zonedDateTimeSlots0, zonedDateTimeSlots1) && zonedDateTimeSlots0.timeZone.m === zonedDateTimeSlots1.timeZone.m && zonedDateTimeSlots0.calendar === zonedDateTimeSlots1.calendar;
}
function plainDateTimesEqual(plainDateTimeSlots0, plainDateTimeSlots1) {
  return !compareIsoDateTimeFields(plainDateTimeSlots0, plainDateTimeSlots1) && plainDateTimeSlots0.calendar === plainDateTimeSlots1.calendar;
}
function plainDatesEqual(plainDateSlots0, plainDateSlots1) {
  return !compareIsoDateFields(plainDateSlots0, plainDateSlots1) && plainDateSlots0.calendar === plainDateSlots1.calendar;
}
function plainYearMonthsEqual(plainYearMonthSlots0, plainYearMonthSlots1) {
  return !compareIsoDateFields(plainYearMonthSlots0, plainYearMonthSlots1) && plainYearMonthSlots0.calendar === plainYearMonthSlots1.calendar;
}
function plainMonthDaysEqual(plainMonthDaySlots0, plainMonthDaySlots1) {
  return !compareIsoDateFields(plainMonthDaySlots0, plainMonthDaySlots1) && plainMonthDaySlots0.calendar === plainMonthDaySlots1.calendar;
}
function plainTimesEqual(plainTimeSlots0, plainTimeSlots1) {
  return !compareTimeFields(plainTimeSlots0, plainTimeSlots1);
}
function getCalendarEraOrigins(calendar) {
  return 0 === calendar ? gregoryEraOrigins : calendar ? calendar.k : void 0;
}
function getCalendarFieldNames(calendar, fieldNames, fieldNamesWithEra = fieldNames) {
  return getCalendarEraOrigins(calendar) ? fieldNamesWithEra : fieldNames;
}
function resolveCalendarYear(fields, calendar) {
  const exoticCalendar = calendar || void 0;
  const eraOrigins = getCalendarEraOrigins(calendar);
  let { era, eraYear, year } = fields;
  if (void 0 !== year && (year = toIntegerWithTrunc(year, "year")), void 0 !== eraYear && (eraYear = toIntegerWithTrunc(eraYear, "eraYear")), void 0 !== era || void 0 !== eraYear) {
    void 0 !== era && void 0 !== eraYear || throwTypeError("Mismatching era/eraYear"), eraOrigins || throwRangeError("Forbidden era/eraYear");
    const normalizedEra = normalizeEraName(era);
    const eraOrigin = eraOrigins[normalizedEra];
    void 0 === eraOrigin && throwRangeError(((era2) => `Invalid era: ${era2}`)(era));
    const yearByEra = exoticCalendar?._ ? exoticCalendar._(eraYear, normalizedEra, eraOrigin) : eraYearToYear(eraYear, eraOrigin);
    void 0 !== year && year !== yearByEra && throwRangeError("Mismatching year/eraYear"), year = yearByEra;
  } else {
    void 0 === year && throwTypeError(missingYear(eraOrigins));
  }
  return year;
}
function resolveCalendarMonth(fields, calendar, year, monthCodeParts, overflow) {
  let { month, monthCode } = fields;
  if (void 0 !== monthCode) {
    const monthByCode = ((calendar2, monthCode2, year2, overflow2, monthCodeParts2 = parseMonthCode(monthCode2)) => {
      const leapMonth = calendar2 ? calendar2.p(year2) : void 0;
      const [monthCodeNumber, wantsLeapMonth] = monthCodeParts2;
      let month2 = monthCodeNumberToMonth(monthCodeNumber, wantsLeapMonth, leapMonth);
      if (wantsLeapMonth) {
        const leapMonthMeta = calendar2 ? calendar2.l : void 0;
        void 0 === leapMonthMeta && throwRangeError(invalidLeapMonth), leapMonthMeta > 0 ? (month2 > leapMonthMeta && throwRangeError(invalidLeapMonth), leapMonth !== month2 && (1 === overflow2 && throwRangeError(invalidLeapMonth), month2 = monthCodeNumberToMonth(monthCodeNumber, 0, leapMonth))) : (month2 !== -leapMonthMeta && throwRangeError(invalidLeapMonth), void 0 === leapMonth && 1 === overflow2 && throwRangeError(invalidLeapMonth));
      }
      return month2;
    })(calendar, monthCode, year, overflow, monthCodeParts);
    void 0 !== month && month !== monthByCode && throwRangeError("Mismatching month/monthCode"), month = monthByCode, overflow = 1;
  } else {
    void 0 === month && throwTypeError("Missing month/monthCode");
  }
  return clampEntity("month", month, 1, computeCalendarMonthsInYearForYear(calendar, year), overflow);
}
function resolveCalendarDay(fields, calendar, year, month, overflow) {
  return clampProp(fields, "day", 1, computeCalendarDaysInMonthForYearMonth(calendar, year, month), overflow);
}
function eraYearToYear(eraYear, eraOrigin) {
  return (eraOrigin + eraYear) * (Math.sign(eraOrigin) || 1) || 0;
}
function resolveTimeFields(fields, overflow) {
  return constrainTimeFields(pluckProps(timeFieldNamesAsc, {
    ...timeFieldDefaults,
    ...fields
  }), overflow);
}
var offsetRegExp = /^([+-])([01]\d|2[0-3])(?:(:?)([0-5]\d)(?:\3([0-5]\d)(?:[.,](\d{1,9}))?)?)?$/;
function parseOffsetNano(s) {
  const offsetNano = parseOffsetNanoMaybe(s);
  return void 0 === offsetNano && throwRangeError(failedParse(s)), offsetNano;
}
function parseOffsetNanoMaybe(s, onlyHourMinute) {
  const parts = offsetRegExp.exec(s);
  if (parts) {
    return onlyHourMinute && parts[5] && throwRangeError(failedParse(s)), /* @__PURE__ */ ((s2) => s2 && "+" !== s2 ? -1 : 1)(parts[1]) * (parseInt(parts[2]) * nanoInHour2 + parseInt0(parts[4]) * nanoInMinute2 + parseInt0(parts[5]) * nanoInSec2 + parseSubsecNano(parts[6] || ""));
  }
}
var dateFieldRefiners = {
  era: toString,
  month: toPositiveIntegerWithTruncation,
  monthCode(monthCode, fieldName) {
    return requireString(toPrimitiveWithStringHint(monthCode), fieldName);
  },
  day: toPositiveIntegerWithTruncation
};
var timeFieldRefiners = /* @__PURE__ */ zipPropsConst(timeFieldNamesAsc, toIntegerWithTrunc);
var durationFieldRefiners = /* @__PURE__ */ zipPropsConst(durationFieldNamesAsc, toStrictInteger);
var dateTimeFieldRefiners = /* @__PURE__ */ Object.assign({}, dateFieldRefiners, timeFieldRefiners);
var zonedDateTimeFieldRefiners = {
  offset(offsetString) {
    return parseOffsetNano(requireString(toPrimitiveWithStringHint(offsetString)));
  },
  ...dateTimeFieldRefiners
};
function readAndRefineBagFields(bag, validFieldNames, fieldRefiners, requiredFieldNames, disallowEmpty = !requiredFieldNames) {
  const res = {};
  let anyMatching = 0;
  for (const fieldName of validFieldNames) {
    let fieldVal = bag[fieldName];
    if (void 0 !== fieldVal) {
      anyMatching = 1;
      const refiner = fieldRefiners[fieldName];
      refiner && (fieldVal = refiner(fieldVal, fieldName)), res[fieldName] = fieldVal;
    } else {
      requiredFieldNames && requiredFieldNames.includes(fieldName) && throwTypeError(missingField(fieldName));
    }
  }
  return disallowEmpty && !anyMatching && throwTypeError("No valid fields: " + validFieldNames.join()), res;
}
function refineOverflowOptions(options) {
  return void 0 === options ? 0 : coerceOverflow(requireObjectLike(options));
}
function refineZonedFieldOptions(options, defaultOffsetDisambig = 0) {
  options = normalizeOptions(options);
  const epochDisambig = coerceEpochDisambig(options);
  const offsetDisambig = coerceOffsetDisambig(options, defaultOffsetDisambig);
  return [coerceOverflow(options), offsetDisambig, epochDisambig];
}
function refineEpochDisambigOptions(options) {
  return coerceEpochDisambig(normalizeOptions(options));
}
function refineCalendarDateFields(fields, calendar, allowMissingDay) {
  const eraOrigins = getCalendarEraOrigins(calendar);
  void 0 !== fields.year || void 0 !== fields.era && void 0 !== fields.eraYear || throwTypeError(missingYear(eraOrigins)), void 0 === fields.monthCode && void 0 === fields.month && throwTypeError("Missing month/monthCode"), allowMissingDay || void 0 !== fields.day || throwTypeError(missingField("day"));
  const monthCodeParts = parseMonthCodeField(fields);
  return [resolveCalendarYear(fields, calendar), monthCodeParts];
}
function refineMonthDayFields(fields, calendar) {
  const isIso = calendar === isoCalendarImpl;
  const eraOrigins = getCalendarEraOrigins(calendar);
  void 0 === fields.day && throwTypeError(missingField("day")), isIso || void 0 === fields.month || void 0 !== fields.year || void 0 !== fields.era && void 0 !== fields.eraYear || throwTypeError(missingYear(eraOrigins));
  const monthCodeParts = parseMonthCodeField(fields);
  return [void 0 !== fields.eraYear || void 0 !== fields.year ? resolveCalendarYear(fields, calendar) : void 0, monthCodeParts];
}
function createDateTimeFromRefinedFields(isoDate, timeFields = timeFieldDefaults, calendar) {
  const isoDateTime = combineDateAndTime(isoDate, timeFields);
  return checkIsoDateTimeInBounds(isoDateTime), createDateTimeSlots(isoDateTime, calendar);
}
function createDateFromRefinedFields(fields, calendar, year, monthCodeParts, overflow) {
  const month = resolveCalendarMonth(fields, calendar, year, monthCodeParts, overflow);
  return createDateSlots(checkIsoDateInBounds(computeCalendarIsoFieldsFromParts(calendar, year, month, resolveCalendarDay(fields, calendar, year, month, overflow))), calendar);
}
function createYearMonthFromRefinedFields(fields, calendar, year, monthCodeParts, overflow) {
  return createYearMonthFromCalendarParts(calendar, year, resolveCalendarMonth(fields, calendar, year, monthCodeParts, overflow));
}
function createMonthDayFromRefinedFields(fields, calendar, year, monthCodeParts, overflow) {
  const isIso = calendar === isoCalendarImpl;
  let yearMaybe = year;
  let day;
  let monthCodeNumber;
  let isLeapMonth;
  if (void 0 === yearMaybe && isIso && (yearMaybe = 1972), void 0 !== yearMaybe) {
    isIso || checkIsoDateInBounds(computeCalendarIsoFieldsFromParts(calendar, yearMaybe, 1, 1));
    const month = resolveCalendarMonth(fields, calendar, yearMaybe, monthCodeParts, overflow);
    day = resolveCalendarDay(fields, calendar, yearMaybe, month, overflow), [monthCodeNumber, isLeapMonth] = computeCalendarMonthCodeParts(calendar, yearMaybe, month);
  } else {
    void 0 === fields.monthCode && throwTypeError("Missing month/monthCode"), [monthCodeNumber, isLeapMonth] = monthCodeParts;
    const referenceYear = calendar ? calendar.re : 1972;
    if (void 0 !== referenceYear) {
      day = resolveCalendarDay(fields, calendar, referenceYear, resolveCalendarMonth(fields, calendar, referenceYear, monthCodeParts, overflow), overflow);
    } else {
      const constrainedDay = 0 === overflow && calendar ? calendar.ge?.(monthCodeNumber, isLeapMonth, fields.day) : void 0;
      day = void 0 !== constrainedDay ? constrainedDay : fields.day;
    }
  }
  return createMonthDayFromMonthCodeParts(calendar, monthCodeNumber, isLeapMonth, day, fields.day, overflow);
}
function createYearMonthFromCalendarParts(calendar, year, month) {
  return createDateSlots(checkIsoYearMonthInBounds(computeCalendarIsoFieldsFromParts(calendar, year, month, 1)), calendar);
}
function createMonthDayFromMonthCodeParts(calendar, monthCodeNumber, isLeapMonthArg, day, requestedDay, overflow) {
  let isLeapMonth = isLeapMonthArg;
  isLeapMonth && ((calendar && calendar.U?.[monthCodeNumber]) ?? 1 / 0) < requestedDay && (1 === overflow && throwRangeError(invalidLeapMonth), isLeapMonth = 0, day = constrainToRange2(requestedDay, 1, (calendar && calendar.R) ?? 1 / 0));
  let res = calendar ? calendar.u(monthCodeNumber, Boolean(isLeapMonth), day) : computeIsoYearMonthFieldsForMonthDay(monthCodeNumber, Boolean(isLeapMonth));
  for (; !res && 0 === overflow && day > 1; ) {
    day--, res = calendar ? calendar.u(monthCodeNumber, Boolean(isLeapMonth), day) : computeIsoYearMonthFieldsForMonthDay(monthCodeNumber, Boolean(isLeapMonth));
  }
  res || throwRangeError("Cannot guess year");
  const { year: finalYear, month: finalMonth } = res;
  return createDateSlots(checkIsoDateInBounds(computeCalendarIsoFieldsFromParts(calendar, finalYear, finalMonth, day)), calendar);
}
function parseMonthCodeField(fields) {
  if (void 0 !== fields.monthCode) {
    return parseMonthCode(fields.monthCode);
  }
}
var RawDateTimeFormat = Intl.DateTimeFormat;
function formatEpochMilliToPartsRecord(intlFormat, epochMilli) {
  epochMilli < -864e13 && throwRangeError(outOfBoundsDate);
  const parts = intlFormat.formatToParts(epochMilli);
  const hash = {};
  for (const part of parts) {
    hash[part.type] = part.value;
  }
  return hash;
}
var timeZonePeriodDaysByName = {
  "El_Aaiun": 16,
  "Tucuman": 12,
  "Tirane": 11,
  "Riga": 10,
  "Simferopol": 9,
  "Vienna": 9,
  "Tunis": 8,
  "Boa_Vista": 6,
  "Fortaleza": 6,
  "Maceio": 6,
  "Noronha": 6,
  "Recife": 6,
  "Gaza": 6,
  "Hebron": 6,
  "DeNoronha": 6
};
var minPossibleTransitionSec = -4e9;
function refineTimeDisplayTuple(options, maxSmallestUnit = 4) {
  const subsecDigits = coerceFractionalSecondDigits(options);
  const roundingMode = coerceRoundingMode(options, 4);
  const smallestUnit = coerceSmallestUnit(options);
  return [roundingMode, ...resolveSmallestUnitAndSubsecDigits(validateUnitRange(smallestUnitStr, smallestUnit, 0, maxSmallestUnit), subsecDigits)];
}
function refineDateDisplayOptions(options) {
  return coerceCalendarDisplay(normalizeOptions(options));
}
function refineTimeDisplayOptions(options, maxSmallestUnit) {
  return refineTimeDisplayTuple(normalizeOptions(options), maxSmallestUnit);
}
function resolveSmallestUnitAndSubsecDigits(smallestUnit, subsecDigits) {
  return null != smallestUnit ? [unitNanoMap[smallestUnit], smallestUnit < 4 ? 9 - 3 * smallestUnit : -1] : [void 0 === subsecDigits ? 1 : 10 ** (9 - subsecDigits), subsecDigits];
}
function formatInstantIso(refineTimeZoneString, instantSlots, options) {
  const [timeZoneArg, roundingMode, nanoInc, subsecDigits] = ((options2) => {
    const subsecDigits2 = coerceFractionalSecondDigits(options2 = normalizeOptions(options2));
    const roundingMode2 = coerceRoundingMode(options2, 4);
    const smallestUnit = coerceSmallestUnit(options2);
    return [options2.timeZone, roundingMode2, ...resolveSmallestUnitAndSubsecDigits(validateUnitRange(smallestUnitStr, smallestUnit, 0, 4), subsecDigits2)];
  })(options);
  const providedTimeZone = void 0 !== timeZoneArg;
  return ((providedTimeZone2, timeZone, epochNano, roundingMode2, nanoInc2, subsecDigits2) => {
    epochNano = roundBigNanoToDayOriginInc(epochNano, BigInt(nanoInc2), roundingMode2);
    const offsetNano = timeZone.B(epochNano);
    return formatIsoDateTimeFields(epochNanoToIsoDateTime(epochNano + BigInt(offsetNano)), subsecDigits2) + (providedTimeZone2 ? formatOffsetNano(roundToMinute(offsetNano)) : "Z");
  })(providedTimeZone, queryTimeZone(providedTimeZone ? refineTimeZoneString(timeZoneArg) : "UTC"), instantSlots.epochNanoseconds, roundingMode, nanoInc, subsecDigits);
}
function formatZonedDateTimeIso(zonedDateTimeSlots0, options) {
  const displayOptions = ((options2) => {
    options2 = normalizeOptions(options2);
    const calendarDisplay = coerceCalendarDisplay(options2);
    const subsecDigits = coerceFractionalSecondDigits(options2);
    const offsetDisplay = coerceOffsetDisplay(options2);
    const roundingMode = coerceRoundingMode(options2, 4);
    const smallestUnit = coerceSmallestUnit(options2);
    return [calendarDisplay, coerceTimeZoneDisplay(options2), offsetDisplay, roundingMode, ...resolveSmallestUnitAndSubsecDigits(validateUnitRange(smallestUnitStr, smallestUnit, 0, 4), subsecDigits)];
  })(options);
  return ((calendar, timeZoneId, timeZone, epochNano, calendarDisplay, timeZoneDisplay, offsetDisplay, roundingMode, nanoInc, subsecDigits) => {
    epochNano = roundBigNanoToDayOriginInc(epochNano, BigInt(nanoInc), roundingMode);
    const offsetNano = timeZone.B(epochNano);
    return formatIsoDateTimeFields(epochNanoToIsoDateTime(epochNano + BigInt(offsetNano)), subsecDigits) + formatOffsetNano(roundToMinute(offsetNano), offsetDisplay) + formatTimeZone(timeZoneId, timeZoneDisplay) + formatCalendar(calendar, calendarDisplay);
  })(zonedDateTimeSlots0.calendar, zonedDateTimeSlots0.timeZone.id, zonedDateTimeSlots0.timeZone, zonedDateTimeSlots0.epochNanoseconds, ...displayOptions);
}
function formatPlainDateTimeIso(plainDateTimeSlots0, options) {
  const displayOptions = ((options2) => (options2 = normalizeOptions(options2), [coerceCalendarDisplay(options2), ...refineTimeDisplayTuple(options2)]))(options);
  return ((calendar, isoDateTime, calendarDisplay, roundingMode, nanoInc, subsecDigits) => formatIsoDateTimeFields(roundDateTimeToInc(isoDateTime, nanoInc, roundingMode), subsecDigits) + formatCalendar(calendar, calendarDisplay))(plainDateTimeSlots0.calendar, plainDateTimeSlots0, ...displayOptions);
}
function formatPlainDateIso(plainDateSlots, options) {
  return calendar = plainDateSlots.calendar, isoDate = plainDateSlots, calendarDisplay = refineDateDisplayOptions(options), formatIsoDateFields(isoDate) + formatCalendar(calendar, calendarDisplay);
  var calendar, isoDate, calendarDisplay;
}
function formatPlainYearMonthIso(plainYearMonthSlots, options) {
  return formatDateLikeIso(plainYearMonthSlots.calendar, formatIsoYearMonthFields, plainYearMonthSlots, refineDateDisplayOptions(options));
}
function formatPlainMonthDayIso(plainMonthDaySlots, options) {
  return formatDateLikeIso(plainMonthDaySlots.calendar, formatIsoMonthDayFields, plainMonthDaySlots, refineDateDisplayOptions(options));
}
function formatDateLikeIso(calendar, formatSimple, isoDate, calendarDisplay) {
  const showCalendar = calendarDisplay > 1 || 0 === calendarDisplay && calendar !== isoCalendarImpl;
  return 1 === calendarDisplay ? calendar === isoCalendarImpl ? formatSimple(isoDate) : formatIsoDateFields(isoDate) : showCalendar ? formatIsoDateFields(isoDate) + formatCalendarId(getCalendarSlotId(calendar), 2 === calendarDisplay) : formatSimple(isoDate);
}
function formatPlainTimeIso(slots, options) {
  return ((fields, roundingMode, nanoInc, subsecDigits) => formatTimeFields(roundTimeToInc(fields, nanoInc, roundingMode)[0], subsecDigits))(slots, ...refineTimeDisplayOptions(options));
}
function formatDurationIso(slots, options) {
  const [roundingMode, nanoInc, subsecDigits] = refineTimeDisplayOptions(options, 3);
  return nanoInc > 1 && ((slots = {
    ...slots,
    ...roundDayTimeDurationByInc(slots, nanoInc, roundingMode)
  }).sign = computeDurationSign(slots), validateDurationFields(slots)), formatDurationSlots(slots, subsecDigits);
}
function formatDurationSlots(durationSlots, subsecDigits) {
  const { sign } = durationSlots;
  const abs = -1 === sign ? negateDurationFields(durationSlots) : durationSlots;
  const { hours, minutes } = abs;
  const bigNano = durationSubMinuteToBigNano(abs);
  const wholeSec = Number(bigNano / bigNanoInSec);
  const subsecNano = Number(bigNano % bigNanoInSec);
  validateDurationTimeUnit(wholeSec);
  const subsecNanoString = formatSubsecNano(subsecNano, subsecDigits);
  const forceSec = subsecDigits >= 0 || !sign || subsecNanoString;
  return (sign < 0 ? "-" : "") + "P" + formatDurationFragments({
    "Y": formatDurationNumber(abs.years),
    "M": formatDurationNumber(abs.months),
    "W": formatDurationNumber(abs.weeks),
    "D": formatDurationNumber(abs.days)
  }) + (hours || minutes || wholeSec || forceSec ? "T" + formatDurationFragments({
    "H": formatDurationNumber(hours),
    "M": formatDurationNumber(minutes),
    "S": formatDurationNumber(wholeSec, forceSec) + subsecNanoString
  }) : "");
}
function formatDurationFragments(fragObj) {
  const parts = [];
  for (const fragName in fragObj) {
    const fragVal = fragObj[fragName];
    fragVal && parts.push(fragVal, fragName);
  }
  return parts.join("");
}
function formatDurationNumber(n, force) {
  if (!n && !force) {
    return "";
  }
  const options = /* @__PURE__ */ Object.create(null);
  return options.useGrouping = 0, n.toLocaleString("fullwide", options);
}
function formatIsoDateTimeFields(isoDateTime, subsecDigits) {
  return formatIsoDateFields(isoDateTime) + "T" + formatTimeFields(isoDateTime, subsecDigits);
}
function formatIsoDateFields(isoDate) {
  return formatIsoYearMonthFields(isoDate) + "-" + padNumber2(isoDate.day);
}
function formatIsoYearMonthFields(isoDate) {
  const { year } = isoDate;
  return (year < 0 || year > 9999 ? getSignStr(year) + padNumber(6, Math.abs(year)) : padNumber(4, year)) + "-" + padNumber2(isoDate.month);
}
function formatIsoMonthDayFields(isoDate) {
  return padNumber2(isoDate.month) + "-" + padNumber2(isoDate.day);
}
function formatTimeFields(timeFields, subsecDigits) {
  const parts = [padNumber2(timeFields.hour), padNumber2(timeFields.minute)];
  return -1 !== subsecDigits && parts.push(padNumber2(timeFields.second) + ((millisecond, microsecond, nanosecond, subsecDigits2) => formatSubsecNano(millisecond * nanoInMilli2 + microsecond * nanoInMicro2 + nanosecond, subsecDigits2))(timeFields.millisecond, timeFields.microsecond, timeFields.nanosecond, subsecDigits)), parts.join(":");
}
function formatOffsetNano(offsetNano, offsetDisplay = 0) {
  if (1 === offsetDisplay) {
    return "";
  }
  const [hour, nanoRemainder0] = divModFloor(Math.abs(offsetNano), nanoInHour2);
  const [minute, nanoRemainder1] = divModFloor(nanoRemainder0, nanoInMinute2);
  const [second, nanoRemainder2] = divModFloor(nanoRemainder1, nanoInSec2);
  return getSignStr(offsetNano) + padNumber2(hour) + ":" + padNumber2(minute) + (second || nanoRemainder2 ? ":" + padNumber2(second) + formatSubsecNano(nanoRemainder2) : "");
}
function formatTimeZone(timeZoneId, timeZoneDisplay) {
  return 1 !== timeZoneDisplay ? "[" + (2 === timeZoneDisplay ? "!" : "") + timeZoneId + "]" : "";
}
function formatCalendar(calendar, calendarDisplay) {
  return calendarDisplay > 1 || 0 === calendarDisplay && calendar !== isoCalendarImpl ? formatCalendarId(getCalendarSlotId(calendar), 2 === calendarDisplay) : "";
}
function formatCalendarId(calendarId, isCritical) {
  return "[" + (isCritical ? "!" : "") + "u-ca=" + calendarId + "]";
}
var trailingZerosRE = /0+$/;
function formatSubsecNano(totalNano, subsecDigits) {
  let s = padNumber(9, totalNano);
  return s = void 0 === subsecDigits ? s.replace(trailingZerosRE, "") : s.slice(0, subsecDigits), s ? "." + s : "";
}
function getSignStr(num) {
  return num < 0 ? "-" : "+";
}
var icuRegExp = /^(AC|AE|AG|AR|AS|BE|BS|CA|CN|CS|CT|EA|EC|IE|IS|JS|MI|NE|NS|PL|PN|PR|PS|SS|VS)T$/;
var badCharactersRegExp = /[^\w\/:+-]+/;
function refineTimeZoneId(rawId) {
  return resolveTimeZoneId(requireString(rawId));
}
function resolveTimeZoneId(rawId) {
  return resolveTimeZoneRecord(rawId).id;
}
var resolveTimeZoneRecord = /* @__PURE__ */ memoize((rawId) => {
  const upperRawId = rawId.toUpperCase();
  const offsetRecord = ((upperRawId2) => {
    const offsetNano = parseOffsetNanoMaybe(upperRawId2, 1);
    if (void 0 !== offsetNano) {
      return {
        id: formatOffsetNano(offsetNano),
        Z: offsetNano,
        m: offsetNano
      };
    }
  })(upperRawId);
  if (offsetRecord) {
    return {
      kind: "fixed",
      ...offsetRecord
    };
  }
  const normId = "UTC" === upperRawId ? "UTC" : ((rawId2) => (badCharactersRegExp.test(rawId2) && throwRangeError(invalidTimeZone(rawId2)), icuRegExp.test(rawId2) && throwRangeError("Forbidden ICU TimeZone"), rawId2.toLowerCase().split("/").map((part, partI) => (part.length <= 3 || /\d/.test(part)) && !/etc|yap/.test(part) ? part.toUpperCase() : part.replace(/baja|dumont|[a-z]+/g, (a, i) => a.length <= 2 && !partI || "in" === a || "chat" === a ? a.toUpperCase() : a.length > 2 || !i ? capitalize(a).replace(/island|noronha|murdo|rivadavia|urville/, capitalize) : a)).join("/")))(rawId);
  return queryNamedTimeZoneRecord(normId);
});
var queryNamedTimeZoneRecord = /* @__PURE__ */ memoize((normId) => {
  if ("UTC" === normId) {
    return {
      kind: "utc",
      id: normId,
      m: normId
    };
  }
  const format = (upperNormId = normId.toUpperCase(), new RawDateTimeFormat("en-u-hc-h23", {
    calendar: "iso8601",
    timeZone: upperNormId,
    era: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric"
  }));
  var upperNormId;
  return {
    kind: "named",
    id: normId,
    format,
    m: format.resolvedOptions().timeZone
  };
});
function queryTimeZone(rawTimeZoneId) {
  const record = resolveTimeZoneRecord(rawTimeZoneId);
  return queryTimeZoneRecord(record.id, record);
}
var queryTimeZoneRecord = /* @__PURE__ */ memoize((normTimeZoneId, record) => "named" === record.kind ? new IntlTimeZone(normTimeZoneId, record.m, record.format) : new FixedTimeZone(normTimeZoneId, record.m, "fixed" === record.kind ? record.Z : 0));
var FixedTimeZone = class {
  constructor(id2, compareKey, offsetNano) {
    this.id = id2, this.m = compareKey, this.Z = offsetNano;
  }
  B() {
    return this.Z;
  }
  O(isoDateTime) {
    return [isoDateTimeAndOffsetToEpochNano(isoDateTime, this.Z)];
  }
  C() {
  }
};
var IntlTimeZone = class {
  constructor(id2, compareKey, format) {
    this.id = id2, this.m = compareKey, this.me = ((computeOffsetSec, periodDays) => {
      const getSample = memoize(computeOffsetSec);
      const getSplit = memoize(createSplitTuple);
      const periodSec = 86400 * periodDays;
      function getOffsetSec(epochSec) {
        const [startEpochSec, endEpochSec] = computePeriod(epochSec, periodSec);
        const clampedStartEpochSec = clampIntlSampleEpochSec(startEpochSec);
        const clampedEndEpochSec = clampIntlSampleEpochSec(endEpochSec);
        const startOffsetSec = getSample(clampedStartEpochSec);
        const endOffsetSec = getSample(clampedEndEpochSec);
        return startOffsetSec === endOffsetSec ? startOffsetSec : pinch(getSplit(clampedStartEpochSec, clampedEndEpochSec), startOffsetSec, endOffsetSec, epochSec);
      }
      function searchTransition(searchEpochSec, direction, searchLimit, epochSec = searchEpochSec) {
        let [startEpochSec, endEpochSec] = computePeriod(searchEpochSec, periodSec);
        const inc = periodSec * direction;
        const inBounds = () => direction < 0 ? endEpochSec > searchLimit : startEpochSec < searchLimit;
        for (; inBounds(); ) {
          const clampedStartEpochSec = clampIntlSampleEpochSec(startEpochSec);
          const clampedEndEpochSec = clampIntlSampleEpochSec(endEpochSec);
          const startOffsetSec = getSample(clampedStartEpochSec);
          const endOffsetSec = getSample(clampedEndEpochSec);
          if (startOffsetSec !== endOffsetSec) {
            const split = getSplit(clampedStartEpochSec, clampedEndEpochSec);
            pinch(split, startOffsetSec, endOffsetSec);
            const transitionEpochSec = split[0];
            if ((compareNumbers(transitionEpochSec, epochSec) || 1) === direction) {
              return transitionEpochSec;
            }
          }
          startEpochSec += inc, endEpochSec += inc;
        }
      }
      function pinch(split, startOffsetSec, endOffsetSec, forEpochSec) {
        let offsetSec;
        let splitDurSec;
        for (; (void 0 === forEpochSec || void 0 === (offsetSec = forEpochSec < split[0] ? startOffsetSec : forEpochSec >= split[1] ? endOffsetSec : void 0)) && (splitDurSec = split[1] - split[0]); ) {
          const middleEpochSec = split[0] + Math.floor(splitDurSec / 2);
          computeOffsetSec(middleEpochSec) === endOffsetSec ? split[1] = middleEpochSec : split[0] = middleEpochSec + 1;
        }
        return offsetSec;
      }
      return {
        Ae(zonedEpochSec) {
          const wideOffsetSec0 = getOffsetSec(zonedEpochSec - 86400);
          const wideOffsetSec1 = getOffsetSec(zonedEpochSec + 86400);
          const wideUtcEpochSec0 = zonedEpochSec - wideOffsetSec0;
          const wideUtcEpochSec1 = zonedEpochSec - wideOffsetSec1;
          if (wideOffsetSec0 === wideOffsetSec1) {
            return [wideUtcEpochSec0];
          }
          const narrowOffsetSec0 = getOffsetSec(wideUtcEpochSec0);
          return narrowOffsetSec0 === getOffsetSec(wideUtcEpochSec1) ? [zonedEpochSec - narrowOffsetSec0] : wideOffsetSec0 > wideOffsetSec1 ? [wideUtcEpochSec0, wideUtcEpochSec1] : [];
        },
        ze: getOffsetSec,
        C(epochSec, direction) {
          if (!(direction > 0 && epochSec >= 864e10)) {
            if (direction < 0) {
              if (epochSec <= minPossibleTransitionSec) {
                return;
              }
              return epochSec > 4e9 ? searchTransition(epochSec, -1, epochSec - 94867200) ?? searchTransition(4e9, -1, minPossibleTransitionSec) : searchTransition(epochSec, -1, minPossibleTransitionSec);
            }
            return searchTransition(Math.max(epochSec, minPossibleTransitionSec) - 1, 1, Math.max(epochSec, Math.floor(Date.now() / 1e3)) + 94867200, epochSec);
          }
        }
      };
    })(/* @__PURE__ */ ((format2) => (epochSec) => {
      const intlParts = formatEpochMilliToPartsRecord(format2, 1e3 * epochSec);
      return 86400 * isoPartsToEpochDays(((intlParts2) => {
        const relatedYear = intlParts2.relatedYear;
        if (void 0 !== relatedYear) {
          return parseInt(relatedYear);
        }
        const year = parseInt(intlParts2.year);
        return void 0 !== intlParts2.era && "bce" === normalizeEraName(intlParts2.era) ? 1 - year : year;
      })(intlParts), parseInt(intlParts.month), parseInt(intlParts.day)) + 3600 * parseInt(intlParts.hour) + 60 * parseInt(intlParts.minute) + parseInt(intlParts.second) - epochSec;
    })(format), ((timeZoneId) => {
      const timeZoneName = timeZoneId.split("/").pop();
      return timeZonePeriodDaysByName[timeZoneName] || 19;
    })(id2));
  }
  B(epochNano) {
    return this.me.ze(((epochNano2) => epochNanoToSecMod(epochNano2)[0])(epochNano)) * nanoInSec2;
  }
  O(isoDateTime) {
    const zonedEpochSec = 86400 * isoDateToEpochDays(isoDateTime) + timeFieldsToSec(isoDateTime);
    const subsecNano = timeFieldsToSubsecNano(isoDateTime);
    return this.me.Ae(zonedEpochSec).map((epochSec) => checkEpochNanoInBounds(BigInt(epochSec) * bigNanoInSec + BigInt(subsecNano)));
  }
  C(epochNano, direction) {
    const [epochSec, subsecNano] = epochNanoToSecMod(epochNano);
    const resEpochSec = this.me.C(epochSec + (direction > 0 || subsecNano ? 1 : 0), direction);
    if (void 0 !== resEpochSec) {
      return BigInt(resEpochSec) * bigNanoInSec;
    }
  }
};
function createSplitTuple(startEpochSec, endEpochSec) {
  return [startEpochSec, endEpochSec];
}
function computePeriod(epochSec, periodSec) {
  const startEpochSec = Math.floor(epochSec / periodSec) * periodSec;
  return [startEpochSec, startEpochSec + periodSec];
}
function clampIntlSampleEpochSec(epochSec) {
  return constrainToRange2(epochSec, -1e10, 864e10);
}
function refineMaybeZonedDateTimeObjectLike(refineTimeZoneString, calendar, bag) {
  const fields = readAndRefineBagFields(bag, getCalendarFieldNames(calendar, dateTimeAndZoneFieldNamesAlpha, dateTimeAndZoneFieldNamesWithEraAlpha), zonedDateTimeFieldRefiners, [], 0);
  const isZoned2 = void 0 !== fields.timeZone;
  const [year, monthCodeParts] = refineCalendarDateFields(fields, calendar);
  const isoDate = createDateFromRefinedFields(fields, calendar, year, monthCodeParts, 0);
  if (isZoned2) {
    const timeFields = resolveTimeFields(fields);
    const timeZone = queryTimeZone(refineTimeZoneString(fields.timeZone));
    return {
      epochNanoseconds: getMatchingInstantFor(timeZone, combineDateAndTime(isoDate, timeFields), fields.offset),
      timeZone,
      calendar
    };
  }
  return isoDate;
}
function refineZonedDateTimeObjectLike(refineTimeZoneString, calendar, bag, options) {
  const fields = readAndRefineBagFields(bag, getCalendarFieldNames(calendar, dateTimeAndZoneFieldNamesAlpha, dateTimeAndZoneFieldNamesWithEraAlpha), zonedDateTimeFieldRefiners, timeZoneFieldNames, 0);
  const timeZoneId = refineTimeZoneString(fields.timeZone);
  const [year, monthCodeParts] = refineCalendarDateFields(fields, calendar);
  const [overflow, offsetDisambig, epochDisambig] = refineZonedFieldOptions(options);
  const isoDate = createDateFromRefinedFields(fields, calendar, year, monthCodeParts, overflow);
  const timeFields = resolveTimeFields(fields, overflow);
  const timeZone = queryTimeZone(timeZoneId);
  return createZonedEpochNanoSlots(getMatchingInstantFor(timeZone, combineDateAndTime(isoDate, timeFields), fields.offset, offsetDisambig, epochDisambig), timeZone, calendar);
}
function refinePlainDateTimeObjectLike(calendar, bag, options) {
  const fields = readAndRefineBagFields(bag, getCalendarFieldNames(calendar, dateTimeFieldNamesAlpha, dateTimeFieldNamesWithEraAlpha), dateTimeFieldRefiners, [], 0);
  const [year, monthCodeParts] = refineCalendarDateFields(fields, calendar);
  const overflow = refineOverflowOptions(options);
  return createDateTimeFromRefinedFields(createDateFromRefinedFields(fields, calendar, year, monthCodeParts, overflow), resolveTimeFields(fields, overflow), calendar);
}
function refinePlainDateObjectLike(calendar, bag, options, requireFields = []) {
  const fields = readAndRefineBagFields(bag, getCalendarFieldNames(calendar, dateFieldNamesAlpha, dateFieldNamesWithEraAlpha), dateFieldRefiners, requireFields);
  const [year, monthCodeParts] = refineCalendarDateFields(fields, calendar);
  return createDateFromRefinedFields(fields, calendar, year, monthCodeParts, refineOverflowOptions(options));
}
function refinePlainYearMonthObjectLike(calendar, bag, options, requireFields) {
  const fields = readAndRefineBagFields(bag, getCalendarFieldNames(calendar, yearMonthFieldNamesAlpha, yearMonthFieldNamesWithEraAlpha), dateFieldRefiners, requireFields);
  const [year, monthCodeParts] = refineCalendarDateFields(fields, calendar, 1);
  return createYearMonthFromRefinedFields(fields, calendar, year, monthCodeParts, refineOverflowOptions(options));
}
function refinePlainMonthDayObjectLike(calendar, calendarAbsent, bag, options) {
  const fields = readAndRefineBagFields(bag, getCalendarFieldNames(calendar, dateFieldNamesAlpha, dateFieldNamesWithEraAlpha), dateFieldRefiners, dayFieldNamesAsc, 0);
  calendarAbsent && void 0 !== fields.month && void 0 === fields.monthCode && void 0 === fields.year && (fields.year = 1972);
  const [year, monthCodeParts] = refineMonthDayFields(fields, calendar);
  return createMonthDayFromRefinedFields(fields, calendar, year, monthCodeParts, refineOverflowOptions(options));
}
function refinePlainTimeObjectLike(bag, options) {
  return resolveTimeFields(readAndRefineBagFields(bag, timeFieldNamesAlpha, timeFieldRefiners, [], 1), refineOverflowOptions(options));
}
function refineDurationObjectLike(bag) {
  const durationFields = readAndRefineBagFields(bag, durationFieldNamesAlpha, durationFieldRefiners);
  return createDurationSlots(validateDurationFields({
    ...durationFieldDefaults,
    ...durationFields
  }));
}
function throwFailedParse(s) {
  throwRangeError(failedParse(s));
}
function parseInstant(s) {
  const organized = parseDateTimeLike(s = requireString(toPrimitiveWithStringHint(s)));
  let offsetNano;
  return organized || throwFailedParse(s), organized.I ? offsetNano = 0 : organized.offset ? offsetNano = parseOffsetNano(organized.offset) : throwFailedParse(s), createEpochNanoSlots(isoDateTimeAndOffsetToEpochNano(organized, offsetNano));
}
function parseRelativeToSlots(s, resolveCalendar) {
  const organized = parseDateTimeLike(requireString(s));
  return organized && organized.timeZoneId ? finalizeZonedDateTime(organized, resolveCalendar, void 0) : finalizeDate(parsePlainDateLike(s), resolveCalendar);
}
function parseZonedDateTime(s, resolveCalendar, options) {
  const organized = parseDateTimeLike(requireString(s));
  return organized && organized.timeZoneId || throwFailedParse(s), finalizeZonedDateTime(organized, resolveCalendar, options);
}
function parsePlainDateTime(s, resolveCalendar) {
  const organized = parsePlainDateLike(s);
  return checkIsoDateTimeInBounds(organized), {
    ...combineDateAndTime(organized, organized),
    calendar: resolveCalendar(organized.calendarId)
  };
}
function parsePlainDate(s, resolveCalendar) {
  return finalizeDate(parsePlainDateLike(s), resolveCalendar);
}
function parsePlainYearMonth(s, resolveCalendar) {
  const organized = parseYearMonthOnly(requireString(s)) || parsePlainDateLike(s);
  const calendar = resolveCalendar(organized.calendarId);
  return createDateSlots(checkIsoYearMonthInBounds(moveToStartOfMonth(calendar, checkIsoYearMonthInBounds(organized))), calendar);
}
function parsePlainMonthDay(s, resolveCalendar) {
  const organized = parseMonthDayOnly(requireString(s)) || parsePlainDateLike(s);
  if ("iso8601" === organized.calendarId) {
    return createDateSlots({
      ...organized,
      year: 1972
    }, resolveCalendar("iso8601"));
  }
  const { calendar } = finalizeDate(organized, resolveCalendar);
  const { year: origYear, month: origMonth, day } = computeCalendarDateFields(calendar, organized);
  const [monthCodeNumber, isLeapMonth] = computeCalendarMonthCodeParts(calendar, origYear, origMonth);
  const yearMonthFields = calendar ? calendar.u(monthCodeNumber, isLeapMonth, day) : computeIsoYearMonthFieldsForMonthDay(monthCodeNumber, isLeapMonth);
  return yearMonthFields || throwRangeError("Cannot guess year"), createDateSlots(checkIsoDateInBounds(computeCalendarIsoFieldsFromParts(calendar, yearMonthFields.year, yearMonthFields.month, day)), calendar);
}
function parsePlainTime(s) {
  const organized = parseDateTimeLike(s = requireString(s)) || parseTimeOnly(s);
  return (!organized || !organized.qe || organized.I || parseYearMonthOnly(s) || parseMonthDayOnly(s)) && throwFailedParse(s), createTimeSlots(organized);
}
function parseDuration(s) {
  const parts = durationRegExp.exec(requireString(s));
  parts && !invalidDurationRegExp.test(s) || throwFailedParse(s);
  const fraction = nanoToGivenFields(3600 * parseSubsecNano(parts[7] || "") + 60 * parseSubsecNano(parts[9] || "") + parseSubsecNano(parts[11] || ""), 4, durationFieldNamesAsc);
  const durationFields = {
    ...fraction,
    years: parseInt0(parts[2]),
    months: parseInt0(parts[3]),
    weeks: parseInt0(parts[4]),
    days: parseInt0(parts[5]),
    hours: parseInt0(parts[6]),
    minutes: parseInt0(parts[8]) + fraction.minutes,
    seconds: parseInt0(parts[10]) + fraction.seconds
  };
  return createDurationSlots(validateDurationFields("-" === parts[1] ? negateDurationFields(durationFields) : durationFields));
}
function parseCalendarId(s) {
  const organized = parseDateTimeLike(s) || parseYearMonthOnly(s) || parseMonthDayOnly(s) || parseTimeOnly(s);
  return organized ? organized.calendarId : s;
}
function parseTimeZoneId(s) {
  const parsed = parseDateTimeLike(s);
  return parsed && (parsed.timeZoneId || parsed.I && "UTC" || parsed.offset) || s;
}
function parsePlainDateLike(s) {
  const organized = parseDateTimeLike(requireString(s));
  return organized && !organized.I || throwFailedParse(s), organized;
}
function finalizeZonedDateTime(organized, resolveCalendar, options) {
  const timeZone = queryTimeZone(resolveTimeZoneId(organized.timeZoneId));
  let epochNano;
  if (organized.qe) {
    const offsetNano = organized.offset ? parseOffsetNano(organized.offset) : void 0;
    const [, offsetDisambig, epochDisambig] = refineZonedFieldOptions(options);
    epochNano = getMatchingInstantFor(timeZone, organized, offsetNano, offsetDisambig, epochDisambig, !(timeZone.Z || void 0 === organized.offset || (offset = organized.offset, offset.length > 6)), organized.I);
  } else {
    refineZonedFieldOptions(options), epochNano = getStartOfDayInstantFor(timeZone, organized);
  }
  var offset;
  return checkEpochNanoInBounds(epochNano), createZonedEpochNanoSlots(epochNano, timeZone, resolveCalendar(organized.calendarId));
}
function finalizeDate(organized, resolveCalendar) {
  return createDateSlots(checkIsoDateInBounds(organized), resolveCalendar(organized.calendarId));
}
function timeRegExpStr(separatorIndex, leapSecondStr = "") {
  return `([01]\\d|2[0-3])(?:(:?)([0-5]\\d)(?:\\${separatorIndex}([0-5]\\d${leapSecondStr})(?:[.,](\\d{1,9}))?)?)?`;
}
var dateTimeRegExpStr = "((?!-0{6})[+-]\\d{6}|\\d{4})(-?)(0[1-9]|1[0-2])\\2(0[1-9]|[12]\\d|3[01])(?:[Tt ]" + timeRegExpStr(6, "|60") + "(?:([Zz])|(([+-])" + timeRegExpStr(14) + "))?)?";
var yearMonthRegExp = /* @__PURE__ */ createRegExp("((?!-0{6})[+-]\\d{6}|\\d{4})-?(0[1-9]|1[0-2])(?:\\[!?([+-](?:[01]\\d|2[0-3])(?::?[0-5]\\d)?|[a-zA-Z._][\\w.+-]*(?:/[a-zA-Z._][\\w.+-]*)*)\\])?((?:\\[!?[a-z_][a-z\\d_-]*=[a-zA-Z\\d]+(?:-[a-zA-Z\\d]+)*\\])*)");
var monthDayRegExp = /* @__PURE__ */ createRegExp("(?:--)?(0[1-9]|1[0-2])-?(0[1-9]|[12]\\d|3[01])(?:\\[!?([+-](?:[01]\\d|2[0-3])(?::?[0-5]\\d)?|[a-zA-Z._][\\w.+-]*(?:/[a-zA-Z._][\\w.+-]*)*)\\])?((?:\\[!?[a-z_][a-z\\d_-]*=[a-zA-Z\\d]+(?:-[a-zA-Z\\d]+)*\\])*)");
var dateTimeRegExp = /* @__PURE__ */ createRegExp(dateTimeRegExpStr + "(?:\\[!?([+-](?:[01]\\d|2[0-3])(?::?[0-5]\\d)?|[a-zA-Z._][\\w.+-]*(?:/[a-zA-Z._][\\w.+-]*)*)\\])?((?:\\[!?[a-z_][a-z\\d_-]*=[a-zA-Z\\d]+(?:-[a-zA-Z\\d]+)*\\])*)");
var annotationRegExp = /\[(!?)([^=]+)=([^\]]+)/g;
var durationRegExp = /^([+-])?P(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(?:T(?:(\d+)(?:[.,](\d{1,9}))?H)?(?:(\d+)(?:[.,](\d{1,9}))?M)?(?:(\d+)(?:[.,](\d{1,9}))?S)?)?$/i;
var invalidDurationRegExp = /[PT]$|[.,]\d+[HMS]./i;
function parseDateTimeLike(s) {
  const parts = dateTimeRegExp.exec(s);
  if (!parts) {
    return;
  }
  const organized = ((parts2) => ({
    year: parseInt(parts2[1]),
    month: parseInt(parts2[3]),
    day: parseInt(parts2[4]),
    ...nanoToTimeAndDay(parseSubsecNano(parts2[9] || ""))[0],
    hour: parseInt0(parts2[5]),
    minute: parseInt0(parts2[7]),
    second: Math.min(parseInt0(parts2[8]), 59),
    ...organizeAnnotationParts(parts2[18], parts2[19]),
    qe: !!parts2[5],
    I: !!parts2[10],
    offset: parts2[11]
  }))(parts);
  return validateIsoDateFields(organized);
}
function parseYearMonthOnly(s) {
  const parts = yearMonthRegExp.exec(s);
  return parts ? requireIsoCalendar(((parts2) => ({
    year: parseInt(parts2[1]),
    month: parseInt(parts2[2]),
    day: 1,
    ...organizeAnnotationParts(parts2[3], parts2[4])
  }))(parts)) : void 0;
}
function parseMonthDayOnly(s) {
  const parts = monthDayRegExp.exec(s);
  if (parts) {
    const organized = ((parts2) => ({
      year: 1972,
      month: parseInt(parts2[1]),
      day: parseInt(parts2[2]),
      ...organizeAnnotationParts(parts2[3], parts2[4])
    }))(parts);
    if (allPropsEqual(calendarDateFieldNamesAsc, isoDate = organized, constrainIsoDateFields(isoDate))) {
      return requireIsoCalendar(organized);
    }
  }
  var isoDate;
}
function requireIsoCalendar(organized) {
  return "iso8601" !== organized.calendarId && throwFailedParse(organized.calendarId), organized;
}
function parseTimeOnly(s) {
  const organized = parseDateTimeLike(s.replace(/^t?/i, "0000-01-01T"));
  return organized && !organized.I ? organized : void 0;
}
function organizeAnnotationParts(timeZoneId, s) {
  let calendarIsCritical;
  const calendarIds = [];
  return s.replace(annotationRegExp, (whole, criticalStr, key, value) => ("u-ca" === key ? (calendarIds.push(value.toLowerCase()), calendarIsCritical || (calendarIsCritical = criticalStr)) : criticalStr && throwFailedParse(whole), "")), calendarIds.length > 1 && calendarIsCritical && throwFailedParse(s), {
    timeZoneId,
    calendarId: calendarIds[0] || "iso8601"
  };
}
function mergeCalendarFields(calendar, baseFields, additionalFields) {
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), baseFields);
  return spliceFields(merged, additionalFields, monthFieldNames), getCalendarEraOrigins(calendar) && (spliceFields(merged, additionalFields, allYearFieldNames), calendar && calendar.je && spliceFields(merged, additionalFields, monthDayFieldNames, eraYearFieldNames)), merged;
}
function spliceFields(dest, additional, allPropNames, deletablePropNames) {
  let anyMatching = 0;
  const nonMatchingPropNames = [];
  for (const propName of allPropNames) {
    void 0 !== additional[propName] ? anyMatching = 1 : nonMatchingPropNames.push(propName);
  }
  if (Object.assign(dest, additional), anyMatching) {
    for (const deletablePropName of deletablePropNames || nonMatchingPropNames) {
      delete dest[deletablePropName];
    }
  }
}
function mergeZonedDateTimeFields(calendar, zonedDateTimeSlots, modFields) {
  const validFieldNames = getCalendarFieldNames(calendar, dateTimeAndOffsetFieldNamesAlpha, dateTimeAndOffsetFieldNamesWithEraAlpha);
  const zonedSlots = zonedEpochSlotsToIso(zonedDateTimeSlots);
  const { year, month, day } = computeCalendarDateFields(calendar, zonedSlots);
  const origFields = {
    year,
    monthCode: computeMonthCode(calendar, year, month),
    day,
    hour: zonedSlots.hour,
    minute: zonedSlots.minute,
    second: zonedSlots.second,
    millisecond: zonedSlots.millisecond,
    microsecond: zonedSlots.microsecond,
    nanosecond: zonedSlots.nanosecond,
    offset: zonedSlots.offsetNanoseconds
  };
  const partialFields = readAndRefineBagFields(modFields, validFieldNames, zonedDateTimeFieldRefiners);
  const mergedCalendarFields = mergeCalendarFields(calendar, origFields, partialFields);
  return [{
    ...origFields,
    ...partialFields
  }, mergedCalendarFields];
}
function mergeDateTimeFields(calendar, plainDateTimeSlots, modFields) {
  const validFieldNames = getCalendarFieldNames(calendar, dateTimeFieldNamesAlpha, dateTimeFieldNamesWithEraAlpha);
  const { year, month, day } = computeCalendarDateFields(calendar, plainDateTimeSlots);
  const origFields = {
    year,
    monthCode: computeMonthCode(calendar, year, month),
    day,
    hour: plainDateTimeSlots.hour,
    minute: plainDateTimeSlots.minute,
    second: plainDateTimeSlots.second,
    millisecond: plainDateTimeSlots.millisecond,
    microsecond: plainDateTimeSlots.microsecond,
    nanosecond: plainDateTimeSlots.nanosecond
  };
  const partialFields = readAndRefineBagFields(modFields, validFieldNames, dateTimeFieldRefiners);
  const mergedCalendarFields = mergeCalendarFields(calendar, origFields, partialFields);
  return [{
    ...origFields,
    ...partialFields
  }, mergedCalendarFields];
}
function mergeDateFields(calendar, plainDateSlots, modFields) {
  const validFieldNames = getCalendarFieldNames(calendar, dateFieldNamesAlpha, dateFieldNamesWithEraAlpha);
  const { year, month, day } = computeCalendarDateFields(calendar, plainDateSlots);
  return mergeCalendarFields(calendar, {
    year,
    monthCode: computeMonthCode(calendar, year, month),
    day
  }, readAndRefineBagFields(modFields, validFieldNames, dateFieldRefiners));
}
function mergeYearMonthFields(calendar, plainYearMonthSlots, modFields) {
  const validFieldNames = getCalendarFieldNames(calendar, yearMonthFieldNamesAlpha, yearMonthFieldNamesWithEraAlpha);
  const { year, month } = computeCalendarDateFields(calendar, plainYearMonthSlots);
  return mergeCalendarFields(calendar, {
    year,
    monthCode: computeMonthCode(calendar, year, month)
  }, readAndRefineBagFields(modFields, validFieldNames, dateFieldRefiners));
}
function mergeMonthDayFields(calendar, plainMonthDaySlots, modFields) {
  const validFieldNames = getCalendarFieldNames(calendar, dateFieldNamesAlpha, dateFieldNamesWithEraAlpha);
  const { year, month, day } = computeCalendarDateFields(calendar, plainMonthDaySlots);
  return mergeCalendarFields(calendar, {
    monthCode: computeMonthCode(calendar, year, month),
    day
  }, readAndRefineBagFields(modFields, validFieldNames, dateFieldRefiners));
}
function createZonedDateTimeFromMergedFields(zonedDateTimeSlots, mergedAllFields, calendarFields, year, monthCodeParts, overflow, offsetDisambig, epochDisambig) {
  const { calendar, timeZone } = zonedDateTimeSlots;
  return createZonedEpochNanoSlots(getMatchingInstantFor(timeZone, combineDateAndTime(createDateFromRefinedFields(calendarFields, calendar, year, monthCodeParts, overflow), constrainTimeFields(mergedAllFields, overflow)), mergedAllFields.offset, offsetDisambig, epochDisambig), timeZone, calendar);
}
function createDateTimeFromMergedFields(mergedAllFields, calendarFields, calendar, year, monthCodeParts, overflow) {
  return createDateTimeFromRefinedFields(createDateFromRefinedFields(calendarFields, calendar, year, monthCodeParts, overflow), constrainTimeFields(mergedAllFields, overflow), calendar);
}
function mergeTimeFields(initialFields, modFields) {
  return {
    ...pluckProps(timeFieldNamesAlpha, initialFields),
    ...readAndRefineBagFields(modFields, timeFieldNamesAlpha, timeFieldRefiners)
  };
}
function mergeDurationFields(slots, fields) {
  return createDurationSlots((initialFields = slots, modFields = fields, validateDurationFields({
    ...initialFields,
    ...readAndRefineBagFields(modFields, durationFieldNamesAlpha, durationFieldRefiners)
  })));
  var initialFields, modFields;
}
function computeMonthCode(calendar, year, month) {
  const [monthCodeNumber, isLeapMonth] = computeCalendarMonthCodeParts(calendar, year, month);
  return formatMonthCode(monthCodeNumber, isLeapMonth);
}
function totalDuration(refineRelativeTo, slots, options) {
  const [totalUnit, relativeToSlots] = ((options2, refineRelativeTo2) => {
    const relativeToInternals = refineRelativeTo2((options2 = normalizeOptionsOrString(options2, "unit")).relativeTo);
    let totalUnit2 = coerceTotalUnit(options2);
    return totalUnit2 = requirePropDefined("unit", totalUnit2), [totalUnit2, relativeToInternals];
  })(options, refineRelativeTo);
  const maxDurationUnit = getMaxDurationUnit(slots);
  const maxUnit = Math.max(totalUnit, maxDurationUnit);
  const isZoned2 = relativeToSlots && isZonedEpochSlots(relativeToSlots);
  if (!relativeToSlots && isUniformUnit(maxUnit, isZoned2)) {
    return totalDayTimeDuration(slots, totalUnit);
  }
  if (relativeToSlots || throwRangeError("Missing relativeTo"), !slots.sign && (!isZoned2 || totalUnit < 6)) {
    return 0;
  }
  const [balancedDuration, endEpochNano, relativeOps] = spanRelativeDuration(relativeToSlots, slots, totalUnit);
  return isUniformUnit(totalUnit, isZoned2) ? totalDayTimeDuration(balancedDuration, totalUnit) : ((durationFields, endEpochNano2, totalUnit2, relativeOps2) => {
    const fieldName = durationFieldNamesAsc[totalUnit2];
    const baseDurationFields = clearDurationFields(totalUnit2, durationFields);
    return totalRelativeUnit(durationFields[fieldName], computeDurationSign(durationFields) || 1, endEpochNano2, (value) => (baseDurationFields[fieldName] = value, moveRelativeMarkerToEpochNano(relativeOps2, baseDurationFields)));
  })(balancedDuration, endEpochNano, totalUnit, relativeOps);
}
function totalDayTimeDuration(durationFields, totalUnit) {
  return divideBigNanoToExactNumber(durationDayTimeToBigNano(durationFields), unitNanoMap[totalUnit]);
}
function instantToZonedDateTime(instantSlots, timeZone, calendar) {
  return createZonedEpochNanoSlots(instantSlots.epochNanoseconds, timeZone, calendar);
}
function zonedDateTimeToInstant(zonedDateTimeSlots0) {
  return createEpochNanoSlots(zonedDateTimeSlots0.epochNanoseconds);
}
function zonedDateTimeToDateTime(zonedDateTimeSlots0) {
  return createDateTimeSlots(zonedEpochSlotsToIso(zonedDateTimeSlots0), zonedDateTimeSlots0.calendar);
}
function zonedDateTimeToDate(zonedDateTimeSlots0) {
  return createDateSlots(zonedEpochSlotsToIso(zonedDateTimeSlots0), zonedDateTimeSlots0.calendar);
}
function zonedDateTimeToTime(zonedDateTimeSlots0) {
  return createTimeSlots(zonedEpochSlotsToIso(zonedDateTimeSlots0));
}
function dateTimeToZonedDateTime(plainDateTimeSlots, timeZone, epochDisambig) {
  return createZonedEpochNanoSlots(checkEpochNanoInBounds(getSingleInstantFor(timeZone, plainDateTimeSlots, epochDisambig)), timeZone, plainDateTimeSlots.calendar);
}
function dateToZonedDateTime(plainDateSlots, timeZone, timeFields) {
  let epochNano;
  return epochNano = timeFields ? getSingleInstantFor(timeZone, combineDateAndTime(plainDateSlots, timeFields)) : getStartOfDayInstantFor(timeZone, combineDateAndTime(plainDateSlots, timeFieldDefaults)), createZonedEpochNanoSlots(epochNano, timeZone, plainDateSlots.calendar);
}
function yearMonthToDate(calendar, input, bag) {
  return mergeFieldsIntoDate(calendar, pluckProps(getCalendarFieldNames(calendar, yearMonthCodeFieldNamesAlpha, yearMonthCodeFieldNamesWithEraAlpha), input), readAndRefineBagFields(requireObjectLike(bag), dayFieldNamesAsc, dateFieldRefiners, []));
}
function monthDayToDate(calendar, input, bag) {
  const extraFieldNames = getCalendarFieldNames(calendar, yearFieldNamesAsc, yearFieldNamesWithEraAlpha);
  return mergeFieldsIntoDate(calendar, pluckProps(monthCodeDayFieldNamesAlpha, input), readAndRefineBagFields(requireObjectLike(bag), extraFieldNames, dateFieldRefiners, []));
}
function fieldsToMonthDay(calendar, input) {
  const refinedFields = readAndRefineBagFields(input, monthCodeDayFieldNamesAlpha, dateFieldRefiners);
  const [year, monthCodeParts] = refineMonthDayFields(refinedFields, calendar);
  return createMonthDayFromRefinedFields(refinedFields, calendar, year, monthCodeParts, 0);
}
function fieldsToYearMonth(calendar, input) {
  const refinedFields = readAndRefineBagFields(input, getCalendarFieldNames(calendar, yearMonthCodeFieldNamesAlpha, yearMonthCodeFieldNamesWithEraAlpha), dateFieldRefiners);
  const [year, monthCodeParts] = refineCalendarDateFields(refinedFields, calendar, 1);
  return createYearMonthFromRefinedFields(refinedFields, calendar, year, monthCodeParts, 0);
}
function mergeFieldsIntoDate(calendar, inputFields, extraFields) {
  const mergedFieldNames = getCalendarFieldNames(calendar, yearMonthCodeDayFieldNamesAlpha, yearMonthCodeDayFieldNamesWithEraAlpha);
  let mergedFields = mergeCalendarFields(calendar, inputFields, extraFields);
  mergedFields = readAndRefineBagFields(mergedFields, mergedFieldNames, dateFieldRefiners, []);
  const [year, monthCodeParts] = refineCalendarDateFields(mergedFields, calendar);
  return createDateFromRefinedFields(mergedFields, calendar, year, monthCodeParts, 0);
}
function epochMilliToInstant(epochMilli) {
  return createEpochNanoSlots(checkEpochNanoInBounds(BigInt(toStrictInteger(epochMilli)) * bigNanoInMilli));
}
function epochNanoToInstant(epochNano) {
  return createEpochNanoSlots(checkEpochNanoInBounds(toBigInt(epochNano)));
}
function applyPlainFormatTimeZone(options) {
  return options.timeZone = "UTC", ["full", "long"].includes(options.timeStyle) && (options.timeStyle = "medium"), options;
}
function applyZonedFormatTimeZone(options, timeZoneId) {
  return void 0 !== options.timeZone && throwTypeError("Cannot specify TimeZone"), options.timeZone = timeZoneId, options;
}
function checkResolvedCalendarCompatible(format, slots, strictCalendarCheck) {
  const resolvedCalendarId = format.resolvedOptions().calendar;
  !strictCalendarCheck && slots.calendar === isoCalendarImpl || getCalendarSlotId(slots.calendar) === resolvedCalendarId || throwRangeError("Mismatching Calendars");
}
function createOptionsTransformer(shapeFieldNames, invalidShapeFieldNames, ignoredFieldNames, defaultShapeFields, dateStyleReplacementFields) {
  const shapeFieldNameSet = new Set(shapeFieldNames);
  const invalidShapeFieldNameSet = new Set(invalidShapeFieldNames);
  const ignoredFieldNameSet = new Set(ignoredFieldNames);
  return (options, allowPartialOverlap) => {
    let dateStyle;
    let timeStyle;
    const granularShapeFields = {};
    const modifierFields = {};
    const otherFields = {};
    let hasInvalidGranularShapeFields = 0;
    let hasInvalidStyleFields = 0;
    for (const name2 of Object.keys(options)) {
      const value = options[name2];
      void 0 === value || ignoredFieldNameSet.has(name2) || (shapeFieldNameSet.has(name2) ? "dateStyle" === name2 ? dateStyle = value : "timeStyle" === name2 ? timeStyle = value : granularShapeFields[name2] = value : "era" === name2 ? modifierFields[name2] = value : invalidShapeFieldNameSet.has(name2) ? "dateStyle" === name2 || "timeStyle" === name2 ? hasInvalidStyleFields = 1 : hasInvalidGranularShapeFields = 1 : otherFields[name2] = value);
    }
    const hasDateStyle = void 0 !== dateStyle;
    const hasTimeStyle = void 0 !== timeStyle;
    const hasAnyStyle = hasDateStyle || hasTimeStyle;
    const hasGranularShapeFields = Object.keys(granularShapeFields).length > 0;
    const hasInvalids = hasInvalidGranularShapeFields || hasInvalidStyleFields;
    const hasShapeFields = hasGranularShapeFields || hasDateStyle || hasTimeStyle;
    const hasModifierFields = Object.keys(modifierFields).length > 0;
    (!allowPartialOverlap && hasInvalids || allowPartialOverlap && hasInvalids && !hasShapeFields || hasAnyStyle && (hasGranularShapeFields || hasModifierFields || hasInvalidGranularShapeFields)) && throwTypeError("Invalid formatting options");
    const transformedOptions = {};
    return hasAnyStyle || hasShapeFields || Object.assign(transformedOptions, defaultShapeFields), Object.assign(transformedOptions, granularShapeFields, modifierFields, otherFields), hasDateStyle && (dateStyleReplacementFields ? Object.assign(transformedOptions, dateStyleReplacementFields[dateStyle]) : transformedOptions.dateStyle = dateStyle), hasTimeStyle && (transformedOptions.timeStyle = timeStyle), transformedOptions;
  };
}
var dateDefaultShapeFields = {
  year: "numeric",
  month: "numeric",
  day: "numeric"
};
var timeDefaultShapeFields = {
  hour: "numeric",
  minute: "numeric",
  second: "numeric"
};
var dateTimeDefaultShapeFields = /* @__PURE__ */ Object.assign({}, dateDefaultShapeFields, timeDefaultShapeFields);
var dateShapeFieldNames = ["weekday", "year", "month", "day", "dateStyle"];
var timeShapeFieldNames = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits", "timeStyle"];
var dateTimeShapeFieldNames = /* @__PURE__ */ dateShapeFieldNames.concat(timeShapeFieldNames);
var yearMonthIgnoredFieldNames = /* @__PURE__ */ ["weekday", "day"].concat(timeShapeFieldNames);
var monthDayIgnoredFieldNames = /* @__PURE__ */ ["weekday", "year"].concat(timeShapeFieldNames);
var transformInstantOptions = /* @__PURE__ */ createOptionsTransformer(dateTimeShapeFieldNames, [], [], dateTimeDefaultShapeFields);
var transformZonedOptions = /* @__PURE__ */ createOptionsTransformer(dateTimeShapeFieldNames, [], [], {
  ...dateTimeDefaultShapeFields,
  timeZoneName: "short"
});
var transformDateTimeOptions = /* @__PURE__ */ createOptionsTransformer(dateTimeShapeFieldNames, [], ["timeZoneName"], dateTimeDefaultShapeFields);
var transformDateOptions = /* @__PURE__ */ createOptionsTransformer(dateShapeFieldNames, timeShapeFieldNames, ["timeZoneName"], dateDefaultShapeFields);
var transformTimeOptions = /* @__PURE__ */ createOptionsTransformer(timeShapeFieldNames, dateShapeFieldNames, ["timeZoneName", "era"], timeDefaultShapeFields);
var transformYearMonthOptions = /* @__PURE__ */ createOptionsTransformer(["year", "month", "dateStyle"], yearMonthIgnoredFieldNames, ["timeZoneName"], {
  year: "numeric",
  month: "numeric"
}, {
  full: {
    year: "numeric",
    month: "long"
  },
  long: {
    year: "numeric",
    month: "long"
  },
  medium: {
    year: "numeric",
    month: "short"
  },
  short: {
    year: "2-digit",
    month: "numeric"
  }
});
var transformMonthDayOptions = /* @__PURE__ */ createOptionsTransformer(["month", "day", "dateStyle"], monthDayIgnoredFieldNames, ["timeZoneName", "era"], {
  month: "numeric",
  day: "numeric"
}, {
  full: {
    month: "long",
    day: "numeric"
  },
  long: {
    month: "long",
    day: "numeric"
  },
  medium: {
    month: "short",
    day: "numeric"
  },
  short: {
    month: "numeric",
    day: "numeric"
  }
});
function zonedDateTimeWithPlainTime(zonedDateTimeSlots, plainTimeFields) {
  const { timeZone } = zonedDateTimeSlots;
  const newIsoDateTime = combineDateAndTime(zonedEpochSlotsToIso(zonedDateTimeSlots), plainTimeFields || timeFieldDefaults);
  return createZonedEpochNanoSlots(plainTimeFields ? getSingleInstantFor(timeZone, newIsoDateTime) : getStartOfDayInstantFor(timeZone, newIsoDateTime), timeZone, zonedDateTimeSlots.calendar);
}
function refineDirectionOptions(options) {
  const normalizedOptions = normalizeOptionsOrString(options, "direction");
  const res = coerceDirection(normalizedOptions, 0);
  return res || throwRangeError(invalidEntity2("direction", res)), res;
}
function getCurrentIsoDateTime(timeZone) {
  const epochNano = getCurrentEpochNano();
  const offsetNano = timeZone.B(epochNano);
  return epochNanoToIsoDateTime(epochNano + BigInt(offsetNano));
}
function getCurrentEpochNano() {
  return BigInt(Date.now()) * bigNanoInMilli;
}
function getCurrentTimeZoneId() {
  return new RawDateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// node_modules/temporal-polyfill/chunks/apiHelpers.js
var PlainYearMonthBranding = "PlainYearMonth";
var PlainMonthDayBranding = "PlainMonthDay";
var PlainDateBranding = "PlainDate";
var PlainDateTimeBranding = "PlainDateTime";
var PlainTimeBranding = "PlainTime";
var ZonedDateTimeBranding = "ZonedDateTime";
var InstantBranding = "Instant";
var DurationBranding = "Duration";
function defineTemporalClass(branding, cls, getSlots, ...getterMaps) {
  return Object.defineProperties(cls, createNameDescriptors(branding)), Object.defineProperties(cls.prototype, createStringTagDescriptors("Temporal." + branding)), Object.defineProperties(cls.prototype, mapProps((getter) => ({
    get() {
      return getter(getSlots(this));
    },
    configurable: 1
  }), Object.assign({}, ...getterMaps))), cls;
}
var attachDebugString = "noop" !== noop.name || globalThis.process ? noop : (instance) => {
  Object.defineProperty(instance, "_str_", {
    value: instance.toJSON()
  });
};
function invalidRecordType() {
  throwTypeError(invalidCallingContext);
}
function forbiddenValueOf2() {
  throwTypeError(forbiddenValueOf);
}
var yearMonthFieldGetters$1 = {
  era(slots) {
    return computeCalendarEraFields(slots.calendar, slots).era;
  },
  eraYear(slots) {
    return computeCalendarEraFields(slots.calendar, slots).eraYear;
  },
  year(slots) {
    return computeCalendarDateFields(slots.calendar, slots).year;
  },
  month(slots) {
    return computeCalendarDateFields(slots.calendar, slots).month;
  },
  monthCode(slots) {
    return computeCalendarMonthCode(slots.calendar, slots);
  }
};
var dateFieldGetters$1 = {
  era(slots) {
    return computeCalendarEraFields(slots.calendar, slots).era;
  },
  eraYear(slots) {
    return computeCalendarEraFields(slots.calendar, slots).eraYear;
  },
  year(slots) {
    return computeCalendarDateFields(slots.calendar, slots).year;
  },
  month(slots) {
    return computeCalendarDateFields(slots.calendar, slots).month;
  },
  monthCode(slots) {
    return computeCalendarMonthCode(slots.calendar, slots);
  },
  day(slots) {
    return computeCalendarDateFields(slots.calendar, slots).day;
  }
};
var monthDayFieldGetters$1 = {
  monthCode(slots) {
    return computeCalendarMonthCode(slots.calendar, slots);
  },
  day(slots) {
    return computeCalendarDateFields(slots.calendar, slots).day;
  }
};
var yearMonthDerivedGetters = {
  daysInMonth(slots) {
    return computeCalendarDaysInMonth(slots.calendar, slots);
  },
  daysInYear(slots) {
    return computeCalendarDaysInYear(slots.calendar, slots);
  },
  monthsInYear(slots) {
    return computeCalendarMonthsInYear(slots.calendar, slots);
  },
  inLeapYear(slots) {
    return computeCalendarInLeapYear(slots.calendar, slots);
  }
};
var dateDerivedGetters = {
  dayOfWeek(slots) {
    return computeIsoDayOfWeek(slots);
  },
  dayOfYear(slots) {
    return computeCalendarDayOfYear(slots.calendar, slots);
  },
  weekOfYear(slots) {
    return computeCalendarWeekOfYear(slots.calendar, slots);
  },
  yearOfWeek(slots) {
    return computeCalendarYearOfWeek(slots.calendar, slots);
  },
  daysInWeek() {
    return 7;
  },
  daysInMonth(slots) {
    return computeCalendarDaysInMonth(slots.calendar, slots);
  },
  daysInYear(slots) {
    return computeCalendarDaysInYear(slots.calendar, slots);
  },
  monthsInYear(slots) {
    return computeCalendarMonthsInYear(slots.calendar, slots);
  },
  inLeapYear(slots) {
    return computeCalendarInLeapYear(slots.calendar, slots);
  }
};
function diffInstants(invert, instantSlots0, instantSlots1, options) {
  const [largestUnit, smallestUnit, roundingInc, roundingMode] = refineDiffOptions(invert, options, 3, 5);
  return createDiffDurationSlots(invert, diffEpochNanosRounded(instantSlots0.epochNanoseconds, instantSlots1.epochNanoseconds, largestUnit, smallestUnit, roundingInc, roundingMode));
}
function diffZonedDateTimes(invert, slots0, slots1, options) {
  const calendar = getCommonCalendar(slots0.calendar, slots1.calendar);
  const [largestUnit, smallestUnit, roundingInc, roundingMode] = refineDiffOptions(invert, options, 5);
  return createDiffDurationSlots(invert, diffZonedDateTimesRounded(calendar, slots0, slots1, largestUnit, smallestUnit, roundingInc, roundingMode));
}
function diffDateTimes(invert, plainDateTimeSlots0, plainDateTimeSlots1, options) {
  const calendar = getCommonCalendar(plainDateTimeSlots0.calendar, plainDateTimeSlots1.calendar);
  const [largestUnit, smallestUnit, roundingInc, roundingMode] = refineDiffOptions(invert, options, 6);
  return createDiffDurationSlots(invert, diffDateTimesRounded(calendar, plainDateTimeSlots0, plainDateTimeSlots1, largestUnit, smallestUnit, roundingInc, roundingMode));
}
function diffDates(invert, plainDateSlots0, plainDateSlots1, options) {
  const calendar = getCommonCalendar(plainDateSlots0.calendar, plainDateSlots1.calendar);
  const [largestUnit, smallestUnit, roundingInc, roundingMode] = refineDiffOptions(invert, options, 6, 9, 6);
  return createDiffDurationSlots(invert, diffDatesRounded(calendar, plainDateSlots0, plainDateSlots1, largestUnit, smallestUnit, roundingInc, roundingMode));
}
function diffYearMonths(invert, plainYearMonthSlots0, plainYearMonthSlots1, options) {
  const calendar = getCommonCalendar(plainYearMonthSlots0.calendar, plainYearMonthSlots1.calendar);
  const [largestUnit, smallestUnit, roundingInc, roundingMode] = refineDiffOptions(invert, options, 9, 9, 8);
  return createDiffDurationSlots(invert, diffYearMonthsRounded(calendar, plainYearMonthSlots0, plainYearMonthSlots1, largestUnit, smallestUnit, roundingInc, roundingMode));
}
function diffTimes(invert, plainTimeSlots0, plainTimeSlots1, options) {
  const [largestUnit, smallestUnit, roundingInc, roundingMode] = refineDiffOptions(invert, options, 5, 5);
  return createDiffDurationSlots(invert, diffTimesRounded(plainTimeSlots0, plainTimeSlots1, largestUnit, smallestUnit, roundingInc, roundingMode));
}
function createDiffDurationSlots(invert, durationFields) {
  return createDurationSlots(invert ? negateDurationFields(durationFields) : durationFields);
}
function withDateFields(slots, modFields, options) {
  const { calendar } = slots;
  const fields = mergeDateFields(calendar, slots, modFields);
  const [year, monthCodeParts] = refineCalendarDateFields(fields, calendar);
  const overflow = refineOverflowOptions(options);
  return createDateFromRefinedFields(fields, calendar, year, monthCodeParts, overflow);
}
function withDateTimeFields(slots, modFields, options) {
  const { calendar } = slots;
  const [mergedFields, calendarFields] = mergeDateTimeFields(calendar, slots, modFields);
  const [year, monthCodeParts] = refineCalendarDateFields(calendarFields, calendar);
  const overflow = refineOverflowOptions(options);
  return createDateTimeFromMergedFields(mergedFields, calendarFields, calendar, year, monthCodeParts, overflow);
}
function withYearMonthFields(slots, modFields, options) {
  const { calendar } = slots;
  const fields = mergeYearMonthFields(calendar, slots, modFields);
  const [year, monthCodeParts] = refineCalendarDateFields(fields, calendar, 1);
  const overflow = refineOverflowOptions(options);
  return createYearMonthFromRefinedFields(fields, calendar, year, monthCodeParts, overflow);
}
function withMonthDayFields(slots, modFields, options) {
  const { calendar } = slots;
  const fields = mergeMonthDayFields(calendar, slots, modFields);
  const [year, monthCodeParts] = refineMonthDayFields(fields, calendar);
  const overflow = refineOverflowOptions(options);
  return createMonthDayFromRefinedFields(fields, calendar, year, monthCodeParts, overflow);
}
function withTimeFields(slots, modFields, options) {
  const refinedFields = mergeTimeFields(slots, modFields);
  const overflow = refineOverflowOptions(options);
  return resolveTimeFields(refinedFields, overflow);
}
function withZonedDateTimeFields(slots, modFields, options) {
  const { calendar } = slots;
  const [mergedFields, calendarFields] = mergeZonedDateTimeFields(calendar, slots, modFields);
  const [year, monthCodeParts] = refineCalendarDateFields(calendarFields, calendar);
  const [overflow, offsetDisambig, epochDisambig] = refineZonedFieldOptions(options, 2);
  return createZonedDateTimeFromMergedFields(slots, mergedFields, calendarFields, year, monthCodeParts, overflow, offsetDisambig, epochDisambig);
}

// node_modules/temporal-polyfill/chunks/classApi-basic.js
function resolveBasicCalendarId(rawCalendarId) {
  const lowerRawCalendarId = requireString(rawCalendarId).toLowerCase();
  return lowerRawCalendarId === isoCalendarId ? isoCalendarImpl : lowerRawCalendarId === gregoryCalendarId ? gregoryCalendarImpl : void throwRangeError(exoticCalendarRequired(rawCalendarId, "temporal-polyfill/full"));
}
function resolveBasicCalendarArg(rawCalendarId = isoCalendarId) {
  return resolveBasicCalendarId(rawCalendarId);
}
var zonedDateTimeSlotsMap = /* @__PURE__ */ new WeakMap();
var ZonedDateTime = /* @__PURE__ */ defineTemporalClass(ZonedDateTimeBranding, class {
  constructor(epochNanoseconds, timeZoneId, calendar = void 0) {
    const epochNano = checkEpochNanoInBounds(toBigInt(epochNanoseconds));
    const timeZone = queryTimeZone(refineTimeZoneId(timeZoneId));
    const calendarImpl = resolveBasicCalendarArg(calendar);
    initZonedDateTime(this, createZonedEpochNanoSlots(epochNano, timeZone, calendarImpl));
  }
  static from(arg, options = void 0) {
    return createZonedDateTime(toZonedDateTimeSlots(arg, options));
  }
  static compare(arg0, arg1) {
    return compareZonedEpochSlots(toZonedDateTimeSlots(arg0), toZonedDateTimeSlots(arg1));
  }
  get calendarId() {
    return getCalendarSlotId(getZonedDateTimeSlots(this).calendar);
  }
  get timeZoneId() {
    return getZonedDateTimeSlots(this).timeZone.id;
  }
  get epochMilliseconds() {
    return epochNanoToMilli(getZonedDateTimeSlots(this).epochNanoseconds);
  }
  get epochNanoseconds() {
    return getZonedDateTimeSlots(this).epochNanoseconds;
  }
  get offset() {
    return formatOffsetNano(zonedEpochSlotsToIso(getZonedDateTimeSlots(this)).offsetNanoseconds);
  }
  get offsetNanoseconds() {
    return zonedEpochSlotsToIso(getZonedDateTimeSlots(this)).offsetNanoseconds;
  }
  get hoursInDay() {
    return computeZonedHoursInDay(getZonedDateTimeSlots(this));
  }
  with(mod, options = void 0) {
    return createZonedDateTime(withZonedDateTimeFields(getZonedDateTimeSlots(this), validateBag(mod), options));
  }
  withCalendar(calendarArg) {
    return createZonedDateTime({
      ...getZonedDateTimeSlots(this),
      calendar: refineCalendarArg(calendarArg)
    });
  }
  withTimeZone(timeZoneArg) {
    return createZonedDateTime({
      ...getZonedDateTimeSlots(this),
      timeZone: queryTimeZone(refineTimeZoneArg(timeZoneArg))
    });
  }
  withPlainTime(plainTimeArg = void 0) {
    return createZonedDateTime(zonedDateTimeWithPlainTime(getZonedDateTimeSlots(this), optionalToPlainTimeFields(plainTimeArg)));
  }
  add(durationArg, options = void 0) {
    const slots = getZonedDateTimeSlots(this);
    return createZonedDateTime(moveZonedEpochSlots(slots, toDurationSlots(durationArg), refineOverflowOptions(options)));
  }
  subtract(durationArg, options = void 0) {
    const slots = getZonedDateTimeSlots(this);
    return createZonedDateTime(moveZonedEpochSlots(slots, negateDurationFields(toDurationSlots(durationArg)), refineOverflowOptions(options)));
  }
  until(otherArg, options = void 0) {
    const slots = getZonedDateTimeSlots(this);
    const other = toZonedDateTimeSlots(otherArg);
    return createDuration(diffZonedDateTimes(0, slots, other, options));
  }
  since(otherArg, options = void 0) {
    const slots = getZonedDateTimeSlots(this);
    const other = toZonedDateTimeSlots(otherArg);
    return createDuration(diffZonedDateTimes(1, slots, other, options));
  }
  round(options) {
    const slots = getZonedDateTimeSlots(this);
    const [smallestUnit, roundingInc, roundingMode] = refineRoundingOptions(options);
    return createZonedDateTime(roundZonedEpochSlotsToUnit(slots, smallestUnit, roundingInc, roundingMode));
  }
  startOfDay() {
    return createZonedDateTime(computeZonedStartOfDay(getZonedDateTimeSlots(this)));
  }
  equals(otherArg) {
    return zonedDateTimesEqual(getZonedDateTimeSlots(this), toZonedDateTimeSlots(otherArg));
  }
  toInstant() {
    return createInstant(zonedDateTimeToInstant(getZonedDateTimeSlots(this)));
  }
  toPlainDateTime() {
    return createPlainDateTime(zonedDateTimeToDateTime(getZonedDateTimeSlots(this)));
  }
  toPlainDate() {
    return createPlainDate(zonedDateTimeToDate(getZonedDateTimeSlots(this)));
  }
  toPlainTime() {
    return createPlainTime(zonedDateTimeToTime(getZonedDateTimeSlots(this)));
  }
  toLocaleString(locales = void 0, options = {}) {
    const slots = getZonedDateTimeSlots(this);
    const format = new RawDateTimeFormat(locales, applyZonedFormatTimeZone(transformZonedOptions(options), getZonedTimeZoneId(slots)));
    return checkResolvedCalendarCompatible(format, slots), format.format(epochNanoToMilli(slots.epochNanoseconds));
  }
  toString(options = void 0) {
    return formatZonedDateTimeIso(getZonedDateTimeSlots(this), options);
  }
  toJSON() {
    return formatZonedDateTimeIso(getZonedDateTimeSlots(this));
  }
  getTimeZoneTransition(options) {
    const slots = getZonedDateTimeSlots(this);
    const newEpochNano = slots.timeZone.C(slots.epochNanoseconds, refineDirectionOptions(options));
    return void 0 !== newEpochNano ? createZonedDateTime({
      ...slots,
      epochNanoseconds: newEpochNano
    }) : null;
  }
  valueOf() {
    return forbiddenValueOf2();
  }
}, getZonedDateTimeIsoSlots, dateFieldGetters$1, dateDerivedGetters, timeGetters);
function createZonedDateTime(slots) {
  return initZonedDateTime(Object.create(ZonedDateTime.prototype), slots);
}
function getZonedDateTimeSlots(obj) {
  return getZonedDateTimeSlotsIfPresent(obj) || invalidRecordType();
}
function getZonedDateTimeIsoSlots(obj) {
  const slots = getZonedDateTimeSlots(obj);
  return {
    ...zonedEpochSlotsToIso(slots),
    calendar: slots.calendar
  };
}
function getZonedDateTimeSlotsIfPresent(obj) {
  return zonedDateTimeSlotsMap.get(obj);
}
function toZonedDateTimeSlots(arg, options) {
  if (isObjectLike2(arg)) {
    const ownSlots = getZonedDateTimeSlotsIfPresent(arg);
    if (ownSlots) {
      return refineZonedFieldOptions(options), ownSlots;
    }
    const calendar = getCalendarFromBag(arg);
    return refineZonedDateTimeObjectLike(refineTimeZoneArg, calendar, arg, options);
  }
  return parseZonedDateTime(arg, resolveBasicCalendarId, options);
}
function initZonedDateTime(instance, slots) {
  return zonedDateTimeSlotsMap.set(instance, slots), attachDebugString(instance), instance;
}
function refineTimeZoneArg(arg) {
  if (isObjectLike2(arg)) {
    const slots = getZonedDateTimeSlotsIfPresent(arg);
    return slots || throwTypeError(invalidTimeZone(arg)), slots.timeZone.id;
  }
  return ((arg2) => resolveTimeZoneId(parseTimeZoneId(requireString(arg2))))(arg);
}
var instantSlotsMap = /* @__PURE__ */ new WeakMap();
var Instant = /* @__PURE__ */ defineTemporalClass(InstantBranding, class {
  constructor(epochNanoseconds) {
    const epochNano = checkEpochNanoInBounds(toBigInt(epochNanoseconds));
    initInstant(this, createEpochNanoSlots(epochNano));
  }
  static from(arg) {
    return createInstant(toInstantSlots(arg));
  }
  static fromEpochMilliseconds(epochMilli) {
    return createInstant(epochMilliToInstant(epochMilli));
  }
  static fromEpochNanoseconds(epochNano) {
    return createInstant(epochNanoToInstant(epochNano));
  }
  static compare(a, b) {
    return compareZonedEpochSlots(toInstantSlots(a), toInstantSlots(b));
  }
  get epochMilliseconds() {
    return epochNanoToMilli(getInstantSlots(this).epochNanoseconds);
  }
  get epochNanoseconds() {
    return getInstantSlots(this).epochNanoseconds;
  }
  add(durationArg) {
    const slots = getInstantSlots(this);
    return createInstant(createEpochNanoSlots(moveEpochNano(slots.epochNanoseconds, toDurationSlots(durationArg))));
  }
  subtract(durationArg) {
    const slots = getInstantSlots(this);
    return createInstant(createEpochNanoSlots(moveEpochNano(slots.epochNanoseconds, negateDurationFields(toDurationSlots(durationArg)))));
  }
  until(otherArg, options = void 0) {
    return createDuration(diffInstants(0, getInstantSlots(this), toInstantSlots(otherArg), options));
  }
  since(otherArg, options = void 0) {
    return createDuration(diffInstants(1, getInstantSlots(this), toInstantSlots(otherArg), options));
  }
  round(options) {
    const slots = getInstantSlots(this);
    const [smallestUnit, roundingInc, roundingMode] = refineRoundingOptions(options, 5, 1);
    return createInstant(createEpochNanoSlots(roundBigNanoToDayOriginInc(slots.epochNanoseconds, computeBigNanoInc(smallestUnit, roundingInc), roundingMode)));
  }
  equals(otherArg) {
    return instantsEqual(getInstantSlots(this), toInstantSlots(otherArg));
  }
  toZonedDateTimeISO(timeZoneArg) {
    return createZonedDateTime(instantToZonedDateTime(getInstantSlots(this), queryTimeZone(refineTimeZoneArg(timeZoneArg))));
  }
  toLocaleString(locales = void 0, options = {}) {
    const slots = getInstantSlots(this);
    return new RawDateTimeFormat(locales, transformInstantOptions(options)).format(epochNanoToMilli(slots.epochNanoseconds));
  }
  toString(options = void 0) {
    return formatInstantIso(refineTimeZoneArg, getInstantSlots(this), options);
  }
  toJSON() {
    return formatInstantIso(refineTimeZoneArg, getInstantSlots(this));
  }
  valueOf() {
    return forbiddenValueOf2();
  }
});
function createInstant(slots) {
  return initInstant(Object.create(Instant.prototype), slots);
}
function getInstantSlots(obj) {
  return getInstantSlotsIfPresent(obj) || invalidRecordType();
}
function getInstantSlotsIfPresent(obj) {
  return instantSlotsMap.get(obj);
}
function toInstantSlots(arg) {
  if (isObjectLike2(arg)) {
    const ownSlots = getInstantSlotsIfPresent(arg);
    if (ownSlots) {
      return ownSlots;
    }
    const zonedDateTimeSlots = getZonedDateTimeSlotsIfPresent(arg);
    if (zonedDateTimeSlots) {
      return createEpochNanoSlots(zonedDateTimeSlots.epochNanoseconds);
    }
  }
  return parseInstant(arg);
}
var { toTemporalInstant } = {
  toTemporalInstant() {
    const epochMilli = Date.prototype.valueOf.call(this);
    return createInstant(createEpochNanoSlots(BigInt(requireNumberIsInteger(epochMilli)) * bigNanoInMilli));
  }
};
function initInstant(instance, slots) {
  return instantSlotsMap.set(instance, slots), attachDebugString(instance), instance;
}
var plainMonthDaySlotsMap = /* @__PURE__ */ new WeakMap();
var PlainMonthDay = /* @__PURE__ */ defineTemporalClass(PlainMonthDayBranding, class {
  constructor(isoMonth, isoDay, calendar = void 0, referenceIsoYear) {
    const isoMonthInt = toIntegerWithTrunc(isoMonth);
    const isoDayInt = toIntegerWithTrunc(isoDay);
    const calendarImpl = resolveBasicCalendarArg(calendar);
    const isoYearInt = toIntegerWithTrunc(referenceIsoYear ?? isoEpochFirstLeapYear);
    const fields = checkIsoDateInBounds(validateIsoDateFields({
      year: isoYearInt,
      month: isoMonthInt,
      day: isoDayInt
    }));
    initPlainMonthDay(this, createDateSlots(fields, calendarImpl));
  }
  static from(arg, options = void 0) {
    return createPlainMonthDay(toPlainMonthDaySlots(arg, options));
  }
  get calendarId() {
    return getCalendarSlotId(getPlainMonthDaySlots(this).calendar);
  }
  with(mod, options = void 0) {
    return createPlainMonthDay(withMonthDayFields(getPlainMonthDaySlots(this), validateBag(mod), options));
  }
  equals(otherArg) {
    return plainMonthDaysEqual(getPlainMonthDaySlots(this), toPlainMonthDaySlots(otherArg));
  }
  toPlainDate(bag) {
    const slots = getPlainMonthDaySlots(this);
    return createPlainDate(monthDayToDate(slots.calendar, this, bag));
  }
  toLocaleString(locales = void 0, options = {}) {
    const slots = getPlainMonthDaySlots(this);
    const format = new RawDateTimeFormat(locales, applyPlainFormatTimeZone(transformMonthDayOptions(options)));
    return checkResolvedCalendarCompatible(format, slots, 1), format.format(isoDateToEpochMilli(slots));
  }
  toString(options = void 0) {
    return formatPlainMonthDayIso(getPlainMonthDaySlots(this), options);
  }
  toJSON() {
    return formatPlainMonthDayIso(getPlainMonthDaySlots(this));
  }
  valueOf() {
    return forbiddenValueOf2();
  }
}, getPlainMonthDaySlots, monthDayFieldGetters$1);
function createPlainMonthDay(slots) {
  return initPlainMonthDay(Object.create(PlainMonthDay.prototype), slots);
}
function getPlainMonthDaySlots(obj) {
  return getPlainMonthDaySlotsIfPresent(obj) || invalidRecordType();
}
function getPlainMonthDaySlotsIfPresent(obj) {
  return plainMonthDaySlotsMap.get(obj);
}
function toPlainMonthDaySlots(arg, options) {
  if (isObjectLike2(arg)) {
    const ownSlots = getPlainMonthDaySlotsIfPresent(arg);
    if (ownSlots) {
      return refineOverflowOptions(options), ownSlots;
    }
    const calendarMaybe = extractCalendarFromBag(arg);
    return refinePlainMonthDayObjectLike(void 0 === calendarMaybe ? isoCalendarImpl : calendarMaybe, void 0 === calendarMaybe, arg, options);
  }
  const res = parsePlainMonthDay(arg, resolveBasicCalendarId);
  return refineOverflowOptions(options), res;
}
function initPlainMonthDay(instance, slots) {
  return plainMonthDaySlotsMap.set(instance, slots), attachDebugString(instance), instance;
}
var plainYearMonthSlotsMap = /* @__PURE__ */ new WeakMap();
var PlainYearMonth = /* @__PURE__ */ defineTemporalClass(PlainYearMonthBranding, class {
  constructor(isoYear, isoMonth, calendar = void 0, referenceIsoDay) {
    const isoYearInt = toIntegerWithTrunc(isoYear);
    const isoMonthInt = toIntegerWithTrunc(isoMonth);
    const calendarImpl = resolveBasicCalendarArg(calendar);
    const isoDayInt = toIntegerWithTrunc(referenceIsoDay ?? 1);
    const fields = checkIsoYearMonthInBounds(validateIsoDateFields({
      year: isoYearInt,
      month: isoMonthInt,
      day: isoDayInt
    }));
    initPlainYearMonth(this, createDateSlots(fields, calendarImpl));
  }
  static from(arg, options = void 0) {
    return createPlainYearMonth(toPlainYearMonthSlots(arg, options));
  }
  static compare(arg0, arg1) {
    return compareIsoDateFields(toPlainYearMonthSlots(arg0), toPlainYearMonthSlots(arg1));
  }
  get calendarId() {
    return getCalendarSlotId(getPlainYearMonthSlots(this).calendar);
  }
  with(mod, options = void 0) {
    return createPlainYearMonth(withYearMonthFields(getPlainYearMonthSlots(this), validateBag(mod), options));
  }
  add(durationArg, options = void 0) {
    const slots = getPlainYearMonthSlots(this);
    return createPlainYearMonth(createDateSlots(moveYearMonth(slots.calendar, slots, toDurationSlots(durationArg), refineOverflowOptions(options)), slots.calendar));
  }
  subtract(durationArg, options = void 0) {
    const slots = getPlainYearMonthSlots(this);
    return createPlainYearMonth(createDateSlots(moveYearMonth(slots.calendar, slots, negateDurationFields(toDurationSlots(durationArg)), refineOverflowOptions(options)), slots.calendar));
  }
  until(otherArg, options = void 0) {
    const slots = getPlainYearMonthSlots(this);
    const other = toPlainYearMonthSlots(otherArg);
    return createDuration(diffYearMonths(0, slots, other, options));
  }
  since(otherArg, options = void 0) {
    const slots = getPlainYearMonthSlots(this);
    const other = toPlainYearMonthSlots(otherArg);
    return createDuration(diffYearMonths(1, slots, other, options));
  }
  equals(otherArg) {
    return plainYearMonthsEqual(getPlainYearMonthSlots(this), toPlainYearMonthSlots(otherArg));
  }
  toPlainDate(bag) {
    const slots = getPlainYearMonthSlots(this);
    return createPlainDate(yearMonthToDate(slots.calendar, this, bag));
  }
  toLocaleString(locales = void 0, options = {}) {
    const slots = getPlainYearMonthSlots(this);
    const format = new RawDateTimeFormat(locales, applyPlainFormatTimeZone(transformYearMonthOptions(options)));
    return checkResolvedCalendarCompatible(format, slots, 1), format.format(isoDateToEpochMilli(slots));
  }
  toString(options = void 0) {
    return formatPlainYearMonthIso(getPlainYearMonthSlots(this), options);
  }
  toJSON() {
    return formatPlainYearMonthIso(getPlainYearMonthSlots(this));
  }
  valueOf() {
    return forbiddenValueOf2();
  }
}, getPlainYearMonthSlots, yearMonthFieldGetters$1, yearMonthDerivedGetters);
function createPlainYearMonth(slots) {
  return initPlainYearMonth(Object.create(PlainYearMonth.prototype), slots);
}
function getPlainYearMonthSlots(obj) {
  return getPlainYearMonthSlotsIfPresent(obj) || invalidRecordType();
}
function getPlainYearMonthSlotsIfPresent(obj) {
  return plainYearMonthSlotsMap.get(obj);
}
function toPlainYearMonthSlots(arg, options) {
  if (isObjectLike2(arg)) {
    const ownSlots = getPlainYearMonthSlotsIfPresent(arg);
    if (ownSlots) {
      return refineOverflowOptions(options), ownSlots;
    }
    const calendar = getCalendarFromBag(arg);
    return refinePlainYearMonthObjectLike(calendar, arg, options);
  }
  const res = parsePlainYearMonth(arg, resolveBasicCalendarId);
  return refineOverflowOptions(options), res;
}
function initPlainYearMonth(instance, slots) {
  return plainYearMonthSlotsMap.set(instance, slots), attachDebugString(instance), instance;
}
function getTemporalBrandingAndSlots(obj) {
  if (!isObjectLike2(obj)) {
    return;
  }
  let slots = getInstantSlotsIfPresent(obj);
  return slots ? [InstantBranding, slots] : (slots = getZonedDateTimeSlotsIfPresent(obj), slots ? [ZonedDateTimeBranding, slots] : (slots = getPlainDateTimeSlotsIfPresent(obj), slots ? [PlainDateTimeBranding, slots] : (slots = getPlainDateSlotsIfPresent(obj), slots ? [PlainDateBranding, slots] : (slots = getPlainTimeSlotsIfPresent(obj), slots ? [PlainTimeBranding, slots] : (slots = getPlainYearMonthSlotsIfPresent(obj), slots ? [PlainYearMonthBranding, slots] : (slots = getPlainMonthDaySlotsIfPresent(obj), slots ? [PlainMonthDayBranding, slots] : (slots = getDurationSlotsIfPresent(obj), slots ? [DurationBranding, slots] : void 0)))))));
}
function validateBag(bag) {
  return (getTemporalBrandingAndSlots(bag) || void 0 !== bag.calendar || void 0 !== bag.timeZone) && throwTypeError(invalidBag), bag;
}
var plainTimeSlotsMap = /* @__PURE__ */ new WeakMap();
var PlainTime = /* @__PURE__ */ defineTemporalClass(PlainTimeBranding, class {
  constructor(hour = 0, minute = 0, second = 0, millisecond = 0, microsecond = 0, nanosecond = 0) {
    const fields = validateTimeFields(mapProps(toIntegerWithTrunc, {
      hour,
      minute,
      second,
      millisecond,
      microsecond,
      nanosecond
    }));
    initPlainTime(this, createTimeSlots(fields));
  }
  static from(arg, options = void 0) {
    return createPlainTime(toPlainTimeSlots(arg, options));
  }
  static compare(arg0, arg1) {
    return compareTimeFields(toPlainTimeSlots(arg0), toPlainTimeSlots(arg1));
  }
  with(mod, options = void 0) {
    return createPlainTime(withTimeFields(getPlainTimeSlots(this), validateBag(mod), options));
  }
  add(durationArg) {
    const slots = getPlainTimeSlots(this);
    return createPlainTime(moveTime(slots, toDurationSlots(durationArg))[0]);
  }
  subtract(durationArg) {
    const slots = getPlainTimeSlots(this);
    return createPlainTime(moveTime(slots, negateDurationFields(toDurationSlots(durationArg)))[0]);
  }
  until(otherArg, options = void 0) {
    return createDuration(diffTimes(0, getPlainTimeSlots(this), toPlainTimeSlots(otherArg), options));
  }
  since(otherArg, options = void 0) {
    return createDuration(diffTimes(1, getPlainTimeSlots(this), toPlainTimeSlots(otherArg), options));
  }
  round(options) {
    const slots = getPlainTimeSlots(this);
    const [smallestUnit, roundingInc, roundingMode] = refineRoundingOptions(options, 5);
    return createPlainTime(roundTimeToUnit(slots, smallestUnit, roundingInc, roundingMode)[0]);
  }
  equals(other) {
    return plainTimesEqual(getPlainTimeSlots(this), toPlainTimeSlots(other));
  }
  toLocaleString(locales = void 0, options = {}) {
    const slots = getPlainTimeSlots(this);
    return new RawDateTimeFormat(locales, applyPlainFormatTimeZone(transformTimeOptions(options))).format(timeFieldsToMilli(slots));
  }
  toString(options = void 0) {
    return formatPlainTimeIso(getPlainTimeSlots(this), options);
  }
  toJSON() {
    return formatPlainTimeIso(getPlainTimeSlots(this));
  }
  valueOf() {
    return forbiddenValueOf2();
  }
}, getPlainTimeSlots, timeGetters);
function createPlainTime(slots) {
  return initPlainTime(Object.create(PlainTime.prototype), slots);
}
function getPlainTimeSlots(obj) {
  return getPlainTimeSlotsIfPresent(obj) || invalidRecordType();
}
function getPlainTimeSlotsIfPresent(obj) {
  return plainTimeSlotsMap.get(obj);
}
function toPlainTimeSlots(arg, options) {
  if (isObjectLike2(arg)) {
    const ownSlots = getPlainTimeSlotsIfPresent(arg);
    if (ownSlots) {
      return refineOverflowOptions(options), ownSlots;
    }
    const dateTimeSlots = getPlainDateTimeSlotsIfPresent(arg);
    if (dateTimeSlots) {
      return refineOverflowOptions(options), createTimeSlots(dateTimeSlots);
    }
    const zonedDateTimeSlots = getZonedDateTimeSlotsIfPresent(arg);
    return zonedDateTimeSlots ? (refineOverflowOptions(options), zonedDateTimeToTime(zonedDateTimeSlots)) : refinePlainTimeObjectLike(arg, options);
  }
  const timeSlots = parsePlainTime(arg);
  return refineOverflowOptions(options), timeSlots;
}
function optionalToPlainTimeFields(timeArg) {
  return void 0 === timeArg ? void 0 : toPlainTimeSlots(timeArg);
}
function initPlainTime(instance, slots) {
  return plainTimeSlotsMap.set(instance, slots), attachDebugString(instance), instance;
}
var plainDateTimeSlotsMap = /* @__PURE__ */ new WeakMap();
var PlainDateTime = /* @__PURE__ */ defineTemporalClass(PlainDateTimeBranding, class {
  constructor(isoYear, isoMonth, isoDay, hour = 0, minute = 0, second = 0, millisecond = 0, microsecond = 0, nanosecond = 0, calendar = void 0) {
    const fields = checkIsoDateTimeInBounds(validateIsoDateTimeFields(mapProps(toIntegerWithTrunc, {
      year: isoYear,
      month: isoMonth,
      day: isoDay,
      hour,
      minute,
      second,
      millisecond,
      microsecond,
      nanosecond
    })));
    const calendarImpl = resolveBasicCalendarArg(calendar);
    initPlainDateTime(this, createDateTimeSlots(fields, calendarImpl));
  }
  static from(arg, options = void 0) {
    return createPlainDateTime(toPlainDateTimeSlots(arg, options));
  }
  static compare(arg0, arg1) {
    const slots0 = toPlainDateTimeSlots(arg0);
    const slots1 = toPlainDateTimeSlots(arg1);
    return compareIsoDateTimeFields(slots0, slots1);
  }
  get calendarId() {
    return getCalendarSlotId(getPlainDateTimeSlots(this).calendar);
  }
  with(mod, options = void 0) {
    return createPlainDateTime(withDateTimeFields(getPlainDateTimeSlots(this), validateBag(mod), options));
  }
  withCalendar(calendarArg) {
    const slots = getPlainDateTimeSlots(this);
    return createPlainDateTime(createDateTimeSlots(slots, refineCalendarArg(calendarArg)));
  }
  withPlainTime(plainTimeArg = void 0) {
    const slots = getPlainDateTimeSlots(this);
    return createPlainDateTime(createDateTimeFromRefinedFields(slots, optionalToPlainTimeFields(plainTimeArg), slots.calendar));
  }
  add(durationArg, options = void 0) {
    const slots = getPlainDateTimeSlots(this);
    return createPlainDateTime(createDateTimeSlots(moveDateTime(slots.calendar, slots, toDurationSlots(durationArg), refineOverflowOptions(options)), slots.calendar));
  }
  subtract(durationArg, options = void 0) {
    const slots = getPlainDateTimeSlots(this);
    return createPlainDateTime(createDateTimeSlots(moveDateTime(slots.calendar, slots, negateDurationFields(toDurationSlots(durationArg)), refineOverflowOptions(options)), slots.calendar));
  }
  until(otherArg, options = void 0) {
    const slots = getPlainDateTimeSlots(this);
    const other = toPlainDateTimeSlots(otherArg);
    return createDuration(diffDateTimes(0, slots, other, options));
  }
  since(otherArg, options = void 0) {
    const slots = getPlainDateTimeSlots(this);
    const other = toPlainDateTimeSlots(otherArg);
    return createDuration(diffDateTimes(1, slots, other, options));
  }
  round(options) {
    const slots = getPlainDateTimeSlots(this);
    const [smallestUnit, roundingInc, roundingMode] = refineRoundingOptions(options);
    return createPlainDateTime(createDateTimeSlots(roundDateTimeToUnit(slots, smallestUnit, roundingInc, roundingMode), slots.calendar));
  }
  equals(otherArg) {
    return plainDateTimesEqual(getPlainDateTimeSlots(this), toPlainDateTimeSlots(otherArg));
  }
  toZonedDateTime(timeZoneArg, options = void 0) {
    return createZonedDateTime(dateTimeToZonedDateTime(getPlainDateTimeSlots(this), queryTimeZone(refineTimeZoneArg(timeZoneArg)), refineEpochDisambigOptions(options)));
  }
  toPlainDate() {
    const slots = getPlainDateTimeSlots(this);
    return createPlainDate(createDateSlots(slots, slots.calendar));
  }
  toPlainTime() {
    return createPlainTime(createTimeSlots(getPlainDateTimeSlots(this)));
  }
  toLocaleString(locales = void 0, options = {}) {
    const slots = getPlainDateTimeSlots(this);
    const format = new RawDateTimeFormat(locales, applyPlainFormatTimeZone(transformDateTimeOptions(options)));
    return checkResolvedCalendarCompatible(format, slots), format.format(isoDateTimeToEpochMilli(slots));
  }
  toString(options = void 0) {
    return formatPlainDateTimeIso(getPlainDateTimeSlots(this), options);
  }
  toJSON() {
    return formatPlainDateTimeIso(getPlainDateTimeSlots(this));
  }
  valueOf() {
    return forbiddenValueOf2();
  }
}, getPlainDateTimeSlots, dateFieldGetters$1, dateDerivedGetters, timeGetters);
function createPlainDateTime(slots) {
  return initPlainDateTime(Object.create(PlainDateTime.prototype), slots);
}
function getPlainDateTimeSlots(obj) {
  return getPlainDateTimeSlotsIfPresent(obj) || invalidRecordType();
}
function getPlainDateTimeSlotsIfPresent(obj) {
  return plainDateTimeSlotsMap.get(obj);
}
function toPlainDateTimeSlots(arg, options) {
  if (isObjectLike2(arg)) {
    const ownSlots = getPlainDateTimeSlotsIfPresent(arg);
    if (ownSlots) {
      return refineOverflowOptions(options), ownSlots;
    }
    const dateSlots = getPlainDateSlotsIfPresent(arg);
    if (dateSlots) {
      return refineOverflowOptions(options), createDateTimeSlots(combineDateAndTime(dateSlots, timeFieldDefaults), dateSlots.calendar);
    }
    const zonedDateTimeSlots = getZonedDateTimeSlotsIfPresent(arg);
    if (zonedDateTimeSlots) {
      return refineOverflowOptions(options), zonedDateTimeToDateTime(zonedDateTimeSlots);
    }
    const calendar = getCalendarFromBag(arg);
    return refinePlainDateTimeObjectLike(calendar, arg, options);
  }
  const res = parsePlainDateTime(arg, resolveBasicCalendarId);
  return refineOverflowOptions(options), res;
}
function initPlainDateTime(instance, slots) {
  return plainDateTimeSlotsMap.set(instance, slots), attachDebugString(instance), instance;
}
var plainDateSlotsMap = /* @__PURE__ */ new WeakMap();
var PlainDate = /* @__PURE__ */ defineTemporalClass(PlainDateBranding, class {
  constructor(isoYear, isoMonth, isoDay, calendar = void 0) {
    const fields = checkIsoDateInBounds(validateIsoDateFields(mapProps(toIntegerWithTrunc, {
      year: isoYear,
      month: isoMonth,
      day: isoDay
    })));
    const calendarImpl = resolveBasicCalendarArg(calendar);
    initPlainDate(this, createDateSlots(fields, calendarImpl));
  }
  static from(arg, options = void 0) {
    return createPlainDate(toPlainDateSlots(arg, options));
  }
  static compare(arg0, arg1) {
    return compareIsoDateFields(toPlainDateSlots(arg0), toPlainDateSlots(arg1));
  }
  get calendarId() {
    return getCalendarSlotId(getPlainDateSlots(this).calendar);
  }
  with(mod, options = void 0) {
    return createPlainDate(withDateFields(getPlainDateSlots(this), validateBag(mod), options));
  }
  withCalendar(calendarArg) {
    const slots = getPlainDateSlots(this);
    return createPlainDate(createDateSlots(slots, refineCalendarArg(calendarArg)));
  }
  add(durationArg, options = void 0) {
    const slots = getPlainDateSlots(this);
    return createPlainDate(createDateSlots(moveDate(slots.calendar, slots, toDurationSlots(durationArg), refineOverflowOptions(options)), slots.calendar));
  }
  subtract(durationArg, options = void 0) {
    const slots = getPlainDateSlots(this);
    return createPlainDate(createDateSlots(moveDate(slots.calendar, slots, negateDurationFields(toDurationSlots(durationArg)), refineOverflowOptions(options)), slots.calendar));
  }
  until(otherArg, options = void 0) {
    const slots = getPlainDateSlots(this);
    const other = toPlainDateSlots(otherArg);
    return createDuration(diffDates(0, slots, other, options));
  }
  since(otherArg, options = void 0) {
    const slots = getPlainDateSlots(this);
    const other = toPlainDateSlots(otherArg);
    return createDuration(diffDates(1, slots, other, options));
  }
  equals(otherArg) {
    return plainDatesEqual(getPlainDateSlots(this), toPlainDateSlots(otherArg));
  }
  toZonedDateTime(options) {
    const optionsObj = isObjectLike2(options) ? {
      timeZone: options.timeZone,
      plainTime: options.plainTime
    } : {
      timeZone: options
    };
    const slots = getPlainDateSlots(this);
    const timeZoneId = refineTimeZoneArg(optionsObj.timeZone);
    const plainTimeArg = optionsObj.plainTime;
    const timeFields = void 0 !== plainTimeArg ? toPlainTimeSlots(plainTimeArg) : void 0;
    return createZonedDateTime(dateToZonedDateTime(slots, queryTimeZone(timeZoneId), timeFields));
  }
  toPlainDateTime(plainTimeArg = void 0) {
    const slots = getPlainDateSlots(this);
    return createPlainDateTime(createDateTimeFromRefinedFields(slots, optionalToPlainTimeFields(plainTimeArg), slots.calendar));
  }
  toPlainYearMonth() {
    const slots = getPlainDateSlots(this);
    return createPlainYearMonth(fieldsToYearMonth(slots.calendar, this));
  }
  toPlainMonthDay() {
    const slots = getPlainDateSlots(this);
    return createPlainMonthDay(fieldsToMonthDay(slots.calendar, this));
  }
  toLocaleString(locales = void 0, options = {}) {
    const slots = getPlainDateSlots(this);
    const format = new RawDateTimeFormat(locales, applyPlainFormatTimeZone(transformDateOptions(options)));
    return checkResolvedCalendarCompatible(format, slots), format.format(isoDateToEpochMilli(slots));
  }
  toString(options = void 0) {
    return formatPlainDateIso(getPlainDateSlots(this), options);
  }
  toJSON() {
    return formatPlainDateIso(getPlainDateSlots(this));
  }
  valueOf() {
    return forbiddenValueOf2();
  }
}, getPlainDateSlots, dateFieldGetters$1, dateDerivedGetters);
function createPlainDate(slots) {
  return initPlainDate(Object.create(PlainDate.prototype), slots);
}
function getPlainDateSlots(obj) {
  return getPlainDateSlotsIfPresent(obj) || invalidRecordType();
}
function getPlainDateSlotsIfPresent(obj) {
  return plainDateSlotsMap.get(obj);
}
function toPlainDateSlots(arg, options) {
  if (isObjectLike2(arg)) {
    const ownSlots = getPlainDateSlotsIfPresent(arg);
    if (ownSlots) {
      return refineOverflowOptions(options), ownSlots;
    }
    const dateTimeSlots = getPlainDateTimeSlotsIfPresent(arg);
    if (dateTimeSlots) {
      return refineOverflowOptions(options), createDateSlots(dateTimeSlots, dateTimeSlots.calendar);
    }
    const zonedDateTimeSlots = getZonedDateTimeSlotsIfPresent(arg);
    if (zonedDateTimeSlots) {
      return refineOverflowOptions(options), zonedDateTimeToDate(zonedDateTimeSlots);
    }
    const calendar = getCalendarFromBag(arg);
    return refinePlainDateObjectLike(calendar, arg, options);
  }
  const res = parsePlainDate(arg, resolveBasicCalendarId);
  return refineOverflowOptions(options), res;
}
function initPlainDate(instance, slots) {
  return plainDateSlotsMap.set(instance, slots), attachDebugString(instance), instance;
}
function getCalendarFromBag(bag) {
  const calendar = extractCalendarFromBag(bag);
  return void 0 === calendar ? isoCalendarImpl : calendar;
}
function extractCalendarFromBag(bag) {
  const { calendar: calendarArg } = bag;
  if (void 0 !== calendarArg) {
    return refineCalendarArg(calendarArg);
  }
}
function refineCalendarArg(arg) {
  if (isObjectLike2(arg)) {
    const slots = getPlainDateSlotsIfPresent(arg) || getPlainDateTimeSlotsIfPresent(arg) || getZonedDateTimeSlotsIfPresent(arg) || getPlainMonthDaySlotsIfPresent(arg) || getPlainYearMonthSlotsIfPresent(arg);
    return slots || throwTypeError(invalidCalendar(arg)), slots.calendar;
  }
  return ((arg2) => resolveBasicCalendarId(parseCalendarId(requireString(arg2))))(arg);
}
var durationSlotsMap = /* @__PURE__ */ new WeakMap();
var Duration = /* @__PURE__ */ defineTemporalClass(DurationBranding, class {
  constructor(years = 0, months = 0, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0, microseconds = 0, nanoseconds = 0) {
    const fields = validateDurationFields(mapProps(toStrictInteger, {
      years,
      months,
      weeks,
      days,
      hours,
      minutes,
      seconds,
      milliseconds,
      microseconds,
      nanoseconds
    }));
    initDuration(this, createDurationSlots(fields));
  }
  static from(arg) {
    return createDuration(toDurationSlots(arg));
  }
  static compare(durationArg0, durationArg1, options = void 0) {
    return compareDurations(refinePublicRelativeTo, toDurationSlots(durationArg0), toDurationSlots(durationArg1), options);
  }
  get sign() {
    return getDurationSlots(this).sign;
  }
  get blank() {
    return !getDurationSlots(this).sign;
  }
  with(mod) {
    return createDuration(mergeDurationFields(getDurationSlots(this), mod));
  }
  negated() {
    return createDuration(negateDuration(getDurationSlots(this)));
  }
  abs() {
    return createDuration(absDuration(getDurationSlots(this)));
  }
  add(otherArg) {
    return createDuration(addDurationsWithoutRelativeTo(0, getDurationSlots(this), toDurationSlots(otherArg)));
  }
  subtract(otherArg) {
    return createDuration(addDurationsWithoutRelativeTo(1, getDurationSlots(this), toDurationSlots(otherArg)));
  }
  round(roundTo) {
    return createDuration(roundDuration(refinePublicRelativeTo, getDurationSlots(this), roundTo));
  }
  total(totalOf) {
    return totalDuration(refinePublicRelativeTo, getDurationSlots(this), totalOf);
  }
  toLocaleString(locales = void 0, options) {
    const slots = getDurationSlots(this);
    return Intl.DurationFormat ? new Intl.DurationFormat(locales, options).format(slots) : formatDurationIso(slots, options);
  }
  toString(options = void 0) {
    return formatDurationIso(getDurationSlots(this), options);
  }
  toJSON() {
    return formatDurationIso(getDurationSlots(this));
  }
  valueOf() {
    return forbiddenValueOf2();
  }
}, getDurationSlots, durationGetters);
function createDuration(slots) {
  return initDuration(Object.create(Duration.prototype), slots);
}
function getDurationSlots(obj) {
  return getDurationSlotsIfPresent(obj) || invalidRecordType();
}
function getDurationSlotsIfPresent(obj) {
  return durationSlotsMap.get(obj);
}
function toDurationSlots(arg) {
  if (isObjectLike2(arg)) {
    return getDurationSlotsIfPresent(arg) || refineDurationObjectLike(arg);
  }
  return parseDuration(arg);
}
function refinePublicRelativeTo(relativeTo) {
  if (void 0 !== relativeTo) {
    if (isObjectLike2(relativeTo)) {
      const zonedDateTimeSlots = getZonedDateTimeSlotsIfPresent(relativeTo);
      if (zonedDateTimeSlots) {
        return zonedDateTimeSlots;
      }
      const dateSlots = getPlainDateSlotsIfPresent(relativeTo);
      if (dateSlots) {
        return dateSlots;
      }
      const dateTimeSlots = getPlainDateTimeSlotsIfPresent(relativeTo);
      if (dateTimeSlots) {
        return createDateSlots(dateTimeSlots, dateTimeSlots.calendar);
      }
      const calendar = getCalendarFromBag(relativeTo);
      return refineMaybeZonedDateTimeObjectLike(refineTimeZoneArg, calendar, relativeTo);
    }
    return parseRelativeToSlots(relativeTo, resolveBasicCalendarId);
  }
}
function initDuration(instance, slots) {
  return durationSlotsMap.set(instance, slots), attachDebugString(instance), instance;
}
var Now = /* @__PURE__ */ Object.defineProperties({}, {
  ...createStringTagDescriptors("Temporal.Now"),
  ...createPropDescriptors({
    timeZoneId() {
      return getCurrentTimeZoneId();
    },
    instant() {
      return createInstant(createEpochNanoSlots(getCurrentEpochNano()));
    },
    zonedDateTimeISO(timeZoneArg = getCurrentTimeZoneId()) {
      const timeZone = queryTimeZone(refineTimeZoneArg(timeZoneArg));
      return createZonedDateTime(createZonedEpochNanoSlots(getCurrentEpochNano(), timeZone));
    },
    plainDateTimeISO(timeZoneArg = getCurrentTimeZoneId()) {
      const isoDateTime = getCurrentIsoDateTime(queryTimeZone(refineTimeZoneArg(timeZoneArg)));
      return createPlainDateTime(createDateTimeSlots(isoDateTime));
    },
    plainDateISO(timeZoneArg = getCurrentTimeZoneId()) {
      const isoDateTime = getCurrentIsoDateTime(queryTimeZone(refineTimeZoneArg(timeZoneArg)));
      return createPlainDate(createDateSlots(isoDateTime));
    },
    plainTimeISO(timeZoneArg = getCurrentTimeZoneId()) {
      const isoDateTime = getCurrentIsoDateTime(queryTimeZone(refineTimeZoneArg(timeZoneArg)));
      return createPlainTime(createTimeSlots(isoDateTime));
    }
  })
});
var Temporal = /* @__PURE__ */ Object.defineProperties({}, {
  ...createStringTagDescriptors("Temporal"),
  ...createPropDescriptors({
    PlainYearMonth,
    PlainMonthDay,
    PlainDate,
    PlainTime,
    PlainDateTime,
    ZonedDateTime,
    Instant,
    Duration,
    Now
  })
});

// node_modules/temporal-polyfill/index.js
var Temporal2 = NativeTemporal || Temporal;
var toTemporalInstant2 = NativeTemporal ? Date.prototype.toTemporalInstant : toTemporalInstant;

// node_modules/@lezer/common/dist/index.js
var DefaultBufferLength = 1024;
var nextPropID = 0;
var Range = class {
  constructor(from, to) {
    this.from = from;
    this.to = to;
  }
};
var NodeProp = class {
  /**
  Create a new node prop type.
  */
  constructor(config = {}) {
    this.id = nextPropID++;
    this.perNode = !!config.perNode;
    this.deserialize = config.deserialize || (() => {
      throw new Error("This node type doesn't define a deserialize function");
    });
    this.combine = config.combine || null;
  }
  /**
  This is meant to be used with
  [`NodeSet.extend`](#common.NodeSet.extend) or
  [`LRParser.configure`](#lr.ParserConfig.props) to compute
  prop values for each node type in the set. Takes a [match
  object](#common.NodeType^match) or function that returns undefined
  if the node type doesn't get this prop, and the prop's value if
  it does.
  */
  add(match) {
    if (this.perNode)
      throw new RangeError("Can't add per-node props to node types");
    if (typeof match != "function")
      match = NodeType.match(match);
    return (type) => {
      let result = match(type);
      return result === void 0 ? null : [this, result];
    };
  }
};
NodeProp.closedBy = new NodeProp({ deserialize: (str) => str.split(" ") });
NodeProp.openedBy = new NodeProp({ deserialize: (str) => str.split(" ") });
NodeProp.group = new NodeProp({ deserialize: (str) => str.split(" ") });
NodeProp.isolate = new NodeProp({ deserialize: (value) => {
  if (value && value != "rtl" && value != "ltr" && value != "auto")
    throw new RangeError("Invalid value for isolate: " + value);
  return value || "auto";
} });
NodeProp.contextHash = new NodeProp({ perNode: true });
NodeProp.lookAhead = new NodeProp({ perNode: true });
NodeProp.mounted = new NodeProp({ perNode: true });
var MountedTree = class {
  constructor(tree, overlay, parser2, bracketed = false) {
    this.tree = tree;
    this.overlay = overlay;
    this.parser = parser2;
    this.bracketed = bracketed;
  }
  /**
  @internal
  */
  static get(tree) {
    return tree && tree.props && tree.props[NodeProp.mounted.id];
  }
};
var noProps = /* @__PURE__ */ Object.create(null);
var NodeType = class _NodeType {
  /**
  @internal
  */
  constructor(name2, props, id2, flags = 0) {
    this.name = name2;
    this.props = props;
    this.id = id2;
    this.flags = flags;
  }
  /**
  Define a node type.
  */
  static define(spec) {
    let props = spec.props && spec.props.length ? /* @__PURE__ */ Object.create(null) : noProps;
    let flags = (spec.top ? 1 : 0) | (spec.skipped ? 2 : 0) | (spec.error ? 4 : 0) | (spec.name == null ? 8 : 0);
    let type = new _NodeType(spec.name || "", props, spec.id, flags);
    if (spec.props)
      for (let src of spec.props) {
        if (!Array.isArray(src))
          src = src(type);
        if (src) {
          if (src[0].perNode)
            throw new RangeError("Can't store a per-node prop on a node type");
          props[src[0].id] = src[1];
        }
      }
    return type;
  }
  /**
  Retrieves a node prop for this type. Will return `undefined` if
  the prop isn't present on this node.
  */
  prop(prop) {
    return this.props[prop.id];
  }
  /**
  True when this is the top node of a grammar.
  */
  get isTop() {
    return (this.flags & 1) > 0;
  }
  /**
  True when this node is produced by a skip rule.
  */
  get isSkipped() {
    return (this.flags & 2) > 0;
  }
  /**
  Indicates whether this is an error node.
  */
  get isError() {
    return (this.flags & 4) > 0;
  }
  /**
  When true, this node type doesn't correspond to a user-declared
  named node, for example because it is used to cache repetition.
  */
  get isAnonymous() {
    return (this.flags & 8) > 0;
  }
  /**
  Returns true when this node's name or one of its
  [groups](#common.NodeProp^group) matches the given string.
  */
  is(name2) {
    if (typeof name2 == "string") {
      if (this.name == name2)
        return true;
      let group = this.prop(NodeProp.group);
      return group ? group.indexOf(name2) > -1 : false;
    }
    return this.id == name2;
  }
  /**
  Create a function from node types to arbitrary values by
  specifying an object whose property names are node or
  [group](#common.NodeProp^group) names. Often useful with
  [`NodeProp.add`](#common.NodeProp.add). You can put multiple
  names, separated by spaces, in a single property name to map
  multiple node names to a single value.
  */
  static match(map) {
    let direct = /* @__PURE__ */ Object.create(null);
    for (let prop in map)
      for (let name2 of prop.split(" "))
        direct[name2] = map[prop];
    return (node) => {
      for (let groups = node.prop(NodeProp.group), i = -1; i < (groups ? groups.length : 0); i++) {
        let found = direct[i < 0 ? node.name : groups[i]];
        if (found)
          return found;
      }
    };
  }
};
NodeType.none = new NodeType(
  "",
  /* @__PURE__ */ Object.create(null),
  0,
  8
  /* NodeFlag.Anonymous */
);
var NodeSet = class _NodeSet {
  /**
  Create a set with the given types. The `id` property of each
  type should correspond to its position within the array.
  */
  constructor(types) {
    this.types = types;
    for (let i = 0; i < types.length; i++)
      if (types[i].id != i)
        throw new RangeError("Node type ids should correspond to array positions when creating a node set");
  }
  /**
  Create a copy of this set with some node properties added. The
  arguments to this method can be created with
  [`NodeProp.add`](#common.NodeProp.add).
  */
  extend(...props) {
    let newTypes = [];
    for (let type of this.types) {
      let newProps = null;
      for (let source of props) {
        let add = source(type);
        if (add) {
          if (!newProps)
            newProps = Object.assign({}, type.props);
          let value = add[1], prop = add[0];
          if (prop.combine && prop.id in newProps)
            value = prop.combine(newProps[prop.id], value);
          newProps[prop.id] = value;
        }
      }
      newTypes.push(newProps ? new NodeType(type.name, newProps, type.id, type.flags) : type);
    }
    return new _NodeSet(newTypes);
  }
};
var CachedNode = /* @__PURE__ */ new WeakMap();
var CachedInnerNode = /* @__PURE__ */ new WeakMap();
var IterMode;
(function(IterMode2) {
  IterMode2[IterMode2["ExcludeBuffers"] = 1] = "ExcludeBuffers";
  IterMode2[IterMode2["IncludeAnonymous"] = 2] = "IncludeAnonymous";
  IterMode2[IterMode2["IgnoreMounts"] = 4] = "IgnoreMounts";
  IterMode2[IterMode2["IgnoreOverlays"] = 8] = "IgnoreOverlays";
  IterMode2[IterMode2["EnterBracketed"] = 16] = "EnterBracketed";
})(IterMode || (IterMode = {}));
var Tree = class _Tree {
  /**
  Construct a new tree. See also [`Tree.build`](#common.Tree^build).
  */
  constructor(type, children, positions, length, props) {
    this.type = type;
    this.children = children;
    this.positions = positions;
    this.length = length;
    this.props = null;
    if (props && props.length) {
      this.props = /* @__PURE__ */ Object.create(null);
      for (let [prop, value] of props)
        this.props[typeof prop == "number" ? prop : prop.id] = value;
    }
  }
  /**
  @internal
  */
  toString() {
    let mounted = MountedTree.get(this);
    if (mounted && !mounted.overlay)
      return mounted.tree.toString();
    let children = "";
    for (let ch of this.children) {
      let str = ch.toString();
      if (str) {
        if (children)
          children += ",";
        children += str;
      }
    }
    return !this.type.name ? children : (/\W/.test(this.type.name) && !this.type.isError ? JSON.stringify(this.type.name) : this.type.name) + (children.length ? "(" + children + ")" : "");
  }
  /**
  Get a [tree cursor](#common.TreeCursor) positioned at the top of
  the tree. Mode can be used to [control](#common.IterMode) which
  nodes the cursor visits.
  */
  cursor(mode2 = 0) {
    return new TreeCursor(this.topNode, mode2);
  }
  /**
  Get a [tree cursor](#common.TreeCursor) pointing into this tree
  at the given position and side (see
  [`moveTo`](#common.TreeCursor.moveTo).
  */
  cursorAt(pos, side = 0, mode2 = 0) {
    let scope = CachedNode.get(this) || this.topNode;
    let cursor = new TreeCursor(scope);
    cursor.moveTo(pos, side);
    CachedNode.set(this, cursor._tree);
    return cursor;
  }
  /**
  Get a [syntax node](#common.SyntaxNode) object for the top of the
  tree.
  */
  get topNode() {
    return new TreeNode(this, 0, 0, null);
  }
  /**
  Get the [syntax node](#common.SyntaxNode) at the given position.
  If `side` is -1, this will move into nodes that end at the
  position. If 1, it'll move into nodes that start at the
  position. With 0, it'll only enter nodes that cover the position
  from both sides.
  
  Note that this will not enter
  [overlays](#common.MountedTree.overlay), and you often want
  [`resolveInner`](#common.Tree.resolveInner) instead.
  */
  resolve(pos, side = 0) {
    let node = resolveNode(CachedNode.get(this) || this.topNode, pos, side, false);
    CachedNode.set(this, node);
    return node;
  }
  /**
  Like [`resolve`](#common.Tree.resolve), but will enter
  [overlaid](#common.MountedTree.overlay) nodes, producing a syntax node
  pointing into the innermost overlaid tree at the given position
  (with parent links going through all parent structure, including
  the host trees).
  */
  resolveInner(pos, side = 0) {
    let node = resolveNode(CachedInnerNode.get(this) || this.topNode, pos, side, true);
    CachedInnerNode.set(this, node);
    return node;
  }
  /**
  In some situations, it can be useful to iterate through all
  nodes around a position, including those in overlays that don't
  directly cover the position. This method gives you an iterator
  that will produce all nodes, from small to big, around the given
  position.
  */
  resolveStack(pos, side = 0) {
    return stackIterator(this, pos, side);
  }
  /**
  Iterate over the tree and its children, calling `enter` for any
  node that touches the `from`/`to` region (if given) before
  running over such a node's children, and `leave` (if given) when
  leaving the node. When `enter` returns `false`, that node will
  not have its children iterated over (or `leave` called).
  */
  iterate(spec) {
    let { enter, leave, from = 0, to = this.length } = spec;
    let mode2 = spec.mode || 0, anon = (mode2 & IterMode.IncludeAnonymous) > 0;
    for (let c = this.cursor(mode2 | IterMode.IncludeAnonymous); ; ) {
      let entered = false;
      if (c.from <= to && c.to >= from && (!anon && c.type.isAnonymous || enter(c) !== false)) {
        if (c.firstChild())
          continue;
        entered = true;
      }
      for (; ; ) {
        if (entered && leave && (anon || !c.type.isAnonymous))
          leave(c);
        if (c.nextSibling())
          break;
        if (!c.parent())
          return;
        entered = true;
      }
    }
  }
  /**
  Get the value of the given [node prop](#common.NodeProp) for this
  node. Works with both per-node and per-type props.
  */
  prop(prop) {
    return !prop.perNode ? this.type.prop(prop) : this.props ? this.props[prop.id] : void 0;
  }
  /**
  Returns the node's [per-node props](#common.NodeProp.perNode) in a
  format that can be passed to the [`Tree`](#common.Tree)
  constructor.
  */
  get propValues() {
    let result = [];
    if (this.props)
      for (let id2 in this.props)
        result.push([+id2, this.props[id2]]);
    return result;
  }
  /**
  Balance the direct children of this tree, producing a copy of
  which may have children grouped into subtrees with type
  [`NodeType.none`](#common.NodeType^none).
  */
  balance(config = {}) {
    return this.children.length <= 8 ? this : balanceRange(NodeType.none, this.children, this.positions, 0, this.children.length, 0, this.length, (children, positions, length) => new _Tree(this.type, children, positions, length, this.propValues), config.makeTree || ((children, positions, length) => new _Tree(NodeType.none, children, positions, length)));
  }
  /**
  Build a tree from a postfix-ordered buffer of node information,
  or a cursor over such a buffer.
  */
  static build(data) {
    return buildTree(data);
  }
};
Tree.empty = new Tree(NodeType.none, [], [], 0);
var FlatBufferCursor = class _FlatBufferCursor {
  constructor(buffer, index) {
    this.buffer = buffer;
    this.index = index;
  }
  get id() {
    return this.buffer[this.index - 4];
  }
  get start() {
    return this.buffer[this.index - 3];
  }
  get end() {
    return this.buffer[this.index - 2];
  }
  get size() {
    return this.buffer[this.index - 1];
  }
  get pos() {
    return this.index;
  }
  next() {
    this.index -= 4;
  }
  fork() {
    return new _FlatBufferCursor(this.buffer, this.index);
  }
};
var TreeBuffer = class _TreeBuffer {
  /**
  Create a tree buffer.
  */
  constructor(buffer, length, set) {
    this.buffer = buffer;
    this.length = length;
    this.set = set;
  }
  /**
  @internal
  */
  get type() {
    return NodeType.none;
  }
  /**
  @internal
  */
  toString() {
    let result = [];
    for (let index = 0; index < this.buffer.length; ) {
      result.push(this.childString(index));
      index = this.buffer[index + 3];
    }
    return result.join(",");
  }
  /**
  @internal
  */
  childString(index) {
    let id2 = this.buffer[index], endIndex = this.buffer[index + 3];
    let type = this.set.types[id2], result = type.name;
    if (/\W/.test(result) && !type.isError)
      result = JSON.stringify(result);
    index += 4;
    if (endIndex == index)
      return result;
    let children = [];
    while (index < endIndex) {
      children.push(this.childString(index));
      index = this.buffer[index + 3];
    }
    return result + "(" + children.join(",") + ")";
  }
  /**
  @internal
  */
  findChild(startIndex, endIndex, dir, pos, side) {
    let { buffer } = this, pick = -1;
    for (let i = startIndex; i != endIndex; i = buffer[i + 3]) {
      if (checkSide(side, pos, buffer[i + 1], buffer[i + 2])) {
        pick = i;
        if (dir > 0)
          break;
      }
    }
    return pick;
  }
  /**
  @internal
  */
  slice(startI, endI, from) {
    let b = this.buffer;
    let copy = new Uint16Array(endI - startI), len = 0;
    for (let i = startI, j = 0; i < endI; ) {
      copy[j++] = b[i++];
      copy[j++] = b[i++] - from;
      let to = copy[j++] = b[i++] - from;
      copy[j++] = b[i++] - startI;
      len = Math.max(len, to);
    }
    return new _TreeBuffer(copy, len, this.set);
  }
};
function checkSide(side, pos, from, to) {
  switch (side) {
    case -2:
      return from < pos;
    case -1:
      return to >= pos && from < pos;
    case 0:
      return from < pos && to > pos;
    case 1:
      return from <= pos && to > pos;
    case 2:
      return to > pos;
    case 4:
      return true;
  }
}
function resolveNode(node, pos, side, overlays) {
  var _a;
  while (node.from == node.to || (side < 1 ? node.from >= pos : node.from > pos) || (side > -1 ? node.to <= pos : node.to < pos)) {
    let parent = !overlays && node instanceof TreeNode && node.index < 0 ? null : node.parent;
    if (!parent)
      return node;
    node = parent;
  }
  let mode2 = overlays ? 0 : IterMode.IgnoreOverlays;
  if (overlays)
    for (let scan = node, parent = scan.parent; parent; scan = parent, parent = scan.parent) {
      if (scan instanceof TreeNode && scan.index < 0 && ((_a = parent.enter(pos, side, mode2)) === null || _a === void 0 ? void 0 : _a.from) != scan.from)
        node = parent;
    }
  for (; ; ) {
    let inner = node.enter(pos, side, mode2);
    if (!inner)
      return node;
    node = inner;
  }
}
var BaseNode = class {
  cursor(mode2 = 0) {
    return new TreeCursor(this, mode2);
  }
  getChild(type, before2 = null, after = null) {
    let r = getChildren(this, type, before2, after);
    return r.length ? r[0] : null;
  }
  getChildren(type, before2 = null, after = null) {
    return getChildren(this, type, before2, after);
  }
  resolve(pos, side = 0) {
    return resolveNode(this, pos, side, false);
  }
  resolveInner(pos, side = 0) {
    return resolveNode(this, pos, side, true);
  }
  matchContext(context) {
    return matchNodeContext(this.parent, context);
  }
  enterUnfinishedNodesBefore(pos) {
    let scan = this.childBefore(pos), node = this;
    while (scan) {
      let last2 = scan.lastChild;
      if (!last2 || last2.to != scan.to)
        break;
      if (last2.type.isError && last2.from == last2.to) {
        node = scan;
        scan = last2.prevSibling;
      } else {
        scan = last2;
      }
    }
    return node;
  }
  get node() {
    return this;
  }
  get next() {
    return this.parent;
  }
};
var TreeNode = class _TreeNode extends BaseNode {
  constructor(_tree, from, index, _parent) {
    super();
    this._tree = _tree;
    this.from = from;
    this.index = index;
    this._parent = _parent;
  }
  get type() {
    return this._tree.type;
  }
  get name() {
    return this._tree.type.name;
  }
  get to() {
    return this.from + this._tree.length;
  }
  nextChild(i, dir, pos, side, mode2 = 0) {
    for (let parent = this; ; ) {
      for (let { children, positions } = parent._tree, e = dir > 0 ? children.length : -1; i != e; i += dir) {
        let next = children[i], start = positions[i] + parent.from, mounted;
        if (!(mode2 & IterMode.EnterBracketed && next instanceof Tree && (mounted = MountedTree.get(next)) && !mounted.overlay && mounted.bracketed && pos >= start && pos <= start + next.length) && !checkSide(side, pos, start, start + next.length))
          continue;
        if (next instanceof TreeBuffer) {
          if (mode2 & IterMode.ExcludeBuffers)
            continue;
          let index = next.findChild(0, next.buffer.length, dir, pos - start, side);
          if (index > -1)
            return new BufferNode(new BufferContext(parent, next, i, start), null, index);
        } else if (mode2 & IterMode.IncludeAnonymous || (!next.type.isAnonymous || hasChild(next))) {
          let mounted2;
          if (!(mode2 & IterMode.IgnoreMounts) && (mounted2 = MountedTree.get(next)) && !mounted2.overlay)
            return new _TreeNode(mounted2.tree, start, i, parent);
          let inner = new _TreeNode(next, start, i, parent);
          return mode2 & IterMode.IncludeAnonymous || !inner.type.isAnonymous ? inner : inner.nextChild(dir < 0 ? next.children.length - 1 : 0, dir, pos, side, mode2);
        }
      }
      if (mode2 & IterMode.IncludeAnonymous || !parent.type.isAnonymous)
        return null;
      if (parent.index >= 0)
        i = parent.index + dir;
      else
        i = dir < 0 ? -1 : parent._parent._tree.children.length;
      parent = parent._parent;
      if (!parent)
        return null;
    }
  }
  get firstChild() {
    return this.nextChild(
      0,
      1,
      0,
      4
      /* Side.DontCare */
    );
  }
  get lastChild() {
    return this.nextChild(
      this._tree.children.length - 1,
      -1,
      0,
      4
      /* Side.DontCare */
    );
  }
  childAfter(pos) {
    return this.nextChild(
      0,
      1,
      pos,
      2
      /* Side.After */
    );
  }
  childBefore(pos) {
    return this.nextChild(
      this._tree.children.length - 1,
      -1,
      pos,
      -2
      /* Side.Before */
    );
  }
  prop(prop) {
    return this._tree.prop(prop);
  }
  enter(pos, side, mode2 = 0) {
    let mounted;
    if (!(mode2 & IterMode.IgnoreOverlays) && (mounted = MountedTree.get(this._tree)) && mounted.overlay) {
      let rPos = pos - this.from, enterBracketed = mode2 & IterMode.EnterBracketed && mounted.bracketed;
      for (let { from, to } of mounted.overlay) {
        if ((side > 0 || enterBracketed ? from <= rPos : from < rPos) && (side < 0 || enterBracketed ? to >= rPos : to > rPos))
          return new _TreeNode(mounted.tree, mounted.overlay[0].from + this.from, -1, this);
      }
    }
    return this.nextChild(0, 1, pos, side, mode2);
  }
  nextSignificantParent() {
    let val = this;
    while (val.type.isAnonymous && val._parent)
      val = val._parent;
    return val;
  }
  get parent() {
    return this._parent ? this._parent.nextSignificantParent() : null;
  }
  get nextSibling() {
    return this._parent && this.index >= 0 ? this._parent.nextChild(
      this.index + 1,
      1,
      0,
      4
      /* Side.DontCare */
    ) : null;
  }
  get prevSibling() {
    return this._parent && this.index >= 0 ? this._parent.nextChild(
      this.index - 1,
      -1,
      0,
      4
      /* Side.DontCare */
    ) : null;
  }
  get tree() {
    return this._tree;
  }
  toTree() {
    return this._tree;
  }
  /**
  @internal
  */
  toString() {
    return this._tree.toString();
  }
};
function getChildren(node, type, before2, after) {
  let cur = node.cursor(), result = [];
  if (!cur.firstChild())
    return result;
  if (before2 != null)
    for (let found = false; !found; ) {
      found = cur.type.is(before2);
      if (!cur.nextSibling())
        return result;
    }
  for (; ; ) {
    if (after != null && cur.type.is(after))
      return result;
    if (cur.type.is(type))
      result.push(cur.node);
    if (!cur.nextSibling())
      return after == null ? result : [];
  }
}
function matchNodeContext(node, context, i = context.length - 1) {
  for (let p = node; i >= 0; p = p.parent) {
    if (!p)
      return false;
    if (!p.type.isAnonymous) {
      if (context[i] && context[i] != p.name)
        return false;
      i--;
    }
  }
  return true;
}
var BufferContext = class {
  constructor(parent, buffer, index, start) {
    this.parent = parent;
    this.buffer = buffer;
    this.index = index;
    this.start = start;
  }
};
var BufferNode = class _BufferNode extends BaseNode {
  get name() {
    return this.type.name;
  }
  get from() {
    return this.context.start + this.context.buffer.buffer[this.index + 1];
  }
  get to() {
    return this.context.start + this.context.buffer.buffer[this.index + 2];
  }
  constructor(context, _parent, index) {
    super();
    this.context = context;
    this._parent = _parent;
    this.index = index;
    this.type = context.buffer.set.types[context.buffer.buffer[index]];
  }
  child(dir, pos, side) {
    let { buffer } = this.context;
    let index = buffer.findChild(this.index + 4, buffer.buffer[this.index + 3], dir, pos - this.context.start, side);
    return index < 0 ? null : new _BufferNode(this.context, this, index);
  }
  get firstChild() {
    return this.child(
      1,
      0,
      4
      /* Side.DontCare */
    );
  }
  get lastChild() {
    return this.child(
      -1,
      0,
      4
      /* Side.DontCare */
    );
  }
  childAfter(pos) {
    return this.child(
      1,
      pos,
      2
      /* Side.After */
    );
  }
  childBefore(pos) {
    return this.child(
      -1,
      pos,
      -2
      /* Side.Before */
    );
  }
  prop(prop) {
    return this.type.prop(prop);
  }
  enter(pos, side, mode2 = 0) {
    if (mode2 & IterMode.ExcludeBuffers)
      return null;
    let { buffer } = this.context;
    let index = buffer.findChild(this.index + 4, buffer.buffer[this.index + 3], side > 0 ? 1 : -1, pos - this.context.start, side);
    return index < 0 ? null : new _BufferNode(this.context, this, index);
  }
  get parent() {
    return this._parent || this.context.parent.nextSignificantParent();
  }
  externalSibling(dir) {
    return this._parent ? null : this.context.parent.nextChild(
      this.context.index + dir,
      dir,
      0,
      4
      /* Side.DontCare */
    );
  }
  get nextSibling() {
    let { buffer } = this.context;
    let after = buffer.buffer[this.index + 3];
    if (after < (this._parent ? buffer.buffer[this._parent.index + 3] : buffer.buffer.length))
      return new _BufferNode(this.context, this._parent, after);
    return this.externalSibling(1);
  }
  get prevSibling() {
    let { buffer } = this.context;
    let parentStart = this._parent ? this._parent.index + 4 : 0;
    if (this.index == parentStart)
      return this.externalSibling(-1);
    return new _BufferNode(this.context, this._parent, buffer.findChild(
      parentStart,
      this.index,
      -1,
      0,
      4
      /* Side.DontCare */
    ));
  }
  get tree() {
    return null;
  }
  toTree() {
    let children = [], positions = [];
    let { buffer } = this.context;
    let startI = this.index + 4, endI = buffer.buffer[this.index + 3];
    if (endI > startI) {
      let from = buffer.buffer[this.index + 1];
      children.push(buffer.slice(startI, endI, from));
      positions.push(0);
    }
    return new Tree(this.type, children, positions, this.to - this.from);
  }
  /**
  @internal
  */
  toString() {
    return this.context.buffer.childString(this.index);
  }
};
function iterStack(heads) {
  if (!heads.length)
    return null;
  let pick = 0, picked = heads[0];
  for (let i = 1; i < heads.length; i++) {
    let node = heads[i];
    if (node.from > picked.from || node.to < picked.to) {
      picked = node;
      pick = i;
    }
  }
  let next = picked instanceof TreeNode && picked.index < 0 ? null : picked.parent;
  let newHeads = heads.slice();
  if (next)
    newHeads[pick] = next;
  else
    newHeads.splice(pick, 1);
  return new StackIterator(newHeads, picked);
}
var StackIterator = class {
  constructor(heads, node) {
    this.heads = heads;
    this.node = node;
  }
  get next() {
    return iterStack(this.heads);
  }
};
function stackIterator(tree, pos, side) {
  let inner = tree.resolveInner(pos, side), layers = null;
  for (let scan = inner instanceof TreeNode ? inner : inner.context.parent; scan; scan = scan.parent) {
    if (scan.index < 0) {
      let parent = scan.parent;
      (layers || (layers = [inner])).push(parent.resolve(pos, side));
      scan = parent;
    } else {
      let mount = MountedTree.get(scan.tree);
      if (mount && mount.overlay && mount.overlay[0].from <= pos && mount.overlay[mount.overlay.length - 1].to >= pos) {
        let root = new TreeNode(mount.tree, mount.overlay[0].from + scan.from, -1, scan);
        (layers || (layers = [inner])).push(resolveNode(root, pos, side, false));
      }
    }
  }
  return layers ? iterStack(layers) : inner;
}
var TreeCursor = class {
  /**
  Shorthand for `.type.name`.
  */
  get name() {
    return this.type.name;
  }
  /**
  @internal
  */
  constructor(node, mode2 = 0) {
    this.buffer = null;
    this.stack = [];
    this.index = 0;
    this.bufferNode = null;
    this.mode = mode2 & ~IterMode.EnterBracketed;
    if (node instanceof TreeNode) {
      this.yieldNode(node);
    } else {
      this._tree = node.context.parent;
      this.buffer = node.context;
      for (let n = node._parent; n; n = n._parent)
        this.stack.unshift(n.index);
      this.bufferNode = node;
      this.yieldBuf(node.index);
    }
  }
  yieldNode(node) {
    if (!node)
      return false;
    this._tree = node;
    this.type = node.type;
    this.from = node.from;
    this.to = node.to;
    return true;
  }
  yieldBuf(index, type) {
    this.index = index;
    let { start, buffer } = this.buffer;
    this.type = type || buffer.set.types[buffer.buffer[index]];
    this.from = start + buffer.buffer[index + 1];
    this.to = start + buffer.buffer[index + 2];
    return true;
  }
  /**
  @internal
  */
  yield(node) {
    if (!node)
      return false;
    if (node instanceof TreeNode) {
      this.buffer = null;
      return this.yieldNode(node);
    }
    this.buffer = node.context;
    return this.yieldBuf(node.index, node.type);
  }
  /**
  @internal
  */
  toString() {
    return this.buffer ? this.buffer.buffer.childString(this.index) : this._tree.toString();
  }
  /**
  @internal
  */
  enterChild(dir, pos, side) {
    if (!this.buffer)
      return this.yield(this._tree.nextChild(dir < 0 ? this._tree._tree.children.length - 1 : 0, dir, pos, side, this.mode));
    let { buffer } = this.buffer;
    let index = buffer.findChild(this.index + 4, buffer.buffer[this.index + 3], dir, pos - this.buffer.start, side);
    if (index < 0)
      return false;
    this.stack.push(this.index);
    return this.yieldBuf(index);
  }
  /**
  Move the cursor to this node's first child. When this returns
  false, the node has no child, and the cursor has not been moved.
  */
  firstChild() {
    return this.enterChild(
      1,
      0,
      4
      /* Side.DontCare */
    );
  }
  /**
  Move the cursor to this node's last child.
  */
  lastChild() {
    return this.enterChild(
      -1,
      0,
      4
      /* Side.DontCare */
    );
  }
  /**
  Move the cursor to the first child that ends after `pos`.
  */
  childAfter(pos) {
    return this.enterChild(
      1,
      pos,
      2
      /* Side.After */
    );
  }
  /**
  Move to the last child that starts before `pos`.
  */
  childBefore(pos) {
    return this.enterChild(
      -1,
      pos,
      -2
      /* Side.Before */
    );
  }
  /**
  Move the cursor to the child around `pos`. If side is -1 the
  child may end at that position, when 1 it may start there. This
  will also enter [overlaid](#common.MountedTree.overlay)
  [mounted](#common.NodeProp^mounted) trees unless `overlays` is
  set to false.
  */
  enter(pos, side, mode2 = this.mode) {
    if (!this.buffer)
      return this.yield(this._tree.enter(pos, side, mode2));
    return mode2 & IterMode.ExcludeBuffers ? false : this.enterChild(1, pos, side);
  }
  /**
  Move to the node's parent node, if this isn't the top node.
  */
  parent() {
    if (!this.buffer)
      return this.yieldNode(this.mode & IterMode.IncludeAnonymous ? this._tree._parent : this._tree.parent);
    if (this.stack.length)
      return this.yieldBuf(this.stack.pop());
    let parent = this.mode & IterMode.IncludeAnonymous ? this.buffer.parent : this.buffer.parent.nextSignificantParent();
    this.buffer = null;
    return this.yieldNode(parent);
  }
  /**
  @internal
  */
  sibling(dir) {
    if (!this.buffer)
      return !this._tree._parent ? false : this.yield(this._tree.index < 0 ? null : this._tree._parent.nextChild(this._tree.index + dir, dir, 0, 4, this.mode));
    let { buffer } = this.buffer, d = this.stack.length - 1;
    if (dir < 0) {
      let parentStart = d < 0 ? 0 : this.stack[d] + 4;
      if (this.index != parentStart)
        return this.yieldBuf(buffer.findChild(
          parentStart,
          this.index,
          -1,
          0,
          4
          /* Side.DontCare */
        ));
    } else {
      let after = buffer.buffer[this.index + 3];
      if (after < (d < 0 ? buffer.buffer.length : buffer.buffer[this.stack[d] + 3]))
        return this.yieldBuf(after);
    }
    return d < 0 ? this.yield(this.buffer.parent.nextChild(this.buffer.index + dir, dir, 0, 4, this.mode)) : false;
  }
  /**
  Move to this node's next sibling, if any.
  */
  nextSibling() {
    return this.sibling(1);
  }
  /**
  Move to this node's previous sibling, if any.
  */
  prevSibling() {
    return this.sibling(-1);
  }
  atLastNode(dir) {
    let index, parent, { buffer } = this;
    if (buffer) {
      if (dir > 0) {
        if (this.index < buffer.buffer.buffer.length)
          return false;
      } else {
        for (let i = 0; i < this.index; i++)
          if (buffer.buffer.buffer[i + 3] < this.index)
            return false;
      }
      ({ index, parent } = buffer);
    } else {
      ({ index, _parent: parent } = this._tree);
    }
    for (; parent; { index, _parent: parent } = parent) {
      if (index > -1)
        for (let i = index + dir, e = dir < 0 ? -1 : parent._tree.children.length; i != e; i += dir) {
          let child = parent._tree.children[i];
          if (this.mode & IterMode.IncludeAnonymous || child instanceof TreeBuffer || !child.type.isAnonymous || hasChild(child))
            return false;
        }
    }
    return true;
  }
  move(dir, enter) {
    if (enter && this.enterChild(
      dir,
      0,
      4
      /* Side.DontCare */
    ))
      return true;
    for (; ; ) {
      if (this.sibling(dir))
        return true;
      if (this.atLastNode(dir) || !this.parent())
        return false;
    }
  }
  /**
  Move to the next node in a
  [pre-order](https://en.wikipedia.org/wiki/Tree_traversal#Pre-order,_NLR)
  traversal, going from a node to its first child or, if the
  current node is empty or `enter` is false, its next sibling or
  the next sibling of the first parent node that has one.
  */
  next(enter = true) {
    return this.move(1, enter);
  }
  /**
  Move to the next node in a last-to-first pre-order traversal. A
  node is followed by its last child or, if it has none, its
  previous sibling or the previous sibling of the first parent
  node that has one.
  */
  prev(enter = true) {
    return this.move(-1, enter);
  }
  /**
  Move the cursor to the innermost node that covers `pos`. If
  `side` is -1, it will enter nodes that end at `pos`. If it is 1,
  it will enter nodes that start at `pos`.
  */
  moveTo(pos, side = 0) {
    while (this.from == this.to || (side < 1 ? this.from >= pos : this.from > pos) || (side > -1 ? this.to <= pos : this.to < pos))
      if (!this.parent())
        break;
    while (this.enterChild(1, pos, side)) {
    }
    return this;
  }
  /**
  Get a [syntax node](#common.SyntaxNode) at the cursor's current
  position.
  */
  get node() {
    if (!this.buffer)
      return this._tree;
    let cache = this.bufferNode, result = null, depth = 0;
    if (cache && cache.context == this.buffer) {
      scan: for (let index = this.index, d = this.stack.length; d >= 0; ) {
        for (let c = cache; c; c = c._parent)
          if (c.index == index) {
            if (index == this.index)
              return c;
            result = c;
            depth = d + 1;
            break scan;
          }
        index = this.stack[--d];
      }
    }
    for (let i = depth; i < this.stack.length; i++)
      result = new BufferNode(this.buffer, result, this.stack[i]);
    return this.bufferNode = new BufferNode(this.buffer, result, this.index);
  }
  /**
  Get the [tree](#common.Tree) that represents the current node, if
  any. Will return null when the node is in a [tree
  buffer](#common.TreeBuffer).
  */
  get tree() {
    return this.buffer ? null : this._tree._tree;
  }
  /**
  Iterate over the current node and all its descendants, calling
  `enter` when entering a node and `leave`, if given, when leaving
  one. When `enter` returns `false`, any children of that node are
  skipped, and `leave` isn't called for it.
  */
  iterate(enter, leave) {
    for (let depth = 0; ; ) {
      let mustLeave = false;
      if (this.type.isAnonymous || enter(this) !== false) {
        if (this.firstChild()) {
          depth++;
          continue;
        }
        if (!this.type.isAnonymous)
          mustLeave = true;
      }
      for (; ; ) {
        if (mustLeave && leave)
          leave(this);
        mustLeave = this.type.isAnonymous;
        if (!depth)
          return;
        if (this.nextSibling())
          break;
        this.parent();
        depth--;
        mustLeave = true;
      }
    }
  }
  /**
  Test whether the current node matches a given context—a sequence
  of direct parent node names. Empty strings in the context array
  are treated as wildcards.
  */
  matchContext(context) {
    if (!this.buffer)
      return matchNodeContext(this.node.parent, context);
    let { buffer } = this.buffer, { types } = buffer.set;
    for (let i = context.length - 1, d = this.stack.length - 1; i >= 0; d--) {
      if (d < 0)
        return matchNodeContext(this._tree, context, i);
      let type = types[buffer.buffer[this.stack[d]]];
      if (!type.isAnonymous) {
        if (context[i] && context[i] != type.name)
          return false;
        i--;
      }
    }
    return true;
  }
};
function hasChild(tree) {
  return tree.children.some((ch) => ch instanceof TreeBuffer || !ch.type.isAnonymous || hasChild(ch));
}
function buildTree(data) {
  var _a;
  let { buffer, nodeSet, maxBufferLength = DefaultBufferLength, reused = [], minRepeatType = nodeSet.types.length } = data;
  let cursor = Array.isArray(buffer) ? new FlatBufferCursor(buffer, buffer.length) : buffer;
  let types = nodeSet.types;
  let contextHash = 0, lookAhead = 0;
  function takeNode(parentStart, minPos, children2, positions2, inRepeat, depth) {
    let { id: id2, start, end, size } = cursor;
    let lookAheadAtStart = lookAhead, contextAtStart = contextHash;
    if (size < 0) {
      cursor.next();
      if (size == -1) {
        let node2 = reused[id2];
        children2.push(node2);
        positions2.push(start - parentStart);
        return;
      } else if (size == -3) {
        contextHash = id2;
        return;
      } else if (size == -4) {
        lookAhead = id2;
        return;
      } else {
        throw new RangeError(`Unrecognized record size: ${size}`);
      }
    }
    let type = types[id2], node, buffer2;
    let startPos = start - parentStart;
    if (end - start <= maxBufferLength && (buffer2 = findBufferSize(cursor.pos - minPos, inRepeat))) {
      let data2 = new Uint16Array(buffer2.size - buffer2.skip);
      let endPos = cursor.pos - buffer2.size, index = data2.length;
      while (cursor.pos > endPos)
        index = copyToBuffer(buffer2.start, data2, index);
      node = new TreeBuffer(data2, end - buffer2.start, nodeSet);
      startPos = buffer2.start - parentStart;
    } else {
      let endPos = cursor.pos - size;
      cursor.next();
      let localChildren = [], localPositions = [];
      let localInRepeat = id2 >= minRepeatType ? id2 : -1;
      let lastGroup = 0, lastEnd = end, groupLookAhead = lookAheadAtStart;
      while (cursor.pos > endPos) {
        if (localInRepeat >= 0 && cursor.id == localInRepeat && cursor.size >= 0) {
          if (cursor.end <= lastEnd - maxBufferLength) {
            makeRepeatLeaf(localChildren, localPositions, start, lastGroup, cursor.end, lastEnd, localInRepeat, groupLookAhead, contextAtStart);
            lastGroup = localChildren.length;
            lastEnd = cursor.end;
            groupLookAhead = lookAhead;
          }
          cursor.next();
        } else if (depth > 2500) {
          takeFlatNode(start, endPos, localChildren, localPositions);
        } else {
          if (localInRepeat >= 0 && cursor.size == -1 && reused[cursor.id].type == nodeSet.types[localInRepeat]) {
            if (lastGroup < localChildren.length)
              makeRepeatLeaf(localChildren, localPositions, start, lastGroup, cursor.end, lastEnd, localInRepeat, groupLookAhead, contextAtStart);
            lastGroup = localChildren.length + 1;
            lastEnd = cursor.start;
            groupLookAhead = lookAhead;
          }
          takeNode(start, endPos, localChildren, localPositions, localInRepeat, depth + 1);
        }
      }
      if (localInRepeat >= 0 && lastGroup > 0 && lastGroup < localChildren.length)
        makeRepeatLeaf(localChildren, localPositions, start, lastGroup, start, lastEnd, localInRepeat, groupLookAhead, contextAtStart);
      localChildren.reverse();
      localPositions.reverse();
      if (localInRepeat > -1 && lastGroup > 0) {
        let make = makeBalanced(type, contextAtStart);
        node = balanceRange(type, localChildren, localPositions, 0, localChildren.length, 0, end - start, make, make);
      } else {
        node = makeTree(type, localChildren, localPositions, end - start, lookAheadAtStart - end, contextAtStart);
      }
    }
    children2.push(node);
    positions2.push(startPos);
  }
  function takeFlatNode(parentStart, minPos, children2, positions2) {
    let nodes = [];
    let nodeCount = 0, stopAt = -1;
    while (cursor.pos > minPos) {
      let { id: id2, start, end, size } = cursor;
      if (size > 4) {
        cursor.next();
      } else if (stopAt > -1 && start < stopAt) {
        break;
      } else {
        if (stopAt < 0)
          stopAt = end - maxBufferLength;
        nodes.push(id2, start, end);
        nodeCount++;
        cursor.next();
      }
    }
    if (nodeCount) {
      let buffer2 = new Uint16Array(nodeCount * 4);
      let start = nodes[nodes.length - 2];
      for (let i = nodes.length - 3, j = 0; i >= 0; i -= 3) {
        buffer2[j++] = nodes[i];
        buffer2[j++] = nodes[i + 1] - start;
        buffer2[j++] = nodes[i + 2] - start;
        buffer2[j++] = j;
      }
      children2.push(new TreeBuffer(buffer2, nodes[2] - start, nodeSet));
      positions2.push(start - parentStart);
    }
  }
  function makeBalanced(type, contextHash2) {
    return (children2, positions2, length2) => {
      let lookAhead2 = 0, lastI = children2.length - 1, last2, lookAheadProp;
      if (lastI >= 0 && (last2 = children2[lastI]) instanceof Tree) {
        if (!lastI && last2.type == type && last2.length == length2)
          return last2;
        if (lookAheadProp = last2.prop(NodeProp.lookAhead))
          lookAhead2 = positions2[lastI] + last2.length + lookAheadProp - length2;
      }
      return makeTree(type, children2, positions2, length2, lookAhead2, contextHash2);
    };
  }
  function makeRepeatLeaf(children2, positions2, base, i, from, to, type, lookAhead2, contextHash2) {
    let localChildren = [], localPositions = [];
    while (children2.length > i) {
      localChildren.push(children2.pop());
      localPositions.push(positions2.pop() + base - from);
    }
    children2.push(makeTree(nodeSet.types[type], localChildren, localPositions, to - from, lookAhead2 - to, contextHash2));
    positions2.push(from - base);
  }
  function makeTree(type, children2, positions2, length2, lookAhead2, contextHash2, props) {
    if (contextHash2) {
      let pair2 = [NodeProp.contextHash, contextHash2];
      props = props ? [pair2].concat(props) : [pair2];
    }
    if (lookAhead2 > 25) {
      let pair2 = [NodeProp.lookAhead, lookAhead2];
      props = props ? [pair2].concat(props) : [pair2];
    }
    return new Tree(type, children2, positions2, length2, props);
  }
  function findBufferSize(maxSize, inRepeat) {
    let fork = cursor.fork();
    let size = 0, start = 0, skip = 0, minStart = fork.end - maxBufferLength;
    let result = { size: 0, start: 0, skip: 0 };
    scan: for (let minPos = fork.pos - maxSize; fork.pos > minPos; ) {
      let nodeSize2 = fork.size;
      if (fork.id == inRepeat && nodeSize2 >= 0) {
        result.size = size;
        result.start = start;
        result.skip = skip;
        skip += 4;
        size += 4;
        fork.next();
        continue;
      }
      let startPos = fork.pos - nodeSize2;
      if (nodeSize2 < 0 || startPos < minPos || fork.start < minStart)
        break;
      let localSkipped = fork.id >= minRepeatType ? 4 : 0;
      let nodeStart = fork.start;
      fork.next();
      while (fork.pos > startPos) {
        if (fork.size < 0) {
          if (fork.size == -3 || fork.size == -4)
            localSkipped += 4;
          else
            break scan;
        } else if (fork.id >= minRepeatType) {
          localSkipped += 4;
        }
        fork.next();
      }
      start = nodeStart;
      size += nodeSize2;
      skip += localSkipped;
    }
    if (inRepeat < 0 || size == maxSize) {
      result.size = size;
      result.start = start;
      result.skip = skip;
    }
    return result.size > 4 ? result : void 0;
  }
  function copyToBuffer(bufferStart, buffer2, index) {
    let { id: id2, start, end, size } = cursor;
    cursor.next();
    if (size >= 0 && id2 < minRepeatType) {
      let startIndex = index;
      if (size > 4) {
        let endPos = cursor.pos - (size - 4);
        while (cursor.pos > endPos)
          index = copyToBuffer(bufferStart, buffer2, index);
      }
      buffer2[--index] = startIndex;
      buffer2[--index] = end - bufferStart;
      buffer2[--index] = start - bufferStart;
      buffer2[--index] = id2;
    } else if (size == -3) {
      contextHash = id2;
    } else if (size == -4) {
      lookAhead = id2;
    }
    return index;
  }
  let children = [], positions = [];
  while (cursor.pos > 0)
    takeNode(data.start || 0, data.bufferStart || 0, children, positions, -1, 0);
  let length = (_a = data.length) !== null && _a !== void 0 ? _a : children.length ? positions[0] + children[0].length : 0;
  return new Tree(types[data.topID], children.reverse(), positions.reverse(), length);
}
var nodeSizeCache = /* @__PURE__ */ new WeakMap();
function nodeSize(balanceType, node) {
  if (!balanceType.isAnonymous || node instanceof TreeBuffer || node.type != balanceType)
    return 1;
  let size = nodeSizeCache.get(node);
  if (size == null) {
    size = 1;
    for (let child of node.children) {
      if (child.type != balanceType || !(child instanceof Tree)) {
        size = 1;
        break;
      }
      size += nodeSize(balanceType, child);
    }
    nodeSizeCache.set(node, size);
  }
  return size;
}
function balanceRange(balanceType, children, positions, from, to, start, length, mkTop, mkTree) {
  let total = 0;
  for (let i = from; i < to; i++)
    total += nodeSize(balanceType, children[i]);
  let maxChild = Math.ceil(
    total * 1.5 / 8
    /* Balance.BranchFactor */
  );
  let localChildren = [], localPositions = [];
  function divide(children2, positions2, from2, to2, offset) {
    for (let i = from2; i < to2; ) {
      let groupFrom = i, groupStart = positions2[i], groupSize = nodeSize(balanceType, children2[i]);
      i++;
      for (; i < to2; i++) {
        let nextSize = nodeSize(balanceType, children2[i]);
        if (groupSize + nextSize >= maxChild)
          break;
        groupSize += nextSize;
      }
      if (i == groupFrom + 1) {
        if (groupSize > maxChild) {
          let only = children2[groupFrom];
          divide(only.children, only.positions, 0, only.children.length, positions2[groupFrom] + offset);
          continue;
        }
        localChildren.push(children2[groupFrom]);
      } else {
        let length2 = positions2[i - 1] + children2[i - 1].length - groupStart;
        localChildren.push(balanceRange(balanceType, children2, positions2, groupFrom, i, groupStart, length2, null, mkTree));
      }
      localPositions.push(groupStart + offset - start);
    }
  }
  divide(children, positions, from, to, 0);
  return (mkTop || mkTree)(localChildren, localPositions, length);
}
var Parser = class {
  /**
  Start a parse, returning a [partial parse](#common.PartialParse)
  object. [`fragments`](#common.TreeFragment) can be passed in to
  make the parse incremental.
  
  By default, the entire input is parsed. You can pass `ranges`,
  which should be a sorted array of non-empty, non-overlapping
  ranges, to parse only those ranges. The tree returned in that
  case will start at `ranges[0].from`.
  */
  startParse(input, fragments, ranges) {
    if (typeof input == "string")
      input = new StringInput(input);
    ranges = !ranges ? [new Range(0, input.length)] : ranges.length ? ranges.map((r) => new Range(r.from, r.to)) : [new Range(0, 0)];
    return this.createParse(input, fragments || [], ranges);
  }
  /**
  Run a full parse, returning the resulting tree.
  */
  parse(input, fragments, ranges) {
    let parse = this.startParse(input, fragments, ranges);
    for (; ; ) {
      let done = parse.advance();
      if (done)
        return done;
    }
  }
};
var StringInput = class {
  constructor(string2) {
    this.string = string2;
  }
  get length() {
    return this.string.length;
  }
  chunk(from) {
    return this.string.slice(from);
  }
  get lineChunks() {
    return false;
  }
  read(from, to) {
    return this.string.slice(from, to);
  }
};
var stoppedInner = new NodeProp({ perNode: true });

// node_modules/@lezer/lr/dist/index.js
var Stack = class _Stack {
  /**
  @internal
  */
  constructor(p, stack, state, reducePos, pos, score, buffer, bufferBase, curContext, lookAhead = 0, parent) {
    this.p = p;
    this.stack = stack;
    this.state = state;
    this.reducePos = reducePos;
    this.pos = pos;
    this.score = score;
    this.buffer = buffer;
    this.bufferBase = bufferBase;
    this.curContext = curContext;
    this.lookAhead = lookAhead;
    this.parent = parent;
  }
  /**
  @internal
  */
  toString() {
    return `[${this.stack.filter((_, i) => i % 3 == 0).concat(this.state)}]@${this.pos}${this.score ? "!" + this.score : ""}`;
  }
  // Start an empty stack
  /**
  @internal
  */
  static start(p, state, pos = 0) {
    let cx = p.parser.context;
    return new _Stack(p, [], state, pos, pos, 0, [], 0, cx ? new StackContext(cx, cx.start) : null, 0, null);
  }
  /**
  The stack's current [context](#lr.ContextTracker) value, if
  any. Its type will depend on the context tracker's type
  parameter, or it will be `null` if there is no context
  tracker.
  */
  get context() {
    return this.curContext ? this.curContext.context : null;
  }
  // Push a state onto the stack, tracking its start position as well
  // as the buffer base at that point.
  /**
  @internal
  */
  pushState(state, start) {
    this.stack.push(this.state, start, this.bufferBase + this.buffer.length);
    this.state = state;
  }
  // Apply a reduce action
  /**
  @internal
  */
  reduce(action) {
    var _a;
    let depth = action >> 19, type = action & 65535;
    let { parser: parser2 } = this.p;
    let lookaheadRecord = this.reducePos < this.pos - 25 && this.setLookAhead(this.pos);
    let dPrec = parser2.dynamicPrecedence(type);
    if (dPrec)
      this.score += dPrec;
    if (depth == 0) {
      if (type < parser2.minRepeatTerm && this.reducePos < this.pos)
        this.reducePos = this.pos;
      this.pushState(parser2.getGoto(this.state, type, true), this.reducePos);
      if (type < parser2.minRepeatTerm)
        this.storeNode(type, this.reducePos, this.reducePos, lookaheadRecord ? 8 : 4, true);
      this.reduceContext(type, this.reducePos);
      return;
    }
    let base = this.stack.length - (depth - 1) * 3 - (action & 262144 ? 6 : 0);
    let start = base ? this.stack[base - 2] : this.p.ranges[0].from;
    if (type < parser2.minRepeatTerm && start == this.reducePos && this.reducePos < this.pos)
      this.reducePos = this.pos;
    let size = this.reducePos - start;
    if (size >= 2e3 && !((_a = this.p.parser.nodeSet.types[type]) === null || _a === void 0 ? void 0 : _a.isAnonymous)) {
      if (start == this.p.lastBigReductionStart) {
        this.p.bigReductionCount++;
        this.p.lastBigReductionSize = size;
      } else if (this.p.lastBigReductionSize < size) {
        this.p.bigReductionCount = 1;
        this.p.lastBigReductionStart = start;
        this.p.lastBigReductionSize = size;
      }
    }
    let bufferBase = base ? this.stack[base - 1] : 0, count = this.bufferBase + this.buffer.length - bufferBase;
    if (type < parser2.minRepeatTerm || action & 131072) {
      let pos = parser2.stateFlag(
        this.state,
        1
        /* StateFlag.Skipped */
      ) ? this.pos : this.reducePos;
      this.storeNode(type, start, pos, count + 4, true);
    }
    if (action & 262144) {
      this.state = this.stack[base];
    } else {
      let baseStateID = this.stack[base - 3];
      this.state = parser2.getGoto(baseStateID, type, true);
    }
    while (this.stack.length > base)
      this.stack.pop();
    this.reduceContext(type, start);
  }
  // Shift a value into the buffer
  /**
  @internal
  */
  storeNode(term, start, end, size = 4, mustSink = false) {
    if (term == 0 && (!this.stack.length || this.stack[this.stack.length - 1] < this.buffer.length + this.bufferBase)) {
      let top = this.buffer.length;
      if (top > 0 && this.buffer[top - 4] == 0 && this.buffer[top - 1] > -1) {
        if (start == end)
          return;
        if (this.buffer[top - 2] >= start) {
          this.buffer[top - 2] = end;
          return;
        }
      }
    }
    if (!mustSink || this.pos == end) {
      this.buffer.push(term, start, end, size);
    } else {
      let index = this.buffer.length;
      if (index > 0 && (this.buffer[index - 4] != 0 || this.buffer[index - 1] < 0)) {
        let mustMove = false;
        for (let scan = index; scan > 0 && this.buffer[scan - 2] > end; scan -= 4) {
          if (this.buffer[scan - 1] >= 0) {
            mustMove = true;
            break;
          }
        }
        if (mustMove)
          while (index > 0 && this.buffer[index - 2] > end) {
            this.buffer[index] = this.buffer[index - 4];
            this.buffer[index + 1] = this.buffer[index - 3];
            this.buffer[index + 2] = this.buffer[index - 2];
            this.buffer[index + 3] = this.buffer[index - 1];
            index -= 4;
            if (size > 4)
              size -= 4;
          }
      }
      this.buffer[index] = term;
      this.buffer[index + 1] = start;
      this.buffer[index + 2] = end;
      this.buffer[index + 3] = size;
    }
  }
  // Apply a shift action
  /**
  @internal
  */
  shift(action, type, start, end) {
    if (action & 131072) {
      this.pushState(action & 65535, this.pos);
    } else if ((action & 262144) == 0) {
      let nextState = action, { parser: parser2 } = this.p;
      this.pos = end;
      let skipped = parser2.stateFlag(
        nextState,
        1
        /* StateFlag.Skipped */
      );
      if (!skipped && (end > start || type <= parser2.maxNode))
        this.reducePos = end;
      this.pushState(nextState, skipped ? start : Math.min(start, this.reducePos));
      this.shiftContext(type, start);
      if (type <= parser2.maxNode)
        this.buffer.push(type, start, end, 4);
    } else {
      this.pos = end;
      this.shiftContext(type, start);
      if (type <= this.p.parser.maxNode)
        this.buffer.push(type, start, end, 4);
    }
  }
  // Apply an action
  /**
  @internal
  */
  apply(action, next, nextStart, nextEnd) {
    if (action & 65536)
      this.reduce(action);
    else
      this.shift(action, next, nextStart, nextEnd);
  }
  // Add a prebuilt (reused) node into the buffer.
  /**
  @internal
  */
  useNode(value, next, start) {
    let index = this.p.reused.length - 1;
    if (index < 0 || this.p.reused[index] != value) {
      this.p.reused.push(value);
      index++;
    }
    let end = this.reducePos = this.pos = start + value.length;
    this.pushState(next, start);
    this.buffer.push(
      index,
      start,
      end,
      -1
      /* size == -1 means this is a reused value */
    );
    if (this.curContext)
      this.updateContext(this.curContext.tracker.reuse(this.curContext.context, value, this, this.p.stream.reset(this.pos - value.length)));
  }
  // Split the stack. Due to the buffer sharing and the fact
  // that `this.stack` tends to stay quite shallow, this isn't very
  // expensive.
  /**
  @internal
  */
  split() {
    let parent = this;
    let off = parent.buffer.length;
    if (off && parent.buffer[off - 4] == 0)
      off -= 4;
    while (off > 0 && parent.buffer[off - 2] > parent.reducePos)
      off -= 4;
    let buffer = parent.buffer.slice(off), base = parent.bufferBase + off;
    while (parent && base == parent.bufferBase)
      parent = parent.parent;
    return new _Stack(this.p, this.stack.slice(), this.state, this.reducePos, this.pos, this.score, buffer, base, this.curContext, this.lookAhead, parent);
  }
  // Try to recover from an error by 'deleting' (ignoring) one token.
  /**
  @internal
  */
  recoverByDelete(next, nextEnd) {
    let isNode = next <= this.p.parser.maxNode;
    if (isNode)
      this.storeNode(next, this.pos, nextEnd, 4);
    this.storeNode(0, this.pos, nextEnd, isNode ? 8 : 4);
    this.pos = this.reducePos = nextEnd;
    this.score -= 190;
  }
  /**
  Check if the given term would be able to be shifted (optionally
  after some reductions) on this stack. This can be useful for
  external tokenizers that want to make sure they only provide a
  given token when it applies.
  */
  canShift(term) {
    for (let sim = new SimulatedStack(this); ; ) {
      let action = this.p.parser.stateSlot(
        sim.state,
        4
        /* ParseState.DefaultReduce */
      ) || this.p.parser.hasAction(sim.state, term);
      if (action == 0)
        return false;
      if ((action & 65536) == 0)
        return true;
      sim.reduce(action);
    }
  }
  // Apply up to Recover.MaxNext recovery actions that conceptually
  // inserts some missing token or rule.
  /**
  @internal
  */
  recoverByInsert(next) {
    if (this.stack.length >= 300)
      return [];
    let nextStates = this.p.parser.nextStates(this.state);
    if (nextStates.length > 4 << 1 || this.stack.length >= 120) {
      let best = [];
      for (let i = 0, s; i < nextStates.length; i += 2) {
        if ((s = nextStates[i + 1]) != this.state && this.p.parser.hasAction(s, next))
          best.push(nextStates[i], s);
      }
      if (this.stack.length < 120)
        for (let i = 0; best.length < 4 << 1 && i < nextStates.length; i += 2) {
          let s = nextStates[i + 1];
          if (!best.some((v, i2) => i2 & 1 && v == s))
            best.push(nextStates[i], s);
        }
      nextStates = best;
    }
    let result = [];
    for (let i = 0; i < nextStates.length && result.length < 4; i += 2) {
      let s = nextStates[i + 1];
      if (s == this.state)
        continue;
      let stack = this.split();
      stack.pushState(s, this.pos);
      stack.storeNode(0, stack.pos, stack.pos, 4, true);
      stack.shiftContext(nextStates[i], this.pos);
      stack.reducePos = this.pos;
      stack.score -= 200;
      result.push(stack);
    }
    return result;
  }
  // Force a reduce, if possible. Return false if that can't
  // be done.
  /**
  @internal
  */
  forceReduce() {
    let { parser: parser2 } = this.p;
    let reduce = parser2.stateSlot(
      this.state,
      5
      /* ParseState.ForcedReduce */
    );
    if ((reduce & 65536) == 0)
      return false;
    if (!parser2.validAction(this.state, reduce)) {
      let depth = reduce >> 19, term = reduce & 65535;
      let target = this.stack.length - depth * 3;
      if (target < 0 || parser2.getGoto(this.stack[target], term, false) < 0) {
        let backup = this.findForcedReduction();
        if (backup == null)
          return false;
        reduce = backup;
      }
      this.storeNode(0, this.pos, this.pos, 4, true);
      this.score -= 100;
    }
    this.reducePos = this.pos;
    this.reduce(reduce);
    return true;
  }
  /**
  Try to scan through the automaton to find some kind of reduction
  that can be applied. Used when the regular ForcedReduce field
  isn't a valid action. @internal
  */
  findForcedReduction() {
    let { parser: parser2 } = this.p, seen = [];
    let explore = (state, depth) => {
      if (seen.includes(state))
        return;
      seen.push(state);
      return parser2.allActions(state, (action) => {
        if (action & (262144 | 131072)) ;
        else if (action & 65536) {
          let rDepth = (action >> 19) - depth;
          if (rDepth > 1) {
            let term = action & 65535, target = this.stack.length - rDepth * 3;
            if (target >= 0 && parser2.getGoto(this.stack[target], term, false) >= 0)
              return rDepth << 19 | 65536 | term;
          }
        } else {
          let found = explore(action, depth + 1);
          if (found != null)
            return found;
        }
      });
    };
    return explore(this.state, 0);
  }
  /**
  @internal
  */
  forceAll() {
    while (!this.p.parser.stateFlag(
      this.state,
      2
      /* StateFlag.Accepting */
    )) {
      if (!this.forceReduce()) {
        this.storeNode(0, this.pos, this.pos, 4, true);
        break;
      }
    }
    return this;
  }
  /**
  Check whether this state has no further actions (assumed to be a direct descendant of the
  top state, since any other states must be able to continue
  somehow). @internal
  */
  get deadEnd() {
    if (this.stack.length != 3)
      return false;
    let { parser: parser2 } = this.p;
    return parser2.data[parser2.stateSlot(
      this.state,
      1
      /* ParseState.Actions */
    )] == 65535 && !parser2.stateSlot(
      this.state,
      4
      /* ParseState.DefaultReduce */
    );
  }
  /**
  Restart the stack (put it back in its start state). Only safe
  when this.stack.length == 3 (state is directly below the top
  state). @internal
  */
  restart() {
    this.storeNode(0, this.pos, this.pos, 4, true);
    this.state = this.stack[0];
    this.stack.length = 0;
  }
  /**
  @internal
  */
  sameState(other) {
    if (this.state != other.state || this.stack.length != other.stack.length)
      return false;
    for (let i = 0; i < this.stack.length; i += 3)
      if (this.stack[i] != other.stack[i])
        return false;
    return true;
  }
  /**
  Get the parser used by this stack.
  */
  get parser() {
    return this.p.parser;
  }
  /**
  Test whether a given dialect (by numeric ID, as exported from
  the terms file) is enabled.
  */
  dialectEnabled(dialectID) {
    return this.p.parser.dialect.flags[dialectID];
  }
  shiftContext(term, start) {
    if (this.curContext)
      this.updateContext(this.curContext.tracker.shift(this.curContext.context, term, this, this.p.stream.reset(start)));
  }
  reduceContext(term, start) {
    if (this.curContext)
      this.updateContext(this.curContext.tracker.reduce(this.curContext.context, term, this, this.p.stream.reset(start)));
  }
  /**
  @internal
  */
  emitContext() {
    let last2 = this.buffer.length - 1;
    if (last2 < 0 || this.buffer[last2] != -3)
      this.storeNode(this.curContext.hash, this.reducePos, this.reducePos, -3, true);
  }
  /**
  @internal
  */
  emitLookAhead() {
    let last2 = this.buffer.length - 1;
    if (last2 < 0 || this.buffer[last2] != -4)
      this.buffer.push(this.lookAhead, this.pos, this.pos, -4);
  }
  updateContext(context) {
    if (context != this.curContext.context) {
      let newCx = new StackContext(this.curContext.tracker, context);
      if (newCx.hash != this.curContext.hash)
        this.emitContext();
      this.curContext = newCx;
    }
  }
  /**
  @internal
  */
  setLookAhead(lookAhead) {
    if (lookAhead <= this.lookAhead)
      return false;
    this.emitLookAhead();
    this.lookAhead = lookAhead;
    return true;
  }
  /**
  @internal
  */
  close() {
    if (this.curContext && this.curContext.tracker.strict)
      this.emitContext();
    if (this.lookAhead > 0)
      this.emitLookAhead();
  }
};
var StackContext = class {
  constructor(tracker, context) {
    this.tracker = tracker;
    this.context = context;
    this.hash = tracker.strict ? tracker.hash(context) : 0;
  }
};
var SimulatedStack = class {
  constructor(start) {
    this.start = start;
    this.state = start.state;
    this.stack = start.stack;
    this.base = this.stack.length;
  }
  reduce(action) {
    let term = action & 65535, depth = action >> 19;
    if (depth == 0) {
      if (this.stack == this.start.stack)
        this.stack = this.stack.slice();
      this.stack.push(this.state, 0, 0);
      this.base += 3;
    } else {
      this.base -= (depth - 1) * 3;
    }
    let goto = this.start.p.parser.getGoto(this.stack[this.base - 3], term, true);
    this.state = goto;
  }
};
var StackBufferCursor = class _StackBufferCursor {
  constructor(stack, pos, index) {
    this.stack = stack;
    this.pos = pos;
    this.index = index;
    this.buffer = stack.buffer;
    if (this.index == 0)
      this.maybeNext();
  }
  static create(stack, pos = stack.bufferBase + stack.buffer.length) {
    return new _StackBufferCursor(stack, pos, pos - stack.bufferBase);
  }
  maybeNext() {
    let next = this.stack.parent;
    if (next != null) {
      this.index = this.stack.bufferBase - next.bufferBase;
      this.stack = next;
      this.buffer = next.buffer;
    }
  }
  get id() {
    return this.buffer[this.index - 4];
  }
  get start() {
    return this.buffer[this.index - 3];
  }
  get end() {
    return this.buffer[this.index - 2];
  }
  get size() {
    return this.buffer[this.index - 1];
  }
  next() {
    this.index -= 4;
    this.pos -= 4;
    if (this.index == 0)
      this.maybeNext();
  }
  fork() {
    return new _StackBufferCursor(this.stack, this.pos, this.index);
  }
};
function decodeArray(input, Type = Uint16Array) {
  if (typeof input != "string")
    return input;
  let array = null;
  for (let pos = 0, out = 0; pos < input.length; ) {
    let value = 0;
    for (; ; ) {
      let next = input.charCodeAt(pos++), stop = false;
      if (next == 126) {
        value = 65535;
        break;
      }
      if (next >= 92)
        next--;
      if (next >= 34)
        next--;
      let digit = next - 32;
      if (digit >= 46) {
        digit -= 46;
        stop = true;
      }
      value += digit;
      if (stop)
        break;
      value *= 46;
    }
    if (array)
      array[out++] = value;
    else
      array = new Type(value);
  }
  return array;
}
var CachedToken = class {
  constructor() {
    this.start = -1;
    this.value = -1;
    this.end = -1;
    this.extended = -1;
    this.lookAhead = 0;
    this.mask = 0;
    this.context = 0;
  }
};
var nullToken = new CachedToken();
var InputStream = class {
  /**
  @internal
  */
  constructor(input, ranges) {
    this.input = input;
    this.ranges = ranges;
    this.chunk = "";
    this.chunkOff = 0;
    this.chunk2 = "";
    this.chunk2Pos = 0;
    this.next = -1;
    this.token = nullToken;
    this.rangeIndex = 0;
    this.pos = this.chunkPos = ranges[0].from;
    this.range = ranges[0];
    this.end = ranges[ranges.length - 1].to;
    this.readNext();
  }
  /**
  @internal
  */
  resolveOffset(offset, assoc) {
    let range = this.range, index = this.rangeIndex;
    let pos = this.pos + offset;
    while (pos < range.from) {
      if (!index)
        return null;
      let next = this.ranges[--index];
      pos -= range.from - next.to;
      range = next;
    }
    while (assoc < 0 ? pos > range.to : pos >= range.to) {
      if (index == this.ranges.length - 1)
        return null;
      let next = this.ranges[++index];
      pos += next.from - range.to;
      range = next;
    }
    return pos;
  }
  /**
  @internal
  */
  clipPos(pos) {
    if (pos >= this.range.from && pos < this.range.to)
      return pos;
    for (let range of this.ranges)
      if (range.to > pos)
        return Math.max(pos, range.from);
    return this.end;
  }
  /**
  Look at a code unit near the stream position. `.peek(0)` equals
  `.next`, `.peek(-1)` gives you the previous character, and so
  on.
  
  Note that looking around during tokenizing creates dependencies
  on potentially far-away content, which may reduce the
  effectiveness incremental parsing—when looking forward—or even
  cause invalid reparses when looking backward more than 25 code
  units, since the library does not track lookbehind.
  */
  peek(offset) {
    let idx = this.chunkOff + offset, pos, result;
    if (idx >= 0 && idx < this.chunk.length) {
      pos = this.pos + offset;
      result = this.chunk.charCodeAt(idx);
    } else {
      let resolved = this.resolveOffset(offset, 1);
      if (resolved == null)
        return -1;
      pos = resolved;
      if (pos >= this.chunk2Pos && pos < this.chunk2Pos + this.chunk2.length) {
        result = this.chunk2.charCodeAt(pos - this.chunk2Pos);
      } else {
        let i = this.rangeIndex, range = this.range;
        while (range.to <= pos)
          range = this.ranges[++i];
        this.chunk2 = this.input.chunk(this.chunk2Pos = pos);
        if (pos + this.chunk2.length > range.to)
          this.chunk2 = this.chunk2.slice(0, range.to - pos);
        result = this.chunk2.charCodeAt(0);
      }
    }
    if (pos >= this.token.lookAhead)
      this.token.lookAhead = pos + 1;
    return result;
  }
  /**
  Accept a token. By default, the end of the token is set to the
  current stream position, but you can pass an offset (relative to
  the stream position) to change that.
  */
  acceptToken(token, endOffset = 0) {
    let end = endOffset ? this.resolveOffset(endOffset, -1) : this.pos;
    if (end == null || end < this.token.start)
      throw new RangeError("Token end out of bounds");
    this.token.value = token;
    this.token.end = end;
  }
  /**
  Accept a token ending at a specific given position.
  */
  acceptTokenTo(token, endPos) {
    this.token.value = token;
    this.token.end = endPos;
  }
  getChunk() {
    if (this.pos >= this.chunk2Pos && this.pos < this.chunk2Pos + this.chunk2.length) {
      let { chunk, chunkPos } = this;
      this.chunk = this.chunk2;
      this.chunkPos = this.chunk2Pos;
      this.chunk2 = chunk;
      this.chunk2Pos = chunkPos;
      this.chunkOff = this.pos - this.chunkPos;
    } else {
      this.chunk2 = this.chunk;
      this.chunk2Pos = this.chunkPos;
      let nextChunk = this.input.chunk(this.pos);
      let end = this.pos + nextChunk.length;
      this.chunk = end > this.range.to ? nextChunk.slice(0, this.range.to - this.pos) : nextChunk;
      this.chunkPos = this.pos;
      this.chunkOff = 0;
    }
  }
  readNext() {
    if (this.chunkOff >= this.chunk.length) {
      this.getChunk();
      if (this.chunkOff == this.chunk.length)
        return this.next = -1;
    }
    return this.next = this.chunk.charCodeAt(this.chunkOff);
  }
  /**
  Move the stream forward N (defaults to 1) code units. Returns
  the new value of [`next`](#lr.InputStream.next).
  */
  advance(n = 1) {
    this.chunkOff += n;
    while (this.pos + n >= this.range.to) {
      if (this.rangeIndex == this.ranges.length - 1)
        return this.setDone();
      n -= this.range.to - this.pos;
      this.range = this.ranges[++this.rangeIndex];
      this.pos = this.range.from;
    }
    this.pos += n;
    if (this.pos >= this.token.lookAhead)
      this.token.lookAhead = this.pos + 1;
    return this.readNext();
  }
  setDone() {
    this.pos = this.chunkPos = this.end;
    this.range = this.ranges[this.rangeIndex = this.ranges.length - 1];
    this.chunk = "";
    return this.next = -1;
  }
  /**
  @internal
  */
  reset(pos, token) {
    if (token) {
      this.token = token;
      token.start = pos;
      token.lookAhead = pos + 1;
      token.value = token.extended = -1;
    } else {
      this.token = nullToken;
    }
    if (this.pos != pos) {
      this.pos = pos;
      if (pos == this.end) {
        this.setDone();
        return this;
      }
      while (pos < this.range.from)
        this.range = this.ranges[--this.rangeIndex];
      while (pos >= this.range.to)
        this.range = this.ranges[++this.rangeIndex];
      if (pos >= this.chunkPos && pos < this.chunkPos + this.chunk.length) {
        this.chunkOff = pos - this.chunkPos;
      } else {
        this.chunk = "";
        this.chunkOff = 0;
      }
      this.readNext();
    }
    return this;
  }
  /**
  @internal
  */
  read(from, to) {
    if (from >= this.chunkPos && to <= this.chunkPos + this.chunk.length)
      return this.chunk.slice(from - this.chunkPos, to - this.chunkPos);
    if (from >= this.chunk2Pos && to <= this.chunk2Pos + this.chunk2.length)
      return this.chunk2.slice(from - this.chunk2Pos, to - this.chunk2Pos);
    if (from >= this.range.from && to <= this.range.to)
      return this.input.read(from, to);
    let result = "";
    for (let r of this.ranges) {
      if (r.from >= to)
        break;
      if (r.to > from)
        result += this.input.read(Math.max(r.from, from), Math.min(r.to, to));
    }
    return result;
  }
};
var TokenGroup = class {
  constructor(data, id2) {
    this.data = data;
    this.id = id2;
  }
  token(input, stack) {
    let { parser: parser2 } = stack.p;
    readToken(this.data, input, stack, this.id, parser2.data, parser2.tokenPrecTable);
  }
};
TokenGroup.prototype.contextual = TokenGroup.prototype.fallback = TokenGroup.prototype.extend = false;
var LocalTokenGroup = class {
  constructor(data, precTable, elseToken) {
    this.precTable = precTable;
    this.elseToken = elseToken;
    this.data = typeof data == "string" ? decodeArray(data) : data;
  }
  token(input, stack) {
    let start = input.pos, skipped = 0;
    for (; ; ) {
      let atEof = input.next < 0, nextPos = input.resolveOffset(1, 1);
      readToken(this.data, input, stack, 0, this.data, this.precTable);
      if (input.token.value > -1)
        break;
      if (this.elseToken == null)
        return;
      if (!atEof)
        skipped++;
      if (nextPos == null)
        break;
      input.reset(nextPos, input.token);
    }
    if (skipped) {
      input.reset(start, input.token);
      input.acceptToken(this.elseToken, skipped);
    }
  }
};
LocalTokenGroup.prototype.contextual = TokenGroup.prototype.fallback = TokenGroup.prototype.extend = false;
var ExternalTokenizer = class {
  /**
  Create a tokenizer. The first argument is the function that,
  given an input stream, scans for the types of tokens it
  recognizes at the stream's position, and calls
  [`acceptToken`](#lr.InputStream.acceptToken) when it finds
  one.
  */
  constructor(token, options = {}) {
    this.token = token;
    this.contextual = !!options.contextual;
    this.fallback = !!options.fallback;
    this.extend = !!options.extend;
  }
};
function readToken(data, input, stack, group, precTable, precOffset) {
  let state = 0, groupMask = 1 << group, { dialect } = stack.p.parser;
  scan: for (; ; ) {
    if ((groupMask & data[state]) == 0)
      break;
    let accEnd = data[state + 1];
    for (let i = state + 3; i < accEnd; i += 2)
      if ((data[i + 1] & groupMask) > 0) {
        let term = data[i];
        if (dialect.allows(term) && (input.token.value == -1 || input.token.value == term || overrides(term, input.token.value, precTable, precOffset))) {
          input.acceptToken(term);
          break;
        }
      }
    let next = input.next, low = 0, high = data[state + 2];
    if (input.next < 0 && high > low && data[accEnd + high * 3 - 3] == 65535) {
      state = data[accEnd + high * 3 - 1];
      continue scan;
    }
    for (; low < high; ) {
      let mid = low + high >> 1;
      let index = accEnd + mid + (mid << 1);
      let from = data[index], to = data[index + 1] || 65536;
      if (next < from)
        high = mid;
      else if (next >= to)
        low = mid + 1;
      else {
        state = data[index + 2];
        input.advance();
        continue scan;
      }
    }
    break;
  }
}
function findOffset(data, start, term) {
  for (let i = start, next; (next = data[i]) != 65535; i++)
    if (next == term)
      return i - start;
  return -1;
}
function overrides(token, prev, tableData, tableOffset) {
  let iPrev = findOffset(tableData, tableOffset, prev);
  return iPrev < 0 || findOffset(tableData, tableOffset, token) < iPrev;
}
var verbose = typeof process != "undefined" && process.env && /\bparse\b/.test(process.env.LOG);
var stackIDs = null;
function cutAt(tree, pos, side) {
  let cursor = tree.cursor(IterMode.IncludeAnonymous);
  cursor.moveTo(pos);
  for (; ; ) {
    if (!(side < 0 ? cursor.childBefore(pos) : cursor.childAfter(pos)))
      for (; ; ) {
        if ((side < 0 ? cursor.to < pos : cursor.from > pos) && !cursor.type.isError)
          return side < 0 ? Math.max(0, Math.min(
            cursor.to - 1,
            pos - 25
            /* Lookahead.Margin */
          )) : Math.min(tree.length, Math.max(
            cursor.from + 1,
            pos + 25
            /* Lookahead.Margin */
          ));
        if (side < 0 ? cursor.prevSibling() : cursor.nextSibling())
          break;
        if (!cursor.parent())
          return side < 0 ? 0 : tree.length;
      }
  }
}
var FragmentCursor = class {
  constructor(fragments, minRepeat) {
    this.fragments = fragments;
    this.minRepeat = minRepeat;
    this.i = 0;
    this.fragment = null;
    this.safeFrom = -1;
    this.safeTo = -1;
    this.trees = [];
    this.start = [];
    this.index = [];
    this.lastRepeat = null;
    this.lastRepeatPos = -1;
    this.nextFragment();
  }
  nextFragment() {
    let fr = this.fragment = this.i == this.fragments.length ? null : this.fragments[this.i++];
    if (fr) {
      this.safeFrom = fr.openStart ? cutAt(fr.tree, fr.from + fr.offset, 1) - fr.offset : fr.from;
      this.safeTo = fr.openEnd ? cutAt(fr.tree, fr.to + fr.offset, -1) - fr.offset : fr.to;
      while (this.trees.length) {
        this.trees.pop();
        this.start.pop();
        this.index.pop();
      }
      this.trees.push(fr.tree);
      this.start.push(-fr.offset);
      this.index.push(0);
      this.nextStart = this.safeFrom;
    } else {
      this.nextStart = 1e9;
    }
  }
  // `pos` must be >= any previously given `pos` for this cursor
  nodeAt(pos) {
    if (pos < this.nextStart)
      return null;
    while (this.fragment && this.safeTo <= pos)
      this.nextFragment();
    if (!this.fragment)
      return null;
    for (; ; ) {
      let last2 = this.trees.length - 1;
      if (last2 < 0) {
        this.nextFragment();
        return null;
      }
      if (pos < this.safeFrom)
        return null;
      let top = this.trees[last2], index = this.index[last2];
      if (index == top.children.length) {
        this.trees.pop();
        this.start.pop();
        this.index.pop();
        continue;
      }
      let next = top.children[index];
      let start = this.start[last2] + top.positions[index];
      if (start > pos) {
        this.nextStart = start;
        return null;
      }
      if (next instanceof Tree) {
        let storeRepeat = start > this.lastRepeatPos && next.type.id >= this.minRepeat;
        if (start == pos || storeRepeat) {
          let end = start + next.length, lookahead;
          if (start >= this.safeFrom && end <= this.safeTo && (!(lookahead = next.prop(NodeProp.lookAhead)) || end + lookahead < this.fragment.to)) {
            if (storeRepeat) {
              this.lastRepeat = next;
              this.lastRepeatPos = start;
            }
            if (start == pos)
              return next;
          }
        }
        this.index[last2]++;
        if (start + next.length >= Math.max(this.safeFrom, pos)) {
          this.trees.push(next);
          this.start.push(start);
          this.index.push(0);
        }
      } else {
        this.index[last2]++;
        this.nextStart = start + next.length;
      }
    }
  }
};
var TokenCache = class {
  constructor(parser2, stream) {
    this.stream = stream;
    this.tokens = [];
    this.mainToken = null;
    this.actions = [];
    this.tokens = parser2.tokenizers.map((_) => new CachedToken());
  }
  getActions(stack) {
    let actionIndex = 0;
    let main = null;
    let { parser: parser2 } = stack.p, { tokenizers } = parser2;
    let mask = parser2.stateSlot(
      stack.state,
      3
      /* ParseState.TokenizerMask */
    );
    let context = stack.curContext ? stack.curContext.hash : 0;
    let lookAhead = 0;
    for (let i = 0; i < tokenizers.length; i++) {
      if ((1 << i & mask) == 0)
        continue;
      let tokenizer = tokenizers[i], token = this.tokens[i];
      if (main && !tokenizer.fallback)
        continue;
      if (tokenizer.contextual || token.start != stack.pos || token.mask != mask || token.context != context) {
        this.updateCachedToken(token, tokenizer, stack);
        token.mask = mask;
        token.context = context;
      }
      if (token.lookAhead > token.end + 25)
        lookAhead = Math.max(token.lookAhead, lookAhead);
      if (token.value != 0) {
        let startIndex = actionIndex;
        if (token.extended > -1)
          actionIndex = this.addActions(stack, token.extended, token.end, actionIndex);
        actionIndex = this.addActions(stack, token.value, token.end, actionIndex);
        if (!tokenizer.extend) {
          main = token;
          if (actionIndex > startIndex)
            break;
        }
      }
    }
    while (this.actions.length > actionIndex)
      this.actions.pop();
    if (lookAhead)
      stack.setLookAhead(lookAhead);
    if (!main && stack.pos == this.stream.end) {
      main = new CachedToken();
      main.value = stack.p.parser.eofTerm;
      main.start = main.end = stack.pos;
      actionIndex = this.addActions(stack, main.value, main.end, actionIndex);
    }
    this.mainToken = main;
    return this.actions;
  }
  getMainToken(stack) {
    if (this.mainToken)
      return this.mainToken;
    let main = new CachedToken(), { pos, p } = stack;
    main.start = pos;
    main.end = Math.min(pos + 1, p.stream.end);
    main.value = pos == p.stream.end ? p.parser.eofTerm : 0;
    return main;
  }
  updateCachedToken(token, tokenizer, stack) {
    let start = this.stream.clipPos(stack.pos);
    tokenizer.token(this.stream.reset(start, token), stack);
    if (token.value > -1) {
      let { parser: parser2 } = stack.p;
      for (let i = 0; i < parser2.specialized.length; i++)
        if (parser2.specialized[i] == token.value) {
          let result = parser2.specializers[i](this.stream.read(token.start, token.end), stack);
          if (result >= 0 && stack.p.parser.dialect.allows(result >> 1)) {
            if ((result & 1) == 0)
              token.value = result >> 1;
            else
              token.extended = result >> 1;
            break;
          }
        }
    } else {
      token.value = 0;
      token.end = this.stream.clipPos(start + 1);
    }
  }
  putAction(action, token, end, index) {
    for (let i = 0; i < index; i += 3)
      if (this.actions[i] == action)
        return index;
    this.actions[index++] = action;
    this.actions[index++] = token;
    this.actions[index++] = end;
    return index;
  }
  addActions(stack, token, end, index) {
    let { state } = stack, { parser: parser2 } = stack.p, { data } = parser2;
    for (let set = 0; set < 2; set++) {
      for (let i = parser2.stateSlot(
        state,
        set ? 2 : 1
        /* ParseState.Actions */
      ); ; i += 3) {
        if (data[i] == 65535) {
          if (data[i + 1] == 1) {
            i = pair(data, i + 2);
          } else {
            if (index == 0 && data[i + 1] == 2)
              index = this.putAction(pair(data, i + 2), token, end, index);
            break;
          }
        }
        if (data[i] == token)
          index = this.putAction(pair(data, i + 1), token, end, index);
      }
    }
    return index;
  }
};
var Parse = class {
  constructor(parser2, input, fragments, ranges) {
    this.parser = parser2;
    this.input = input;
    this.ranges = ranges;
    this.recovering = 0;
    this.nextStackID = 9812;
    this.minStackPos = 0;
    this.reused = [];
    this.stoppedAt = null;
    this.lastBigReductionStart = -1;
    this.lastBigReductionSize = 0;
    this.bigReductionCount = 0;
    this.stream = new InputStream(input, ranges);
    this.tokens = new TokenCache(parser2, this.stream);
    this.topTerm = parser2.top[1];
    let { from } = ranges[0];
    this.stacks = [Stack.start(this, parser2.top[0], from)];
    this.fragments = fragments.length && this.stream.end - from > parser2.bufferLength * 4 ? new FragmentCursor(fragments, parser2.minRepeatTerm) : null;
  }
  get parsedPos() {
    return this.minStackPos;
  }
  // Move the parser forward. This will process all parse stacks at
  // `this.pos` and try to advance them to a further position. If no
  // stack for such a position is found, it'll start error-recovery.
  //
  // When the parse is finished, this will return a syntax tree. When
  // not, it returns `null`.
  advance() {
    let stacks = this.stacks, pos = this.minStackPos;
    let newStacks = this.stacks = [];
    let stopped, stoppedTokens;
    if (this.bigReductionCount > 300 && stacks.length == 1) {
      let [s] = stacks;
      while (s.forceReduce() && s.stack.length && s.stack[s.stack.length - 2] >= this.lastBigReductionStart) {
      }
      this.bigReductionCount = this.lastBigReductionSize = 0;
    }
    for (let i = 0; i < stacks.length; i++) {
      let stack = stacks[i];
      for (; ; ) {
        this.tokens.mainToken = null;
        if (stack.pos > pos) {
          newStacks.push(stack);
        } else if (this.advanceStack(stack, newStacks, stacks)) {
          continue;
        } else {
          if (!stopped) {
            stopped = [];
            stoppedTokens = [];
          }
          stopped.push(stack);
          let tok = this.tokens.getMainToken(stack);
          stoppedTokens.push(tok.value, tok.end);
        }
        break;
      }
    }
    if (!newStacks.length) {
      let finished = stopped && findFinished(stopped);
      if (finished) {
        if (verbose)
          console.log("Finish with " + this.stackID(finished));
        return this.stackToTree(finished);
      }
      if (this.parser.strict) {
        if (verbose && stopped)
          console.log("Stuck with token " + (this.tokens.mainToken ? this.parser.getName(this.tokens.mainToken.value) : "none"));
        throw new SyntaxError("No parse at " + pos);
      }
      if (!this.recovering)
        this.recovering = 5;
    }
    if (this.recovering && stopped) {
      let finished = this.stoppedAt != null && stopped[0].pos > this.stoppedAt ? stopped[0] : this.runRecovery(stopped, stoppedTokens, newStacks);
      if (finished) {
        if (verbose)
          console.log("Force-finish " + this.stackID(finished));
        return this.stackToTree(finished.forceAll());
      }
    }
    if (this.recovering) {
      let maxRemaining = this.recovering == 1 ? 1 : this.recovering * 3;
      if (newStacks.length > maxRemaining) {
        newStacks.sort((a, b) => b.score - a.score);
        while (newStacks.length > maxRemaining)
          newStacks.pop();
      }
      if (newStacks.some((s) => s.reducePos > pos))
        this.recovering--;
    } else if (newStacks.length > 1) {
      outer: for (let i = 0; i < newStacks.length - 1; i++) {
        let stack = newStacks[i];
        for (let j = i + 1; j < newStacks.length; j++) {
          let other = newStacks[j];
          if (stack.sameState(other) || stack.buffer.length > 500 && other.buffer.length > 500) {
            if ((stack.score - other.score || stack.buffer.length - other.buffer.length) > 0) {
              newStacks.splice(j--, 1);
            } else {
              newStacks.splice(i--, 1);
              continue outer;
            }
          }
        }
      }
      if (newStacks.length > 12) {
        newStacks.sort((a, b) => b.score - a.score);
        newStacks.splice(
          12,
          newStacks.length - 12
          /* Rec.MaxStackCount */
        );
      }
    }
    this.minStackPos = newStacks[0].pos;
    for (let i = 1; i < newStacks.length; i++)
      if (newStacks[i].pos < this.minStackPos)
        this.minStackPos = newStacks[i].pos;
    return null;
  }
  stopAt(pos) {
    if (this.stoppedAt != null && this.stoppedAt < pos)
      throw new RangeError("Can't move stoppedAt forward");
    this.stoppedAt = pos;
  }
  // See if a given tree, or a descendant right at its start, can be
  // reused in the given stack.
  tryReuse(stack, start, tree, repeatOnly) {
    if (!tree)
      return null;
    let strictCx = stack.curContext && stack.curContext.tracker.strict, cxHash = strictCx ? stack.curContext.hash : 0;
    for (; tree; ) {
      let match = this.parser.nodeSet.types[tree.type.id] != tree.type ? -1 : this.parser.getGoto(stack.state, tree.type.id);
      if (match > -1 && tree.length && (!strictCx || (tree.prop(NodeProp.contextHash) || 0) == cxHash)) {
        stack.useNode(tree, match, start);
        return tree;
      }
      if (tree.children.length == 0 || tree.positions[0] > 0)
        break;
      let inner = tree.children[0];
      if (inner instanceof Tree && (!repeatOnly || inner.type.id >= this.parser.minRepeatTerm))
        tree = inner;
      else
        break;
    }
    return null;
  }
  // Returns an updated version of the given stack, or null if the
  // stack can't advance normally. When `split` and `stacks` are
  // given, stacks split off by ambiguous operations will be pushed to
  // `split`, or added to `stacks` if they move `pos` forward.
  advanceStack(stack, stacks, split) {
    let start = stack.pos, { parser: parser2 } = this;
    let base = verbose ? this.stackID(stack) + " -> " : "";
    if (this.stoppedAt != null && start > this.stoppedAt)
      return stack.forceReduce() ? stack : null;
    if (this.fragments) {
      let reused = stack.reducePos < start && stack.buffer.length && stack.buffer[stack.buffer.length - 2] <= stack.reducePos && this.fragments.lastRepeatPos == stack.reducePos && this.tryReuse(stack, stack.reducePos, this.fragments.lastRepeat, true) || this.tryReuse(stack, start, this.fragments.nodeAt(start), false);
      if (reused) {
        if (verbose)
          console.log(base + this.stackID(stack) + ` (via reuse of ${parser2.getName(reused.type.id)})`);
        return true;
      }
    }
    let defaultReduce = parser2.stateSlot(
      stack.state,
      4
      /* ParseState.DefaultReduce */
    );
    if (defaultReduce > 0) {
      stack.reduce(defaultReduce);
      if (verbose)
        console.log(base + this.stackID(stack) + ` (via always-reduce ${parser2.getName(
          defaultReduce & 65535
          /* Action.ValueMask */
        )})`);
      return true;
    }
    if (stack.stack.length >= 8400) {
      while (stack.stack.length > 6e3 && stack.forceReduce()) {
      }
    }
    let actions = this.tokens.getActions(stack);
    for (let i = 0; i < actions.length; ) {
      let action = actions[i++], term = actions[i++], end = actions[i++];
      let last2 = i == actions.length || !split;
      let localStack = last2 ? stack : stack.split();
      let main = this.tokens.mainToken;
      localStack.apply(action, term, main ? main.start : localStack.pos, end);
      if (verbose)
        console.log(base + this.stackID(localStack) + ` (via ${(action & 65536) == 0 ? "shift" : `reduce of ${parser2.getName(
          action & 65535
          /* Action.ValueMask */
        )}`} for ${parser2.getName(term)} @ ${start}${localStack == stack ? "" : ", split"})`);
      if (last2)
        return true;
      else if (localStack.pos > start)
        stacks.push(localStack);
      else
        split.push(localStack);
    }
    return false;
  }
  // Advance a given stack forward as far as it will go. Returns the
  // (possibly updated) stack if it got stuck, or null if it moved
  // forward and was given to `pushStackDedup`.
  advanceFully(stack, newStacks) {
    let pos = stack.pos;
    for (; ; ) {
      if (!this.advanceStack(stack, null, null))
        return false;
      if (stack.pos > pos) {
        pushStackDedup(stack, newStacks);
        return true;
      }
    }
  }
  runRecovery(stacks, tokens, newStacks) {
    let finished = null, restarted = false;
    for (let i = 0; i < stacks.length; i++) {
      let stack = stacks[i], token = tokens[i << 1], tokenEnd = tokens[(i << 1) + 1];
      let base = verbose ? this.stackID(stack) + " -> " : "";
      if (stack.deadEnd) {
        if (restarted)
          continue;
        restarted = true;
        stack.restart();
        if (verbose)
          console.log(base + this.stackID(stack) + " (restarted)");
        let done = this.advanceFully(stack, newStacks);
        if (done)
          continue;
      }
      let force = stack.split(), forceBase = base;
      for (let j = 0; j < 10 && force.forceReduce(); j++) {
        if (verbose)
          console.log(forceBase + this.stackID(force) + " (via force-reduce)");
        let done = this.advanceFully(force, newStacks);
        if (done)
          break;
        if (verbose)
          forceBase = this.stackID(force) + " -> ";
      }
      for (let insert of stack.recoverByInsert(token)) {
        if (verbose)
          console.log(base + this.stackID(insert) + " (via recover-insert)");
        this.advanceFully(insert, newStacks);
      }
      if (this.stream.end > stack.pos) {
        if (tokenEnd == stack.pos) {
          tokenEnd++;
          token = 0;
        }
        stack.recoverByDelete(token, tokenEnd);
        if (verbose)
          console.log(base + this.stackID(stack) + ` (via recover-delete ${this.parser.getName(token)})`);
        pushStackDedup(stack, newStacks);
      } else if (!finished || finished.score < force.score) {
        finished = force;
      }
    }
    return finished;
  }
  // Convert the stack's buffer to a syntax tree.
  stackToTree(stack) {
    stack.close();
    return Tree.build({
      buffer: StackBufferCursor.create(stack),
      nodeSet: this.parser.nodeSet,
      topID: this.topTerm,
      maxBufferLength: this.parser.bufferLength,
      reused: this.reused,
      start: this.ranges[0].from,
      length: stack.pos - this.ranges[0].from,
      minRepeatType: this.parser.minRepeatTerm
    });
  }
  stackID(stack) {
    let id2 = (stackIDs || (stackIDs = /* @__PURE__ */ new WeakMap())).get(stack);
    if (!id2)
      stackIDs.set(stack, id2 = String.fromCodePoint(this.nextStackID++));
    return id2 + stack;
  }
};
function pushStackDedup(stack, newStacks) {
  for (let i = 0; i < newStacks.length; i++) {
    let other = newStacks[i];
    if (other.pos == stack.pos && other.sameState(stack)) {
      if (newStacks[i].score < stack.score)
        newStacks[i] = stack;
      return;
    }
  }
  newStacks.push(stack);
}
var Dialect = class {
  constructor(source, flags, disabled) {
    this.source = source;
    this.flags = flags;
    this.disabled = disabled;
  }
  allows(term) {
    return !this.disabled || this.disabled[term] == 0;
  }
};
var id = (x) => x;
var ContextTracker = class {
  /**
  Define a context tracker.
  */
  constructor(spec) {
    this.start = spec.start;
    this.shift = spec.shift || id;
    this.reduce = spec.reduce || id;
    this.reuse = spec.reuse || id;
    this.hash = spec.hash || (() => 0);
    this.strict = spec.strict !== false;
  }
};
var LRParser = class _LRParser extends Parser {
  /**
  @internal
  */
  constructor(spec) {
    super();
    this.wrappers = [];
    if (spec.version != 14)
      throw new RangeError(`Parser version (${spec.version}) doesn't match runtime version (${14})`);
    let nodeNames = spec.nodeNames.split(" ");
    this.minRepeatTerm = nodeNames.length;
    for (let i = 0; i < spec.repeatNodeCount; i++)
      nodeNames.push("");
    let topTerms = Object.keys(spec.topRules).map((r) => spec.topRules[r][1]);
    let nodeProps = [];
    for (let i = 0; i < nodeNames.length; i++)
      nodeProps.push([]);
    function setProp(nodeID, prop, value) {
      nodeProps[nodeID].push([prop, prop.deserialize(String(value))]);
    }
    if (spec.nodeProps)
      for (let propSpec of spec.nodeProps) {
        let prop = propSpec[0];
        if (typeof prop == "string")
          prop = NodeProp[prop];
        for (let i = 1; i < propSpec.length; ) {
          let next = propSpec[i++];
          if (next >= 0) {
            setProp(next, prop, propSpec[i++]);
          } else {
            let value = propSpec[i + -next];
            for (let j = -next; j > 0; j--)
              setProp(propSpec[i++], prop, value);
            i++;
          }
        }
      }
    this.nodeSet = new NodeSet(nodeNames.map((name2, i) => NodeType.define({
      name: i >= this.minRepeatTerm ? void 0 : name2,
      id: i,
      props: nodeProps[i],
      top: topTerms.indexOf(i) > -1,
      error: i == 0,
      skipped: spec.skippedNodes && spec.skippedNodes.indexOf(i) > -1
    })));
    if (spec.propSources)
      this.nodeSet = this.nodeSet.extend(...spec.propSources);
    this.strict = false;
    this.bufferLength = DefaultBufferLength;
    let tokenArray = decodeArray(spec.tokenData);
    this.context = spec.context;
    this.specializerSpecs = spec.specialized || [];
    this.specialized = new Uint16Array(this.specializerSpecs.length);
    for (let i = 0; i < this.specializerSpecs.length; i++)
      this.specialized[i] = this.specializerSpecs[i].term;
    this.specializers = this.specializerSpecs.map(getSpecializer);
    this.states = decodeArray(spec.states, Uint32Array);
    this.data = decodeArray(spec.stateData);
    this.goto = decodeArray(spec.goto);
    this.maxTerm = spec.maxTerm;
    this.tokenizers = spec.tokenizers.map((value) => typeof value == "number" ? new TokenGroup(tokenArray, value) : value);
    this.topRules = spec.topRules;
    this.dialects = spec.dialects || {};
    this.dynamicPrecedences = spec.dynamicPrecedences || null;
    this.tokenPrecTable = spec.tokenPrec;
    this.termNames = spec.termNames || null;
    this.maxNode = this.nodeSet.types.length - 1;
    this.dialect = this.parseDialect();
    this.top = this.topRules[Object.keys(this.topRules)[0]];
  }
  createParse(input, fragments, ranges) {
    let parse = new Parse(this, input, fragments, ranges);
    for (let w of this.wrappers)
      parse = w(parse, input, fragments, ranges);
    return parse;
  }
  /**
  Get a goto table entry @internal
  */
  getGoto(state, term, loose = false) {
    let table = this.goto;
    if (term >= table[0])
      return -1;
    for (let pos = table[term + 1]; ; ) {
      let groupTag = table[pos++], last2 = groupTag & 1;
      let target = table[pos++];
      if (last2 && loose)
        return target;
      for (let end = pos + (groupTag >> 1); pos < end; pos++)
        if (table[pos] == state)
          return target;
      if (last2)
        return -1;
    }
  }
  /**
  Check if this state has an action for a given terminal @internal
  */
  hasAction(state, terminal) {
    let data = this.data;
    for (let set = 0; set < 2; set++) {
      for (let i = this.stateSlot(
        state,
        set ? 2 : 1
        /* ParseState.Actions */
      ), next; ; i += 3) {
        if ((next = data[i]) == 65535) {
          if (data[i + 1] == 1)
            next = data[i = pair(data, i + 2)];
          else if (data[i + 1] == 2)
            return pair(data, i + 2);
          else
            break;
        }
        if (next == terminal || next == 0)
          return pair(data, i + 1);
      }
    }
    return 0;
  }
  /**
  @internal
  */
  stateSlot(state, slot) {
    return this.states[state * 6 + slot];
  }
  /**
  @internal
  */
  stateFlag(state, flag) {
    return (this.stateSlot(
      state,
      0
      /* ParseState.Flags */
    ) & flag) > 0;
  }
  /**
  @internal
  */
  validAction(state, action) {
    return !!this.allActions(state, (a) => a == action ? true : null);
  }
  /**
  @internal
  */
  allActions(state, action) {
    let deflt = this.stateSlot(
      state,
      4
      /* ParseState.DefaultReduce */
    );
    let result = deflt ? action(deflt) : void 0;
    for (let i = this.stateSlot(
      state,
      1
      /* ParseState.Actions */
    ); result == null; i += 3) {
      if (this.data[i] == 65535) {
        if (this.data[i + 1] == 1)
          i = pair(this.data, i + 2);
        else
          break;
      }
      result = action(pair(this.data, i + 1));
    }
    return result;
  }
  /**
  Get the states that can follow this one through shift actions or
  goto jumps. @internal
  */
  nextStates(state) {
    let result = [];
    for (let i = this.stateSlot(
      state,
      1
      /* ParseState.Actions */
    ); ; i += 3) {
      if (this.data[i] == 65535) {
        if (this.data[i + 1] == 1)
          i = pair(this.data, i + 2);
        else
          break;
      }
      if ((this.data[i + 2] & 65536 >> 16) == 0) {
        let value = this.data[i + 1];
        if (!result.some((v, i2) => i2 & 1 && v == value))
          result.push(this.data[i], value);
      }
    }
    return result;
  }
  /**
  Configure the parser. Returns a new parser instance that has the
  given settings modified. Settings not provided in `config` are
  kept from the original parser.
  */
  configure(config) {
    let copy = Object.assign(Object.create(_LRParser.prototype), this);
    if (config.props)
      copy.nodeSet = this.nodeSet.extend(...config.props);
    if (config.top) {
      let info = this.topRules[config.top];
      if (!info)
        throw new RangeError(`Invalid top rule name ${config.top}`);
      copy.top = info;
    }
    if (config.tokenizers)
      copy.tokenizers = this.tokenizers.map((t2) => {
        let found = config.tokenizers.find((r) => r.from == t2);
        return found ? found.to : t2;
      });
    if (config.specializers) {
      copy.specializers = this.specializers.slice();
      copy.specializerSpecs = this.specializerSpecs.map((s, i) => {
        let found = config.specializers.find((r) => r.from == s.external);
        if (!found)
          return s;
        let spec = Object.assign(Object.assign({}, s), { external: found.to });
        copy.specializers[i] = getSpecializer(spec);
        return spec;
      });
    }
    if (config.contextTracker)
      copy.context = config.contextTracker;
    if (config.dialect)
      copy.dialect = this.parseDialect(config.dialect);
    if (config.strict != null)
      copy.strict = config.strict;
    if (config.wrap)
      copy.wrappers = copy.wrappers.concat(config.wrap);
    if (config.bufferLength != null)
      copy.bufferLength = config.bufferLength;
    return copy;
  }
  /**
  Tells you whether any [parse wrappers](#lr.ParserConfig.wrap)
  are registered for this parser.
  */
  hasWrappers() {
    return this.wrappers.length > 0;
  }
  /**
  Returns the name associated with a given term. This will only
  work for all terms when the parser was generated with the
  `--names` option. By default, only the names of tagged terms are
  stored.
  */
  getName(term) {
    return this.termNames ? this.termNames[term] : String(term <= this.maxNode && this.nodeSet.types[term].name || term);
  }
  /**
  The eof term id is always allocated directly after the node
  types. @internal
  */
  get eofTerm() {
    return this.maxNode + 1;
  }
  /**
  The type of top node produced by the parser.
  */
  get topNode() {
    return this.nodeSet.types[this.top[1]];
  }
  /**
  @internal
  */
  dynamicPrecedence(term) {
    let prec = this.dynamicPrecedences;
    return prec == null ? 0 : prec[term] || 0;
  }
  /**
  @internal
  */
  parseDialect(dialect) {
    let values = Object.keys(this.dialects), flags = values.map(() => false);
    if (dialect)
      for (let part of dialect.split(" ")) {
        let id2 = values.indexOf(part);
        if (id2 >= 0)
          flags[id2] = true;
      }
    let disabled = null;
    for (let i = 0; i < values.length; i++)
      if (!flags[i]) {
        for (let j = this.dialects[values[i]], id2; (id2 = this.data[j++]) != 65535; )
          (disabled || (disabled = new Uint8Array(this.maxTerm + 1)))[id2] = 1;
      }
    return new Dialect(dialect, flags, disabled);
  }
  /**
  Used by the output of the parser generator. Not available to
  user code. @hide
  */
  static deserialize(spec) {
    return new _LRParser(spec);
  }
};
function pair(data, off) {
  return data[off] | data[off + 1] << 16;
}
function findFinished(stacks) {
  let best = null;
  for (let stack of stacks) {
    let stopped = stack.p.stoppedAt;
    if ((stack.pos == stack.p.stream.end || stopped != null && stack.pos > stopped) && stack.p.parser.stateFlag(
      stack.state,
      2
      /* StateFlag.Accepting */
    ) && (!best || best.score < stack.score))
      best = stack;
  }
  return best;
}
function getSpecializer(spec) {
  if (spec.external) {
    let mask = spec.extend ? 1 : 0;
    return (value, stack) => spec.external(value, stack) << 1 | mask;
  }
  return spec.get;
}

// node_modules/min-dash/dist/index.js
var nativeHasOwnProperty = Object.prototype.hasOwnProperty;
function isNil(obj) {
  return obj == null;
}
function has(target, key) {
  return !isNil(target) && nativeHasOwnProperty.call(target, key);
}

// node_modules/@lezer/highlight/dist/index.js
var nextTagID = 0;
var Tag = class _Tag {
  /**
  @internal
  */
  constructor(name2, set, base, modified) {
    this.name = name2;
    this.set = set;
    this.base = base;
    this.modified = modified;
    this.id = nextTagID++;
  }
  toString() {
    let { name: name2 } = this;
    for (let mod of this.modified)
      if (mod.name)
        name2 = `${mod.name}(${name2})`;
    return name2;
  }
  static define(nameOrParent, parent) {
    let name2 = typeof nameOrParent == "string" ? nameOrParent : "?";
    if (nameOrParent instanceof _Tag)
      parent = nameOrParent;
    if (parent === null || parent === void 0 ? void 0 : parent.base)
      throw new Error("Can not derive from a modified tag");
    let tag2 = new _Tag(name2, [], null, []);
    tag2.set.push(tag2);
    if (parent)
      for (let t2 of parent.set)
        tag2.set.push(t2);
    return tag2;
  }
  /**
  Define a tag _modifier_, which is a function that, given a tag,
  will return a tag that is a subtag of the original. Applying the
  same modifier to a twice tag will return the same value (`m1(t1)
  == m1(t1)`) and applying multiple modifiers will, regardless or
  order, produce the same tag (`m1(m2(t1)) == m2(m1(t1))`).
  
  When multiple modifiers are applied to a given base tag, each
  smaller set of modifiers is registered as a parent, so that for
  example `m1(m2(m3(t1)))` is a subtype of `m1(m2(t1))`,
  `m1(m3(t1)`, and so on.
  */
  static defineModifier(name2) {
    let mod = new Modifier(name2);
    return (tag2) => {
      if (tag2.modified.indexOf(mod) > -1)
        return tag2;
      return Modifier.get(tag2.base || tag2, tag2.modified.concat(mod).sort((a, b) => a.id - b.id));
    };
  }
};
var nextModifierID = 0;
var Modifier = class _Modifier {
  constructor(name2) {
    this.name = name2;
    this.instances = [];
    this.id = nextModifierID++;
  }
  static get(base, mods) {
    if (!mods.length)
      return base;
    let exists = mods[0].instances.find((t2) => t2.base == base && sameArray(mods, t2.modified));
    if (exists)
      return exists;
    let set = [], tag2 = new Tag(base.name, set, base, mods);
    for (let m of mods)
      m.instances.push(tag2);
    let configs = powerSet(mods);
    for (let parent of base.set)
      if (!parent.modified.length)
        for (let config of configs)
          set.push(_Modifier.get(parent, config));
    return tag2;
  }
};
function sameArray(a, b) {
  return a.length == b.length && a.every((x, i) => x == b[i]);
}
function powerSet(array) {
  let sets = [[]];
  for (let i = 0; i < array.length; i++) {
    for (let j = 0, e = sets.length; j < e; j++) {
      sets.push(sets[j].concat(array[i]));
    }
  }
  return sets.sort((a, b) => b.length - a.length);
}
function styleTags(spec) {
  let byName = /* @__PURE__ */ Object.create(null);
  for (let prop in spec) {
    let tags2 = spec[prop];
    if (!Array.isArray(tags2))
      tags2 = [tags2];
    for (let part of prop.split(" "))
      if (part) {
        let pieces = [], mode2 = 2, rest = part;
        for (let pos = 0; ; ) {
          if (rest == "..." && pos > 0 && pos + 3 == part.length) {
            mode2 = 1;
            break;
          }
          let m = /^"(?:[^"\\]|\\.)*?"|[^\/!]+/.exec(rest);
          if (!m)
            throw new RangeError("Invalid path: " + part);
          pieces.push(m[0] == "*" ? "" : m[0][0] == '"' ? JSON.parse(m[0]) : m[0]);
          pos += m[0].length;
          if (pos == part.length)
            break;
          let next = part[pos++];
          if (pos == part.length && next == "!") {
            mode2 = 0;
            break;
          }
          if (next != "/")
            throw new RangeError("Invalid path: " + part);
          rest = part.slice(pos);
        }
        let last2 = pieces.length - 1, inner = pieces[last2];
        if (!inner)
          throw new RangeError("Invalid path: " + part);
        let rule = new Rule(tags2, mode2, last2 > 0 ? pieces.slice(0, last2) : null);
        byName[inner] = rule.sort(byName[inner]);
      }
  }
  return ruleNodeProp.add(byName);
}
var ruleNodeProp = new NodeProp({
  combine(a, b) {
    let cur, root, take;
    while (a || b) {
      if (!a || b && a.depth <= b.depth) {
        take = b;
        b = b.next;
      } else {
        take = a;
        a = a.next;
      }
      if (cur && cur.mode == take.mode && !take.context && !cur.context)
        continue;
      let copy = new Rule(take.tags, take.mode, take.context);
      if (cur)
        cur.next = copy;
      else
        root = copy;
      cur = copy;
    }
    return root;
  }
});
var Rule = class {
  constructor(tags2, mode2, context, next) {
    this.tags = tags2;
    this.mode = mode2;
    this.context = context;
    this.next = next;
  }
  get opaque() {
    return this.mode == 0;
  }
  get inherit() {
    return this.mode == 1;
  }
  sort(other) {
    if (!other || other.depth < this.depth) {
      this.next = other;
      return this;
    }
    other.next = this.sort(other.next);
    return other;
  }
  get depth() {
    return this.context ? this.context.length : 0;
  }
};
Rule.empty = new Rule([], 2, null);
function tagHighlighter(tags2, options) {
  let map = /* @__PURE__ */ Object.create(null);
  for (let style of tags2) {
    if (!Array.isArray(style.tag))
      map[style.tag.id] = style.class;
    else
      for (let tag2 of style.tag)
        map[tag2.id] = style.class;
  }
  let { scope, all = null } = options || {};
  return {
    style: (tags3) => {
      let cls = all;
      for (let tag2 of tags3) {
        for (let sub of tag2.set) {
          let tagClass = map[sub.id];
          if (tagClass) {
            cls = cls ? cls + " " + tagClass : tagClass;
            break;
          }
        }
      }
      return cls;
    },
    scope
  };
}
var t = Tag.define;
var comment = t();
var name = t();
var typeName = t(name);
var propertyName = t(name);
var literal = t();
var string = t(literal);
var number = t(literal);
var content = t();
var heading = t(content);
var keyword = t();
var operator = t();
var punctuation = t();
var bracket = t(punctuation);
var meta = t();
var tags = {
  /**
  A comment.
  */
  comment,
  /**
  A line [comment](#highlight.tags.comment).
  */
  lineComment: t(comment),
  /**
  A block [comment](#highlight.tags.comment).
  */
  blockComment: t(comment),
  /**
  A documentation [comment](#highlight.tags.comment).
  */
  docComment: t(comment),
  /**
  Any kind of identifier.
  */
  name,
  /**
  The [name](#highlight.tags.name) of a variable.
  */
  variableName: t(name),
  /**
  A type [name](#highlight.tags.name).
  */
  typeName,
  /**
  A tag name (subtag of [`typeName`](#highlight.tags.typeName)).
  */
  tagName: t(typeName),
  /**
  A property or field [name](#highlight.tags.name).
  */
  propertyName,
  /**
  An attribute name (subtag of [`propertyName`](#highlight.tags.propertyName)).
  */
  attributeName: t(propertyName),
  /**
  The [name](#highlight.tags.name) of a class.
  */
  className: t(name),
  /**
  A label [name](#highlight.tags.name).
  */
  labelName: t(name),
  /**
  A namespace [name](#highlight.tags.name).
  */
  namespace: t(name),
  /**
  The [name](#highlight.tags.name) of a macro.
  */
  macroName: t(name),
  /**
  A literal value.
  */
  literal,
  /**
  A string [literal](#highlight.tags.literal).
  */
  string,
  /**
  A documentation [string](#highlight.tags.string).
  */
  docString: t(string),
  /**
  A character literal (subtag of [string](#highlight.tags.string)).
  */
  character: t(string),
  /**
  An attribute value (subtag of [string](#highlight.tags.string)).
  */
  attributeValue: t(string),
  /**
  A number [literal](#highlight.tags.literal).
  */
  number,
  /**
  An integer [number](#highlight.tags.number) literal.
  */
  integer: t(number),
  /**
  A floating-point [number](#highlight.tags.number) literal.
  */
  float: t(number),
  /**
  A boolean [literal](#highlight.tags.literal).
  */
  bool: t(literal),
  /**
  Regular expression [literal](#highlight.tags.literal).
  */
  regexp: t(literal),
  /**
  An escape [literal](#highlight.tags.literal), for example a
  backslash escape in a string.
  */
  escape: t(literal),
  /**
  A color [literal](#highlight.tags.literal).
  */
  color: t(literal),
  /**
  A URL [literal](#highlight.tags.literal).
  */
  url: t(literal),
  /**
  A language keyword.
  */
  keyword,
  /**
  The [keyword](#highlight.tags.keyword) for the self or this
  object.
  */
  self: t(keyword),
  /**
  The [keyword](#highlight.tags.keyword) for null.
  */
  null: t(keyword),
  /**
  A [keyword](#highlight.tags.keyword) denoting some atomic value.
  */
  atom: t(keyword),
  /**
  A [keyword](#highlight.tags.keyword) that represents a unit.
  */
  unit: t(keyword),
  /**
  A modifier [keyword](#highlight.tags.keyword).
  */
  modifier: t(keyword),
  /**
  A [keyword](#highlight.tags.keyword) that acts as an operator.
  */
  operatorKeyword: t(keyword),
  /**
  A control-flow related [keyword](#highlight.tags.keyword).
  */
  controlKeyword: t(keyword),
  /**
  A [keyword](#highlight.tags.keyword) that defines something.
  */
  definitionKeyword: t(keyword),
  /**
  A [keyword](#highlight.tags.keyword) related to defining or
  interfacing with modules.
  */
  moduleKeyword: t(keyword),
  /**
  An operator.
  */
  operator,
  /**
  An [operator](#highlight.tags.operator) that dereferences something.
  */
  derefOperator: t(operator),
  /**
  Arithmetic-related [operator](#highlight.tags.operator).
  */
  arithmeticOperator: t(operator),
  /**
  Logical [operator](#highlight.tags.operator).
  */
  logicOperator: t(operator),
  /**
  Bit [operator](#highlight.tags.operator).
  */
  bitwiseOperator: t(operator),
  /**
  Comparison [operator](#highlight.tags.operator).
  */
  compareOperator: t(operator),
  /**
  [Operator](#highlight.tags.operator) that updates its operand.
  */
  updateOperator: t(operator),
  /**
  [Operator](#highlight.tags.operator) that defines something.
  */
  definitionOperator: t(operator),
  /**
  Type-related [operator](#highlight.tags.operator).
  */
  typeOperator: t(operator),
  /**
  Control-flow [operator](#highlight.tags.operator).
  */
  controlOperator: t(operator),
  /**
  Program or markup punctuation.
  */
  punctuation,
  /**
  [Punctuation](#highlight.tags.punctuation) that separates
  things.
  */
  separator: t(punctuation),
  /**
  Bracket-style [punctuation](#highlight.tags.punctuation).
  */
  bracket,
  /**
  Angle [brackets](#highlight.tags.bracket) (usually `<` and `>`
  tokens).
  */
  angleBracket: t(bracket),
  /**
  Square [brackets](#highlight.tags.bracket) (usually `[` and `]`
  tokens).
  */
  squareBracket: t(bracket),
  /**
  Parentheses (usually `(` and `)` tokens). Subtag of
  [bracket](#highlight.tags.bracket).
  */
  paren: t(bracket),
  /**
  Braces (usually `{` and `}` tokens). Subtag of
  [bracket](#highlight.tags.bracket).
  */
  brace: t(bracket),
  /**
  Content, for example plain text in XML or markup documents.
  */
  content,
  /**
  [Content](#highlight.tags.content) that represents a heading.
  */
  heading,
  /**
  A level 1 [heading](#highlight.tags.heading).
  */
  heading1: t(heading),
  /**
  A level 2 [heading](#highlight.tags.heading).
  */
  heading2: t(heading),
  /**
  A level 3 [heading](#highlight.tags.heading).
  */
  heading3: t(heading),
  /**
  A level 4 [heading](#highlight.tags.heading).
  */
  heading4: t(heading),
  /**
  A level 5 [heading](#highlight.tags.heading).
  */
  heading5: t(heading),
  /**
  A level 6 [heading](#highlight.tags.heading).
  */
  heading6: t(heading),
  /**
  A prose [content](#highlight.tags.content) separator (such as a horizontal rule).
  */
  contentSeparator: t(content),
  /**
  [Content](#highlight.tags.content) that represents a list.
  */
  list: t(content),
  /**
  [Content](#highlight.tags.content) that represents a quote.
  */
  quote: t(content),
  /**
  [Content](#highlight.tags.content) that is emphasized.
  */
  emphasis: t(content),
  /**
  [Content](#highlight.tags.content) that is styled strong.
  */
  strong: t(content),
  /**
  [Content](#highlight.tags.content) that is part of a link.
  */
  link: t(content),
  /**
  [Content](#highlight.tags.content) that is styled as code or
  monospace.
  */
  monospace: t(content),
  /**
  [Content](#highlight.tags.content) that has a strike-through
  style.
  */
  strikethrough: t(content),
  /**
  Inserted text in a change-tracking format.
  */
  inserted: t(),
  /**
  Deleted text.
  */
  deleted: t(),
  /**
  Changed text.
  */
  changed: t(),
  /**
  An invalid or unsyntactic element.
  */
  invalid: t(),
  /**
  Metadata or meta-instruction.
  */
  meta,
  /**
  [Metadata](#highlight.tags.meta) that applies to the entire
  document.
  */
  documentMeta: t(meta),
  /**
  [Metadata](#highlight.tags.meta) that annotates or adds
  attributes to a given syntactic element.
  */
  annotation: t(meta),
  /**
  Processing instruction or preprocessor directive. Subtag of
  [meta](#highlight.tags.meta).
  */
  processingInstruction: t(meta),
  /**
  [Modifier](#highlight.Tag^defineModifier) that indicates that a
  given element is being defined. Expected to be used with the
  various [name](#highlight.tags.name) tags.
  */
  definition: Tag.defineModifier("definition"),
  /**
  [Modifier](#highlight.Tag^defineModifier) that indicates that
  something is constant. Mostly expected to be used with
  [variable names](#highlight.tags.variableName).
  */
  constant: Tag.defineModifier("constant"),
  /**
  [Modifier](#highlight.Tag^defineModifier) used to indicate that
  a [variable](#highlight.tags.variableName) or [property
  name](#highlight.tags.propertyName) is being called or defined
  as a function.
  */
  function: Tag.defineModifier("function"),
  /**
  [Modifier](#highlight.Tag^defineModifier) that can be applied to
  [names](#highlight.tags.name) to indicate that they belong to
  the language's standard environment.
  */
  standard: Tag.defineModifier("standard"),
  /**
  [Modifier](#highlight.Tag^defineModifier) that indicates a given
  [names](#highlight.tags.name) is local to some scope.
  */
  local: Tag.defineModifier("local"),
  /**
  A generic variant [modifier](#highlight.Tag^defineModifier) that
  can be used to tag language-specific alternative variants of
  some common tag. It is recommended for themes to define special
  forms of at least the [string](#highlight.tags.string) and
  [variable name](#highlight.tags.variableName) tags, since those
  come up a lot.
  */
  special: Tag.defineModifier("special")
};
for (let name2 in tags) {
  let val = tags[name2];
  if (val instanceof Tag)
    val.name = name2;
}
var classHighlighter = tagHighlighter([
  { tag: tags.link, class: "tok-link" },
  { tag: tags.heading, class: "tok-heading" },
  { tag: tags.emphasis, class: "tok-emphasis" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: tags.keyword, class: "tok-keyword" },
  { tag: tags.atom, class: "tok-atom" },
  { tag: tags.bool, class: "tok-bool" },
  { tag: tags.url, class: "tok-url" },
  { tag: tags.labelName, class: "tok-labelName" },
  { tag: tags.inserted, class: "tok-inserted" },
  { tag: tags.deleted, class: "tok-deleted" },
  { tag: tags.literal, class: "tok-literal" },
  { tag: tags.string, class: "tok-string" },
  { tag: tags.number, class: "tok-number" },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], class: "tok-string2" },
  { tag: tags.variableName, class: "tok-variableName" },
  { tag: tags.local(tags.variableName), class: "tok-variableName tok-local" },
  { tag: tags.definition(tags.variableName), class: "tok-variableName tok-definition" },
  { tag: tags.special(tags.variableName), class: "tok-variableName2" },
  { tag: tags.definition(tags.propertyName), class: "tok-propertyName tok-definition" },
  { tag: tags.typeName, class: "tok-typeName" },
  { tag: tags.namespace, class: "tok-namespace" },
  { tag: tags.className, class: "tok-className" },
  { tag: tags.macroName, class: "tok-macroName" },
  { tag: tags.propertyName, class: "tok-propertyName" },
  { tag: tags.operator, class: "tok-operator" },
  { tag: tags.comment, class: "tok-comment" },
  { tag: tags.meta, class: "tok-meta" },
  { tag: tags.invalid, class: "tok-invalid" },
  { tag: tags.punctuation, class: "tok-punctuation" }
]);

// node_modules/lezer-feel/dist/index.js
var propertyIdentifier = 124;
var identifier = 125;
var nameIdentifier = 126;
var insertSemi = 127;
var expression0 = 131;
var ForExpression = 4;
var forExpressionStart = 134;
var ForInExpression = 7;
var Name = 8;
var Identifier = 9;
var AdditionalIdentifier = 10;
var forExpressionBodyStart = 140;
var IfExpression = 21;
var ifExpressionStart = 141;
var QuantifiedExpression = 25;
var quantifiedExpressionStart = 142;
var QuantifiedInExpression = 29;
var PositiveUnaryTest = 39;
var ArithmeticExpression = 43;
var arithmeticPlusStart = 145;
var arithmeticTimesStart = 146;
var arithmeticExpStart = 147;
var arithmeticUnaryStart = 148;
var VariableName = 49;
var PathExpression = 70;
var pathExpressionStart = 154;
var PathName = 71;
var FilterExpression = 73;
var filterExpressionStart = 155;
var FunctionInvocation = 75;
var functionInvocationStart = 156;
var ParameterName = 79;
var nil = 161;
var NumericLiteral = 82;
var StringLiteral = 83;
var BooleanLiteral = 84;
var listStart = 168;
var List = 92;
var FunctionDefinition = 93;
var functionDefinitionStart = 170;
var Context = 100;
var contextStart = 172;
var ContextEntry = 101;
var PropertyName = 103;
var PropertyIdentifier = 104;
var LOG_PARSE = typeof process != "undefined" && process.env && /\bfparse(:dbg)?\b/.test(process.env.LOG);
var LOG_PARSE_DEBUG = typeof process != "undefined" && process.env && /\bfparse:dbg\b/.test(process.env.LOG);
var LOG_VARS = typeof process != "undefined" && process.env && /\bcontext\b/.test(process.env.LOG);
var spaceChars = [
  9,
  11,
  12,
  32,
  133,
  160,
  5760,
  8192,
  8193,
  8194,
  8195,
  8196,
  8197,
  8198,
  8199,
  8200,
  8201,
  8202,
  8232,
  8233,
  8239,
  8287,
  12288
];
var newlineChars = chars("\n\r");
var asterix = "*".charCodeAt(0);
var additionalNameChars = chars("'./-+*^");
function chars(str) {
  return Array.from(str).map((s) => s.charCodeAt(0));
}
function isStartChar(ch) {
  return ch === 63 || ch >= 65 && ch <= 90 || ch === 95 || ch >= 97 && ch <= 122 || ch >= 192 && ch <= 214 || ch >= 216 && ch <= 246 || ch >= 248 && ch <= 767 || ch >= 880 && ch <= 893 || ch >= 895 && ch <= 8191 || ch >= 8204 && ch <= 8205 || ch >= 8304 && ch <= 8591 || ch >= 11264 && ch <= 12271 || ch >= 12289 && ch <= 55295 || ch >= 63744 && ch <= 64975 || ch >= 65008 && ch <= 65533 || ch >= 55296 && ch <= 56319 || ch >= 56320 && ch <= 57343;
}
function isAdditional(ch) {
  return additionalNameChars.includes(ch);
}
function isPartChar(ch) {
  return ch >= 48 && ch <= 57 || ch === 183 || ch >= 768 && ch <= 879 || ch >= 8255 && ch <= 8256;
}
function isSpace(ch) {
  return spaceChars.includes(ch);
}
function indent(str, spaces) {
  return spaces.concat(
    str.split(/\n/g).join("\n" + spaces)
  );
}
function parseAdditionalSymbol(input, offset = 0) {
  const next = input.peek(offset);
  if (next === asterix && input.peek(offset + 1) === asterix) {
    return {
      offset: 2,
      token: "**"
    };
  }
  if (isAdditional(next)) {
    return {
      offset: 1,
      token: String.fromCharCode(next)
    };
  }
  return null;
}
function parseIdentifier(input, offset = 0, namePart = false) {
  for (let inside = false, chars2 = [], i = 0; ; i++) {
    const next = input.peek(offset + i);
    if (isStartChar(next) || (inside || namePart) && isPartChar(next)) {
      if (!inside) {
        inside = true;
      }
      chars2.push(next);
    } else {
      if (chars2.length) {
        return {
          token: String.fromCharCode(...chars2),
          offset: i
        };
      }
      return null;
    }
  }
}
function parseSpaces(input, offset) {
  for (let inside = false, i = 0; ; i++) {
    let next = input.peek(offset + i);
    if (isSpace(next)) {
      if (!inside) {
        inside = true;
      }
    } else {
      if (inside) {
        return {
          token: " ",
          offset: i
        };
      }
      return null;
    }
  }
}
function parseName(input, variables) {
  const {
    keys,
    prefixes
  } = variables.contextCache();
  const start = variables.tokens;
  for (let i = 0, tokens = [], nextMatch = null; ; ) {
    const namePart = start.length + tokens.length > 0;
    const maybeSpace = tokens.length > 0;
    const match = parseIdentifier(input, i, namePart) || namePart && parseAdditionalSymbol(input, i) || maybeSpace && parseSpaces(input, i);
    if (!match) {
      return nextMatch;
    }
    const {
      token,
      offset
    } = match;
    i += offset;
    if (token === " ") {
      continue;
    }
    tokens = [...tokens, token];
    const name2 = [...start, ...tokens].join(" ");
    if (keys.has(name2)) {
      const token2 = tokens[0];
      nextMatch = {
        token: token2,
        offset: token2.length,
        term: nameIdentifier
      };
    }
    if (prefixes.has(name2)) {
      continue;
    }
    if (dateTimeIdentifiers.some((el) => el === name2)) {
      const token2 = tokens[0];
      nextMatch = {
        token: token2,
        offset: token2.length,
        term: identifier
      };
    }
    if (dateTimeIdentifiers.some((el) => el.startsWith(name2))) {
      continue;
    }
    return nextMatch;
  }
}
var identifiersMap = {
  [identifier]: "identifier",
  [nameIdentifier]: "nameIdentifier"
};
var identifiers = new ExternalTokenizer((input, stack) => {
  LOG_PARSE_DEBUG && console.log("%s: T <identifier | nameIdentifier>", input.pos);
  const nameMatch = parseName(input, stack.context);
  const start = stack.context.tokens;
  const match = nameMatch || parseIdentifier(input, 0, start.length > 0);
  if (match) {
    input.advance(match.offset);
    input.acceptToken(nameMatch ? nameMatch.term : identifier);
    LOG_PARSE && console.log("%s: MATCH <%s> <%s>", input.pos, nameMatch ? identifiersMap[nameMatch.term] : "identifier", match.token);
  }
}, { contextual: true });
var propertyIdentifiers = new ExternalTokenizer((input, stack) => {
  LOG_PARSE_DEBUG && console.log("%s: T <propertyIdentifier>", input.pos);
  const start = stack.context.tokens;
  const match = parseIdentifier(input, 0, start.length > 0);
  if (match) {
    input.advance(match.offset);
    input.acceptToken(propertyIdentifier);
    LOG_PARSE && console.log("%s: MATCH <propertyIdentifier> <%s>", input.pos, match.token);
  }
});
var insertSemicolon = new ExternalTokenizer((input, stack) => {
  LOG_PARSE_DEBUG && console.log("%s: T <insertSemi>", input.pos);
  let offset;
  let insert = false;
  for (offset = 0; ; offset++) {
    const char = input.peek(offset);
    if (spaceChars.includes(char)) {
      continue;
    }
    if (newlineChars.includes(char)) {
      insert = true;
    }
    break;
  }
  if (insert) {
    const identifier2 = parseIdentifier(input, offset + 1);
    const spaces = parseSpaces(input, offset + 1);
    if (spaces || identifier2 && /^(then|else|return|satisfies)$/.test(identifier2.token)) {
      return;
    }
    LOG_PARSE && console.log("%s: MATCH <insertSemi>", input.pos);
    input.acceptToken(insertSemi);
  }
});
var prefixedContextStarts = {
  [functionInvocationStart]: "FunctionInvocation",
  [filterExpressionStart]: "FilterExpression",
  [pathExpressionStart]: "PathExpression"
};
var contextStarts = {
  [contextStart]: "Context",
  [functionDefinitionStart]: "FunctionDefinition",
  [forExpressionStart]: "ForExpression",
  [listStart]: "List",
  [ifExpressionStart]: "IfExpression",
  [quantifiedExpressionStart]: "QuantifiedExpression"
};
var contextEnds = {
  [Context]: "Context",
  [FunctionDefinition]: "FunctionDefinition",
  [ForExpression]: "ForExpression",
  [List]: "List",
  [IfExpression]: "IfExpression",
  [QuantifiedExpression]: "QuantifiedExpression",
  [PathExpression]: "PathExpression",
  [FunctionInvocation]: "FunctionInvocation",
  [FilterExpression]: "FilterExpression",
  [ArithmeticExpression]: "ArithmeticExpression"
};
var ValueProducer = class _ValueProducer {
  /**
   * @param { Function } fn
   */
  constructor(fn2) {
    this.fn = fn2;
  }
  get(variables) {
    return this.fn(variables);
  }
  /**
   * @param { (variables: Variables) => ContextValue } fn
   *
   * @return { ValueProducer }
   */
  static of(fn2) {
    return new _ValueProducer(fn2);
  }
};
var dateTimeLiterals = {
  "date and time": 1,
  "date": 1,
  "time": 1,
  "duration": 1
};
var dateTimeIdentifiers = Object.keys(dateTimeLiterals);
function getPrefixes(str) {
  const prefixes = [];
  for (let i = 1; i <= str.length; i++) {
    prefixes.push(str.substring(0, i));
  }
  return prefixes;
}
function cacheKey(key, cache) {
  const normalizedKey = normalizeContextKey(key);
  const prefixes = getPrefixes(normalizedKey);
  cache.keys.add(normalizedKey);
  for (const prefix of prefixes) {
    cache.prefixes.add(prefix);
  }
  cache.originalMap.set(normalizedKey, key);
  return cache;
}
function computeContextCache(context) {
  const cache = createContextCache();
  for (const key of context.getKeys()) {
    cacheKey(key, cache);
  }
  return cache;
}
function createContextCache(from) {
  return {
    keys: new Set(from?.keys),
    prefixes: new Set(from?.prefixes),
    originalMap: new Map(from?.originalMap)
  };
}
var VariableContext = class {
  /**
   * Creates a new context from a JavaScript object.
   *
   * @param {any} [value]
   */
  constructor(value = {}) {
    this.value = value;
  }
  /**
   * Return all defined keys of the context.
   *
   * @returns {string[] } the keys of the context
   */
  getKeys() {
    return Object.keys(this.value);
  }
  /**
   * Returns the value of the given key.
   *
   * If the value represents a context itself, it should be wrapped in a
   * context class.
   *
   * @param {string} key
   * @returns {VariableContext|ValueProducer|null}
   */
  get(key) {
    const result = this.value[key];
    const constructor = (
      /** @type { typeof VariableContext } */
      this.constructor
    );
    if (constructor.isAtomic(result)) {
      return result;
    }
    return constructor.of(result);
  }
  /**
   * Creates a new context with the given key added.
   *
   * @param {string} key
   * @param {any} value
   *
   * @returns {VariableContext} new context with the given key added
   */
  set(key, value) {
    const constructor = (
      /** @type { typeof VariableContext } */
      this.constructor
    );
    return new constructor({
      ...this.value,
      [key]: value
    });
  }
  /**
   * Non-destructively merge another context into this one,
   * and return the result.
   *
   * @param {ContextValue} other
   *
   * @return {VariableContext}
   */
  merge(other) {
    const constructor = (
      /** @type { typeof VariableContext } */
      this.constructor
    );
    return new constructor(
      constructor.__merge(this.value, other)
    );
  }
  /**
   * Wether the given value is atomic. Non-atomic values need to be wrapped in a
   * context Class.
   *
   * @param {any} value
   * @returns {Boolean}
   */
  static isAtomic(value) {
    return value === null || value === void 0 || value instanceof this || value instanceof ValueProducer || typeof value !== "object";
  }
  /**
   * Takes any number of Contexts and merges them into a single context.
   *
   * @param { ...(VariableContext | undefined) } contexts
   * @returns { VariableContext }
   */
  static of(...contexts) {
    const merged = contexts.reduce((context, otherContext) => {
      return this.__merge(context, otherContext);
    }, {});
    return new this(merged);
  }
  /**
   * Returns the raw representation of the given context.
   *
   * @param {VariableContext | any} context
   *
   * @return {any}
   */
  static __unwrap(context) {
    if (!context) {
      return {};
    }
    if (context instanceof this) {
      return context.value;
    }
    if (this.isAtomic(context)) {
      return {};
    }
    return context;
  }
  /**
   * Non-destructively merges two contexts (or their values)
   * with each other, returning the result.
   *
   * @param {ContextValue} context
   * @param {ContextValue} other
   *
   * @return {ContextValue} merged context value
   */
  static __merge(context, other) {
    const merged = Object.assign({}, this.__unwrap(context));
    for (const [key, value] of Object.entries(this.__unwrap(other))) {
      if (value instanceof ValueProducer) {
        merged[key] = value;
        continue;
      }
      if (has(merged, key)) {
        merged[key] = this.__merge(merged[key], value);
        continue;
      }
      merged[key] = value;
    }
    return merged;
  }
};
var Variables = class _Variables {
  /**
   * @param { {
   *   name?: string,
   *   tokens?: string[],
   *   children?: Variables[],
   *   parent: Variables | null
   *   context: VariableContext,
   *   value?: any,
   *   raw?: any,
   *   __cache?: CacheMap
   * } } options
   */
  constructor({
    name: name2 = "Expressions",
    tokens = [],
    children = [],
    parent = null,
    context,
    value,
    raw,
    __cache
  }) {
    this.name = name2;
    this.tokens = tokens;
    this.children = children;
    this.parent = parent;
    this.context = context;
    this.value = value;
    this.raw = raw;
    this.__cache = __cache;
  }
  /**
   * Get the root Variables instance by traversing up the parent chain.
   *
   * @returns {Variables}
   */
  get root() {
    let current = (
      /** @type {Variables} */
      this
    );
    while (current.parent) {
      current = current.parent;
    }
    return current;
  }
  /**
   * Get the root Variables instance by traversing up the parent chain.
   *
   * @returns {CacheMap}
   */
  get cache() {
    const root = this.root;
    if (!root.__cache) {
      root.__cache = /* @__PURE__ */ new WeakMap();
    }
    return root.__cache;
  }
  enterScope(name2) {
    const childScope = this.of({
      name: name2,
      parent: this
    });
    LOG_VARS && console.log("[%s] enter", childScope.path, childScope.context);
    return childScope;
  }
  exitScope(str) {
    if (!this.parent) {
      LOG_VARS && console.log("[%s] NO exit %o\n%s", this.path, this.context, indent(str, "  "));
      return this;
    }
    LOG_VARS && console.log("[%s] exit %o\n%s", this.path, this.context, indent(str, "  "));
    return this.parent.pushChild(this);
  }
  token(part) {
    LOG_VARS && console.log("[%s] token <%s> + <%s>", this.path, this.tokens.join(" "), part);
    return this.assign({
      tokens: [...this.tokens, part]
    });
  }
  literal(value) {
    LOG_VARS && console.log("[%s] literal %o", this.path, value);
    return this.pushChild(this.of({
      name: "Literal",
      value
    }));
  }
  /**
   * Return computed scope value
   *
   * @return {any}
   */
  computedValue() {
    for (let scope = (
      /** @type {Variables} */
      this
    ); ; scope = last(scope.children)) {
      if (!scope) {
        return null;
      }
      if (!isNil(scope.value)) {
        return scope.value;
      }
    }
  }
  /**
   * Get or compute the context cache for fast retrieval
   * of keys, prefixes and original mappings.
   *
   * @returns {ContextCache}
   */
  contextCache() {
    let cache = this.cache.get(this.context);
    if (!cache) {
      cache = computeContextCache(this.context);
      this.cache.set(this.context, cache);
    }
    return cache;
  }
  get path() {
    return this.parent?.path?.concat(" > ", this.name) || this.name;
  }
  /**
   * Return value of variable.
   *
   * @param { string } variable
   * @return { any } value
   */
  get(variable) {
    const normalizedVariable = variable && normalizeContextKey(variable);
    const contextKey = this.contextCache().originalMap.get(normalizedVariable);
    if (typeof contextKey === "undefined") {
      return void 0;
    }
    const val = this.context.get(contextKey);
    if (val instanceof ValueProducer) {
      return val.get(this);
    } else {
      return val;
    }
  }
  resolveName(name2) {
    const variable = this.tokens.join(" ");
    const tokens = [];
    const parentScope = this.assign({
      tokens
    });
    const variableScope = this.of({
      name: name2,
      parent: parentScope,
      value: this.get(variable),
      raw: variable
    });
    LOG_VARS && console.log("[%s] resolve %s <%s=%s>", name2, variableScope.path, variable, variableScope.value);
    return parentScope.pushChild(variableScope);
  }
  pushChild(child) {
    if (!child) {
      return this;
    }
    const parent = this.assign({
      children: [...this.children, child]
    });
    child.parent = parent;
    return parent;
  }
  pushChildren(children) {
    let parent = this;
    for (const child of children) {
      parent = parent.pushChild(child);
    }
    return parent;
  }
  declareName() {
    if (this.tokens.length === 0) {
      throw Error("no tokens to declare name");
    }
    const variableName = this.tokens.join(" ");
    LOG_VARS && console.log("[%s] declareName <%s>", this.path, variableName);
    return this.assign({
      tokens: []
    }).pushChild(
      this.of({
        name: "Name",
        value: variableName
      })
    );
  }
  define(name2, value) {
    if (typeof name2 !== "string") {
      LOG_VARS && console.log("[%s] no define <%s=%s>", this.path, name2, value);
      return this;
    }
    LOG_VARS && console.log("[%s] define <%s=%s>", this.path, name2, value);
    const oldContext = this.context;
    const newContext = oldContext.set(name2, value);
    const oldCache = this.cache.get(oldContext) || computeContextCache(oldContext);
    const newCache = cacheKey(
      name2,
      createContextCache(oldCache)
    );
    this.cache.set(newContext, newCache);
    return this.assign({
      context: newContext
    });
  }
  /**
   * @param { Record<string, any> } [options]
   *
   * @return { Variables }
   */
  assign(options = {}) {
    return _Variables.of({
      ...this,
      ...options
    });
  }
  /**
   * @param { Record<string, any> } [options]
   *
   * @return { Variables }
   */
  of(options = {}) {
    const defaultOptions = {
      context: this.context,
      parent: this.parent
    };
    return _Variables.of({
      ...defaultOptions,
      ...options
    });
  }
  /**
   * @param { {
   *   name?: string,
   *   tokens?: string[],
   *   children?: Variables[],
   *   parent?: Variables | null
   *   context: VariableContext,
   *   value?: any,
   *   raw?: any,
   *   __cache?: CacheMap
   * } } options
   *
   * @return {Variables}
   */
  static of(options) {
    const {
      name: name2,
      tokens = [],
      children = [],
      parent = null,
      context,
      value,
      raw,
      __cache
    } = options;
    if (!context) {
      throw new Error("must provide <context>");
    }
    return new _Variables({
      name: name2,
      tokens: [...tokens],
      children: [...children],
      context,
      parent,
      value,
      raw,
      __cache
    });
  }
};
function normalizeContextKey(name2) {
  return name2.replace(/\s*([./\-'+]|\*\*?)\s*/g, " $1 ").replace(/\s{2,}/g, " ").trim();
}
function wrap(variables, scopeName, code) {
  const parts = variables.children.filter((c) => c.name !== scopeName);
  const children = variables.children.filter((c) => c.name === scopeName);
  const namePart = parts[0];
  const valuePart = parts[Math.max(1, parts.length - 1)];
  const name2 = namePart?.computedValue();
  const value = valuePart?.computedValue() ?? null;
  return variables.assign({
    children
  }).enterScope(scopeName).pushChildren(parts).exitScope(code).define(name2, value);
}
function trackVariables(context = {}, Context2 = VariableContext) {
  const start = Variables.of({
    context: Context2.of(context)
  });
  return new ContextTracker({
    start,
    reduce(variables, term, stack, input) {
      if (term === IfExpression) {
        const [thenPart, elsePart] = variables.children.slice(-2);
        variables = variables.assign({
          value: Context2.of(
            thenPart?.computedValue(),
            elsePart?.computedValue()
          )
        });
      }
      if (term === List) {
        variables = variables.assign({
          value: Context2.of(
            ...variables.children.map(
              (c) => c?.computedValue()
            )
          )
        });
      }
      if (term === FilterExpression) {
        const [sourcePart, _] = variables.children.slice(-2);
        variables = variables.assign({
          value: sourcePart?.computedValue()
        });
      }
      if (term === FunctionInvocation) {
        const [
          name2,
          ...args
        ] = variables.children;
        if (name2?.raw === "get value") {
          variables = getContextValue(variables, args);
        } else {
          variables = variables.assign({
            value: name2?.computedValue() || Context2.of(void 0)
          });
        }
      }
      const start2 = contextStarts[term];
      if (start2) {
        return variables.enterScope(start2);
      }
      const prefixedStart = prefixedContextStarts[term];
      if (prefixedStart) {
        const {
          children: currentChildren,
          context: currentContext
        } = variables;
        const children = currentChildren.slice(0, -1);
        const lastChild = last(currentChildren);
        let newContext = null;
        if (term === pathExpressionStart) {
          newContext = Context2.of(lastChild?.computedValue());
        }
        if (term === filterExpressionStart) {
          newContext = Context2.of(
            currentContext,
            lastChild?.computedValue()
          ).set("item", lastChild?.computedValue());
        }
        return variables.assign({ children }).enterScope(prefixedStart).pushChild(lastChild).assign({ context: newContext || currentContext });
      }
      const code = input.read(input.pos, stack.pos);
      const end = contextEnds[term];
      if (end) {
        return variables.exitScope(code);
      }
      if (term === ContextEntry) {
        const parts = variables.children.filter((c) => c.name !== "ContextEntry");
        const name2 = parts[0];
        const value = last(parts);
        return wrap(variables, "ContextEntry", code).assign(
          {
            value: Context2.of(variables.value).set(name2?.computedValue(), value?.computedValue())
          }
        );
      }
      if (term === ForInExpression || term === QuantifiedInExpression) {
        return wrap(variables, "InExpression", code);
      }
      if (term === forExpressionBodyStart) {
        return variables.define(
          "partial",
          ValueProducer.of((variables2) => {
            return last(variables2.children)?.computedValue();
          })
        );
      }
      if (term === ParameterName) {
        const name2 = last(variables.children).computedValue();
        return variables.define(name2, 1);
      }
      if (term === arithmeticPlusStart || term === arithmeticTimesStart || term === arithmeticExpStart) {
        const children = variables.children.slice(0, -1);
        const lastChild = last(variables.children);
        return variables.assign({
          children
        }).enterScope("ArithmeticExpression").pushChild(lastChild);
      }
      if (term === arithmeticUnaryStart) {
        return variables.enterScope("ArithmeticExpression");
      }
      if (term === Identifier || term === AdditionalIdentifier || term === PropertyIdentifier) {
        return variables.token(code);
      }
      if (term === StringLiteral) {
        return variables.literal(code.replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1"));
      }
      if (term === BooleanLiteral) {
        return variables.literal(code === "true" ? true : false);
      }
      if (term === NumericLiteral) {
        return variables.literal(parseFloat(code));
      }
      if (term === nil) {
        return variables.literal(null);
      }
      if (term === VariableName) {
        return variables.resolveName("VariableName");
      }
      if (term === PathName) {
        return variables.resolveName("PathName");
      }
      if (term === Name || term === PropertyName) {
        return variables.declareName();
      }
      if (term === expression0 || term === PositiveUnaryTest) {
        if (variables.tokens.length > 0) {
          throw new Error("uncleared name");
        }
      }
      if (term === expression0) {
        let parent = variables;
        while (parent.parent) {
          parent = parent.exitScope(code);
        }
        return parent;
      }
      return variables;
    }
  });
}
var variableTracker = trackVariables({});
function getContextValue(variables, args) {
  if (!args.length) {
    return variables.assign({
      value: null
    });
  }
  if (args[0].name === "Name") {
    args = extractNamedArgs(args, ["m", "key"]);
  }
  if (args.length !== 2) {
    return variables.assign({
      value: null
    });
  }
  const [
    context,
    key
  ] = args;
  const keyValue = key?.computedValue();
  const contextValue = context?.computedValue();
  if (!contextValue || typeof contextValue !== "object" || typeof keyValue !== "string") {
    return variables.assign({
      value: null
    });
  }
  return variables.assign({
    value: [normalizeContextKey(keyValue), keyValue].reduce((value, keyValue2) => {
      return contextValue.get(keyValue2) || value;
    }, null)
  });
}
function extractNamedArgs(args, argNames) {
  const context = {};
  for (let i = 0; i < args.length; i += 2) {
    const [name2, value] = args.slice(i, i + 2);
    context[name2.value] = value;
  }
  return argNames.map((name2) => context[name2]);
}
function last(arr) {
  return arr[arr.length - 1];
}
var feelHighlighting = styleTags({
  StringLiteral: tags.string,
  NumericLiteral: tags.number,
  BooleanLiteral: tags.bool,
  "AtLiteral!": tags.special(tags.string),
  CompareOp: tags.compareOperator,
  ArithOp: tags.arithmeticOperator,
  "for if then else some every return": tags.controlKeyword,
  "in instance of and or satisfies between as": tags.operatorKeyword,
  function: tags.definitionKeyword,
  "Type/...": tags.typeName,
  "Wildcard!": tags.modifier,
  null: tags.null,
  LineComment: tags.lineComment,
  BlockComment: tags.blockComment,
  "VariableName!": tags.variableName,
  '"?"': tags.self,
  "DateTimeConstructor! SpecialFunctionName!": tags.standard(tags.function(tags.variableName)),
  "FunctionInvocation/VariableName!": tags.function(tags.variableName),
  "Name!": tags.definition(tags.variableName),
  "Key/Name! ContextEntryType/Name!": tags.definition(tags.propertyName),
  "PathExpression/PathName!": tags.propertyName,
  "FormalParameter/ParameterName!": tags.function(tags.definition(tags.variableName)),
  "( )": tags.paren,
  "[ ]": tags.squareBracket,
  "{ }": tags.brace,
  ".": tags.derefOperator,
  ", ;": tags.separator,
  "..": tags.punctuation
});
var spec_identifier = { __proto__: null, for: 10, in: 34, return: 40, if: 44, then: 46, else: 48, some: 52, every: 54, satisfies: 60, or: 64, and: 68, between: 76, instance: 90, of: 93, days: 105, time: 107, duration: 109, years: 111, months: 113, date: 115, list: 121, context: 127, function: 134, null: 162, true: 332, false: 332, "?": 176, external: 192, not: 217 };
var parser = LRParser.deserialize({
  version: 14,
  states: "CvO`QYOOO`QYOOO$yQYOOOOQU'#Ce'#CeO%TQYO'#C`O&^QYO'#FTOOQQ'#Ff'#FfO&hQYO'#FfO`QYO'#DXOOQU'#Eq'#EqO(_Q^O'#D_OOQU'#D`'#D`OOQU'#D_'#D_OOQO'#Fn'#FnO*[QWO'#DyOOQQ'#EQ'#EQOOQQ'#ER'#EROOQQ'#ES'#ESO*aOWO'#EVO*[QWO'#ETOOQQ'#ET'#ETOOQQ'#Ft'#FtOOQQ'#Fr'#FrOOQQ'#Fz'#FzOOQQ'#EX'#EXO`QYO'#EZOOQQ'#FV'#FVO*iQ^O'#FVO,`QYO'#E[O,gQWO'#E]OOQP'#GO'#GOO,lQXO'#EdOOQQ'#F{'#F{OOQQ'#FU'#FUQOQWOOOOQQ'#FW'#FWOOQQ'#F_'#F_O`QYO'#CqOOQQ'#F`'#F`O%TQYO'#CuO,zQYO'#DzOOQQ'#Fs'#FsO-PQYO'#EUOOQO'#EU'#EUO`QYO'#EYO`QYO'#EXOOQO'#F|'#F|Q-XQWOOO-^QYO'#DTO.TQWO'#FbOOQO'#DV'#DVO.`QYO'#FfO.gQWOOO/^QYO'#CdO/kQYO'#FYOOQQ'#Cc'#CcO/pQYO'#FXOOQQ'#Cb'#CbO/xQYO,58zO`QYO,59kOOQQ'#Fc'#FcOOQQ'#Fd'#FdOOQQ'#Fe'#FeO`QYO,59sO`QYO,59sO`QYO,59sOOQQ'#Fl'#FlO/}QYO,5:`OOQQ'#Fm'#FmO`QYO,5:cO`QYO,59gO`QYO,59iO`QYO,59kO1|QYO,59kO2TQYO,59tOOQQ,5:l,5:lO2YQYO,59sOOQU-E8o-E8oO3|QYO'#FoOOQQ,5:e,5:eOOQQ,5:q,5:qOOQQ,5:o,5:oO4TQYO,5:uOOQQ,5;q,5;qO4_QYO,5:tO4lQWO,5:vO4qQYO,5:wOOQP'#Eh'#EhO5hQXO'#EgOOQO'#Ef'#EfO5oQWO'#EeO5tQWO'#GPO5|QWO,5;OO6RQYO,59]OOQQ'#Cy'#CyO6YQYO'#FaOOQQ'#Cx'#CxO6bQYO,59aO6gQYO,5:fO6lQYO,5:pO6qQYO,5:tO6xQYO,5:sO`QYO'#EzQ-XQWOOO`QYO'#EpO7oQWO,5;|O`QYOOOOQR'#Cf'#CfOOQQ'#Em'#EmO8iQYO,59OO`QYO,5;tOOQQ'#F['#F[O%TQYO'#EnO8yQYO,5;sO`QYO1G.fOOQQ'#F^'#F^O9pQYO1G/VO<gQYO1G/_O<qQYO1G/_O<{QYO1G/_O>oQYO'#DuOOQQ'#Du'#DuOOQQ1G/z1G/zO@iQYO1G/}O@pQYO1G/ROAyQYO1G/TOCSQYO1G/VO`QYO1G/VOOQQ1G/V1G/VOCjQYO1G/`ODXQ^O'#CdOEkQYO'#FqOOQO'#D}'#D}OEuQWO'#D|OEzQWO'#FpOOQO'#D{'#D{OOQO'#EO'#EOOFSQWO,5<ZOOQQ1G0a1G0aO`QYO1G0`O`QYO'#EvOFXQWO,5<]OOQQ1G0b1G0bOFdQWO'#E_OFoQWO'#F}OOQO'#E^'#E^OFwQWO1G0cOOQP'#Ex'#ExOF|QXO,5;RO`QYO,5;POGTQXO'#EyOG`QWO,5<kOOQQ1G0j1G0jO`QYO1G.wO%TQYO'#EoOGhQYO,5;{O`QYO1G.{OGpQYO1G0QOOQO1G0[1G0[OOQO,5;f,5;fOOQO-E8x-E8xOOQO,5;[,5;[OOQO-E8n-E8nOGuQWOOOOQQ-E8k-E8kOGzQYO'#CnOOQQ1G1`1G1`OOQQ,5;Y,5;YOOQQ-E8l-E8lOH[QYO7+$QOOQQ7+%i7+%iO`QYO7+$qOIRQYO,5:uOI`QWO7+$qOIeQYO'#D^OOQQ'#D]'#D]OKXQYO'#DaOK^QYO'#DaOKcQYO'#DaOKhQ`O'#DiOKmQ`O'#DlOKrQ`O'#DpOOQQ7+$z7+$zO`QYO,5:hO%TQYO'#EuOKwQWO,5<[OOQQ1G1u1G1uOL}QYO7+%zOM[QYO,5;bOOQO-E8t-E8tOCjQYO,5:yO%TQYO'#EwOMiQWO,5<iOMqQYO7+%}OOQP-E8v-E8vOMxQYO1G0kOOQO,5;e,5;eOOQO-E8w-E8wONSQYO7+$cOOQQ,5;Z,5;ZOOQQ-E8m-E8mONZQYO7+$gOOQO7+%l7+%lO`QYO,59YO! QQYO<<H]OOQQ<<H]<<H]O/}QYO'#ErO!!ZQYO,59xO!#}QYO,59{O!$SQYO,59{O!$XQYO,59{O!$^QYO,5:TO%TQYO,5:WO!${QbO,5:[O!%SQYO1G0SOOQO,5;a,5;aOOQO-E8s-E8sO!%^QYO<<IfOOQQ<<If<<IfOOQO1G0e1G0eOOQO,5;c,5;cOOQO-E8u-E8uO!(`QYO'#EaOOQQ<<Ii<<IiO`QYO<<IiO`QYO<<G}O!)VQYO1G.tOOQQ,5;^,5;^OOQQ-E8p-E8pO!)dQYO1G/gOOQQ1G/g1G/gO!)iQbO'#D_O!)zQ`O'#D^O!*VQ`O1G/oO!*[QWO'#DoO!*aQ`O'#FhOOQO'#Dn'#DnO!*iQ`O1G/rOOQO'#Ds'#DsO!*nQ`O'#FjOOQO'#Dr'#DrO!*vQ`O1G/vOOQQAN?TAN?TO!*{QYOAN=iOOQQ7+%R7+%RO!+rQ`O,59xOOQQ7+%Z7+%ZO!$^QYO,5:ZO%TQYO'#EsO!+}Q`O,5<SOOQQ7+%^7+%^O!$^QYO'#EtO!,VQ`O,5<UO!,_Q`O7+%bOOQO1G/u1G/uOOQO,5;_,5;_OOQO-E8q-E8qOOQO,5;`,5;`OOQO-E8r-E8rOCjQYO<<H|OOQQAN>hAN>hO/}QYO'#ErO!$^QYO<<H|O!,dQ`O7+%bO!,iQ`O1G/vO!${QbO,5:[O!,nQ`O'#Dp",
  stateData: "!-R~O#uOS#vOSPOSQOS~OTsO[VO]UOftOjvOkvOt}Ou}OxiO!V{O!W{O!XxO!ZzO!e!OO!j|O!lgO!syO!zjO#VnO#qRO#rRO$ZZO$i_O$j`O$k`O$laO$mbO~OTsO]UOftOjvOkvOt}Ou}OxiO!V{O!W{O!XxO!ZzO!e!OO!j|O!lgO!syO!zjO#VnO#qRO#rRO$ZZO$i_O$j`O$k`O$laO$mbO~O[!TO#`!UO~P#VO#qRO#rRO~OZ!dO[!^O]!^O^!_O_!_O`!`Oa!kOp!hOr!iOt!]Ou!]Ov!jO}!lO!l!fOx$bX~O#o#wX$t#wX~P%]O$i!mOT$YX[$YX]$YXf$YXj$YXk$YXt$YXu$YXx$YX!V$YX!W$YX!X$YX!Z$YX!e$YX!j$YX!l$YX!s$YX!z$YX#V$YX#q$YX#r$YX$Z$YX$j$YX$k$YX$l$YX$m$YX~O#qRO#rROZ!RX[!RX]!RX^!RX_!RX`!RXa!RXp!RXr!RXt!RXu!RXv!RXx!RX}!RX!l!RX#o!RX#s!RX$t!RX$P!RXc!RXz!RX!j!RXg!RXd!RX#U!RXh!RXn!RX~Ox!pO~O$j`O$k`O~O#s!uOZ#yX[#yX]#yX^#yX_#yX`#yXa#yXp#yXr#yXt#yXu#yXv#yXx#yX}#yX!l#yX#o#yX$t#yX$P#yXc#yXz#yX!j#yXg#yXd#yX#U#yXh#yXn#yX~O!j$eP~P`Ox!xO~O#p!yO$j`O$k`O#U$sP~Or#UO~Or#VOx!xX~O$t#YO~O#owX$PwX$twXzwXcwX!jwXgwXdwX#UwXhwXnwX~P%]O$P#[O#o$UXz$UX~O#o#_X~P&hOx#^O~OZ#_O[#_O]#_O^#_O_#_O`#_O#qRO#rRO#}#_O$]WX~OaWXzWX$PWX~P.lOa#cO~O$P#dOd#{X~Od#gO~O#qRO#rRO$ZZO~OTsO[VO]UOftOjvOkvOt}Ou}O!V{O!W{O!XxO!ZzO!e!OO!j|O!lgO!syO!zjO#VnO#qRO#rRO$ZZO$i_O$j`O$k`O$laO$mbO~Ox#sO~P0YO!O#uO~OZ!dO}!lO!l!fO[{a]{a^{a_{a`{aa{ap{ar{at{au{av{ax$bX#o{a$t{a$P{ac{az{a!j{ag{ad{a#U{ah{an{a~Oz$eP~P`Oc$POz$OO~P%]Oc$PO$P$QO!j$eX~P%]O!j$SO~O#qRO#rROz$qP~OZ#_O[#_O]#_O^#_O_#_O`#_O#p!yO#}#_O~O$]#ZX~P4|O$]$ZO~O$P$[O#U$sX~O#U$^O~Og$_O~P%]O$P$`On$TX~On$bO~O!Y$cO~O!V$dO~Oc$PO~P%]O#o!{a$t!{a$P!{ac!{az!{a!j!{ag!{ad!{a#U!{ah!{an!{a~P%]O$P#[O#o$Uaz$Ua~OZ#_O[#_O]#_O^#_O_#_O`#_O#qRO#rRO#}#_O~OaWa$]WazWa$PWa~P7zO$P#dOd#{a~OZ!dO[!^O]!^O^!_O_!_O`!`O}!lO!l!fOx$bX~Oasipsirsitsiusivsi#osi$tsi$Psicsizsi!jsigsidsi#Usihsinsi~P9ROZ!dO`!`O}!lO!l!fO[{i]{ia{ip{ir{it{iu{iv{ix$bX#o{i$t{i$P{ic{iz{i!j{ig{id{i#U{ih{in{i~O^!_O_!_O~P:yO^{i_{i~P:yOZ!dO}!lO!l!fO[{i]{i^{i_{i`{ia{ip{ir{it{iu{iv{ix$bX#o{i$t{i$P{ic{iz{i!j{ig{id{i#U{ih{in{i~O#qRO#rROZ!iX[!iX]!iX^!iX_!iX`!iXa!iXp!iXr!iXt!iXu!iXv!iXx!iX}!iX!l!iX#o!iX$t!iX$P!iXc!iXz!iX!j!iXg!iXd!iX#U!iXh!iXn!iX~O!j$pO~P%]Oa!kOr!iOt!]Ou!]Ov!jOpoi#ooi$toi$Poicoizoi!joigoidoi#Uoihoinoi~P9ROa!kOt!]Ou!]Ov!jOpqirqi#oqi$tqi$Pqicqizqi!jqigqidqi#Uqihqinqi~P9ROa!kOp!hOr$qOt!]Ou!]Ov!jO~P9RO!U$vO!X$wO!Z$xO!^$yO!a$zO!e${O#qRO#rRO$ZZO~OZ#eX[#eX]#eX^#eX_#eX`#eXa#eXp#eXr#eXt#eXu#eXv#eXx#eXz#eX}#eX!l#eX#q#eX#r#eX#s#eX$P#eX~P.lO$P$QOz$eX~P%]O$]$}O~O$P%OOz$dX~Oz%QO~O$P$QO!j$eaz$ea~O$]%UOz#RX$P#RX~O$P%VOz$qX~Oz%XO~O$]#Za~P4|O#p!yO$j`O$k`O~O$P$[O#U$sa~O$P$`On$Ta~O!W%bO~OzrO~Oc%cOdbX$PbXnbX~P%]O#oSq$tSq$PSqcSqzSq!jSqgSqdSq#USqhSqnSq~P%]Oc$POz$OO$PwX~P%]Oz%eO~OZ%fO[!QX]!QX^!QX_!QX`!QXa!QXp!QXr!QXt!QXu!QXv!QXx!QX}!QX!l!QX#o!QX$t!QX$P!QXc!QXz!QX!j!QXg!QXd!QX#U!QXh!QXn!QX~Or%hO~Or%iO~Or%jO~O!_%kO~O!_%lO~O!_%mO~O$P%OOz$da~OZ!dO[!^O]!^O^!_O_!_O`!`Oa!kOp!hOr!iOt!]Ou!]Ov!jO}!lOx$bX~Oz%rO!j%rO!l%qO~PLPO!j#ja$P#jaz#ja~P%]O$P%VOz$qa~O#S%xO~P`O#U#Xi$P#Xi~P%]Oh%yO~P%]O#oiq$tiq$Piqciqziq!jiqgiqdiq#Uiqhiqniq~P%]Oasypsyrsytsyusyvsy#osy$tsy$Psycsyzsy!jsygsydsy#Usyhsynsy~P9ROZ%fO[!Qa]!Qa^!Qa_!Qa`!Qaa!Qap!Qar!Qat!Qau!Qav!Qax!Qa}!Qa!l!Qa#o!Qa$t!Qa$P!Qac!Qaz!Qa!j!Qag!Qad!Qa#U!Qah!Qan!Qa~O!V%}O~O!Y%}O~O!V&OO~O!U$vO!X$wO!Z$xO!^$yO!a$zO!e&tO#qRO#rRO$ZZO~O![$^P~P!$^Oz!pi$P!pi~P%]OT$aXZ!|y[$aX]$aX^!|y_!|y`!|ya!|yf$aXj$aXk$aXp!|yr!|yt$aXu$aXv!|yx$aX}!|y!V$aX!W$aX!X$aX!Z$aX!e$aX!j$aX!l$aX!s$aX!z$aX#V$aX#o!|y#q$aX#r$aX$Z$aX$i$aX$j$aX$k$aX$l$aX$m$aX$t!|y$P!|yc!|yz!|yg!|yd!|y#U!|yh!|yn!|y~O#o#TX$t#TX$P#TXc#TXz#TX!j#TXg#TXd#TX#U#TXh#TXn#TX~P%]Odbi$Pbinbi~P%]O!W&^O~O#qRO#rROZ!RX![!RX$P!RX~OZ&oO![!QX$P!QX~O![&`O~O$]&aO~O$P&bO![$[X~O![&dO~O$P&eO![$^X~O![&gO~O#oe!R$te!R$Pe!Rce!Rze!R!je!Rge!Rde!R#Ue!Rhe!Rne!R~P%]OZ&oO![!Qa$P!Qa~O$P&bO![$[a~O$P&eO![$^a~O$_&mO~O$_&pO~O![&qO~O!_&sO~O$Z$j~$j$k`_$iZQP^Q~",
  goto: "E`$tPPPP$uP%m%p%v&W'qPPPPPPP'zPP$uPPP$uPP'}(QP$uP$uP$uPPP(WP(cP$u$uPP(l)R)^*g)RPPPPPPP)RPP)RP+m+p)RP+v+|$u,TP$uP$u,W-O-R-X-OP-a.X-a-a/W0OP$u0v$u1n1n2f2iP2oPP1n2u2{/S3PPP3XP3[3c3i3o3u5S5^5d5j5p5w5}6T6ZPPPPPPPP6a6j8n9f:^:aP:iP:l:o;g<_<b<g=T=r>bP?YP?]P?a@R@sAkAqAt$uAzAzPPPPPBr8nCjDbDeE]!kjOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yR![SQ!YSR$m#dW!WSw#d$`W#x!p!x%O%VT&S%l&b#WXOPQWYilu|}!]!a!b!c!e!g!h!i!j!k#Y#[#^#b#f#l#s#u$P$Q$Z$_$b$q$}%U%X%c%f%k%m%x%y&P&a&e&m&o&p&sb!VSw!x#d$`%O%V%l&bU#`!V#a#vR#v!pU#`!V#a#vT$X!z$YR$l#bR#TwQ#RwR%_$`U!RQ#^#sQ#t!kR$g#[QrQQ$i#^R$s#sQ$|#uQ%s%UQ&R%kU&W%m&e&sQ&h&aT&n&m&pc$u#u%U%k%m&a&e&m&p&s!jkOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yU$t#u%U&mS%{%f&o]&Q%k%m&a&e&p&s#Q[OPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s#u$P$Q$Z$_$b$q$}%U%X%c%f%k%m%x%y&a&e&m&o&p&sR#m!eR&V%lQ&T%lR&i&bQ&Z%mR&r&sS&X%m&sR&k&eR#n!e!k]OPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yR#}!pQ#z!pR%o%OS#y!p%OT$T!x%V!keOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%y!jeOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yQ!rbT!{o$[!kcOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%y!kdOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%y!khOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%y!kpOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yR$W!xQ$U!xR%t%VQ%w%XR&[%xQ!}oR%[$[T!|o$[S!zo$[T$X!z$YRrQS#a!V#vR$j#aQ#e!YR$n#eQ$a#RR%`$aQ#]!RR$h#]!rYOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s#u$P$Q$Z$_$b$q$}%U%X%c%f%x%y&mU!oY#l&PQ#l!e_&P%k%m&a&e&o&p&sQ%g$tS%|%g&_R&_&QQ&c&TR&j&cQ&f&XR&l&fQ%P#zR%p%PS$R!v#wR%T$RQ%W$UR%u%WQ$Y!zR%Y$YQ$]!}R%]$]Q#Z!PR$f#ZQrOQ!PPR$e#YUTOP#YW!QQ!k#[#^Q!nWQ!tiQ!vlQ#PuQ#W|Q#X}Q#h!]Q#i!aQ#j!bQ#k!cQ#o!gQ#p!hQ#q!iQ#r!jQ#w!pQ$k#bQ$o#fQ$r#sQ%R$PQ%S$QQ%Z$ZQ%^$_Q%a$bQ%d$qQ%n$}S%v%X%xQ%z%cR&]%y!kqOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%y!kSOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yR!ZSS!XS#dT#Qw$`R#b!WR#f![!kuOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%y!kwOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yR#SwV!SQ#^#s!V!aT!Q!t!v#P#W#X#h#o#p#q#r#w$k$o$r%R%S%Z%^%a%d%n%v%z&]!X!bT!Q!t!v#P#W#X#h#i#o#p#q#r#w$k$o$r%R%S%Z%^%a%d%n%v%z&]!Z!cT!Q!t!v#P#W#X#h#i#j#o#p#q#r#w$k$o$r%R%S%Z%^%a%d%n%v%z&]!kWOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yR&U%lT&Y%m&s!_!eT!Q!n!t!v#P#W#X#h#i#j#k#o#p#q#r#w$k$o$r%R%S%Z%^%a%d%n%v%z&]!_!gT!Q!n!t!v#P#W#X#h#i#j#k#o#p#q#r#w$k$o$r%R%S%Z%^%a%d%n%v%z&]!k^OPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yQ!q^R!scR#{!pQ!wlR#|!p!kfOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%y!klOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%y!kmOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yR$V!x!koOPQWilu|}!]!a!b!c!g!h!i!j!k!p#Y#[#^#b#f#s$P$Q$Z$_$b$q$}%X%c%x%yR#Oo",
  nodeNames: "\u26A0 LineComment BlockComment Expression ForExpression for InExpressions InExpression Name Identifier Identifier . ArithOp ArithOp ArithOp ArithOp ArithOp in IterationContext .. return IfExpression if then else QuantifiedExpression some every InExpressions InExpression satisfies Disjunction or Conjunction and Comparison CompareOp CompareOp between PositiveUnaryTest ( PositiveUnaryTests ) ArithmeticExpression InstanceOfExpression instance of Type QualifiedName VariableName BacktickIdentifier SpecialType days time duration years months date > ListType list < ContextType context ContextEntryTypes ContextEntryType FunctionType function ArgumentTypes ArgumentType PathExpression PathName ] FilterExpression [ FunctionInvocation SpecialFunctionName NamedParameters NamedParameter ParameterName PositionalParameters null NumericLiteral StringLiteral BooleanLiteral DateTimeLiteral DateTimeConstructor AtLiteral ? SimplePositiveUnaryTest Interval ParenthesizedExpression List FunctionDefinition FormalParameters FormalParameter external FunctionBody } { Context ContextEntry Key Name Identifier Expressions UnaryTests Wildcard not",
  maxTerm: 174,
  context: variableTracker,
  nodeProps: [
    ["group", -17, 4, 21, 25, 31, 33, 35, 43, 44, 70, 73, 75, 88, 89, 91, 92, 93, 100, "Expr", 49, "Expr Expr", -5, 81, 82, 83, 84, 85, "Expr Literal"],
    ["closedBy", 40, ")", 74, "]", 99, "}"],
    ["openedBy", 42, "(", 72, "[", 98, "{"]
  ],
  propSources: [feelHighlighting],
  skippedNodes: [0, 1, 2],
  repeatNodeCount: 14,
  tokenData: ".v~RvXY#iYZ$^Z[#i]^$^pq#iqr$crs$nwx(Wxy(]yz(bz{(g{|(t|}(y}!O)O!O!P)]!P!Q*g!Q![,b![!],y!]!^-O!^!_-T!_!`$i!`!a-d!b!c-n!}#O-s#P#Q-x#Q#R(o#S#T-}#o#p.l#q#r.q$f$g#i#BY#BZ#i$IS$I_#i$I|$I}$^$I}$JO$^$JT$JU#i$KV$KW#i&FU&FV#i?HT?HU#i~#nY#u~XY#iZ[#ipq#i$f$g#i#BY#BZ#i$IS$I_#i$JT$JU#i$KV$KW#i&FU&FV#i?HT?HU#i~$cO#v~~$fP!_!`$i~$nOt~~$qXOY$nYZ%^Zr$nrs&zs#O$n#O#P'R#P;'S$n;'S;=`(Q<%lO$n~%aVOr%^rs%vs#O%^#O#P%{#P;'S%^;'S;=`&t<%lO%^~%{O$j~~&ORO;'S%^;'S;=`&X;=`O%^~&[WOr%^rs%vs#O%^#O#P%{#P;'S%^;'S;=`&t;=`<%l%^<%lO%^~&wP;=`<%l%^~'RO$j~$k~~'URO;'S$n;'S;=`'_;=`O$n~'bYOY$nYZ%^Zr$nrs&zs#O$n#O#P'R#P;'S$n;'S;=`(Q;=`<%l$n<%lO$n~(TP;=`<%l$n~(]O#}~~(bOx~~(gOz~~(lP_~z{(o~(tO`~~(yO]~~)OO$P~R)TP[P!`!a)WQ)]O$_Q~)bQZ~!O!P)h!Q![)m~)mOc~~)rR$i~!Q![)m!g!h){#X#Y){~*OR{|*X}!O*X!Q![*_~*[P!Q![*_~*dP$i~!Q![*_~*lQ^~z{*r!P!Q+y~*uTOz*rz{+U{;'S*r;'S;=`+s<%lO*r~+XVOz*rz{+U{!P*r!P!Q+n!Q;'S*r;'S;=`+s<%lO*r~+sOQ~~+vP;=`<%l*r~,OSP~OY+yZ;'S+y;'S;=`,[<%lO+y~,_P;=`<%l+y~,gS$i~!O!P,s!Q![,b!g!h){#X#Y){~,vP!Q![)m~-OO$]~~-TO$t~R-[P!_QuP!_!`-_P-dOuPR-kP![QuP!_!`-_~-sO$m~~-xO!l~~-}O!j~~.QTO#S-}#S#T.a#T;'S-};'S;=`.f<%lO-}~.fO$Z~~.iP;=`<%l-}~.qO#V~~.vO#U~",
  tokenizers: [propertyIdentifiers, identifiers, insertSemicolon, 0, 1],
  topRules: { "Expression": [0, 3], "Expressions": [1, 105], "UnaryTests": [2, 106] },
  dialects: { camunda: 2657 },
  dynamicPrecedences: { "33": -1, "70": 1, "75": -1, "77": -1 },
  specialized: [{ term: 125, get: (value) => spec_identifier[value] || -1 }],
  tokenPrec: 2660
});

// node_modules/feelin/dist/index.js
function notImplemented(thing) {
  return new Error(`not implemented: ${thing}`);
}
function isNotImplemented(err) {
  return /^not implemented/.test(err.message);
}
function has2(context, name2) {
  if (Object.prototype.hasOwnProperty.call(context, name2)) {
    return true;
  }
  for (let proto = Object.getPrototypeOf(context); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name2);
    if (descriptor) {
      return typeof descriptor.get === "function";
    }
  }
  return false;
}
var NON_CONTEXT_TYPES = /* @__PURE__ */ new Set(["nil", "boolean", "number", "string"]);
function getFromContext(name2, context) {
  if (NON_CONTEXT_TYPES.has(getType(context))) {
    return void 0;
  }
  if (has2(context, name2)) {
    return context[name2];
  }
  const normalizedName = normalizeContextKey(name2);
  if (has2(context, normalizedName)) {
    return context[normalizedName];
  }
  const entry = Object.entries(context).find(([key]) => normalizedName === normalizeContextKey(key));
  if (entry) {
    return entry[1];
  }
  return void 0;
}
var REFERENCE_DATE = Temporal2.PlainDate.from("1970-01-01");
var FeelDate = class {
  constructor(value) {
    this.value = value;
    this.iso = this.value.toString();
    Object.defineProperty(this, "value", { enumerable: false });
  }
  get year() {
    return this.value.year;
  }
  get month() {
    return this.value.month;
  }
  get day() {
    return this.value.day;
  }
  get weekday() {
    return this.value.dayOfWeek;
  }
  /**
   * Return the underlying `Temporal.PlainDate`.
   *
   * Escape hatch for consumers that need the raw temporal value. The
   * returned type is implementation specific and may change.
   */
  unwrap() {
    return this.value;
  }
  toString() {
    return this.iso;
  }
  toJSON() {
    return this.iso;
  }
};
var FeelTime = class {
  constructor(value, zone = null) {
    this.value = value;
    this.zone = zone;
    this.iso = this.value.toString() + (this.zone === null ? "" : zoneSuffix(this.zone));
    Object.defineProperty(this, "value", { enumerable: false });
  }
  get hour() {
    return this.value.hour;
  }
  get minute() {
    return this.value.minute;
  }
  get second() {
    return this.value.second;
  }
  get timezone() {
    return this.zone;
  }
  /**
   * The zone offset as a {@link FeelDuration}, or `null` for a local time.
   */
  get "time offset"() {
    return this.zone === null ? null : zoneOffset(this);
  }
  /**
   * Return the underlying wall-clock `Temporal.PlainTime`.
   *
   * Escape hatch for consumers that need the raw temporal value. Zone
   * information is available via {@link timezone} / {@link 'time offset'}.
   */
  unwrap() {
    return this.value;
  }
  toString() {
    return this.iso;
  }
  toJSON() {
    return this.iso;
  }
};
var FeelDateTime = class {
  constructor(value, zone = null) {
    this.value = value;
    this.zone = zone;
    this.iso = this.value.toString() + (this.zone === null ? "" : zoneSuffix(this.zone));
    Object.defineProperty(this, "value", { enumerable: false });
  }
  get year() {
    return this.value.year;
  }
  get month() {
    return this.value.month;
  }
  get day() {
    return this.value.day;
  }
  get hour() {
    return this.value.hour;
  }
  get minute() {
    return this.value.minute;
  }
  get second() {
    return this.value.second;
  }
  get weekday() {
    return this.value.dayOfWeek;
  }
  get timezone() {
    return this.zone;
  }
  get "time offset"() {
    return this.zone === null ? null : zoneOffset(this);
  }
  /**
   * Return the underlying wall-clock `Temporal.PlainDateTime`.
   *
   * Escape hatch for consumers that need the raw temporal value. Zone
   * information is available via {@link timezone} / {@link 'time offset'}.
   */
  unwrap() {
    return this.value;
  }
  toString() {
    return this.iso;
  }
  toJSON() {
    return this.iso;
  }
};
var FeelDuration = class {
  constructor(value, yearsMonths) {
    this.value = normalize(value);
    this.yearsMonths = yearsMonths !== null && yearsMonths !== void 0 ? yearsMonths : isYearsMonths(this.value);
    this.iso = this.yearsMonths && this.value.sign === 0 ? "P0M" : this.value.toString();
    Object.defineProperty(this, "value", { enumerable: false });
  }
  get years() {
    return this.yearsMonths ? this.value.years : null;
  }
  get months() {
    return this.yearsMonths ? this.value.months : null;
  }
  get days() {
    return this.yearsMonths ? null : this.value.days;
  }
  get hours() {
    return this.yearsMonths ? null : this.value.hours;
  }
  get minutes() {
    return this.yearsMonths ? null : this.value.minutes;
  }
  get seconds() {
    return this.yearsMonths ? null : this.value.seconds;
  }
  /**
   * Return the underlying `Temporal.Duration`.
   *
   * Escape hatch for consumers that need the raw temporal value. The
   * returned type is implementation specific and may change.
   */
  unwrap() {
    return this.value;
  }
  toString() {
    return this.iso;
  }
  toJSON() {
    return this.iso;
  }
};
function isDate(obj) {
  return obj instanceof FeelDate;
}
function isTime(obj) {
  return obj instanceof FeelTime;
}
function isDateTime(obj) {
  return obj instanceof FeelDateTime;
}
function isDuration(obj) {
  return obj instanceof FeelDuration;
}
function isTemporal(obj) {
  return isDate(obj) || isTime(obj) || isDateTime(obj);
}
function isZoned(obj) {
  return (isTime(obj) || isDateTime(obj)) && obj.zone !== null;
}
var Z_SUFFIX_PATTERN = /z$/i;
var OFFSET_SUFFIX_PATTERN = /[+-]\d{2}:\d{2}(:\d{2})?$/;
var OFFSET_ZONE_PATTERN = /^[+-]\d{2}:\d{2}(:\d{2})?$/;
var OFFSET_SECONDS_PATTERN = /^([+-])(\d{2}):(\d{2}):(\d{2})$/;
var FIXED_OFFSET_PATTERN = /^([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/;
var YEARS_MONTHS_PATTERN = /[YM]/;
var LEAP_SECOND_PATTERN = /^\d{2}:\d{2}:60/;
function splitZone(str) {
  const atIndex = str.indexOf("@");
  if (atIndex !== -1) {
    return {
      value: str.substring(0, atIndex),
      zone: str.substring(atIndex + 1)
    };
  }
  if (Z_SUFFIX_PATTERN.test(str)) {
    return {
      value: str.substring(0, str.length - 1),
      zone: "UTC"
    };
  }
  const offsetMatch = OFFSET_SUFFIX_PATTERN.exec(str);
  if (offsetMatch) {
    return {
      value: str.substring(0, offsetMatch.index),
      zone: offsetMatch[0]
    };
  }
  return {
    value: str,
    zone: null
  };
}
function zoneSuffix(zone) {
  if (zone === "UTC") {
    return "Z";
  }
  if (OFFSET_ZONE_PATTERN.test(zone)) {
    return zone;
  }
  return `@${zone}`;
}
function offsetZoneSeconds(zone) {
  if (zone === null) {
    return null;
  }
  const match = OFFSET_SECONDS_PATTERN.exec(zone);
  if (!match) {
    return null;
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]));
}
function fixedOffsetSeconds(zone) {
  var _a;
  if (zone === "UTC") {
    return 0;
  }
  const match = FIXED_OFFSET_PATTERN.exec(zone);
  if (!match) {
    return null;
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number((_a = match[4]) !== null && _a !== void 0 ? _a : 0));
}
var zoneValidity = /* @__PURE__ */ new Set();
function isValidZone(zone) {
  if (zone === null) {
    return true;
  }
  const offsetSeconds = offsetZoneSeconds(zone);
  if (offsetSeconds !== null) {
    return Math.abs(offsetSeconds) < 24 * 3600;
  }
  if (zoneValidity.has(zone)) {
    return true;
  }
  try {
    new Temporal2.PlainDateTime(1970, 1, 1).toZonedDateTime(zone);
  } catch (_a) {
    return false;
  }
  zoneValidity.add(zone);
  return true;
}
function zoneEquals(a, b) {
  if (a === null || b === null) {
    return a === b;
  }
  const aOffset = fixedOffsetSeconds(a);
  const bOffset = fixedOffsetSeconds(b);
  if (aOffset !== null && bOffset !== null) {
    return aOffset === bOffset;
  }
  return a === b;
}
function zonedDateTime(temporal) {
  if (temporal instanceof FeelTime) {
    return REFERENCE_DATE.toZonedDateTime({
      plainTime: temporal.value,
      timeZone: temporal.zone
    });
  }
  return temporal.value.toZonedDateTime(temporal.zone);
}
function offsetDuration(zdt) {
  return new FeelDuration(Temporal2.Duration.from({ nanoseconds: zdt.offsetNanoseconds }));
}
function zoneOffset(temporal) {
  const seconds = offsetZoneSeconds(temporal.zone);
  if (seconds !== null) {
    return new FeelDuration(Temporal2.Duration.from({ seconds }), false);
  }
  return offsetDuration(zonedDateTime(temporal));
}
function toComparable(value) {
  var _a;
  if (isDate(value)) {
    return value.value.toZonedDateTime("UTC").epochMilliseconds;
  }
  if (isTime(value) || isDateTime(value)) {
    const offsetSeconds = offsetZoneSeconds(value.zone);
    if (offsetSeconds !== null) {
      const utcEpoch = (value instanceof FeelTime ? REFERENCE_DATE.toZonedDateTime({ plainTime: value.value, timeZone: "UTC" }) : value.value.toZonedDateTime("UTC")).epochMilliseconds;
      return utcEpoch - offsetSeconds * 1e3;
    }
    const zone = (_a = value.zone) !== null && _a !== void 0 ? _a : "UTC";
    return (value instanceof FeelTime ? REFERENCE_DATE.toZonedDateTime({ plainTime: value.value, timeZone: zone }) : value.value.toZonedDateTime(zone)).epochMilliseconds;
  }
  if (isDuration(value)) {
    return value.value.total({ unit: "millisecond", relativeTo: REFERENCE_DATE });
  }
  return null;
}
function normalize(d) {
  if (d.years !== 0 || d.months !== 0) {
    return d.round({ largestUnit: "year", relativeTo: REFERENCE_DATE });
  }
  return d.round({ largestUnit: "day", relativeTo: REFERENCE_DATE });
}
function isYearsMonths(d) {
  return d.years !== 0 || d.months !== 0;
}
function isYearsMonthsString(str) {
  const datePart = str.split("T")[0];
  return YEARS_MONTHS_PATTERN.test(datePart);
}
function durationEquals(a, b) {
  const total = (d, unit) => d.value.total({ unit, relativeTo: REFERENCE_DATE });
  if (Math.abs(total(a, "day")) > 180) {
    return Math.trunc(total(a, "month") - total(b, "month")) === 0;
  }
  return Math.trunc(total(a, "second") - total(b, "second")) === 0;
}
var DURATION_PATTERN = /^-?P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
function duration(opts) {
  if (typeof opts === "number") {
    return new FeelDuration(Temporal2.Duration.from({ milliseconds: opts }), false);
  }
  if (!DURATION_PATTERN.test(opts)) {
    return null;
  }
  try {
    return new FeelDuration(Temporal2.Duration.from(opts), isYearsMonthsString(opts));
  } catch (_a) {
    return null;
  }
}
function absDuration2(d) {
  return new FeelDuration(d.value.abs(), d.yearsMonths);
}
function hasTimeComponent(d) {
  const { hours, minutes, seconds, milliseconds } = d.value;
  return !!(hours || minutes || seconds || milliseconds);
}
function addDuration(temporal, dur, sign) {
  const d = sign < 0 ? dur.value.negated() : dur.value;
  if (isDate(temporal)) {
    if (hasTimeComponent(dur)) {
      return new FeelDateTime(temporal.value.toPlainDateTime().add(d), "UTC");
    }
    return new FeelDate(temporal.value.add(d));
  }
  if (isTime(temporal)) {
    return new FeelTime(temporal.value.add(d), temporal.zone);
  }
  if (temporal.zone === null) {
    return new FeelDateTime(temporal.value.add(d), null);
  }
  if (offsetZoneSeconds(temporal.zone) !== null) {
    return new FeelDateTime(temporal.value.add(d), temporal.zone);
  }
  const shifted = temporal.value.toZonedDateTime(temporal.zone).add(d);
  return new FeelDateTime(shifted.toPlainDateTime(), temporal.zone);
}
function subtractTemporals(a, b) {
  if (isTime(a) && isTime(b)) {
    return new FeelDuration(a.value.since(b.value));
  }
  const left = toPlainDateTime(a);
  const right = toPlainDateTime(b);
  return new FeelDuration(left.since(right, { largestUnit: "day" }));
}
function addDurations(a, b, sign) {
  if (a.yearsMonths !== b.yearsMonths) {
    return null;
  }
  const other = sign < 0 ? b.value.negated() : b.value;
  if (a.yearsMonths) {
    const anchor = REFERENCE_DATE.toPlainDateTime();
    const result = anchor.add(a.value).add(other).since(anchor, { largestUnit: "year" });
    return new FeelDuration(result, true);
  }
  return new FeelDuration(a.value.add(other), false);
}
function yearsAndMonthsDuration(from, to) {
  return new FeelDuration(from.value.until(to.value, { largestUnit: "month" }), true);
}
function toPlainDateTime(temporal) {
  if (isDate(temporal)) {
    return temporal.value.toPlainDateTime();
  }
  if (isDateTime(temporal)) {
    return temporal.value;
  }
  return REFERENCE_DATE.toPlainDateTime(temporal.value);
}
function dateOf(dateTime) {
  return new FeelDate(dateTime.value.toPlainDate());
}
function timeOf(dateTime) {
  return new FeelTime(dateTime.value.toPlainTime(), dateTime.zone);
}
function timeOfDate(_date) {
  return new FeelTime(new Temporal2.PlainTime(0, 0, 0), "UTC");
}
function combine(date2, time2) {
  const datePart = isDate(date2) ? date2.value : date2.value.toPlainDate();
  return new FeelDateTime(datePart.toPlainDateTime(time2.value), time2.zone);
}
function dateFrom(year, month, day) {
  try {
    return new FeelDate(Temporal2.PlainDate.from({ year, month, day }, { overflow: "reject" }));
  } catch (_a) {
    return null;
  }
}
function timeFrom(hour, minute, second, offset = null) {
  try {
    const value = Temporal2.PlainTime.from({ hour, minute, second }, { overflow: "reject" });
    const zone = offset ? offsetZone(offset) : null;
    if (zone !== null) {
      const offsetSeconds = offsetZoneSeconds(zone);
      if (offsetSeconds !== null) {
        if (Math.abs(offsetSeconds) >= 24 * 3600) {
          return null;
        }
      } else {
        REFERENCE_DATE.toZonedDateTime({ plainTime: value, timeZone: zone });
      }
    }
    return new FeelTime(value, zone);
  } catch (_a) {
    return null;
  }
}
function offsetZone(offset) {
  const totalSeconds = Math.trunc(offset.value.total({ unit: "second", relativeTo: REFERENCE_DATE }));
  const sign = totalSeconds < 0 ? "-" : "+";
  const abs = Math.abs(totalSeconds);
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor(abs % 3600 / 60);
  const seconds = abs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const base = `${sign}${pad(hours)}:${pad(minutes)}`;
  return seconds ? `${base}:${pad(seconds)}` : base;
}
function parseDate(str) {
  if (str.startsWith("-")) {
    throw notImplemented("negative date");
  }
  try {
    return new FeelDate(Temporal2.PlainDate.from(str));
  } catch (_a) {
    return null;
  }
}
function parseTime(str) {
  const { value, zone } = splitZone(str);
  if (LEAP_SECOND_PATTERN.test(value)) {
    return null;
  }
  try {
    if (!isValidZone(zone)) {
      return null;
    }
    return new FeelTime(Temporal2.PlainTime.from(value), zone);
  } catch (_a) {
    return null;
  }
}
function parseDateTime(str) {
  if (str.startsWith("-")) {
    throw notImplemented("negative date");
  }
  const { value: parsedValue, zone } = splitZone(str);
  let value = parsedValue;
  if (!value.includes("T")) {
    value = `${value}T00:00:00`;
  }
  try {
    if (!isValidZone(zone)) {
      return null;
    }
    return new FeelDateTime(Temporal2.PlainDateTime.from(value), zone);
  } catch (_a) {
    return null;
  }
}
function date(str) {
  if (str.includes("T")) {
    return parseDateTime(str);
  }
  return parseDate(str);
}
function time(str) {
  return parseTime(str);
}
function dateAndTime(str) {
  return parseDateTime(str);
}
function now() {
  const zdt = Temporal2.Now.zonedDateTimeISO();
  return new FeelDateTime(zdt.toPlainDateTime(), zdt.timeZoneId);
}
function today() {
  return new FeelDate(Temporal2.Now.plainDateISO());
}
function toFeel(value) {
  if (isDate(value) || isTime(value) || isDateTime(value) || isDuration(value)) {
    return value;
  }
  if (value instanceof Temporal2.PlainDate) {
    return new FeelDate(value);
  }
  if (value instanceof Temporal2.PlainTime) {
    return new FeelTime(value);
  }
  if (value instanceof Temporal2.PlainDateTime) {
    return new FeelDateTime(value);
  }
  if (value instanceof Temporal2.ZonedDateTime) {
    return new FeelDateTime(value.toPlainDateTime(), value.timeZoneId);
  }
  if (value instanceof Temporal2.Duration) {
    return new FeelDuration(value);
  }
  if (value instanceof Date) {
    const zdt = Temporal2.Instant.fromEpochMilliseconds(value.getTime()).toZonedDateTimeISO("UTC");
    return new FeelDateTime(zdt.toPlainDateTime(), "UTC");
  }
  return value;
}
var TEMPORAL_INSTANT_TYPES = /* @__PURE__ */ new Set(["date", "time", "date time"]);
var FeelRange = class {
  constructor(props) {
    Object.assign(this, props);
    Object.defineProperty(this, "valueType", { enumerable: false });
  }
  /**
   * Whether the range includes the given point or range. Returns `null`
   * for the empty range or a `null` probe.
   */
  includes(value) {
    return rangeIncludes(this, value);
  }
  /**
   * Enumerate the range, applying `fn` to each element. Only defined for
   * closed number ranges and single-character string ranges.
   */
  map(fn2) {
    return rangeMap(this, fn2);
  }
  toString() {
    const startBracket = this["start included"] ? "[" : "(";
    const endBracket = this["end included"] ? "]" : ")";
    return `${startBracket}${this.start}..${this.end}${endBracket}`;
  }
};
function isRange(obj) {
  return obj instanceof FeelRange;
}
function comparable(value) {
  const c = toComparable(value);
  return c === null ? value : c;
}
function cmp(a, b) {
  const ca = comparable(a);
  const cb = comparable(b);
  if (ca < cb) {
    return -1;
  }
  if (ca > cb) {
    return 1;
  }
  return 0;
}
function afterStart(value, start, startIncluded) {
  if (start === null) {
    return true;
  }
  const c = cmp(value, start);
  return startIncluded ? c >= 0 : c > 0;
}
function beforeEnd(value, end, endIncluded) {
  if (end === null) {
    return true;
  }
  const c = cmp(value, end);
  return endIncluded ? c <= 0 : c < 0;
}
function rangeIncludes(range, value) {
  let { start, end } = range;
  let startIncluded = range["start included"];
  let endIncluded = range["end included"];
  if (start === null && end === null) {
    return null;
  }
  if (value === null || value === void 0) {
    return null;
  }
  if (value instanceof FeelRange) {
    return rangeIncludesRange(range, value);
  }
  const valueType = getType(value);
  if (range.valueType !== null && TEMPORAL_INSTANT_TYPES.has(valueType) && TEMPORAL_INSTANT_TYPES.has(range.valueType) && valueType !== range.valueType) {
    return null;
  }
  if (start !== null && end !== null && cmp(start, end) > 0) {
    [start, end] = [end, start];
    [startIncluded, endIncluded] = [endIncluded, startIncluded];
  }
  return afterStart(value, start, startIncluded) && beforeEnd(value, end, endIncluded);
}
function rangeIncludesRange(container, value) {
  const startOk = container.start === null || value.start !== null && (() => {
    const c = cmp(container.start, value.start);
    return c < 0 || c === 0 && (container["start included"] || !value["start included"]);
  })();
  const endOk = container.end === null || value.end !== null && (() => {
    const c = cmp(container.end, value.end);
    return c > 0 || c === 0 && (container["end included"] || !value["end included"]);
  })();
  return startOk && endOk;
}
function before(a, b) {
  if (a instanceof FeelRange && b instanceof FeelRange) {
    const c = cmp(a.end, b.start);
    return c < 0 || c === 0 && (!a["end included"] || !b["start included"]);
  }
  if (a instanceof FeelRange) {
    const c = cmp(a.end, b);
    return c < 0 || c === 0 && !a["end included"];
  }
  if (b instanceof FeelRange) {
    const c = cmp(b.start, a);
    return c > 0 || c === 0 && !b["start included"];
  }
  return cmp(a, b) < 0;
}
function meets(a, b) {
  return cmp(a.end, b.start) === 0 && a["end included"] === true && b["start included"] === true;
}
function includes(range, value) {
  if (!(range instanceof FeelRange)) {
    return false;
  }
  return rangeIncludes(range, value);
}
var CHARS = Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
var CHAR_TO_INDEX = new Map(CHARS.map((c, i) => [c, i]));
function rangeMap(range, fn2) {
  const { start, end, valueType } = range;
  if (start === null && end === null) {
    return [];
  }
  if (valueType === "number" && start !== null && end !== null) {
    return numberRangeMap(start, end, range["start included"], range["end included"], fn2);
  }
  if (valueType === "string" && start !== null && end !== null) {
    const values = charRangeValues(start, end, range["start included"], range["end included"]);
    if (values) {
      return values.map(fn2);
    }
  }
  throw new Error("unsupported range operation: map");
}
function numberRangeMap(start, end, startIncluded, endIncluded, fn2) {
  const direction = start > end ? -1 : 1;
  const result = [];
  for (let i = start; ; i += direction) {
    if (i === start && !startIncluded) {
      continue;
    }
    if (i === end && !endIncluded) {
      break;
    }
    result.push(fn2(i));
    if (i === end) {
      break;
    }
  }
  return result;
}
function charRangeValues(start, end, startIncluded, endIncluded) {
  let startIdx = CHAR_TO_INDEX.get(start);
  let endIdx = CHAR_TO_INDEX.get(end);
  if (startIdx === void 0 || endIdx === void 0) {
    return null;
  }
  const direction = startIdx > endIdx ? -1 : 1;
  if (startIncluded === false) {
    startIdx += direction;
  }
  if (endIncluded === false) {
    endIdx -= direction;
  }
  return CHARS.slice(Math.min(startIdx, endIdx), Math.max(startIdx, endIdx) + 1);
}
var RANGE_TYPES = /* @__PURE__ */ new Set(["string", "number", "duration", "time", "date time", "date"]);
function createRange(start, end, startIncluded = true, endIncluded = true) {
  const startType = start === null ? null : getType(start);
  const endType = end === null ? null : getType(end);
  const type = startType !== null && startType !== void 0 ? startType : endType;
  const valueType = type !== null && RANGE_TYPES.has(type) && (startType === null || startType === type) && (endType === null || endType === type) ? type : null;
  if (valueType === null && !(start === null && end === null)) {
    throw new Error(`unsupported range: ${start}..${end}`);
  }
  return new FeelRange({
    start,
    end,
    "start included": startIncluded,
    "end included": endIncluded,
    valueType
  });
}
var InvocationFailure = class {
  constructor(warning, template, values = {}) {
    this.warning = warning;
    this.template = template;
    this.values = values;
  }
};
function invalidArguments(template, values = {}) {
  return new InvocationFailure("INVALID_ARGUMENTS", template, values);
}
function parameterMismatch(target, params) {
  return new InvocationFailure("FUNCTION_INVOCATION_FAILURE", "Cannot invoke {target} with parameters {params}", { target, params });
}
function isInvocationFailure(value) {
  return value instanceof InvocationFailure;
}
var FeelFunction = class {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(fn2, parameterNames) {
    this.fn = fn2;
    this.parameterNames = parameterNames;
    Object.defineProperty(this, "fn", { enumerable: false });
  }
  invoke(contextOrArgs) {
    let params;
    if (isArray(contextOrArgs)) {
      params = contextOrArgs;
      if (params.length > this.parameterNames.length) {
        const lastParam = this.parameterNames[this.parameterNames.length - 1];
        if (!lastParam || !lastParam.startsWith("...")) {
          return parameterMismatch(this, contextOrArgs);
        }
      }
    } else {
      for (const key of Object.keys(contextOrArgs)) {
        if (!this.parameterNames.includes(key) && !this.parameterNames.includes(`...${key}`)) {
          return parameterMismatch(this, contextOrArgs);
        }
      }
      params = [];
      for (let name2 of this.parameterNames) {
        if (name2.startsWith("...")) {
          name2 = name2.slice(3);
          const value = contextOrArgs[name2];
          if (isNil2(value)) {
            continue;
          }
          if (isArray(value)) {
            for (const v of value) {
              params.push(v);
            }
          } else {
            params.push(value);
          }
          continue;
        }
        params.push(contextOrArgs[name2]);
      }
    }
    return this.fn.call(null, ...params);
  }
};
function isFunction(obj) {
  return obj instanceof FeelFunction;
}
function parseParameterNames(fn2) {
  if (Array.isArray(fn2.$args)) {
    return fn2.$args;
  }
  const code = fn2.toString();
  const match = /^(?:[^(]*\s*)?\(([^)]+)?\)/.exec(code);
  if (!match) {
    throw new Error("failed to parse params: " + code);
  }
  const [_, params] = match;
  if (!params) {
    return [];
  }
  return params.split(",").map((p) => p.trim());
}
function wrapFunction(fn2, parameterNames = null) {
  if (!fn2) {
    return null;
  }
  if (fn2 instanceof FeelFunction) {
    return fn2;
  }
  if (isRange(fn2)) {
    return new FeelFunction((value) => fn2.includes(value), ["value"]);
  }
  if (typeof fn2 !== "function") {
    return null;
  }
  return new FeelFunction(fn2, parameterNames || parseParameterNames(fn2));
}
var TEMPORAL_TYPES$1 = /* @__PURE__ */ new Set(["date time", "time", "date"]);
function isNil2(e) {
  return e === null || e === void 0;
}
function isContext(e) {
  return !isNil2(e) && Object.getPrototypeOf(e) === Object.prototype;
}
function isArray(e) {
  return Array.isArray(e);
}
function isBoolean(e) {
  return typeof e === "boolean";
}
function getType(e) {
  if (isNil2(e)) {
    return "nil";
  }
  if (isBoolean(e)) {
    return "boolean";
  }
  if (isNumber(e)) {
    return "number";
  }
  if (isString(e)) {
    return "string";
  }
  if (isArray(e)) {
    return "list";
  }
  if (isContext(e)) {
    return "context";
  }
  if (isDate(e)) {
    return "date";
  }
  if (isTime(e)) {
    return "time";
  }
  if (isDateTime(e)) {
    return "date time";
  }
  if (isDuration(e)) {
    return "duration";
  }
  if (isRange(e)) {
    return "range";
  }
  if (isFunction(e)) {
    return "function";
  }
  return "literal";
}
function isType(el, type) {
  return getType(el) === type;
}
function typeCast(obj, type) {
  if (isDate(obj)) {
    if (type === "date time") {
      return combine(obj, timeFrom(0, 0, 0));
    }
    return null;
  }
  if (isTime(obj)) {
    return null;
  }
  if (isDateTime(obj)) {
    if (type === "time") {
      return timeOf(obj);
    }
    if (type === "date") {
      return dateOf(obj);
    }
    if (type === "date time") {
      return obj;
    }
  }
  return null;
}
function isNumber(obj) {
  return typeof obj === "number";
}
function isString(obj) {
  return typeof obj === "string";
}
function equals(a, b, strict = false) {
  var _a, _b;
  if (a === null && b !== null || a !== null && b === null) {
    return false;
  }
  if (isArray(a) && a.length < 2) {
    a = a[0];
  }
  if (isArray(b) && b.length < 2) {
    b = b[0];
  }
  const aType = getType(a);
  const bType = getType(b);
  if (TEMPORAL_TYPES$1.has(aType)) {
    if (!TEMPORAL_TYPES$1.has(bType)) {
      return null;
    }
    if (aType !== bType) {
      return strict ? false : null;
    }
    if (isZoned(a) !== isZoned(b)) {
      return false;
    }
    if (strict && !zoneEquals((_a = a.zone) !== null && _a !== void 0 ? _a : null, (_b = b.zone) !== null && _b !== void 0 ? _b : null)) {
      return false;
    }
    return toComparable(a) === toComparable(b);
  }
  if (aType !== bType) {
    return null;
  }
  if (aType === "nil") {
    return true;
  }
  if (aType === "list") {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((element, idx) => equals(element, b[idx]));
  }
  if (aType === "duration") {
    return durationEquals(a, b);
  }
  if (aType === "context") {
    const aEntries = Object.entries(a);
    const bEntries = Object.entries(b);
    if (aEntries.length !== bEntries.length) {
      return false;
    }
    return aEntries.every(([key, value]) => has2(b, key) && equals(value, b[key]));
  }
  if (aType === "range") {
    return a["start included"] === b["start included"] && a["end included"] === b["end included"] && equals(a.start, b.start) === true && equals(a.end, b.end) === true;
  }
  if (a == b) {
    return true;
  }
  return aType === bType ? false : null;
}
var builtins = {
  // 10.3.4.1 Conversion functions
  "number": fn(function(from, groupingSeparator, decimalSeparator) {
    if (arguments.length !== 3) {
      return null;
    }
    const original = from;
    if (groupingSeparator) {
      from = from.split(groupingSeparator).join("");
    }
    if (decimalSeparator && decimalSeparator !== ".") {
      from = from.split(".").join("#").split(decimalSeparator).join(".");
    }
    const number2 = +from;
    if (isNaN(number2)) {
      return invalidArguments("number(from) expects a numeric string, got {from}", {
        from: original
      });
    }
    return number2;
  }, ["string", "string?", "string?"], ["from", "grouping separator", "decimal separator"]),
  "string": fn(function(from) {
    if (from === null) {
      return null;
    }
    return toString2(from);
  }, ["any"], ["from"]),
  // date(from) => date string
  // date(from) => date and time
  // date(year, month, day)
  "date": fn(function(year, month, day, from) {
    if (!from && !isNumber(year)) {
      from = year;
      year = null;
    }
    let d;
    if (isString(from)) {
      d = parseDate(from);
    } else if (isDate(from)) {
      d = from;
    } else if (isDateTime(from)) {
      d = dateOf(from);
    }
    if (isNumber(year)) {
      const error = guard(from == null, "date(year, month, day) does not accept a <from> argument") || guard(isNumber(month) && isNumber(day), "date(year, month, day) expects <month> and <day> to be numbers");
      if (error) {
        return error;
      }
      d = dateFrom(year, month, day);
      if (!d) {
        return invalidArguments("{year}, {month}, {day} is not a valid date", {
          year,
          month,
          day
        });
      }
    }
    if (d) {
      return d;
    }
    return invalidArguments("date({from}) is not a valid date", { from });
  }, ["any?", "number?", "number?", "any?"], ["year", "month", "day", "from"]),
  // date and time(from) => date time string
  // date and time(date, time)
  "date and time": fn(function(d, time2, from) {
    const dateArg = d;
    let dt;
    if ((isDate(d) || isDateTime(d)) && isTime(time2)) {
      dt = combine(d, time2);
    }
    if (isString(d)) {
      from = d;
      d = null;
    }
    if (isString(from)) {
      dt = parseDateTime(from);
    }
    if (dt) {
      return dt;
    }
    return invalidArguments("date and time({from}) is not a valid date time", {
      from: isString(from) ? from : dateArg
    });
  }, ["any?", "time?", "string?"], ["date", "time", "from"]),
  // time(from) => time string
  // time(from) => time, date and time
  // time(hour, minute, second, offset?) => ...
  "time": fn(function(hour, minute, second, offset, from) {
    let t2;
    if (isString(hour) || isDate(hour) || isDateTime(hour) || isTime(hour)) {
      from = hour;
      hour = null;
    }
    if (isString(from) && from) {
      t2 = parseTime(from);
    }
    if (isTime(from)) {
      t2 = from;
    }
    if (isDateTime(from)) {
      t2 = timeOf(from);
    }
    if (isDate(from)) {
      t2 = timeOfDate();
    }
    if (isNumber(hour)) {
      const error = guard(isNumber(minute) && isNumber(second), "time(hour, minute, second) expects <minute> and <second> to be numbers") || guard(offset == null || isDuration(offset), "time(hour, minute, second, offset) expects <offset> to be a duration");
      if (error) {
        return error;
      }
      t2 = timeFrom(hour, minute, second, offset);
      if (!t2) {
        return invalidArguments("{hour}, {minute}, {second} is not a valid time", {
          hour,
          minute,
          second
        });
      }
    }
    if (t2) {
      return t2;
    }
    return invalidArguments("time({from}) is not a valid time", { from: from !== null && from !== void 0 ? from : hour });
  }, ["any?", "number?", "number?", "any?", "any?"], ["hour", "minute", "second", "offset", "from"]),
  "duration": fn(function(from) {
    const d = duration(from);
    if (!d) {
      return invalidArguments("duration({from}) is not a valid duration", { from });
    }
    return d;
  }, ["string"], ["from"]),
  "years and months duration": fn(function(from, to) {
    return yearsAndMonthsDuration(from, to);
  }, ["date", "date"], ["from", "to"]),
  "@": fn(function(string2) {
    let t2;
    if (DURATION_START_PATTERN.test(string2)) {
      t2 = duration(string2);
    } else if (TIME_START_PATTERN.test(string2)) {
      t2 = parseTime(string2);
    } else if (string2.includes("T")) {
      t2 = parseDateTime(string2);
    } else {
      t2 = parseDate(string2);
    }
    if (!t2) {
      return invalidArguments('@"{string}" is not a valid temporal literal', { string: string2 });
    }
    return t2;
  }, ["string"]),
  "now": fn(function() {
    return now();
  }, [], []),
  "today": fn(function() {
    return today();
  }, [], []),
  // 10.3.4.2 Boolean function
  "not": fn(function(negand) {
    return isType(negand, "boolean") ? !negand : null;
  }, ["any"], ["negand"]),
  // 10.3.4.3 String functions
  "substring": fn(function(string2, start, length) {
    const _start = start < 0 ? string2.length + start : start - 1;
    const arr = Array.from(string2);
    return (typeof length !== "undefined" ? arr.slice(_start, _start + length) : arr.slice(_start)).join("");
  }, ["string", "number", "number?"], ["string", "start position", "length"]),
  "string length": fn(function(string2) {
    return countSymbols(string2);
  }, ["string"], ["string"]),
  "upper case": fn(function(string2) {
    return string2.toUpperCase();
  }, ["string"], ["string"]),
  "lower case": fn(function(string2) {
    return string2.toLowerCase();
  }, ["string"], ["string"]),
  "substring before": fn(function(string2, match) {
    const index = string2.indexOf(match);
    if (index === -1) {
      return "";
    }
    return string2.substring(0, index);
  }, ["string", "string"], ["string", "match"]),
  "substring after": fn(function(string2, match) {
    const index = string2.indexOf(match);
    if (index === -1) {
      return "";
    }
    return string2.substring(index + match.length);
  }, ["string", "string"], ["string", "match"]),
  "replace": fn(function(input, pattern, replacement, flags) {
    const regexp = createRegexp(pattern, flags || "", "g");
    if (!regexp) {
      return invalidArguments("replace(input, pattern, replacement) expects a valid pattern, got {pattern}", {
        pattern
      });
    }
    return input.replace(regexp, replacement.replace(/\$0/g, "$$&"));
  }, ["string", "string", "string", "string?"], ["input", "pattern", "replacement", "flags"]),
  "contains": fn(function(string2, match) {
    return string2.includes(match);
  }, ["string", "string"], ["string", "match"]),
  "matches": fn(function(input, pattern, flags) {
    const regexp = createRegexp(pattern, flags || "", "");
    if (!regexp) {
      return invalidArguments("matches(input, pattern) expects a valid pattern, got {pattern}", {
        pattern
      });
    }
    return regexp.test(input);
  }, ["string", "string", "string?"], ["input", "pattern", "flags"]),
  "starts with": fn(function(string2, match) {
    return string2.startsWith(match);
  }, ["string", "string"], ["string", "match"]),
  "ends with": fn(function(string2, match) {
    return string2.endsWith(match);
  }, ["string", "string"], ["string", "match"]),
  "split": fn(function(string2, delimiter) {
    const regexp = createRegexp(delimiter, "", "");
    if (!regexp) {
      return invalidArguments("split(string, delimiter) expects a valid pattern, got {delimiter}", {
        delimiter
      });
    }
    return string2.split(regexp);
  }, ["string", "string"], ["string", "delimiter"]),
  "string join": fn(function(list, delimiter) {
    const invalidItem = list.find((e) => !isString(e) && e !== null);
    if (invalidItem !== void 0) {
      return invalidArguments("string join(list) expects a list of strings, got {item}", {
        item: invalidItem
      });
    }
    return list.filter((l) => l !== null).join(delimiter || "");
  }, ["list", "string?"], ["list", "delimiter"]),
  // 10.3.4.4 List functions
  "list contains": fn(function(list, element) {
    return list.some((el) => matches(el, element));
  }, ["list", "any?"], ["list", "element"]),
  // list replace(list, position, newItem)
  // list replace(list, match, newItem)
  "list replace": fn(function(list, position, newItem, match) {
    const matcher = position || match;
    if (!["number", "function"].includes(getType(matcher))) {
      return invalidArguments("list replace expects a numeric position or a match function, got {matcher}", {
        matcher
      });
    }
    return listReplace(list, position || match, newItem);
  }, ["list", "any?", "any", "function?"], ["list", "position", "newItem", "match"]),
  "count": fn(function(list) {
    return list.length;
  }, ["list"], ["list"]),
  "min": listFn(function(...list) {
    return list.reduce((min, el) => min === null ? el : Math.min(min, el), null);
  }, "number", ["...list"]),
  "max": listFn(function(...list) {
    return list.reduce((max, el) => max === null ? el : Math.max(max, el), null);
  }, "number", ["...list"]),
  "sum": listFn(function(...list) {
    return sum(list);
  }, "number", ["...list"]),
  "mean": listFn(function(...list) {
    const s = sum(list);
    return s === null ? s : s / list.length;
  }, "number", ["...list"]),
  "all": listFn(function(...list) {
    let nonBool = false;
    for (const o of list) {
      if (o === false) {
        return false;
      }
      if (typeof o !== "boolean") {
        nonBool = true;
      }
    }
    return nonBool ? null : true;
  }, "any?", ["...list"]),
  "any": listFn(function(...list) {
    let nonBool = false;
    for (const o of list) {
      if (o === true) {
        return true;
      }
      if (typeof o !== "boolean") {
        nonBool = true;
      }
    }
    return nonBool ? null : false;
  }, "any?", ["...list"]),
  "sublist": fn(function(list, start, length) {
    const _start = start < 0 ? list.length + start : start - 1;
    return typeof length !== "undefined" ? list.slice(_start, _start + length) : list.slice(_start);
  }, ["list", "number", "number?"], ["list", "start", "length"]),
  "append": fn(function(list, ...items) {
    return list.concat(items);
  }, ["list", "any?"], ["list", "...item"]),
  "concatenate": fn(function(...list) {
    const result = [];
    for (const arg of list) {
      if (isArray(arg)) {
        for (const item of arg) {
          result.push(item);
        }
      } else {
        result.push(arg);
      }
    }
    return result;
  }, ["any"], ["...list"]),
  "insert before": fn(function(list, position, newItem) {
    const len = list.length;
    let p = position - 1;
    if (p < 0) {
      p = Math.max(0, len + p);
    } else if (p > len) {
      p = len;
    }
    const result = new Array(len + 1);
    for (let i = 0; i < p; i++) {
      result[i] = list[i];
    }
    result[p] = newItem;
    for (let i = p; i < len; i++) {
      result[i + 1] = list[i];
    }
    return result;
  }, ["list", "number", "any?"], ["list", "position", "newItem"]),
  "remove": fn(function(list, position) {
    const len = list.length;
    const head = Math.min(Math.max(position - 1, -len), len);
    const tail = Math.min(Math.max(position, -len), len);
    const a = head < 0 ? len + head : head;
    const b = tail < 0 ? len + tail : tail;
    const result = new Array(a + (len - b));
    for (let i = 0; i < a; i++) {
      result[i] = list[i];
    }
    for (let i = b; i < len; i++) {
      result[a + (i - b)] = list[i];
    }
    return result;
  }, ["list", "number"], ["list", "position"]),
  "reverse": fn(function(list) {
    return list.slice().reverse();
  }, ["list"], ["list"]),
  "index of": fn(function(list, match) {
    return list.reduce(function(result, element, index) {
      if (matches(element, match)) {
        result.push(index + 1);
      }
      return result;
    }, []);
  }, ["list", "any"], ["list", "match"]),
  "union": listFn(function(...lists) {
    return distinctLists(lists);
  }, "list", ["...list"]),
  "distinct values": fn(function(list) {
    return distinctLists([list]);
  }, ["list"], ["list"]),
  "flatten": fn(function(list) {
    return flatten(list);
  }, ["list"], ["list"]),
  "product": listFn(function(...list) {
    if (list.length === 0) {
      return null;
    }
    return list.reduce((result, n) => {
      return result * n;
    }, 1);
  }, "number", ["...list"]),
  "median": listFn(function(...list) {
    if (list.length === 0) {
      return null;
    }
    return median(list);
  }, "number", ["...list"]),
  "stddev": listFn(function(...list) {
    if (list.length < 2) {
      return null;
    }
    return stddev(list);
  }, "number", ["...list"]),
  "mode": listFn(function(...list) {
    return mode(list);
  }, "number", ["...list"]),
  // 10.3.4.5 Numeric functions
  "decimal": fn(function(n, scale) {
    if (n === null || scale === null)
      return null;
    return offsetted(bankersRound, n, scale);
  }, ["number", "number"], ["n", "scale"]),
  "floor": fn(function(n, scale = 0) {
    if (scale === null) {
      return null;
    }
    const adjust = Math.pow(10, scale);
    return Math.floor(n * adjust) / adjust;
  }, ["number", "number?"], ["n", "scale"]),
  "ceiling": fn(function(n, scale = 0) {
    if (scale === null) {
      return null;
    }
    const adjust = Math.pow(10, scale);
    return Math.ceil(n * adjust) / adjust;
  }, ["number", "number?"], ["n", "scale"]),
  "abs": fn(function(n) {
    if (isNumber(n)) {
      return Math.abs(n);
    }
    if (isDuration(n)) {
      return absDuration2(n);
    }
    if (n === null) {
      return null;
    }
    return invalidArguments("abs(n) expects a number or duration, got {n}", {
      n
    });
  }, ["any"], ["n"]),
  "round up": fn(function(n, scale) {
    if (n === null || scale === null)
      return null;
    return n > 0 ? offsetted(Math.ceil, n, scale) : offsetted(Math.floor, n, scale);
  }, ["number", "number"], ["n", "scale"]),
  "round down": fn(function(n, scale) {
    if (n === null || scale === null)
      return null;
    return n > 0 ? offsetted(Math.floor, n, scale) : offsetted(Math.ceil, n, scale);
  }, ["number", "number"], ["n", "scale"]),
  "round half up": fn(function(n, scale) {
    if (n === null || scale === null)
      return null;
    const remainder = n * Math.pow(10, scale) % 1;
    if (Math.abs(remainder) === 0.5) {
      return offsetted(n > 0 ? Math.ceil : Math.floor, n, scale);
    }
    return offsetted(Math.round, n, scale);
  }, ["number", "number"], ["n", "scale"]),
  "round half down": fn(function(n, scale) {
    if (n === null || scale === null)
      return null;
    const remainder = n * Math.pow(10, scale) % 1;
    if (Math.abs(remainder) === 0.5) {
      return offsetted(n > 0 ? Math.floor : Math.ceil, n, scale);
    }
    return offsetted(Math.round, n, scale);
  }, ["number", "number"], ["n", "scale"]),
  "modulo": fn(function(dividend, divisor) {
    if (!divisor) {
      return invalidArguments("modulo(dividend, divisor) does not accept {divisor} as a divisor", {
        divisor
      });
    }
    const adjust = 1e9;
    return Math.round((dividend % divisor + divisor) % divisor * adjust) / adjust;
  }, ["number", "number"], ["dividend", "divisor"]),
  "sqrt": fn(function(number2) {
    if (number2 < 0) {
      return invalidArguments("sqrt(number) expects a non-negative number, got {number}", {
        number: number2
      });
    }
    return Math.sqrt(number2);
  }, ["number"], ["number"]),
  "log": fn(function(number2) {
    if (number2 <= 0) {
      return invalidArguments("log(number) expects a positive number, got {number}", {
        number: number2
      });
    }
    return Math.log(number2);
  }, ["number"], ["number"]),
  "exp": fn(function(number2) {
    return Math.exp(number2);
  }, ["number"], ["number"]),
  "odd": fn(function(number2) {
    return Math.abs(number2) % 2 === 1;
  }, ["number"], ["number"]),
  "even": fn(function(number2) {
    return Math.abs(number2) % 2 === 0;
  }, ["number"], ["number"]),
  // 10.3.4.6 Date and time functions
  "is": fn(function(value1, value2) {
    if (typeof value1 === "undefined" || typeof value2 === "undefined") {
      return false;
    }
    return equals(value1, value2, true);
  }, ["any?", "any?"], ["value1", "value2"]),
  // 10.3.4.7 Range Functions
  "before": fn(function(a, b) {
    return before(a, b);
  }, ["any", "any"], ["a", "b"]),
  "after": fn(function(a, b) {
    return before(b, a);
  }, ["any", "any"], ["a", "b"]),
  "meets": fn(function(range1, range2) {
    return meets(range1, range2);
  }, ["range", "range"], ["range1", "range2"]),
  "met by": fn(function(range1, range2) {
    return meets(range2, range1);
  }, ["range", "range"], ["range1", "range2"]),
  "overlaps": fn(function(range1, range2) {
    return !before(range1, range2) && !before(range2, range1);
  }, ["range", "range"], ["range1", "range2"]),
  "overlaps before": fn(function() {
    throw notImplemented("overlaps before");
  }, ["any?"]),
  "overlaps after": fn(function() {
    throw notImplemented("overlaps after");
  }, ["any?"]),
  "finishes": fn(function() {
    throw notImplemented("finishes");
  }, ["any?"]),
  "finished by": fn(function() {
    throw notImplemented("finished by");
  }, ["any?"]),
  "includes": fn(function(range, value) {
    return includes(range, value);
  }, ["range", "any"], ["range", "value"]),
  "during": fn(function() {
    throw notImplemented("during");
  }, ["any?"]),
  "starts": fn(function() {
    throw notImplemented("starts");
  }, ["any?"]),
  "started by": fn(function() {
    throw notImplemented("started by");
  }, ["any?"]),
  "coincides": fn(function() {
    throw notImplemented("coincides");
  }, ["any?"]),
  // 10.3.4.8 Temporal built-in functions
  "day of year": fn(function(date2) {
    return date2.value.dayOfYear;
  }, ["date time"], ["date"]),
  "day of week": fn(function(date2) {
    return WEEKDAY_NAMES[date2.value.dayOfWeek - 1];
  }, ["date time"], ["date"]),
  "month of year": fn(function(date2) {
    return MONTH_NAMES[date2.value.month - 1];
  }, ["date time"], ["date"]),
  "week of year": fn(function(date2) {
    return date2.value.weekOfYear;
  }, ["date time"], ["date"]),
  // 10.3.4.9 Sort
  "sort": fn(function(list, precedes) {
    const compare = precedes.parameterNames.length === 2 ? (a, b) => precedes.fn(a, b) ? -1 : 1 : (a, b) => precedes.invoke([a, b]) ? -1 : 1;
    return Array.from(list).sort(compare);
  }, ["list", "function"], ["list", "precedes"]),
  // 10.3.4.10 Context function
  "get value": fn(function(m, key) {
    const value = getFromContext(key, m);
    return value != void 0 ? value : null;
  }, ["context", "string"], ["m", "key"]),
  "get entries": fn(function(m) {
    if (arguments.length !== 1) {
      return null;
    }
    if (Array.isArray(m)) {
      return null;
    }
    return Object.entries(m).map(([key, value]) => ({ key, value }));
  }, ["context"], ["m"]),
  "context": listFn(function(...entries) {
    const context = {};
    for (const entry of entries) {
      if (!["key", "value"].every((e) => e in entry)) {
        return invalidArguments("context(entries) expects each entry to have a key and value, got {entry}", {
          entry
        });
      }
      const key = entry.key;
      if (key === null) {
        return invalidArguments("context(entries) does not accept a null key");
      }
      if (has2(context, key)) {
        return invalidArguments("context(entries) expects unique keys, got {key}", {
          key
        });
      }
      context[key] = entry.value;
    }
    return context;
  }, "context", ["...entries"]),
  "context merge": listFn(function(...contexts) {
    return Object.assign({}, ...contexts);
  }, "context", ["...contexts"]),
  "context put": fn(function(context, keys, value, key) {
    if (typeof keys === "undefined" && typeof key === "undefined") {
      return invalidArguments("context put(context, value) expects a key or keys");
    }
    return contextPut(context, keys || [key], value);
  }, ["context", "list?", "any", "string?"], ["context", "keys", "value", "key"])
};
function contextPut(context, keys, value) {
  const [key, ...remainingKeys] = keys;
  if (getType(key) !== "string") {
    return invalidArguments("context put expects a string key, got {key}", {
      key
    });
  }
  if (getType(context) === "nil") {
    return invalidArguments("context put expects an existing context, got {context}", {
      context
    });
  }
  if (remainingKeys.length) {
    value = contextPut(context[key], remainingKeys, value);
    if (isInvocationFailure(value)) {
      return value;
    }
  }
  return Object.assign(Object.assign({}, context), { [key]: value });
}
function matches(a, b) {
  return a === b;
}
var FALSE = {};
var DURATION_START_PATTERN = /^-?P/;
var TIME_START_PATTERN = /^\d{1,2}:\d{1,2}:\d{1,2}/;
var NON_WORD_PATTERN = /\W/;
var SUPPORTED_FLAGS_PATTERN = /[smix]/g;
var EXTENDED_FLAG_PATTERN = /x/;
function createArgTester(arg) {
  const optional = arg.endsWith("?");
  const type = optional ? arg.substring(0, arg.length - 1) : arg;
  return function(obj) {
    const arr = Array.isArray(obj);
    if (type === "list") {
      if (arr || optional && typeof obj === "undefined") {
        return obj;
      } else if (typeof obj === "undefined") {
        return FALSE;
      } else {
        return obj === null ? FALSE : [obj];
      }
    }
    if (type !== "any" && arr && obj.length === 1) {
      obj = obj[0];
    }
    const objType = getType(obj);
    if (type === "any" || type === objType) {
      return optional ? obj : typeof obj !== "undefined" ? obj : FALSE;
    }
    if (objType === "nil") {
      return optional ? obj : FALSE;
    }
    return typeCast(obj, type) || FALSE;
  };
}
function createArgsValidator(argDefinitions) {
  const tests = argDefinitions.map(createArgTester);
  return function(args) {
    const result = [];
    const length = Math.max(args.length, argDefinitions.length);
    for (let index = 0; index < length; index++) {
      const test = tests[index];
      const conversion = test ? test(args[index]) : args[index];
      if (conversion === FALSE) {
        return false;
      }
      result.push(conversion);
    }
    return result;
  };
}
function listFn(fnDefinition, type, parameterNames = null) {
  const tester = createArgTester(type);
  const wrappedFn = function(...args) {
    if (args.length === 0) {
      return null;
    }
    if (Array.isArray(args[0]) && args.length === 1) {
      args = args[0];
    }
    if (!args.every((arg) => tester(arg) !== FALSE)) {
      return null;
    }
    return fnDefinition(...args);
  };
  wrappedFn.$args = parameterNames || parseParameterNames(fnDefinition);
  return wrappedFn;
}
function guard(condition, template, values = {}) {
  return condition ? null : invalidArguments(template, values);
}
function fn(fnDefinition, argDefinitions, parameterNames = null) {
  const checkArgs = createArgsValidator(argDefinitions);
  parameterNames = parameterNames || parseParameterNames(fnDefinition);
  const wrappedFn = function(...args) {
    const convertedArgs = checkArgs(args);
    if (!convertedArgs) {
      return null;
    }
    return fnDefinition(...convertedArgs);
  };
  wrappedFn.$args = parameterNames;
  return wrappedFn;
}
function sum(list) {
  return list.reduce((sum2, el) => sum2 === null ? el : sum2 + el, null);
}
function distinctLists(lists) {
  const result = [];
  const seenScalars = /* @__PURE__ */ new Set();
  const seenTemporals = /* @__PURE__ */ new Set();
  const complex = [];
  const temporalKey = (e) => {
    const type = getType(e);
    if (type === "date" || type === "time" || type === "date time") {
      return `${type}|${isZoned(e) ? 1 : 0}|${toComparable(e)}`;
    }
    return null;
  };
  for (const list of lists) {
    for (const e of list) {
      const scalar = typeof e === "number" && !Number.isNaN(e) || typeof e === "string" || typeof e === "boolean" || e === null || e === void 0;
      if (scalar) {
        if (seenScalars.has(e) || complex.some((c) => equals(e, c))) {
          continue;
        }
        seenScalars.add(e);
        result.push(e);
        continue;
      }
      const key = temporalKey(e);
      if (key !== null) {
        if (seenTemporals.has(key) || complex.some((c) => equals(e, c))) {
          continue;
        }
        seenTemporals.add(key);
        result.push(e);
        continue;
      }
      if (result.some((r) => equals(e, r))) {
        continue;
      }
      complex.push(e);
      result.push(e);
    }
  }
  return result;
}
function flatten(list) {
  const result = [];
  const stack = [[list, 0]];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const [items, index] = frame;
    if (index >= items.length) {
      stack.pop();
      continue;
    }
    frame[1]++;
    const item = items[index];
    if (Array.isArray(item)) {
      stack.push([item, 0]);
    } else if (item !== void 0) {
      result.push(item);
    }
  }
  return result;
}
function toKeyString(key) {
  if (typeof key === "string" && NON_WORD_PATTERN.test(key)) {
    return toString2(key, true);
  }
  return key;
}
function toDeepString(obj) {
  return toString2(obj, true);
}
function escapeStr(str) {
  return str.replace(/("|\\)/g, "\\$1");
}
function toString2(obj, wrap2 = false) {
  const type = getType(obj);
  if (type === "nil") {
    return "null";
  }
  if (type === "string") {
    return wrap2 ? `"${escapeStr(obj)}"` : obj;
  }
  if (type === "boolean" || type === "number") {
    return String(obj);
  }
  if (type === "list") {
    return "[" + obj.map(toDeepString).join(", ") + "]";
  }
  if (type === "context") {
    return "{" + Object.entries(obj).map(([key, value]) => {
      return toKeyString(key) + ": " + toDeepString(value);
    }).join(", ") + "}";
  }
  if (type === "duration") {
    return obj.toString();
  }
  if (type === "date time") {
    return obj.toString();
  }
  if (type === "date") {
    return obj.toString();
  }
  if (type === "range") {
    return "<range>";
  }
  if (type === "time") {
    return obj.toString();
  }
  if (type === "function") {
    return "<function>";
  }
  throw notImplemented("string(" + type + ")");
}
function countSymbols(str) {
  return str.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "_").length;
}
function offsetted(func, n, scale) {
  const result = func(n * Math.pow(10, scale)) / Math.pow(10, scale);
  return isNaN(result) ? n : result;
}
function bankersRound(n) {
  const floored = Math.floor(n);
  const decimalPart = n - floored;
  if (decimalPart === 0.5) {
    return floored % 2 === 0 ? floored : floored + 1;
  }
  return Math.round(n);
}
function stddev(array) {
  const n = array.length;
  const mean = array.reduce((a, b) => a + b) / n;
  return Math.sqrt(array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / (n - 1));
}
function listReplace(list, matcher, newItem) {
  if (isNumber(matcher)) {
    return [...list.slice(0, matcher - 1), newItem, ...list.slice(matcher)];
  }
  return list.map((item, _idx) => {
    if (matcher.invoke([item, newItem])) {
      return newItem;
    } else {
      return item;
    }
  });
}
function median(array) {
  const n = array.length;
  const sorted = array.slice().sort();
  const mid = n / 2 - 1;
  const index = Math.ceil(mid);
  if (mid === index) {
    return (sorted[index] + sorted[index + 1]) / 2;
  }
  return sorted[index];
}
function mode(array) {
  if (array.length < 2) {
    return array;
  }
  const buckets = {};
  for (const n of array) {
    buckets[n] = (buckets[n] || 0) + 1;
  }
  const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  return sorted.filter((s) => s[1] === sorted[0][1]).map((e) => +e[0]);
}
var WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday"
];
var MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
function buildFlags(flags, defaultFlags) {
  const unsupportedFlags = flags.replace(SUPPORTED_FLAGS_PATTERN, "");
  if (unsupportedFlags) {
    throw new Error("illegal flags: " + unsupportedFlags);
  }
  if (EXTENDED_FLAG_PATTERN.test(flags)) {
    throw notImplemented("matches <x> flag");
  }
  return flags + defaultFlags;
}
function createRegexp(pattern, flags, defaultFlags = "") {
  try {
    return new RegExp(pattern, "u" + buildFlags(flags, defaultFlags));
  } catch (_err) {
    if (isNotImplemented(_err)) {
      throw _err;
    }
  }
  return null;
}
function parseExpression(expression, context = {}, dialect) {
  return parser.configure({
    top: "Expression",
    contextTracker: trackVariables(context),
    dialect
  }).parse(expression);
}
function parseUnaryTests(expression, context = {}, dialect) {
  return parser.configure({
    top: "UnaryTests",
    contextTracker: trackVariables(context),
    dialect
  }).parse(expression);
}
var SyntaxError2 = class extends Error {
  constructor(message, details) {
    super(message);
    Object.assign(this, details);
  }
};
function formatDetails(template, values) {
  return Object.keys(values).reduce((message, key) => {
    return message.replace(`{${key}}`, `'${formatValue(values[key])}'`);
  }, template);
}
var InterpreterContext = class {
  constructor() {
    this.warnings = [];
  }
  addWarning(node, type, details) {
    this.warnings.push({
      type,
      message: formatDetails(details.template, details.values),
      details,
      position: node.position
    });
  }
  getWarnings() {
    return this.warnings;
  }
};
var Interpreter = class {
  _buildExecutionTree(tree, input, interpreterContext) {
    const root = {
      args: [],
      node: {
        name: "__ROOT",
        input,
        position: {
          from: 0,
          to: input.length
        }
      }
    };
    const stack = [root];
    tree.iterate({
      enter(nodeRef) {
        const { isError, isSkipped } = nodeRef.type;
        if (isError) {
          throw lintError(input, nodeRef);
        }
        if (isSkipped) {
          return false;
        }
        const { from, to, name: name2 } = nodeRef;
        stack.push({
          args: [],
          node: {
            name: name2,
            // materialize the node text only when actually inspected
            // (operator dispatch, literals, error messages)
            get input() {
              return input.slice(from, to);
            },
            position: {
              from,
              to
            }
          }
        });
      },
      leave(nodeRef) {
        if (nodeRef.type.isSkipped) {
          return;
        }
        const { node, args } = stack.pop();
        const parent = stack[stack.length - 1];
        const expr = evalNode(node, args, interpreterContext);
        parent.args.push(expr);
      }
    });
    return {
      root: root.args[root.args.length - 1]
    };
  }
  evaluate(expression, evalContext, dialect, interpreterContext) {
    const parseTree = parseExpression(expression, evalContext, dialect);
    const { root } = this._buildExecutionTree(parseTree, expression, interpreterContext);
    return {
      parseTree,
      root
    };
  }
  unaryTest(expression, evalContext, dialect, interpreterContext) {
    const parseTree = parseUnaryTests(expression, evalContext, dialect);
    const { root } = this._buildExecutionTree(parseTree, expression, interpreterContext);
    return {
      parseTree,
      root
    };
  }
};
var interpreter = new Interpreter();
var TEMPORAL_TYPES = /* @__PURE__ */ new Set(["date", "time", "date time", "duration"]);
var NUMBER_ONLY = ["number"];
var FILTER_INDEX_TYPES = /* @__PURE__ */ new Set(["number", "boolean", "any"]);
var LIST_OR_RANGE = /* @__PURE__ */ new Set(["list", "range"]);
function unaryTest(expression, evalContext = {}, dialect) {
  const interpreterContext = new InterpreterContext();
  evalContext = coerceContext(evalContext);
  const value = evalContext["?"] !== void 0 ? evalContext["?"] : null;
  const { root } = interpreter.unaryTest(expression, evalContext, dialect, interpreterContext);
  const test = root(evalContext);
  const testResult = test(value);
  return {
    value: testResult,
    warnings: interpreterContext.getWarnings()
  };
}
function evaluate(expression, evalContext = {}, dialect) {
  const interpreterContext = new InterpreterContext();
  evalContext = coerceContext(evalContext);
  const { root } = interpreter.evaluate(expression, evalContext, dialect, interpreterContext);
  const result = root(evalContext);
  return {
    value: result,
    warnings: interpreterContext.getWarnings()
  };
}
function coerceContext(value) {
  if (isArray(value)) {
    return value.map(coerceContext);
  }
  if (isContext(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, coerceContext(entry)]));
  }
  return toFeel(value);
}
function evalNode(node, args, interpreterContext) {
  const resolveInvocation = (result) => {
    if (isInvocationFailure(result)) {
      interpreterContext.addWarning(node, result.warning, {
        template: result.template,
        values: result.values
      });
      return null;
    }
    return result;
  };
  switch (node.name) {
    case "ArithOp":
      return (context) => {
        const invalidType = (opName, left, right) => {
          interpreterContext.addWarning(node, "INVALID_TYPE", {
            template: `Can't ${opName} {right} to {left}`,
            values: {
              left,
              right
            }
          });
        };
        const nullable = (op, opName, types = NUMBER_ONLY) => (a, b) => {
          const left = a(context);
          const right = b(context);
          if (isArray(left) || isArray(right)) {
            invalidType(opName, left, right);
            return null;
          }
          const leftType = getType(left);
          const rightType = getType(right);
          if (TEMPORAL_TYPES.has(leftType)) {
            if (!TEMPORAL_TYPES.has(rightType)) {
              invalidType(opName, left, right);
              return null;
            }
          } else if (leftType !== rightType || !types.includes(leftType)) {
            invalidType(opName, left, right);
            return null;
          }
          return op(left, right);
        };
        switch (node.input) {
          case "+":
            return nullable((a, b) => {
              if (isDuration(a) && !isDuration(b)) {
                const tmp = a;
                a = b;
                b = tmp;
              }
              if (isTemporal(a) && isDuration(b)) {
                return addDuration(a, b, 1);
              } else if (isTemporal(a) && isTemporal(b)) {
                return null;
              } else if (isDuration(a) && isDuration(b)) {
                const result = addDurations(a, b, 1);
                if (result === null) {
                  invalidType("add", a, b);
                }
                return result;
              }
              return a + b;
            }, "add", ["string", "number", "date", "time", "duration", "date time"]);
          case "-":
            return nullable((a, b) => {
              if (isTemporal(a) && isDuration(b)) {
                return addDuration(a, b, -1);
              } else if (isTemporal(a) && isTemporal(b)) {
                return subtractTemporals(a, b);
              } else if (isDuration(a) && isDuration(b)) {
                const result = addDurations(a, b, -1);
                if (result === null) {
                  invalidType("subtract", a, b);
                }
                return result;
              }
              return a - b;
            }, "subtract", ["number", "date", "time", "duration", "date time"]);
          case "*":
            return nullable((a, b) => a * b, "multiply", ["number"]);
          case "/":
            return nullable((a, b) => !b ? null : a / b, "divide", ["number"]);
          case "**":
          case "^":
            return nullable((a, b) => Math.pow(a, b), "exponentiate", ["number"]);
        }
      };
    case "CompareOp":
      return tag(() => {
        switch (node.input) {
          case ">":
            return (b) => createRange(b, null, false, false);
          case ">=":
            return (b) => createRange(b, null, true, false);
          case "<":
            return (b) => createRange(null, b, false, false);
          case "<=":
            return (b) => createRange(null, b, false, true);
          case "=":
            return (b) => (a) => equals(a, b);
          case "!=":
            return (b) => (a) => {
              const result = equals(a, b);
              return result === null ? null : !result;
            };
        }
      }, "test");
    case "BacktickIdentifier":
      return node.input.replace(/`/g, "");
    case "Wildcard":
      return (_context) => true;
    case "null":
      return tag((_context) => {
        return null;
      }, "nil");
    case "Disjunction":
      return tag((context) => {
        const left = args[0](context);
        const right = args[2](context);
        const a = typeof left === "boolean" ? left : null;
        const b = typeof right === "boolean" ? right : null;
        if (a === true || b === true) {
          return true;
        }
        if (a === false && b === false) {
          return false;
        }
        return null;
      }, "test");
    case "Conjunction":
      return tag((context) => {
        const left = args[0](context);
        const right = args[2](context);
        const a = typeof left === "boolean" ? left : null;
        const b = typeof right === "boolean" ? right : null;
        if (a === false || b === false) {
          return false;
        }
        if (a === true && b === true) {
          return true;
        }
        return null;
      }, "test");
    case "Context": {
      const entries = args.slice(1, -1);
      return (context) => {
        const merged = Object.assign({}, context);
        const result = {};
        for (const arg of entries) {
          const [key, value] = arg(merged);
          merged[key] = value;
          result[key] = value;
        }
        return result;
      };
    }
    case "FunctionBody":
      return args[0];
    case "FormalParameters":
      return args;
    case "FormalParameter":
      return args[0];
    case "ParameterName":
      return args.join(" ");
    case "FunctionDefinition":
      return (context) => {
        const parameterNames = args[2];
        const external = args[4] === "external";
        if (external) {
          interpreterContext.addWarning(node, "UNSUPPORTED", {
            template: "External functions are not supported",
            values: {}
          });
          return null;
        }
        const fnBody = args[external ? 5 : 4];
        return wrapFunction((...args2) => {
          const fnContext = parameterNames.reduce((context2, name2, idx) => {
            context2[name2] = args2[idx];
            return context2;
          }, Object.assign({}, context));
          return fnBody(fnContext);
        }, parameterNames);
      };
    case "ContextEntry":
      return (context) => {
        const key = typeof args[0] === "function" ? args[0](context) : args[0];
        const value = args[1](context);
        return [key, value];
      };
    case "Key":
      return args[0];
    case "Identifier":
      return node.input;
    case "SpecialFunctionName": {
      const fn2 = getBuiltin(node.input);
      return () => fn2;
    }
    // preserve spaces in name, but compact multiple
    // spaces into one (token)
    case "Name":
      return node.input.replace(/\s{2,}/g, " ");
    case "PathName":
      return tag((context) => {
        const name2 = args.join(" ");
        const contextValue = getFromContext(name2, context);
        if (typeof contextValue !== "undefined") {
          return contextValue;
        }
        if (isContext(context)) {
          interpreterContext.addWarning(node, "NO_CONTEXT_ENTRY_FOUND", {
            template: `Key '${name2}' not found in {target}`,
            values: {
              target: context
            }
          });
        } else {
          interpreterContext.addWarning(node, "NO_PROPERTY_FOUND", {
            template: `Property '${name2}' not found in {target}`,
            values: {
              target: context
            }
          });
        }
        return null;
      }, "any");
    case "VariableName": {
      const name2 = args.join(" ");
      const builtin = getBuiltin(name2);
      return tag((context) => {
        const contextValue = getFromContext(name2, context);
        if (typeof contextValue !== "undefined") {
          return contextValue;
        }
        if (builtin) {
          return builtin;
        }
        interpreterContext.addWarning(node, "NO_VARIABLE_FOUND", {
          template: `Variable '${name2}' not found`,
          values: {}
        });
        return null;
      }, "any");
    }
    case "QualifiedName":
      return {
        kind: "name",
        name: normalizeTypeName(node.input),
        // fall back to a user-provided constructor / value resolved from
        // context, preserving the historic `x instance of SomeClass` behavior
        resolve: (context) => args.reduce((context2, arg) => typeof arg === "function" ? arg(context2) : context2, context)
      };
    case "?":
      return (context) => getFromContext("?", context);
    // expression
    // expression ".." expression
    case "IterationContext":
      return (context) => {
        const a = args[0](context);
        const b = args[2] && args[2](context);
        return b ? createRange(a, b) : a;
      };
    case "Type":
      return args[0];
    // (x in [ [1,2], [3,4] ]), (y in x)
    case "InExpressions":
      return (context) => {
        const isValidContexts = (contexts) => {
          if (contexts === null || contexts.some((arr) => getType(arr) === "nil")) {
            return false;
          }
          return true;
        };
        const join = (aContexts, bContextProducer) => {
          const result = [];
          for (const aContext of aContexts) {
            const bContexts = bContextProducer(Object.assign(Object.assign({}, context), aContext));
            if (!isValidContexts(bContexts)) {
              return null;
            }
            for (const bContext of bContexts) {
              result.push(Object.assign(Object.assign({}, aContext), bContext));
            }
          }
          return result;
        };
        const cartesian = (aContexts, bContextProducer, ...otherContextProducers) => {
          if (!isValidContexts(aContexts)) {
            return null;
          }
          if (!bContextProducer) {
            return aContexts;
          }
          return cartesian(join(aContexts, bContextProducer), ...otherContextProducers);
        };
        const cartesianProduct = (contextProducers) => {
          const [aContextProducer, ...otherContextProducers] = contextProducers;
          const aContexts = aContextProducer(context);
          return cartesian(aContexts, ...otherContextProducers);
        };
        const product = cartesianProduct(args);
        return product && product.map((p) => {
          return Object.assign(Object.assign({}, context), p);
        });
      };
    // Name kw<"in"> Expr
    case "InExpression":
      return (context) => {
        return extractValue(context, args[0], args[2]);
      };
    case "SpecialType":
      return {
        kind: "name",
        name: normalizeTypeName(node.input)
      };
    case "ListType":
      return {
        kind: "list",
        element: args.find(isTypeDescriptor)
      };
    case "ContextType":
      return {
        kind: "context",
        entries: args.find(Array.isArray) || []
      };
    case "ContextEntryTypes":
      return args.filter((arg) => arg && arg.name);
    case "ContextEntryType":
      return {
        name: args[0],
        type: args.find(isTypeDescriptor)
      };
    case "FunctionType":
      return {
        kind: "function"
      };
    case "InstanceOfExpression":
      return tag((context) => {
        const value = args[0](context);
        return matchesType(value, args[3], context);
      }, "test");
    case "every":
      return tag((context) => {
        return (_contexts, _condition) => {
          const contexts = _contexts(context);
          if (getType(contexts) !== "list") {
            return contexts;
          }
          return contexts.every((ctx) => isTruthy(_condition(ctx)));
        };
      }, "test");
    case "some":
      return tag((context) => {
        return (_contexts, _condition) => {
          const contexts = _contexts(context);
          if (getType(contexts) !== "list") {
            return contexts;
          }
          return contexts.some((ctx) => isTruthy(_condition(ctx)));
        };
      }, "test");
    case "NumericLiteral": {
      const value = node.input.includes(".") ? parseFloat(node.input) : parseInt(node.input);
      return constant(value, "number");
    }
    case "BooleanLiteral": {
      const value = node.input === "true";
      return constant(value, "boolean");
    }
    case "StringLiteral": {
      const value = parseString(node.input);
      return constant(value, "string");
    }
    case "PositionalParameters": {
      if (args.every(isConstant)) {
        return constant(args.map((arg) => arg.constantValue), "parameters");
      }
      return (context) => args.map((arg) => arg(context));
    }
    case "NamedParameter":
      return (context) => {
        const name2 = args[0];
        const value = args[1](context);
        return [name2, value];
      };
    case "NamedParameters":
      return (context) => args.reduce((args2, arg) => {
        const [name2, value] = arg(context);
        args2[name2] = value;
        return args2;
      }, {});
    case "DateTimeConstructor":
      return constant(getBuiltin(node.input), "function");
    case "DateTimeLiteral": {
      if (args.length !== 1 && isConstant(args[0]) && isConstant(args[2])) {
        const wrappedFn = wrapFunction(args[0].constantValue);
        if (wrappedFn) {
          const result = wrappedFn.invoke(args[2].constantValue);
          if (!isInvocationFailure(result)) {
            return constant(result, "date");
          }
        }
      }
      return tag((context) => {
        if (args.length === 1) {
          return args[0](context);
        } else {
          const target = args[0](context);
          const wrappedFn = wrapFunction(target);
          if (!wrappedFn) {
            interpreterContext.addWarning(node, "NO_FUNCTION_FOUND", {
              template: "Cannot invoke {target}",
              values: {
                target
              }
            });
            return null;
          }
          const contextOrArgs = args[2](context);
          const result = wrappedFn.invoke(contextOrArgs);
          return resolveInvocation(result);
        }
      }, "date");
    }
    case "AtLiteral": {
      const arg = args[0];
      if (isConstant(arg)) {
        const wrappedFn2 = wrapFunction(getBuiltin("@"));
        if (wrappedFn2) {
          const value = wrappedFn2.invoke([arg.constantValue]);
          if (!isInvocationFailure(value)) {
            return constant(value, "date");
          }
        }
      }
      const wrappedFn = wrapFunction(getBuiltin("@"));
      return tag((context) => {
        if (!wrappedFn) {
          interpreterContext.addWarning(node, "NO_FUNCTION_FOUND", {
            template: "Cannot invoke '@'",
            values: {}
          });
          return null;
        }
        return resolveInvocation(wrappedFn.invoke([arg(context)]));
      }, "date");
    }
    case "FunctionInvocation":
      return tag((context) => {
        const target = args[0](context);
        const wrappedFn = wrapFunction(target);
        if (!wrappedFn) {
          interpreterContext.addWarning(node, "NO_FUNCTION_FOUND", {
            template: "Cannot invoke {target}",
            values: {
              target
            }
          });
          return null;
        }
        const contextOrArgs = args[2](context);
        const result = wrappedFn.invoke(contextOrArgs);
        return resolveInvocation(result);
      }, "any");
    case "IfExpression":
      return (function() {
        const ifCondition = args[1];
        const thenValue = args[3];
        const elseValue = args[5];
        const type = coalecenseTypes(thenValue, elseValue);
        return tag((context) => {
          if (isTruthy(ifCondition(context))) {
            return thenValue(context);
          } else {
            return elseValue ? elseValue(context) : null;
          }
        }, type);
      })();
    case "Parameters":
      return args.length === 3 ? args[1] : (_context) => [];
    case "Comparison":
      return tag((context) => {
        const operator2 = args[1];
        if (operator2 === "in") {
          return compareIn(args[0](context), (args[3] || args[2])(context));
        }
        if (operator2 === "between") {
          const start = args[2](context);
          const end = args[4](context);
          if (start === null || end === null) {
            return null;
          }
          return createRange(start, end).includes(args[0](context));
        }
        const left = args[0](context);
        const right = args[2](context);
        const test = operator2()(right);
        return compareValue(test, left);
      }, "test");
    case "QuantifiedExpression":
      return tag((context) => {
        const testFn = args[0](context);
        const contexts = args[1];
        const condition = args[3];
        return testFn(contexts, condition);
      }, "test");
    // DMN 1.2 - 10.3.2.14
    // kw<"for"> commaSep1<InExpression<IterationContext>> kw<"return"> expression
    case "ForExpression":
      return (context) => {
        const extractor = args[args.length - 1];
        const iterationContexts = args[1](context);
        if (getType(iterationContexts) !== "list") {
          return iterationContexts;
        }
        const partial = [];
        for (const ctx of iterationContexts) {
          ctx.partial = partial;
          partial.push(extractor(ctx));
        }
        return partial;
      };
    case "ArithmeticExpression":
      return (function() {
        if (args.length === 3) {
          const [a, op, b] = args;
          return tag((context) => {
            return op(context)(a, b);
          }, coalecenseTypes(a, b));
        }
        if (args.length === 2) {
          const [op, value] = args;
          return tag((context) => {
            return op(context)(() => 0, value);
          }, value.type);
        }
      })();
    case "PositiveUnaryTest":
      return (context) => {
        if (args[0].type === "boolean" && has(context, "?")) {
          return args[0](context) === context["?"];
        }
        return args[0](context);
      };
    case "ParenthesizedExpression":
      return args[1];
    // expr "."" pathName
    case "PathExpression":
      return tag((context) => {
        const pathTarget = args[0](context);
        const pathProp = args[2];
        if (isArray(pathTarget)) {
          return pathTarget.map((value) => pathProp(value));
        } else {
          return pathProp(pathTarget);
        }
      }, "any");
    // expression !filter "[" expression "]"
    case "FilterExpression":
      return tag((context) => {
        const target = args[0](context);
        const filterFn = args[2];
        const filterTarget = isArray(target) ? target : [target];
        if (target === null) {
          return null;
        }
        const type = filterFn.type;
        if (FILTER_INDEX_TYPES.has(type)) {
          const idx = filterFn(context);
          if (isBoolean(idx)) {
            if (idx === true) {
              return target;
            } else {
              return [];
            }
          }
          if (!isNumber(idx)) {
            return [];
          }
          const value = filterTarget[idx < 0 ? filterTarget.length + idx : idx - 1];
          if (typeof value === "undefined") {
            return null;
          } else {
            return value;
          }
        }
        if (type === "string") {
          const value = filterFn(context);
          return filterTarget.filter((el) => el === value);
        }
        if (type === "test") {
          return filterTarget.map((el) => {
            const iterationContext = Object.assign(Object.assign(Object.assign({}, context), { item: el }), el);
            let result = filterFn(iterationContext);
            if (typeof result === "function") {
              result = result(el);
            }
            if (isRange(result)) {
              result = result.includes(el);
            }
            if (result === true) {
              return el;
            }
            return result;
          }).filter(isTruthy);
        }
        return null;
      }, "any");
    case "SimplePositiveUnaryTest":
      return tag((context) => {
        if (args.length === 1) {
          return args[0](context);
        }
        return args[0](context)(args[1](context));
      }, "test");
    case "List": {
      const elements = args.slice(1, -1);
      return (context) => {
        return elements.map((arg) => arg(context));
      };
    }
    // "[" endpoint ".." endpoint "]"
    case "Interval": {
      const startBracket = args[0] === "[";
      const endBracket = args[4] === "]";
      return tag((context) => {
        const left = args[1](context);
        const right = args[3](context);
        const startIncluded = left !== null && startBracket;
        const endIncluded = right !== null && endBracket;
        return createRange(left, right, startIncluded, endIncluded);
      }, "test");
    }
    case "PositiveUnaryTests":
    case "Expressions":
      return (context) => {
        return args.map((a) => a(context));
      };
    case "Expression":
      return (context) => {
        return args[0](context);
      };
    case "UnaryTests": {
      const negate = args[0] === "not";
      const tests = negate ? args.slice(2, -1) : args;
      return (context) => {
        return (value = null) => {
          const matches2 = tests.map((test) => test(context)).flat(1).map((test) => {
            if (isArray(test)) {
              return test.includes(value);
            }
            if (typeof test === "boolean") {
              return test;
            }
            return compareValue(test, value);
          }).some((v) => v === true);
          return matches2 === null ? null : negate ? !matches2 : matches2;
        };
      };
    }
    default:
      return node.name;
  }
}
function getBuiltin(name2, _context) {
  return getFromContext(name2, builtins);
}
function extractValue(context, prop, _target) {
  const target = _target(context);
  if (LIST_OR_RANGE.has(getType(target))) {
    return target.map((t2) => ({ [prop]: t2 }));
  }
  return null;
}
function compareIn(value, tests) {
  if (!isArray(tests)) {
    if (getType(tests) === "nil") {
      return null;
    }
    tests = [tests];
  }
  let unknown = false;
  for (const test of tests) {
    let result = compareValue(test, value);
    if (result === null && !isRange(test) && typeof test !== "function") {
      result = false;
    }
    if (result === true) {
      return true;
    }
    if (result === null) {
      unknown = true;
    }
  }
  return unknown ? null : false;
}
function compareValue(test, value) {
  if (typeof test === "function") {
    return test(value);
  }
  if (isRange(test)) {
    return test.includes(value);
  }
  return equals(test, value);
}
function coalecenseTypes(a, b) {
  if (!b) {
    return a.type;
  }
  if (a.type === b.type) {
    return a.type;
  }
  return "any";
}
function tag(fn2, type) {
  return Object.assign(fn2, {
    type,
    toString() {
      return `TaggedFunction[${type}] ${Function.prototype.toString.call(fn2)}`;
    }
  });
}
function constant(value, type) {
  return Object.assign(tag(() => value, type), {
    constantValue: value
  });
}
function isConstant(fn2) {
  return "constantValue" in fn2;
}
function isTruthy(obj) {
  return obj !== false && obj !== null;
}
var anyType = (value) => getType(value) !== "nil";
var NAMED_TYPE_CHECKS = {
  "Any": anyType,
  "Null": (value) => value === null,
  "number": (value) => getType(value) === "number",
  "string": (value) => getType(value) === "string",
  "boolean": (value) => getType(value) === "boolean",
  "date": (value) => getType(value) === "date",
  "time": (value) => getType(value) === "time",
  "date and time": (value) => getType(value) === "date time",
  "duration": (value) => getType(value) === "duration",
  "days and time duration": (value) => isDuration(value) && !value.yearsMonths,
  "years and months duration": (value) => isDuration(value) && value.yearsMonths,
  "context": (value) => getType(value) === "context",
  "list": (value) => getType(value) === "list",
  "range": (value) => getType(value) === "range",
  "function": (value) => getType(value) === "function"
};
function normalizeTypeName(name2) {
  return name2.replace(/\s+/g, " ").trim();
}
function isTypeDescriptor(obj) {
  return obj && typeof obj === "object" && typeof obj.kind === "string";
}
function matchesType(value, descriptor, context) {
  if (!isTypeDescriptor(descriptor)) {
    return false;
  }
  switch (descriptor.kind) {
    case "name": {
      const check = NAMED_TYPE_CHECKS[descriptor.name];
      if (check) {
        return check(value);
      }
      const target = descriptor.resolve ? descriptor.resolve(context) : null;
      return typeof target === "function" && value instanceof target;
    }
    case "list":
      return getType(value) === "list" && value.every((element) => matchesType(element, descriptor.element, context));
    case "context":
      return getType(value) === "context" && descriptor.entries.every(({ name: name2, type }) => has(value, name2) && matchesType(value[name2], type, context));
    case "function":
      return getType(value) === "function";
  }
  return false;
}
function parseString(str) {
  if (str.startsWith('"')) {
    str = str.slice(1);
  }
  if (str.endsWith('"')) {
    str = str.slice(0, -1);
  }
  return str.replace(/(\\")|(\\\\)|(\\n)|(\\r)|(\\t)|(\\u[a-fA-F0-9]{5,6})|((?:\\u[a-fA-F0-9]{1,4})+)/ig, function(substring, ...groups) {
    const [quotes, backslash, newline, carriageReturn, tab, codePoint, charCodes] = groups;
    if (quotes) {
      return '"';
    }
    if (newline) {
      return "\n";
    }
    if (carriageReturn) {
      return "\r";
    }
    if (tab) {
      return "	";
    }
    if (backslash) {
      return "\\";
    }
    const escapePattern = /\\u([a-fA-F0-9]+)/ig;
    if (codePoint) {
      const codePointMatch = escapePattern.exec(codePoint);
      return String.fromCodePoint(parseInt(codePointMatch[1], 16));
    }
    if (charCodes) {
      const chars2 = [];
      let charCodeMatch;
      while ((charCodeMatch = escapePattern.exec(substring)) !== null) {
        chars2.push(parseInt(charCodeMatch[1], 16));
      }
      return String.fromCharCode(...chars2);
    }
    throw new Error("illegal match");
  });
}
function lintErrorDetails(errorNodeRef) {
  const node = errorNodeRef.node;
  const parent = node.parent;
  const { from, to } = node;
  if (node.from !== node.to) {
    return {
      message: `Unrecognized token in <${parent.name}>`,
      position: {
        from,
        to
      }
    };
  }
  const next = findNext(node);
  if (next) {
    return {
      message: `Unrecognized token <${next.name}> in <${parent.name}>`,
      position: {
        from: next.from,
        to: next.to
      }
    };
  } else {
    const unfinished = parent.enterUnfinishedNodesBefore(errorNodeRef.to);
    return {
      message: `Incomplete <${(unfinished || parent).name}>`,
      position: {
        from,
        to
      }
    };
  }
}
function lintError(input, errorNodeRef) {
  const { message, position } = lintErrorDetails(errorNodeRef);
  return new SyntaxError2(message, {
    input: input.slice(position.from, position.to),
    position
  });
}
function findNext(nodeRef) {
  const node = nodeRef.node;
  let next, parent = node;
  do {
    next = parent.nextSibling;
    if (next) {
      return next;
    }
    parent = parent.parent;
  } while (parent);
  return null;
}
function formatValue(value) {
  const type = getType(value);
  if (type === "string") {
    return `"${String(value)}"`;
  }
  if (type === "list") {
    return `[${value.length} items]`;
  }
  if (type === "context") {
    return "{...}";
  }
  if (type === "function") {
    const parameterNames = value.parameterNames;
    if (parameterNames) {
      return `function(${parameterNames.join(", ")})`;
    }
    return "function";
  }
  if (type === "nil") {
    return "null";
  }
  return String(value);
}
export {
  FeelDate,
  FeelDateTime,
  FeelDuration,
  FeelFunction,
  FeelRange,
  FeelTime,
  SyntaxError2 as SyntaxError,
  date,
  dateAndTime,
  duration,
  evaluate,
  isFunction,
  isRange,
  now,
  parseDate,
  parseDateTime,
  parseExpression,
  parseTime,
  parseUnaryTests,
  time,
  toFeel,
  today,
  unaryTest
};
