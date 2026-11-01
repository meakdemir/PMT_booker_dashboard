import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays, attemptLabel, dateLabel, earliestDate, freeCourts, hourStarts, isMemberHere, memberSearchPath,
  newPick, nextAttempt, nextOccurrence, parsePlan, tooLateTonight, ukMinutes, ukToday, validateDraft,
  weekdayOf, withoutPastPicks,
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
  const pick = { date: '2026-11-20', times: ['19:00'] };
  assert.deepEqual(nextAttempt(pick, TODAY), { date: '2026-11-20', opensOn: '2026-11-13' });
  assert.equal(attemptLabel(pick, TODAY), 'Booking at 00:00 on Fri 13 Nov');
  assert.equal(attemptLabel({ date: '2026-11-09', times: [] }, TODAY), 'Booking tonight at 00:00 (Mon 2 Nov)');
  assert.equal(attemptLabel({ weekday: 'Monday', times: [] }, TODAY), 'Next: Mon 9 Nov, booking tonight at 00:00 (Mon 2 Nov)');
  assert.equal(attemptLabel({ weekday: 'Monday', paused: true, times: [] }, TODAY), 'Paused');
});

test('dates already released cannot be attempted', () => {
  assert.equal(nextAttempt({ date: '2026-11-08', times: [] }, TODAY), null);
  assert.equal(attemptLabel({ date: '2026-11-08', times: [] }, TODAY), 'Already released');
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
  assert.deepEqual(parsePlan(''), { live: false, picks: [] });
  assert.deepEqual(parsePlan('{"live":"yes"}'), { live: false, picks: [] });
  assert.equal(parsePlan('{"live":true,"picks":[]}').live, true);
  assert.throws(() => parsePlan('{oops'));
});

test('past one-off picks are tidied away but weekly ones stay', () => {
  const plan = { live: true, picks: [{ date: '2026-10-01' }, { date: TODAY }, { weekday: 'Monday' }] };
  assert.equal(withoutPastPicks(plan, TODAY).picks.length, 2);
});

test('a draft must be complete before it can be saved', () => {
  const base = { mode: 'once', date: '2026-11-09', times: ['19:00'], opponent: { id: 1, name: 'A' }, separately: false };
  assert.equal(validateDraft(base, TODAY), null);
  assert.match(validateDraft({ ...base, date: '2026-11-08' }, TODAY), /already been released/);
  assert.match(validateDraft({ ...base, times: [] }, TODAY), /at least one time/);
  assert.match(validateDraft({ ...base, opponent: null }, TODAY), /opponent/);
  assert.equal(validateDraft({ ...base, opponent: null, separately: true }, TODAY), null);
  assert.equal(validateDraft({ ...base, mode: 'weekly', date: null }, TODAY), null);
});

test('new picks have the shape book.py reads', () => {
  const once = newPick({ mode: 'once', date: '2026-11-09', weekday: 'Monday', times: ['19:00', '20:00'], court: 5, opponent: { id: 42, name: 'A B', extra: 1 } }, 'x');
  assert.deepEqual(once, {
    id: 'x', date: '2026-11-09', times: ['19:00', '20:00'], courts: [5], opponent: { id: 42, name: 'A B' },
  });
  const weekly = newPick({ mode: 'weekly', date: '2026-11-09', weekday: 'Monday', times: ['19:00'], court: null, opponent: null }, 'y');
  assert.deepEqual(weekly, { id: 'y', weekday: 'Monday', times: ['19:00'], courts: [], opponent: null });
});
