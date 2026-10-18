// Turns a free-form sentence (Arabic or English) into a reminder:
//   "لما اخرج من الجامعة ذكرني اشتري خبز"  -> location / exit / "الجامعة"
//   "ذكرني اتصل بأمي الساعة 5 المساء"        -> time
//   "remind me to call mom in 10 minutes"    -> time

export type ParsedTrigger =
  | { kind: 'time'; at: Date }
  | { kind: 'location'; event: 'exit' | 'enter'; place: string };

export type ParseResult = {
  text: string;
  trigger: ParsedTrigger | null;
};

type Normalized = { text: string; map: number[] };

const DIACRITICS = /[ً-ٰٟـ]/;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

// Normalizes spelling variants while remembering where every character came
// from, so matches can be cut out of the original sentence.
export function normalize(input: string): Normalized {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let c = input[i];
    if (DIACRITICS.test(c)) continue;
    const d = ARABIC_DIGITS.indexOf(c) >= 0 ? ARABIC_DIGITS.indexOf(c) : PERSIAN_DIGITS.indexOf(c);
    if (d >= 0) c = String(d);
    else if ('أإآٱ'.includes(c)) c = 'ا';
    else if (c === 'ة') c = 'ه';
    else if (c === 'ى') c = 'ي';
    else if (c === '٫' || c === '：') c = ':';
    else if (c === '؛') c = '،';
    else {
      const lower = c.toLowerCase();
      if (lower.length === 1) c = lower;
    }
    text += c;
    map.push(i);
  }
  return { text, map };
}

// Key used to compare place names: "الجامعة" == "جامعه", "the gym" == "gym".
export function placeKey(name: string): string {
  return normalize(name.trim())
    .text.replace(/^(the|my)\s+/, '')
    .replace(/^ال/, '')
    .replace(/\s+/g, '');
}

type Span = { start: number; end: number };

const STOP = String.raw`(?=\s+(?:ذكرني|ذكريني|فكرني|نبهني|remind)|\s*[،,.!؟?]|$)`;
const AR_WHEN = String.raw`(?:لما|لمن|عندما|عند ما|حين|حينما|اذا|لو|اول ما|بعد ما|وقت ما)\s+(?:انا\s+)?`;

const LOCATION_PATTERNS: { event: 'exit' | 'enter'; re: RegExp }[] = [
  { event: 'exit', re: new RegExp(String.raw`${AR_WHEN}(?:اخرج|اطلع|اغادر|اترك|اروح من|امشي من)\s+(?:من\s+)?(.+?)${STOP}`) },
  { event: 'exit', re: new RegExp(String.raw`(?:عند|بعد|اول|وقت)\s+(?:خروجي|طلوعي|مغادرتي)\s+(?:من\s+)?(.+?)${STOP}`) },
  { event: 'enter', re: new RegExp(String.raw`${AR_WHEN}(?:اوصل|ادخل|ارجع|اجي|اكون في|اكون عند)\s+(?:(?:الي|علي|عند|في)\s+)?(.+?)${STOP}`) },
  { event: 'enter', re: new RegExp(String.raw`(?:عند|بعد|اول|وقت)\s+(?:وصولي|دخولي|رجوعي)\s+(?:(?:الي|علي|عند|في)\s+)?(.+?)${STOP}`) },
  { event: 'exit', re: new RegExp(String.raw`(?:when|once|as soon as|after)\s+i\s+(?:leave|exit|get out of|walk out of|am out of)\s+(.+?)${STOP}`) },
  { event: 'enter', re: new RegExp(String.raw`(?:when|once|as soon as)\s+i\s+(?:arrive at|arrive in|arrive|get to|get back to|reach|enter|am at|get)\s+(.+?)${STOP}`) },
];

function findLocation(n: string): { span: Span; event: 'exit' | 'enter'; place: Span } | null {
  for (const { event, re } of LOCATION_PATTERNS) {
    const m = re.exec(n);
    if (!m || m.index === undefined) continue;
    const placeStart = m.index + m[0].length - m[1].length;
    return {
      event,
      span: { start: m.index, end: m.index + m[0].length },
      place: { start: placeStart, end: placeStart + m[1].length },
    };
  }
  return null;
}

const AR_UNITS: Record<string, number> = {
  دقيقه: 1, دقيقتين: 2, دقائق: 1, دقايق: 1,
  ساعه: 60, ساعتين: 120, ساعات: 60,
  يوم: 1440, يومين: 2880, ايام: 1440,
};

function findRelative(n: string, now: Date): { span: Span; at: Date } | null {
  const ar = /(?:بعد|خلال)\s+(?:(\d+)\s*)?(نص|ربع)?\s*(دقيقه|دقيقتين|دقائق|دقايق|ساعه|ساعتين|ساعات|يوم|يومين|ايام)(\s+ونص|\s+وربع)?/.exec(n);
  if (ar) {
    const count = ar[1] ? Number(ar[1]) : 1;
    let minutes = count * AR_UNITS[ar[3]];
    if (ar[2] === 'نص') minutes /= 2;
    if (ar[2] === 'ربع') minutes /= 4;
    if (ar[4]?.includes('نص')) minutes += AR_UNITS[ar[3]] / 2;
    if (ar[4]?.includes('ربع')) minutes += AR_UNITS[ar[3]] / 4;
    return { span: { start: ar.index, end: ar.index + ar[0].length }, at: new Date(now.getTime() + minutes * 60000) };
  }
  const en = /\bin\s+(\d+|an?|half an)\s*(minutes?|mins?|hours?|hrs?|days?)\b/.exec(n);
  if (en) {
    const count = en[1] === 'half an' ? 0.5 : /^\d+$/.test(en[1]) ? Number(en[1]) : 1;
    const unit = en[2].startsWith('m') ? 1 : en[2].startsWith('h') ? 60 : 1440;
    return { span: { start: en.index, end: en.index + en[0].length }, at: new Date(now.getTime() + count * unit * 60000) };
  }
  return null;
}

const PM = ['مساء', 'المساء', 'بالمساء', 'م', 'العصر', 'عصرا', 'بالليل', 'الليل', 'ليلا', 'المغرب', 'pm', 'p.m.'];
const AM = ['صباحا', 'الصبح', 'الصباح', 'بالصباح', 'ص', 'الفجر', 'فجرا', 'am', 'a.m.'];
const NOON = ['الظهر', 'ظهرا'];

const PERIOD = String.raw`(?:\s*(صباحا|الصبح|الصباح|بالصباح|ص|الفجر|فجرا|الظهر|ظهرا|العصر|عصرا|المغرب|مساء|المساء|بالمساء|م|بالليل|الليل|ليلا|am|pm|a\.m\.|p\.m\.)(?=\s|$|[،,.!؟?]))?`;
const TIME_PATTERNS = [
  // الساعه 5 / الساعه 5:30 / الساعه 5 ونص مساء
  new RegExp(String.raw`(?:ع?ال?ساعه|at|@)\s*(\d{1,2})(?::(\d{2}))?(\s+(?:و\s?نص|و\s?ربع|الا ربع|الا\s?ربع))?${PERIOD}`),
  // 5:30 / 5pm / 5 م
  new RegExp(String.raw`(?:^|\s)(\d{1,2})(?::(\d{2}))?()(?:\s*(am|pm|a\.m\.|p\.m\.)|\s+(ص|م|مساء|صباحا)(?=\s|$))`),
  new RegExp(String.raw`(?:^|\s)(\d{1,2}):(\d{2})()${PERIOD}`),
];

const DAY_WORDS: { re: RegExp; offset: number }[] = [
  { re: /(?:^|\s)(بعد\s+بكره|بعد\s+بكرا|بعد\s+غد|after tomorrow|the day after tomorrow)(?=\s|$|[،,.!؟?])/, offset: 2 },
  { re: /(?:^|\s)(بكره|بكرا|غدا|غدوه|الغد|tomorrow)(?=\s|$|[،,.!؟?])/, offset: 1 },
  { re: /(?:^|\s)(اليوم|الليله|today|tonight)(?=\s|$|[،,.!؟?])/, offset: 0 },
];

function findAbsolute(n: string, now: Date): { spans: Span[]; at: Date } | null {
  const spans: Span[] = [];
  let dayOffset: number | null = null;
  let tonight = false;
  for (const { re, offset } of DAY_WORDS) {
    const m = re.exec(n);
    if (!m) continue;
    const start = m.index + m[0].length - m[1].length;
    spans.push({ start, end: start + m[1].length });
    dayOffset = offset;
    tonight = m[1] === 'الليله' || m[1] === 'tonight';
    break;
  }

  let hour: number | null = null;
  let minute = 0;
  let period: 'am' | 'pm' | 'noon' | null = null;
  for (const re of TIME_PATTERNS) {
    const m = re.exec(n);
    if (!m) continue;
    const lead = m[0].length - m[0].trimStart().length;
    spans.push({ start: m.index + lead, end: m.index + m[0].length });
    hour = Number(m[1]);
    minute = m[2] ? Number(m[2]) : 0;
    const frac = (m[3] ?? '').replace(/\s/g, '');
    if (frac === 'ونص') minute = 30;
    else if (frac === 'وربع') minute = 15;
    else if (frac === 'الاربع') { minute = 45; hour -= 1; }
    const p = m[4] ?? m[5];
    if (p && PM.includes(p)) period = 'pm';
    else if (p && AM.includes(p)) period = 'am';
    else if (p && NOON.includes(p)) period = 'noon';
    break;
  }

  if (hour === null && dayOffset === null) return null;
  if (hour !== null && (hour > 24 || minute > 59)) return null;

  const at = new Date(now);
  at.setSeconds(0, 0);
  if (hour === null) {
    // "بكره" alone -> 9:00 that day; "الليله" -> 21:00
    at.setDate(at.getDate() + (dayOffset ?? 0));
    at.setHours(tonight ? 21 : 9, 0);
    if (at <= now) at.setTime(now.getTime() + 60 * 60000);
    return { spans, at };
  }

  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  if (period === 'noon' && hour < 6) hour += 12;
  if (tonight && hour < 12) hour += 12;

  at.setHours(hour % 24, minute);
  if (dayOffset !== null) {
    at.setDate(at.getDate() + dayOffset);
    // A bare "بكره الساعه 5" almost always means 17:00, not 05:00.
    if (period === null && hour >= 1 && hour <= 6) at.setHours(hour + 12);
    return { spans, at };
  }

  if (period === null && hour <= 12) {
    // No am/pm: take the next time the clock shows this hour.
    if (at <= now) at.setHours(at.getHours() + 12);
    if (at <= now) {
      at.setDate(at.getDate() + 1);
      at.setHours(hour, minute);
    }
  } else if (at <= now) {
    at.setDate(at.getDate() + 1);
  }
  return { spans, at };
}

// "ذكرني بالدواء" -> "الدواء", but keep words that merely start with ب.
const KEEP_B = ['بيت', 'بيتزا', 'بنزين', 'بنك', 'بطاقه', 'باص', 'بحر', 'برنامج', 'بريد', 'بطاريه', 'بقاله'];
const KEYWORDS = /(?:^|\s)((?:ذكرني|ذكريني|فكرني|نبهني)(?:\s+(?:ان|اني|انه)(?=\s))?\s*|remind me(?:\s+(?:to|about|of|that))?(?:\s|$))/;

function keywordSpan(n: string): Span | null {
  const kw = KEYWORDS.exec(n);
  if (!kw) return null;
  const start = kw.index + kw[0].length - kw[1].length;
  return { start, end: start + kw[1].length };
}

function dropLeadingLink(text: string): string {
  text = text.replace(/^(?:to|about|of|that)\s+/i, '');
  const first = normalize(/^\S+/.exec(text)?.[0] ?? '').text;
  if (first.startsWith('ب') && first.length > 2 && !KEEP_B.some((w) => first.startsWith(w))) return text.slice(1);
  return text;
}

function cut(original: Normalized, source: string, spans: Span[]): string {
  const remove = new Array(source.length).fill(false);
  for (const s of spans) {
    if (s.end <= s.start) continue;
    const a = original.map[s.start];
    const b = original.map[s.end - 1];
    for (let i = a; i <= b; i++) remove[i] = true;
  }
  return source
    .split('')
    .filter((_, i) => !remove[i])
    .join('');
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[،,.:\-–—\s]+|[،,.:\-–—\s]+$/g, '')
    .replace(/^(?:و|ثم|and|then)\s+/i, '')
    .replace(/\s+(?:و|and)$/i, '')
    .trim();
}

export function parseReminder(input: string, now: Date = new Date()): ParseResult {
  const n = normalize(input);
  const spans: Span[] = [];
  let trigger: ParsedTrigger | null = null;

  const loc = findLocation(n.text);
  if (loc) {
    let place = tidy(cut(n, input, [{ start: 0, end: loc.place.start }, { start: loc.place.end, end: n.text.length }]));
    if (/^لل/.test(normalize(place).text)) place = 'ال' + place.slice(2);
    trigger = { kind: 'location', event: loc.event, place: place.replace(/^(?:the|my)\s+/i, '') };
    spans.push(loc.span);
  } else {
    const rel = findRelative(n.text, now);
    if (rel) {
      trigger = { kind: 'time', at: rel.at };
      spans.push(rel.span);
    } else {
      const abs = findAbsolute(n.text, now);
      if (abs) {
        trigger = { kind: 'time', at: abs.at };
        spans.push(...abs.spans);
      }
    }
  }

  const kw = keywordSpan(n.text);
  if (kw) spans.push(kw);

  const text = tidy(cut(n, input, spans));
  return { text: kw ? dropLeadingLink(text) : text, trigger };
}
