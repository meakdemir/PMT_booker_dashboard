// Date and pick rules, kept apart from the page so they can be tested.
// These must agree with book.py in the private PMT_booker repo.

export const BOOKING_DAYS = 7;
export const FACILITY_ID = 1;
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MAX_TIMES = 5;

const UK = 'Europe/London';

const atNoon = (iso) => new Date(`${iso}T12:00:00Z`);

export function ukToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UK }).format(now);
}

export function ukMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: UK, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return value('hour') * 60 + value('minute');
}

export function addDays(iso, days) {
  const date = atNoon(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekdayOf(iso) {
  return WEEKDAYS[(atNoon(iso).getUTCDay() + 6) % 7];
}

export function dateLabel(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(atNoon(iso)).replace(',', '');
}

// The first date that has not been released yet, so the booker can still catch it.
export function earliestDate(today) {
  return addDays(today, BOOKING_DAYS + 1);
}

export function nextOccurrence(weekday, today) {
  let date = earliestDate(today);
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}

export function nextAttempt(pick, today) {
  if (pick.paused) return null;
  const date = pick.weekday ? nextOccurrence(pick.weekday, today) : pick.date;
  if (date < earliestDate(today)) return null;
  return { date, opensOn: addDays(date, -BOOKING_DAYS) };
}

export function attemptLabel(pick, today) {
  if (pick.paused) return 'Paused';
  const attempt = nextAttempt(pick, today);
  if (!attempt) return 'Already released';
  const when = attempt.opensOn === addDays(today, 1)
    ? `tonight at 00:00 (${dateLabel(attempt.opensOn)})`
    : `at 00:00 on ${dateLabel(attempt.opensOn)}`;
  return pick.weekday ? `Next: ${dateLabel(attempt.date)}, booking ${when}` : `Booking ${when}`;
}

// The last run starts at 23:37 and reads your picks when it starts.
export function tooLateTonight(date, today, minutes) {
  return addDays(date, -BOOKING_DAYS) === addDays(today, 1) && minutes >= 23 * 60 + 30;
}

export function pickTitle(pick) {
  return pick.weekday ? `Every ${pick.weekday}` : dateLabel(pick.date);
}

export function hourStarts(hours) {
  if (!hours) return [];
  const [fromHour, fromMinute] = hours.from.split(':').map(Number);
  const [toHour] = hours.to.split(':').map(Number);
  const starts = [];
  for (let hour = fromHour + (fromMinute > 0 ? 1 : 0); hour < toHour; hour += 1) {
    starts.push(`${String(hour).padStart(2, '0')}:00`);
  }
  return starts;
}

export function endOf(start) {
  return `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`;
}

export function freeCourts(start, courts, bookings) {
  const end = endOf(start);
  return courts.filter((court) => !bookings.some(
    (booking) => booking.court === court.id && start < booking.to && end > booking.from,
  ));
}

export function memberSearchPath(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 3);
  const filters = words.flatMap((word, index) => {
    const value = encodeURIComponent(word);
    return [
      `filters[$and][${index}][$or][0][firstname][$containsi]=${value}`,
      `filters[$and][${index}][$or][1][surname][$containsi]=${value}`,
    ];
  });
  return `players?${filters.join('&')}&fields[0]=firstname&fields[1]=surname`
    + '&populate[facilityMember]=*&pagination[pageSize]=20';
}

export function isMemberHere(attributes) {
  return (attributes.facilityMember || []).some(
    (entry) => Number(entry.facility) === FACILITY_ID && entry.member,
  );
}

export function emptyPlan() {
  return { live: false, picks: [] };
}

export function parsePlan(text) {
  if (!text || !text.trim()) return emptyPlan();
  const data = JSON.parse(text);
  return { live: data.live === true, picks: Array.isArray(data.picks) ? data.picks : [] };
}

export function withoutPastPicks(plan, today) {
  return { ...plan, picks: plan.picks.filter((pick) => pick.weekday || pick.date >= today) };
}

export function validateDraft(draft, today) {
  if (draft.mode === 'once' && !(draft.date >= earliestDate(today))) {
    return `Choose ${dateLabel(earliestDate(today))} or later. Earlier dates have already been released, so book those in the app.`;
  }
  if (!draft.times.length) return 'Choose at least one time.';
  if (!draft.opponent && !draft.separately) return 'Choose an opponent, or tick that you will arrange one yourself.';
  return null;
}

export function newPick(draft, id) {
  return {
    id,
    ...(draft.mode === 'weekly' ? { weekday: draft.weekday } : { date: draft.date }),
    times: [...draft.times],
    courts: draft.court ? [draft.court] : [],
    opponent: draft.opponent ? { id: draft.opponent.id, name: draft.opponent.name } : null,
  };
}
