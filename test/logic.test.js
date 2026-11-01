import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays, attemptLabel, dateLabel, daySettings, daySummary, earliestDate, emptyPlan, freeCourts, hourStarts,
  isMemberHere, memberSearchPath, newPick, nextOccurrence, parsePlan, setDaySettings, slotsFor, toggleSlot,
  tooLateTonight, ukMinutes, ukToday, validateDraft, weekdayOf, weeklyLabel, withoutPastPicks,
} from '../logic.js';

const TODAY = '2026-11-01'; // a Sunday
const COURTS = [{ id: 1 }, { id: 5 }, { id: 15 }];

test('dates use UK time, even late in the evening elsewhere', () => {
  assert.equal(ukToday(new Date('2026-11-01T23:59:00Z')), '2026-11-01');
  assert.equal(ukToday(new Date('2026-07-01T23:30:00Z')), '2026-07-02'); // BST
  assert.equal(ukMinutes(new Date('2026-07-01T23:30:00Z')), 30);
});

test('date helpers survive the clock change', () => {
  assert.equal(addDays('2026-10-24', 2), '2026-10-26');
  assert.equal(weekdayOf('2026-11-09'), 'Monday');
  assert.equal(dateLabel('2026-11-09'), 'Mon 9 Nov');
});

test('the earliest pickable date is the one released at the coming midnight', () => {
  assert.equal(earliestDate(TODAY), '2026-11-09');
  assert.equal(nextOccurrence('Monday', TODAY), '2026-11-09');
  assert.equal(nextOccurrence('Sunday', TODAY), '2026-11-15');
});

test('a pick opens seven days ahead and says when it will be booked', () => {
  assert.equal(attemptLabel({ date: '2026-11-20' }, TODAY), 'Booking at 00:00 on Fri 13 Nov');
  assert.equal(attemptLabel({ date: '2026-11-09' }, TODAY), 'Booking tonight at 00:00 (Mon 2 Nov)');
  assert.equal(attemptLabel({ date: '2026-11-08' }, TODAY), 'Already released');
});

test('a weekly day says when its next booking happens', () => {
  assert.equal(weeklyLabel('Monday', TODAY), 'Next: Mon 9 Nov, booking tonight at 00:00 (Mon 2 Nov)');
  assert.equal(weeklyLabel('Thursday', TODAY), 'Next: Thu 12 Nov, booking at 00:00 on Thu 5 Nov');
});

test('warns only once tonight\'s last run has probably started', () => {
  assert.equal(tooLateTonight('2026-11-09', TODAY, 23 * 60 + 45), true);
  assert.equal(tooLateTonight('2026-11-09', TODAY, 22 * 60), false);
  assert.equal(tooLateTonight('2026-11-10', TODAY, 23 * 60 + 45), false);
});

test('hour slots stay inside opening hours', () => {
  assert.deepEqual(hourStarts({ from: '14:00', to: '17:00' }), ['14:00', '15:00', '16:00']);
  assert.deepEqual(hourStarts({ from: '09:30', to: '12:00' }), ['10:00', '11:00']);
  assert.deepEqual(hourStarts(undefined), []);
});

test('half-hour bookings make a whole-hour slot unavailable', () => {
  const bookings = [
    { court: 1, from: '18:30', to: '19:30' },
    { court: 5, from: '20:00', to: '21:00' },
    { court: 15, from: '18:00', to: '19:00' },
  ];
  assert.deepEqual(freeCourts('19:00', COURTS, bookings).map((c) => c.id), [5, 15]);
});

test('member search needs every word to match', () => {
  const path = memberSearchPath(' sam  taylor ');
  assert.match(path, /filters\[\$and\]\[0\]\[\$or\]\[0\]\[firstname\]\[\$containsi\]=sam/);
  assert.match(path, /filters\[\$and\]\[1\]\[\$or\]\[1\]\[surname\]\[\$containsi\]=taylor/);
  assert.match(memberSearchPath('a&b=c'), /=a%26b%3Dc/);
});

test('only members of this facility count', () => {
  assert.equal(isMemberHere({ facilityMember: [{ facility: '1', member: true }] }), true);
  assert.equal(isMemberHere({ facilityMember: [{ facility: '1', member: false }] }), false);
  assert.equal(isMemberHere({ facilityMember: [{ facility: '2', member: true }] }), false);
  assert.equal(isMemberHere({}), false);
});

test('saved picks parse safely and default to off', () => {
  assert.deepEqual(parsePlan(''), emptyPlan());
  assert.deepEqual(parsePlan('{"live":"yes"}'), emptyPlan());
  assert.equal(parsePlan('{"live":true,"picks":[]}').live, true);
  assert.deepEqual(parsePlan('{"live":true,"picks":[]}').weekly, emptyPlan().weekly);
  assert.deepEqual(parsePlan('{"weekly":{"slots":"oops"}}').weekly.slots, []);
  assert.throws(() => parsePlan('{oops'));
});

test('past one-date picks are tidied away and the weekly plan stays', () => {
  const weekly = { slots: [{ weekday: 'Monday', time: '19:00' }], days: {} };
  const plan = { live: true, picks: [{ date: '2026-10-01' }, { date: TODAY }], weekly };
  const tidied = withoutPastPicks(plan, TODAY);
  assert.equal(tidied.picks.length, 1);
  assert.deepEqual(tidied.weekly, weekly);
});

test('tapping weekly slots adds and removes them, kept in day and time order', () => {
  let weekly = emptyPlan().weekly;
  weekly = toggleSlot(weekly, 'Sunday', '16:00');
  weekly = toggleSlot(weekly, 'Monday', '20:00');
  weekly = toggleSlot(weekly, 'Monday', '19:00');
  weekly = toggleSlot(weekly, 'Thursday', '19:00');
  assert.deepEqual(weekly.slots, [
    { weekday: 'Monday', time: '19:00' },
    { weekday: 'Monday', time: '20:00' },
    { weekday: 'Thursday', time: '19:00' },
    { weekday: 'Sunday', time: '16:00' },
  ]);
  assert.deepEqual(slotsFor(weekly, 'Monday'), ['19:00', '20:00']);
  weekly = toggleSlot(weekly, 'Monday', '19:00');
  assert.deepEqual(slotsFor(weekly, 'Monday'), ['20:00']);
  assert.deepEqual(slotsFor(weekly, 'Tuesday'), []);
});

test('tapping a slot keeps each day\'s court and opponent', () => {
  const weekly = { slots: [], days: { Monday: { opponent: { id: 42, name: 'A B' }, courts: [5] } } };
  const changed = toggleSlot(weekly, 'Monday', '19:00');
  assert.deepEqual(changed.days, weekly.days);
  assert.deepEqual(weekly.slots, []);
  const removed = toggleSlot(changed, 'Monday', '19:00');
  assert.deepEqual(daySettings(removed, 'Monday').courts, [5]);
});

test('each day has its own court and opponent, defaulting to any court and no opponent', () => {
  let weekly = emptyPlan().weekly;
  assert.deepEqual(daySettings(weekly, 'Monday'), { opponent: null, courts: [] });
  weekly = setDaySettings(weekly, 'Monday', { courts: [5] });
  weekly = setDaySettings(weekly, 'Monday', { opponent: { id: 42, name: 'A B' } });
  weekly = setDaySettings(weekly, 'Thursday', { courts: [15] });
  assert.deepEqual(daySettings(weekly, 'Monday'), { opponent: { id: 42, name: 'A B' }, courts: [5] });
  assert.deepEqual(daySettings(weekly, 'Thursday'), { opponent: null, courts: [15] });
  assert.deepEqual(daySettings(weekly, 'Sunday'), { opponent: null, courts: [] });
});

test('a plan saved with one court and opponent gives them to its days', () => {
  const old = '{"weekly":{"slots":[{"weekday":"Monday","time":"19:00"}],"opponent":{"id":42,"name":"A B"},"courts":[5]}}';
  const { weekly } = parsePlan(old);
  assert.deepEqual(daySettings(weekly, 'Monday'), { opponent: { id: 42, name: 'A B' }, courts: [5] });
  assert.deepEqual(daySettings(weekly, 'Tuesday'), { opponent: null, courts: [] });
  assert.deepEqual(Object.keys(weekly).sort(), ['days', 'slots']);
});

test('a day\'s own settings are not overwritten by older plan-wide ones', () => {
  const mixed = '{"weekly":{"slots":[{"weekday":"Monday","time":"19:00"}],"opponent":{"id":42,"name":"A B"},"courts":[5],"days":{"Monday":{"opponent":null,"courts":[15]}}}}';
  assert.deepEqual(daySettings(parsePlan(mixed).weekly, 'Monday'), { opponent: null, courts: [15] });
});

test('the summary reads naturally for each day', () => {
  const courts = [{ id: 5, name: 'Court 2' }];
  let weekly = toggleSlot(toggleSlot(emptyPlan().weekly, 'Monday', '20:00'), 'Monday', '19:00');
  assert.equal(daySummary(weekly, 'Monday', courts), '19:00, 20:00 on any court, arranging your own opponent');
  weekly = setDaySettings(weekly, 'Monday', { courts: [5], opponent: { id: 42, name: 'A B' } });
  assert.equal(daySummary(weekly, 'Monday', courts), '19:00, 20:00 on Court 2, with A B');
});

test('a draft must be complete before it can be saved', () => {
  const base = { date: '2026-11-09', times: ['19:00'], opponent: { id: 1, name: 'A' }, separately: false };
  assert.equal(validateDraft(base, TODAY), null);
  assert.match(validateDraft({ ...base, date: '2026-11-08' }, TODAY), /already been released/);
  assert.match(validateDraft({ ...base, date: '' }, TODAY), /already been released/);
  assert.match(validateDraft({ ...base, times: [] }, TODAY), /at least one time/);
  assert.match(validateDraft({ ...base, opponent: null }, TODAY), /opponent/);
  assert.equal(validateDraft({ ...base, opponent: null, separately: true }, TODAY), null);
});

test('new picks have the shape book.py reads', () => {
  const pick = newPick({ date: '2026-11-09', times: ['19:00', '20:00'], court: 5, opponent: { id: 42, name: 'A B', extra: 1 } }, 'x');
  assert.deepEqual(pick, {
    id: 'x', date: '2026-11-09', times: ['19:00', '20:00'], courts: [5], opponent: { id: 42, name: 'A B' },
  });
  assert.deepEqual(newPick({ date: '2026-11-09', times: ['19:00'], court: null, opponent: null }, 'y').courts, []);
});
