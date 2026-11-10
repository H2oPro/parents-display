// Calendar relay for the family display (Cloudflare Worker).
//
// Reads a private iCloud calendar link and returns only what the display
// needs: titles and times for today and tomorrow. No notes, locations,
// attendees, or anything further out.
//
// Settings (Cloudflare dashboard -> this Worker -> Settings -> Variables and Secrets):
//   ICS_URL         (secret)  the calendar's webcal:// or https:// link
//   ACCESS_KEY      (secret)  long random key; the tablet must send it
//   PEOPLE          (secret)  JSON list of names, aliases and colors, e.g.
//                             [{"name":"Ann","aliases":["Ann","Mom"],"color":"pink"}]
//   TIMEZONE        (text)    e.g. America/Los_Angeles  (default)
//   ALLOWED_ORIGIN  (text)    the display page's origin, e.g. https://yourname.github.io

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

    const auth = request.headers.get("Authorization") || "";
    const sent = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.ACCESS_KEY || !safeEqual(sent, env.ACCESS_KEY)) return json({ error: "not allowed" }, 401);
    if (!env.ICS_URL) return json({ error: "calendar link not set" }, 500);

    const tz = env.TIMEZONE || "America/Los_Angeles";
    let people = [];
    try { people = env.PEOPLE ? JSON.parse(env.PEOPLE) : []; } catch (e) { people = []; }

    let text;
    try {
      const url = env.ICS_URL.replace(/^webcal:/i, "https:");
      const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
      if (!res.ok) return json({ error: "calendar returned " + res.status }, 502);
      text = await res.text();
    } catch (e) {
      return json({ error: "calendar unreachable" }, 502);
    }

    const today = wallToday(tz, new Date());
    const windowStart = today;
    const windowEnd = today + 2 * DAY;
    const events = expandCalendar(text, tz, windowStart, windowEnd);
    return json({ generated: fmtWall(wallNow(tz, new Date())), people, events });
  },
};

// ---------------------------------------------------------------------------
// "Wall time" = the clock time in the display's time zone, stored as
// milliseconds as if it were UTC. Recurrence math happens in wall time, so
// a 7:30 PM daily reminder stays 7:30 PM across daylight-saving changes.

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function zoneParts(tz, date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}
function wallNow(tz, date) { return zoneParts(tz, date); }
function wallToday(tz, date) { const w = zoneParts(tz, date); return w - (w % DAY); }

// Convert a clock time in zone `fromTz` to the same instant's clock time in `toTz`.
function convertWall(wall, fromTz, toTz) {
  if (fromTz === toTz) return wall;
  let utc = wall - (zoneParts(fromTz, new Date(wall)) - wall);
  utc = wall - (zoneParts(fromTz, new Date(utc)) - utc);
  return zoneParts(toTz, new Date(utc));
}

function fmtWall(w) {
  const d = new Date(w);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------------------
// Minimal iCalendar reader

function parseLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter(Boolean).map((line) => {
    const colon = findValueColon(line);
    const left = line.slice(0, colon), value = line.slice(colon + 1);
    const bits = left.split(";");
    const params = {};
    for (const b of bits.slice(1)) { const i = b.indexOf("="); if (i > 0) params[b.slice(0, i).toUpperCase()] = b.slice(i + 1).replace(/^"|"$/g, ""); }
    return { name: bits[0].toUpperCase(), params, value };
  });
}
function findValueColon(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ":" && !q) return i;
  }
  return line.length;
}
function unescapeText(s) {
  return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

// Returns { wall, allDay } in the display zone.
function parseDate(prop, tz) {
  const v = prop.value.trim();
  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    return { wall: Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)), allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) return { wall: zoneParts(tz, new Date(wall)), allDay: false };
  const from = prop.params.TZID;
  if (from) {
    try { return { wall: convertWall(wall, from, tz), allDay: false }; } catch (e) { /* unknown zone: treat as local */ }
  }
  return { wall, allDay: false };
}
function parseDuration(v) {
  const m = (v || "").match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * HOUR) + ((+m[5] || 0) * MIN) + ((+m[6] || 0) * 1000);
  return m[1] === "-" ? -ms : ms;
}

function readEvents(text, tz) {
  const out = [];
  let ev = null, depth = 0;
  for (const p of parseLines(text)) {
    if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") { ev = { exdates: [] }; depth = 0; continue; }
    if (!ev) continue;
    if (p.name === "BEGIN") { depth++; continue; }
    if (p.name === "END" && depth > 0) { depth--; continue; }
    if (p.name === "END" && p.value.toUpperCase() === "VEVENT") { out.push(ev); ev = null; continue; }
    if (depth > 0) continue; // inside a VALARM etc.
    switch (p.name) {
      case "UID": ev.uid = p.value; break;
      case "SUMMARY": ev.title = unescapeText(p.value); break;
      case "STATUS": ev.status = p.value.toUpperCase(); break;
      case "DTSTART": ev.start = parseDate(p, tz); break;
      case "DTEND": ev.end = parseDate(p, tz); break;
      case "DURATION": ev.duration = parseDuration(p.value); break;
      case "RRULE": ev.rrule = p.value; break;
      case "RECURRENCE-ID": ev.recurrenceId = parseDate(p, tz); break;
      case "EXDATE":
        for (const v of p.value.split(",")) { const d = parseDate({ params: p.params, value: v }, tz); if (d) ev.exdates.push(d.wall); }
        break;
    }
  }
  return out.filter((e) => e.start && e.title);
}

function parseRule(s) {
  const r = {};
  for (const part of s.split(";")) { const [k, v] = part.split("="); if (k && v) r[k.toUpperCase()] = v; }
  return r;
}

// Yields occurrence start times (wall ms) in order.
function* occurrences(ev, tz, hardEnd) {
  const start = ev.start.wall;
  if (!ev.rrule) { yield start; return; }
  const r = parseRule(ev.rrule);
  const freq = r.FREQ, interval = Math.max(1, +r.INTERVAL || 1);
  let count = r.COUNT ? +r.COUNT : Infinity;
  let until = Infinity;
  if (r.UNTIL) { const u = parseDate({ params: {}, value: r.UNTIL }, tz); if (u) until = u.allDay ? u.wall + DAY - 1 : u.wall; }
  const limit = Math.min(until, hardEnd);
  const timeOfDay = start % DAY;
  let guard = 0;
  const emit = function* (t) { if (t >= start && t <= until && count > 0) { count--; yield t; } };

  if (freq === "DAILY") {
    for (let t = start; t <= limit && count > 0 && guard++ < 20000; t += interval * DAY) yield* emit(t);
  } else if (freq === "WEEKLY") {
    const days = (r.BYDAY ? r.BYDAY.split(",").map((d) => WEEKDAYS.indexOf(d.slice(-2))) : [new Date(start).getUTCDay()])
      .filter((d) => d >= 0).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday-first
    const startDay = start - timeOfDay;
    const monday = startDay - ((new Date(startDay).getUTCDay() + 6) % 7) * DAY;
    for (let wk = monday; wk <= limit && count > 0 && guard++ < 5000; wk += interval * 7 * DAY) {
      for (const d of days) {
        const t = wk + ((d + 6) % 7) * DAY + timeOfDay;
        if (t > limit) break;
        yield* emit(t);
      }
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const s = new Date(start);
    let y = s.getUTCFullYear(), mo = s.getUTCMonth();
    const step = freq === "MONTHLY" ? interval : interval * 12;
    while (guard++ < 2000 && count > 0) {
      const monthStart = Date.UTC(y, mo, 1);
      if (monthStart > limit) break;
      const daysIn = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      let dates = [];
      if (freq === "MONTHLY" && r.BYDAY) {
        for (const b of r.BYDAY.split(",")) {
          const m = b.match(/^([+-]?\d+)?([A-Z]{2})$/); if (!m) continue;
          const wd = WEEKDAYS.indexOf(m[2]); const n = m[1] ? +m[1] : 0;
          const matches = [];
          for (let d = 1; d <= daysIn; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === wd) matches.push(d);
          if (n === 0) dates.push(...matches);
          else { const pick = n > 0 ? matches[n - 1] : matches[matches.length + n]; if (pick) dates.push(pick); }
        }
      } else if (freq === "MONTHLY" && r.BYMONTHDAY) {
        dates = r.BYMONTHDAY.split(",").map((d) => (+d < 0 ? daysIn + 1 + +d : +d));
      } else {
        dates = [s.getUTCDate()];
      }
      dates = dates.filter((d) => d >= 1 && d <= daysIn).sort((a, b) => a - b);
      for (const d of dates) {
        const t = Date.UTC(y, mo, d) + timeOfDay;
        if (t > limit) break;
        yield* emit(t);
      }
      mo += step; y += Math.floor(mo / 12); mo %= 12;
    }
  } else {
    yield start; // unsupported rule: show the first occurrence only
  }
}

function expandCalendar(text, tz, windowStart, windowEnd) {
  const all = readEvents(text, tz).filter((e) => e.status !== "CANCELLED");
  const overridden = new Set(all.filter((e) => e.recurrenceId).map((e) => e.uid + "|" + e.recurrenceId.wall));
  const out = [];
  for (const ev of all) {
    if (ev.start.allDay) continue; // all-day items are left off the display
    const length = ev.end ? ev.end.wall - ev.start.wall : (ev.duration != null ? ev.duration : 0);
    const skip = new Set(ev.exdates);
    for (const t of occurrences(ev, tz, windowEnd)) {
      if (t >= windowEnd) break;
      if (skip.has(t)) continue;
      if (!ev.recurrenceId && ev.rrule && overridden.has(ev.uid + "|" + t)) continue;
      const end = t + Math.max(0, length);
      if (end < windowStart || (end === t && t < windowStart)) continue;
      out.push({ title: ev.title, start: fmtWall(t), end: length > 0 ? fmtWall(end) : null });
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out.slice(0, 100);
}

export { expandCalendar, wallToday };
