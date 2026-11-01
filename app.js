import {
  FACILITY_ID, MAX_TIMES, WEEKDAYS, addDays, attemptLabel, dateLabel, daySettings, daySummary, earliestDate,
  emptyPlan, freeCourts, hourStarts, isMemberHere, memberSearchPath, newPick, nextOccurrence, parsePlan,
  pickTitle, setDaySettings, slotsFor, toggleSlot, tooLateTonight, ukMinutes, ukToday, validateDraft,
  weekdayOf, weeklyLabel, withoutPastPicks,
} from './logic.js';

const REPO = 'meakdemir/PMT_booker';
const VARIABLE = 'PICKS';
const PMT_API = 'https://api.playmoretennis.com/api';
const GITHUB_API = 'https://api.github.com';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

const saved = {
  read(key) { try { return localStorage.getItem(key); } catch { return null; } },
  write(key, value) { try { localStorage.setItem(key, value); } catch { /* kept for this visit only */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* nothing to remove */ } },
};

const session = { pmt: saved.read('pmtSession'), github: saved.read('githubToken') };

const state = {
  plan: emptyPlan(),
  planExists: false,
  courts: [],
  hours: {},
  myPlayerId: null,
  bookings: [],
  weeklyBookings: [],
  results: [],
  draft: null,
  view: saved.read('view') === 'weekly' ? 'weekly' : 'once',
};

function freshDraft(date = earliestDate(ukToday())) {
  return { date, times: [], court: null, opponent: null, separately: false };
}

function say(text, isError = false) {
  const box = $('message');
  box.textContent = text;
  box.className = isError ? 'message error' : 'message';
  box.hidden = !text;
}

// --- Talking to PMT and GitHub ---------------------------------------------------

async function pmt(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.pmt) headers.Authorization = `Bearer ${session.pmt}`;
  const response = await fetch(`${PMT_API}/${path}`, { ...options, headers });
  if (response.status === 401 && session.pmt) {
    session.pmt = null;
    saved.remove('pmtSession');
    showScreen();
    throw new Error('Your PMT login has expired. Please log in again.');
  }
  if (!response.ok) {
    throw new Error(path === 'auth/local'
      ? 'That email or password was not recognised.'
      : `Play More Tennis returned an error (${response.status}).`);
  }
  return response.json();
}

async function github(path, options = {}) {
  return fetch(`${GITHUB_API}/${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${session.github}`,
      'Content-Type': 'application/json',
    },
  });
}

async function loadPlan() {
  const response = await github(`repos/${REPO}/actions/variables/${VARIABLE}`);
  if (response.status === 404) {
    const repo = await github(`repos/${REPO}`);
    if (!repo.ok) throw new Error('That GitHub token cannot see PMT_booker. Check its repository access.');
    state.planExists = false;
    return emptyPlan();
  }
  if (response.status === 401) throw new Error('GitHub did not accept that token. It may have expired.');
  if (!response.ok) throw new Error('That GitHub token cannot read your picks. It needs the Variables permission.');
  state.planExists = true;
  return parsePlan((await response.json()).value);
}

async function savePlan(plan) {
  const value = JSON.stringify(withoutPastPicks(plan, ukToday()));
  const response = state.planExists
    ? await github(`repos/${REPO}/actions/variables/${VARIABLE}`, {
      method: 'PATCH', body: JSON.stringify({ name: VARIABLE, value }),
    })
    : await github(`repos/${REPO}/actions/variables`, {
      method: 'POST', body: JSON.stringify({ name: VARIABLE, value }),
    });
  if (!response.ok) throw new Error('GitHub would not save your picks. The token needs Variables write access.');
  state.planExists = true;
}

// Reads the latest picks first, in case they were changed on another device.
async function changePlan(change, doneMessage) {
  try {
    const plan = await loadPlan();
    change(plan);
    await savePlan(plan);
    state.plan = { ...withoutPastPicks(plan, ukToday()), weekly: state.plan.weekly };
    renderSwitch();
    renderPicks();
    say(doneMessage);
    return true;
  } catch (error) {
    say(error.message, true);
    return false;
  }
}

async function loadResults() {
  const response = await github(`repos/${REPO}/issues?state=all&per_page=5`);
  return response.ok ? response.json() : [];
}

async function fetchBookings(dateFilter) {
  const rows = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    const body = await pmt(
      `bookings?sort=id:asc&populate[court][fields][0]=name&${dateFilter}`
      + `&filters[facility]=${FACILITY_ID}&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    rows.push(...body.data);
    pageCount = body.meta?.pagination?.pageCount ?? 1;
    page += 1;
  }
  return rows
    .filter((row) => row.attributes.slot && row.attributes.court?.data)
    .map((row) => ({
      date: row.attributes.date,
      court: row.attributes.court.data.id,
      from: row.attributes.slot.from,
      to: row.attributes.slot.to,
    }));
}

// --- Choosing an opponent --------------------------------------------------------

function opponentPicker(prefix, { read, write, afterChange = () => {} }) {
  const name = el('span');
  const picked = el('div', { class: 'row' }, name, el('button', {
    type: 'button',
    class: 'quiet',
    textContent: 'Change',
    onclick: () => {
      write(null);
      render();
      afterChange();
    },
  }));
  const input = el('input', { id: `${prefix}-opponent-search`, type: 'search', autocomplete: 'off' });
  const results = el('ul', { class: 'plain' });
  const searchArea = el('div', { class: 'stack' },
    el('label', { htmlFor: input.id, textContent: 'Search members' }), input, results);
  const root = el('div', { class: 'stack' }, picked, searchArea);
  let hideSearch = false;
  let timer;

  function render() {
    const current = read();
    picked.hidden = !current;
    name.textContent = current ? current.name : '';
    searchArea.hidden = !!current || hideSearch;
  }

  function choose(member) {
    write(member);
    input.value = '';
    results.replaceChildren();
    render();
    afterChange();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 2) {
      results.replaceChildren();
      return;
    }
    timer = setTimeout(async () => {
      try {
        const body = await pmt(memberSearchPath(text));
        const members = body.data
          .filter((row) => row.id !== state.myPlayerId && isMemberHere(row.attributes))
          .map((row) => ({ id: row.id, name: `${row.attributes.firstname} ${row.attributes.surname}` }));
        results.replaceChildren(...(members.length
          ? members.map((member) => el('li', {}, el('button', {
            type: 'button', class: 'quiet wide', textContent: member.name, onclick: () => choose(member),
          })))
          : [el('li', { class: 'note', textContent: 'No members found.' })]));
      } catch (error) {
        say(error.message, true);
      }
    }, 300);
  });

  return {
    root,
    render,
    setSearchHidden(value) {
      hideSearch = value;
      render();
    },
  };
}

const onceOpponent = opponentPicker('once', {
  read: () => state.draft?.opponent,
  write: (member) => { state.draft.opponent = member; },
});

// One per day, kept between renders so a search in progress isn't lost.
const dayOpponents = Object.fromEntries(WEEKDAYS.map((day) => [day, opponentPicker(day.toLowerCase(), {
  read: () => daySettings(state.plan.weekly, day).opponent,
  write: (member) => {
    state.plan.weekly = setDaySettings(state.plan.weekly, day, { opponent: member });
  },
  afterChange: () => {
    renderWeekly();
    queueWeeklySave();
  },
})]));

// --- Rendering -------------------------------------------------------------------

function renderSwitch() {
  const on = state.plan.live;
  $('switch-state').textContent = on ? 'On' : 'Off';
  $('switch-state').className = on ? 'pill on' : 'pill';
  $('switch-note').textContent = on
    ? 'Real bookings will be made on your account at 00:00.'
    : 'Nothing will be booked while this is off.';
  $('switch-button').textContent = on ? 'Turn off' : 'Turn on';
}

function renderView() {
  $('view-once').checked = state.view === 'once';
  $('view-weekly').checked = state.view === 'weekly';
  $('once-view').hidden = state.view !== 'once';
  $('weekly-view').hidden = state.view !== 'weekly';
}

function chip(start, note, { selected, full, onclick }) {
  return el('button', {
    type: 'button',
    class: `chip${selected ? ' selected' : ''}${full ? ' full' : ''}`,
    'aria-pressed': String(selected),
    onclick,
  },
  el('span', { class: 'chip-time', textContent: start }),
  el('span', { class: 'chip-note', textContent: note }));
}

function renderDraftDate() {
  const { draft } = state;
  const today = ukToday();
  $('date').min = earliestDate(today);
  $('date').value = draft.date;
  if (!draft.date) {
    $('preview-note').textContent = 'Choose a date to see free courts.';
    $('late-note').hidden = true;
    return;
  }
  $('preview-note').textContent = `Courts free so far on ${dateLabel(draft.date)}. Full means already blocked before release.`;
  $('late-note').hidden = !tooLateTonight(draft.date, today, ukMinutes());
}

function renderTimes() {
  const { draft, courts, bookings, hours } = state;
  const box = $('times');
  const starts = draft.date ? hourStarts(hours[weekdayOf(draft.date)]) : [];
  if (!starts.length) {
    box.replaceChildren(el('p', { class: 'note', textContent: 'Closed that day.' }));
    return;
  }
  box.replaceChildren(...starts.map((start) => {
    const free = freeCourts(start, courts, bookings).length;
    const order = draft.times.indexOf(start);
    const note = order >= 0 ? `Choice ${order + 1}` : free === 0 ? 'Full' : `${free} free`;
    return chip(start, note, { selected: order >= 0, full: free === 0, onclick: () => toggleTime(start) });
  }));
}

function toggleTime(start) {
  const { draft } = state;
  const index = draft.times.indexOf(start);
  if (index >= 0) draft.times.splice(index, 1);
  else if (draft.times.length < MAX_TIMES) draft.times.push(start);
  renderTimes();
}

function courtOptions(select, chosen) {
  select.replaceChildren(
    el('option', { value: '', textContent: 'Any court' }),
    ...state.courts.map((court) => el('option', { value: String(court.id), textContent: court.name })),
  );
  select.value = chosen ? String(chosen) : '';
}

function renderPicks() {
  const today = ukToday();
  const { picks } = state.plan;
  $('picks-empty').hidden = picks.length > 0;
  $('picks').replaceChildren(...picks.map((pick) => el('li', { class: 'pick' },
    el('div', { class: 'pick-head' },
      el('strong', { textContent: pickTitle(pick) }),
      el('span', { class: 'pick-actions' }, el('button', {
        type: 'button',
        class: 'quiet',
        textContent: 'Remove',
        onclick: () => changePlan((plan) => {
          plan.picks = plan.picks.filter((item) => item.id !== pick.id);
        }, 'Removed.'),
      }))),
    el('p', { textContent: pick.times.join(', then ') }),
    el('p', { textContent: pick.opponent ? `With ${pick.opponent.name}` : 'Opponent arranged separately' }),
    el('p', { class: 'note', textContent: attemptLabel(pick, today) }))));
}

function renderWeeklySummary() {
  const { weekly } = state.plan;
  const days = WEEKDAYS.filter((day) => slotsFor(weekly, day).length);
  $('weekly-summary').replaceChildren(...(days.length
    ? days.map((day) => el('li', {},
      el('strong', { textContent: `${day}: ` }), daySummary(weekly, day, state.courts)))
    : [el('li', { class: 'note', textContent: 'No slots chosen yet.' })]));
}

function daySettingsForm(day) {
  const { opponent, courts } = daySettings(state.plan.weekly, day);
  const select = el('select', {
    id: `${day.toLowerCase()}-court`,
    onchange: () => {
      const court = select.value ? [Number(select.value)] : [];
      state.plan.weekly = setDaySettings(state.plan.weekly, day, { courts: court });
      renderWeeklySummary();
      queueWeeklySave();
    },
  });
  courtOptions(select, courts[0]);

  const picker = dayOpponents[day];
  picker.render();
  const opponentArea = el('div', { class: 'stack' },
    el('p', { class: 'field-label', textContent: `${day}'s opponent` }), picker.root);
  if (!opponent) {
    opponentArea.append(el('p', { class: 'note', textContent: 'None chosen, so you\'ll arrange your own.' }));
  }

  return el('div', { class: 'stack day-settings' },
    el('div', { class: 'stack' },
      el('label', { htmlFor: select.id, textContent: `${day}'s preferred court` }), select),
    opponentArea);
}

function renderWeeklyDays() {
  const { weekly } = state.plan;
  const today = ukToday();
  $('weekly-days').replaceChildren(...WEEKDAYS.map((day) => {
    const date = nextOccurrence(day, today);
    const bookings = state.weeklyBookings.filter((booking) => booking.date === date);
    const chosen = slotsFor(weekly, day);
    const starts = hourStarts(state.hours[day]);
    const fullChosen = chosen.filter((time) => freeCourts(time, state.courts, bookings).length === 0);

    const section = el('div', { class: 'day' }, el('h3', { textContent: day }));
    section.append(starts.length
      ? el('div', { class: 'chips' }, ...starts.map((start) => {
        const free = freeCourts(start, state.courts, bookings).length;
        const selected = chosen.includes(start);
        const count = free === 0 ? 'Full' : `${free} free`;
        return chip(start, selected ? `✓ ${count}` : count, {
          selected,
          full: free === 0,
          onclick: () => {
            state.plan.weekly = toggleSlot(state.plan.weekly, day, start);
            renderWeekly();
            queueWeeklySave();
          },
        });
      }))
      : el('p', { class: 'note', textContent: 'Closed.' }));
    if (chosen.length) section.append(el('p', { class: 'note', textContent: weeklyLabel(day, today) }));
    if (fullChosen.length) {
      section.append(el('p', {
        class: 'note warn',
        textContent: `${fullChosen.join(', ')} is full on ${dateLabel(date)} so far, so it won't book that week unless a court comes free.`,
      }));
    }
    if (chosen.length && tooLateTonight(date, today, ukMinutes())) {
      section.append(el('p', {
        class: 'note warn',
        textContent: 'Tonight\'s last run has probably started, so this change may not count until next week.',
      }));
    }
    if (chosen.length) section.append(daySettingsForm(day));
    return section;
  }));
}

function renderWeekly() {
  renderWeeklySummary();
  renderWeeklyDays();
}

function renderResults() {
  $('results-empty').hidden = state.results.length > 0;
  $('results').replaceChildren(...state.results.map((issue) => el('li', {},
    el('a', { href: issue.html_url, target: '_blank', rel: 'noreferrer', textContent: issue.title }))));
}

function showScreen() {
  const needsPmt = !session.pmt;
  const needsGithub = !session.github;
  $('connect').hidden = !needsPmt && !needsGithub;
  $('pmt-login').hidden = !needsPmt;
  $('github-login').hidden = !needsGithub;
  $('app').hidden = needsPmt || needsGithub;
}

// --- Saving the weekly plan ------------------------------------------------------

let weeklyTimer;
let weeklySaving = false;
let weeklyChangedAgain = false;

function queueWeeklySave() {
  $('weekly-status').textContent = 'Saving...';
  clearTimeout(weeklyTimer);
  weeklyTimer = setTimeout(saveWeekly, 400);
}

async function saveWeekly() {
  if (weeklySaving) {
    weeklyChangedAgain = true;
    return;
  }
  weeklySaving = true;
  try {
    const plan = await loadPlan();
    plan.weekly = state.plan.weekly;
    await savePlan(plan);
    state.plan.live = plan.live;
    state.plan.picks = withoutPastPicks(plan, ukToday()).picks;
    renderSwitch();
    renderPicks();
    $('weekly-status').textContent = 'Saved';
    say('');
  } catch (error) {
    $('weekly-status').textContent = 'Not saved';
    say(error.message, true);
  } finally {
    weeklySaving = false;
    if (weeklyChangedAgain) {
      weeklyChangedAgain = false;
      saveWeekly();
    }
  }
}

// --- Loading ---------------------------------------------------------------------

async function refreshPreview() {
  renderDraftDate();
  try {
    const { draft } = state;
    state.bookings = draft.date ? await fetchBookings(`filters[date][$eq]=${draft.date}`) : [];
    const open = draft.date ? hourStarts(state.hours[weekdayOf(draft.date)]) : [];
    draft.times = draft.times.filter((time) => open.includes(time));
    renderTimes();
  } catch (error) {
    say(error.message, true);
  }
}

async function loadApp() {
  showScreen();
  if (!session.pmt || !session.github) return;
  say('Loading...');
  try {
    const [me, courts, hours] = await Promise.all([
      pmt('users/me?populate=*'),
      pmt(`courts?filters[facility][id][$eq]=${FACILITY_ID}`),
      pmt(`opening-hours?populate=*&filters[facility][id][$eq]=${FACILITY_ID}`),
    ]);
    state.myPlayerId = me.player?.id ?? null;
    state.courts = courts.data
      .map((row) => ({ id: row.id, name: row.attributes.name }))
      .sort((a, b) => a.id - b.id);
    state.hours = {};
    for (const day of hours.data[0]?.attributes?.openingHours || []) {
      if (!day.closed && day.times) state.hours[day.day] = day.times;
    }
    state.draft = freshDraft();
    state.plan = await loadPlan();
    state.results = await loadResults();
    const first = earliestDate(ukToday());
    state.weeklyBookings = await fetchBookings(
      `filters[date][$gte]=${first}&filters[date][$lte]=${addDays(first, 6)}`,
    );
    renderView();
    renderSwitch();
    courtOptions($('court'), null);
    onceOpponent.render();
    renderPicks();
    renderWeekly();
    renderResults();
    await refreshPreview();
    say('');
  } catch (error) {
    say(error.message, true);
  }
}

// --- Actions ---------------------------------------------------------------------

async function logInToPmt(event) {
  event.preventDefault();
  say('');
  try {
    const body = JSON.stringify({ identifier: $('pmt-email').value.trim(), password: $('pmt-password').value });
    const { jwt } = await pmt('auth/local', { method: 'POST', body });
    session.pmt = jwt;
    saved.write('pmtSession', jwt);
    $('pmt-password').value = '';
    await loadApp();
  } catch (error) {
    say(error.message, true);
  }
}

async function saveGithubToken(event) {
  event.preventDefault();
  session.github = $('github-token').value.trim();
  saved.write('githubToken', session.github);
  $('github-token').value = '';
  await loadApp();
}

function logOut() {
  saved.remove('pmtSession');
  saved.remove('githubToken');
  session.pmt = null;
  session.github = null;
  say('Logged out on this device.');
  showScreen();
}

async function addPick(event) {
  event.preventDefault();
  const { draft } = state;
  const problem = validateDraft(draft, ukToday());
  if (problem) {
    say(problem, true);
    return;
  }
  const pick = newPick(draft, crypto.randomUUID());
  const added = await changePlan((plan) => plan.picks.push(pick), `Saved ${pickTitle(pick)}.`);
  if (added) {
    state.draft = freshDraft(draft.date);
    $('separately').checked = false;
    onceOpponent.setSearchHidden(false);
    courtOptions($('court'), null);
    renderTimes();
  }
}

function wire() {
  $('once-opponent').append(onceOpponent.root);
  $('pmt-login').addEventListener('submit', logInToPmt);
  $('github-login').addEventListener('submit', saveGithubToken);
  $('log-out').addEventListener('click', logOut);
  $('add-pick').addEventListener('submit', addPick);
  $('switch-button').addEventListener('click', () => {
    const next = !state.plan.live;
    changePlan((plan) => { plan.live = next; }, next ? 'Automatic booking is on.' : 'Automatic booking is off.');
  });
  for (const id of ['view-once', 'view-weekly']) {
    $(id).addEventListener('change', () => {
      state.view = $('view-weekly').checked ? 'weekly' : 'once';
      saved.write('view', state.view);
      renderView();
    });
  }
  $('date').addEventListener('change', () => {
    state.draft.date = $('date').value;
    refreshPreview();
  });
  $('court').addEventListener('change', () => {
    state.draft.court = $('court').value ? Number($('court').value) : null;
  });
  $('separately').addEventListener('change', () => {
    state.draft.separately = $('separately').checked;
    if (state.draft.separately) state.draft.opponent = null;
    onceOpponent.setSearchHidden(state.draft.separately);
  });
}

wire();
loadApp();
