/**
 * Standard 5-field cron expression parser (minute hour day-of-month month
 * day-of-week, UTC). Supports:  *  ,  -  /  and named shortcuts (@hourly,
 * @daily, @weekly, @monthly). Pure logic — unit tested.
 */

export interface CronFields {
  minutes: Set<number>; // 0-59
  hours: Set<number>; // 0-23
  daysOfMonth: Set<number>; // 1-31 (may contain 0 when dom unbounded)
  months: Set<number>; // 1-12
  daysOfWeek: Set<number>; // 0-6 (0=Sunday)
  domRestricted: boolean;
  dowRestricted: boolean;
}

const NAMED: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function resolveName(tok: string, names: string[], offset = 0): number | null {
  const v = names.indexOf(tok.toLowerCase());
  return v === -1 ? null : v + offset;
}

function parseField(
  field: string,
  min: number,
  max: number,
  names?: string[],
  nameOffset = 0,
): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`empty cron field part`);
    let range = trimmed;
    let step = 1;
    const slash = trimmed.indexOf('/');
    if (slash !== -1) {
      range = trimmed.slice(0, slash);
      step = parseInt(trimmed.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step < 1) throw new Error(`invalid cron step "${trimmed}"`);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = resolveRangeEndpoint(a, min, max, names, nameOffset);
      hi = resolveRangeEndpoint(b, min, max, names, nameOffset);
    } else {
      lo = resolveRangeEndpoint(range, min, max, names, nameOffset);
      hi = slash !== -1 ? max : lo;
    }
    if (lo < min || hi < min || lo > max || hi > max) throw new Error(`cron field "${field}" out of range [${min}-${max}]`);
    if (hi < lo) throw new Error(`cron range "${field}" inverted`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function resolveRangeEndpoint(tok: string, min: number, max: number, names?: string[], nameOffset = 0): number {
  if (names) {
    const named = resolveName(tok, names, nameOffset);
    if (named !== null) return named;
  }
  const v = parseInt(tok, 10);
  if (!Number.isFinite(v)) throw new Error(`invalid cron token "${tok}"`);
  // 7 is often used as Sunday; normalize to 0
  if (max === 6 && v === 7) return 0;
  if (v < min || v > max) throw new Error(`cron value ${v} out of range [${min}-${max}]`);
  return v;
}

export function parseCron(expr: string): CronFields {
  let e = expr.trim().toLowerCase();
  if (NAMED[e]) e = NAMED[e];
  const fields = e.split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression must have 5 fields, got ${fields.length}`);
  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  const daysOfMonth = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12, MONTH_NAMES, 1);
  const daysOfWeek = parseField(fields[4], 0, 6, DAY_NAMES, 0);
  return { minutes, hours, daysOfMonth, months, daysOfWeek, domRestricted, dowRestricted };
}

export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function setHas(set: Set<number>, v: number): boolean {
  return set.has(v);
}

/** Day-of-month / day-of-week OR semantics per Vixie cron when both are restricted. */
function dayMatches(f: CronFields, d: Date): boolean {
  const dom = d.getUTCDate();
  const dow = d.getUTCDay();
  if (f.domRestricted && f.dowRestricted) {
    return setHas(f.daysOfMonth, dom) || setHas(f.daysOfWeek, dow);
  }
  if (f.domRestricted) return setHas(f.daysOfMonth, dom);
  if (f.dowRestricted) return setHas(f.daysOfWeek, dow);
  return true;
}

function minuteMatches(f: CronFields, d: Date): boolean {
  return (
    setHas(f.minutes, d.getUTCMinutes()) &&
    setHas(f.hours, d.getUTCHours()) &&
    setHas(f.months, d.getUTCMonth() + 1) &&
    dayMatches(f, d)
  );
}

/** Next fire time strictly after `after` (ms). Returns null if none within ~2 years. */
export function nextRun(expr: string, after: number): number | null {
  const f = parseCron(expr);
  // first candidate minute boundary strictly after `after`
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limit = after + 2 * 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    // month fast-forward
    if (!setHas(f.months, d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(f, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (minuteMatches(f, d)) return d.getTime();
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

/** The next `count` fire times after `after` (for UI previews). */
export function previewCron(expr: string, after: number, count = 5): number[] | string {
  try {
    const out: number[] = [];
    let t = after;
    for (let i = 0; i < count; i++) {
      const n = nextRun(expr, t);
      if (n === null) break;
      out.push(n);
      t = n;
    }
    return out;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
