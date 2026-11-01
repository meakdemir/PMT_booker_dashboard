import {
  FACILITY_ID, MAX_TIMES, WEEKDAYS, attemptLabel, dateLabel, earliestDate, emptyPlan, freeCourts,
  hourStarts, isMemberHere, memberSearchPath, newPick, nextOccurrence, parsePlan, pickTitle,
  tooLateTonight, ukMinutes, ukToday, validateDraft, weekdayOf, withoutPastPicks,
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
  results: [],
  draft: null,
};

function freshDraft() {
  const today = ukToday();
  return {
    mode: 'once',
    date: earliestDate(today),
    weekday: 'Monday',
    times: [],
    court: null,
    opponent: null,
    separately: false,
  };
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
    state.plan = withoutPastPicks(plan, ukToday());
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

function previewDate() {
  const { draft } = state;
  return draft.mode === 'once' ? draft.date : nextOccurrence(draft.weekday, ukToday());
}

function renderDraftMode() {
  const { draft } = state;
  const today = ukToday();
  $('mode-once').checked = draft.mode === 'once';
  $('mode-weekly').checked = draft.mode === 'weekly';
  $('date-field').hidden = draft.mode !== 'once';
  $('weekday-field').hidden = draft.mode !== 'weekly';
  $('date').min = earliestDate(today);
  $('date').value = draft.date;
  $('weekday').value = draft.weekday;

  const date = previewDate();
  if (!date) {
    $('preview-note').textContent = 'Choose a date to see free courts.';
    $('late-note').hidden = true;
    return;
  }
  $('preview-note').textContent = draft.mode === 'weekly'
    ? `Free courts shown for ${dateLabel(date)}, the next one. Other weeks can differ.`
    : `Courts free so far on ${dateLabel(date)}. Full means already blocked before release.`;
  $('late-note').hidden = !tooLateTonight(date, today, ukMinutes());
}

function renderTimes() {
  const { draft, courts, bookings, hours } = state;
  const date = previewDate();
  const box = $('times');
  const starts = date ? hourStarts(hours[weekdayOf(date)]) : [];
  if (!starts.length) {
    box.replaceChildren(el('p', { class: 'note', textContent: 'Closed that day.' }));
    return;
  }
  box.replaceChildren(...starts.map((start) => {
    const free = freeCourts(start, courts, bookings).length;
    const order = draft.times.indexOf(start);
    return el('button', {
      type: 'button',
      class: `chip${order >= 0 ? ' selected' : ''}${free === 0 ? ' full' : ''}`,
      'aria-pressed': String(order >= 0),
      onclick: () => toggleTime(start),
    },
    el('span', { class: 'chip-time', textContent: start }),
    el('span', {
      class: 'chip-note',
      textContent: order >= 0 ? `Choice ${order + 1}` : free === 0 ? 'Full' : `${free} free`,
    }));
  }));
}

function toggleTime(start) {
  const { draft } = state;
  const index = draft.times.indexOf(start);
  if (index >= 0) draft.times.splice(index, 1);
  else if (draft.times.length < MAX_TIMES) draft.times.push(start);
  renderTimes();
}

function renderCourts() {
  $('court').replaceChildren(
    el('option', { value: '', textContent: 'Any court' }),
    ...state.courts.map((court) => el('option', { value: String(court.id), textContent: court.name })),
  );
  $('court').value = state.draft.court ? String(state.draft.court) : '';
}

function renderOpponent() {
  const { draft } = state;
  $('opponent-picked').hidden = !draft.opponent;
  $('opponent-search-area').hidden = !!draft.opponent || draft.separately;
  $('opponent-name').textContent = draft.opponent ? draft.opponent.name : '';
  $('separately').checked = draft.separately;
}

function renderPicks() {
  const today = ukToday();
  const { picks } = state.plan;
  $('picks-empty').hidden = picks.length > 0;
  $('picks').replaceChildren(...picks.map((pick) => {
    const actions = [];
    if (pick.weekday) {
      actions.push(el('button', {
        type: 'button',
        class: 'quiet',
        textContent: pick.paused ? 'Resume' : 'Pause',
        onclick: () => changePlan((plan) => {
          const match = plan.picks.find((item) => item.id === pick.id);
          if (match) match.paused = !match.paused;
        }, pick.paused ? 'Resumed.' : 'Paused.'),
      }));
    }
    actions.push(el('button', {
      type: 'button',
      class: 'quiet',
      textContent: 'Remove',
      onclick: () => changePlan((plan) => {
        plan.picks = plan.picks.filter((item) => item.id !== pick.id);
      }, 'Removed.'),
    }));
    return el('li', { class: 'pick' },
      el('div', { class: 'pick-head' },
        el('strong', { textContent: pickTitle(pick) }),
        el('span', { class: 'pick-actions' }, ...actions)),
      el('p', { textContent: pick.times.join(', then ') }),
      el('p', { textContent: pick.opponent ? `With ${pick.opponent.name}` : 'Opponent arranged separately' }),
      el('p', { class: 'note', textContent: attemptLabel(pick, today) }));
  }));
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

// --- Loading ---------------------------------------------------------------------

async function loadBookings() {
  const date = previewDate();
  if (!date) {
    state.bookings = [];
    return;
  }
  const body = await pmt(
    'bookings?sort=id:asc&populate[court][fields][0]=name'
    + `&filters[date][$eq]=${date}&filters[facility]=${FACILITY_ID}&pagination[pageSize]=100`,
  );
  state.bookings = body.data
    .filter((row) => row.attributes.slot && row.attributes.court?.data)
    .map((row) => ({
      court: row.attributes.court.data.id,
      from: row.attributes.slot.from,
      to: row.attributes.slot.to,
    }));
}

async function refreshPreview() {
  renderDraftMode();
  try {
    await loadBookings();
    const open = hourStarts(state.hours[weekdayOf(previewDate() || ukToday())]);
    state.draft.times = state.draft.times.filter((time) => open.includes(time));
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
    renderSwitch();
    renderCourts();
    renderOpponent();
    renderPicks();
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

let searchTimer;

function searchMembers() {
  clearTimeout(searchTimer);
  const text = $('opponent-search').value.trim();
  if (text.length < 2) {
    $('opponent-results').replaceChildren();
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const body = await pmt(memberSearchPath(text));
      const members = body.data
        .filter((row) => row.id !== state.myPlayerId && isMemberHere(row.attributes))
        .map((row) => ({ id: row.id, name: `${row.attributes.firstname} ${row.attributes.surname}` }));
      $('opponent-results').replaceChildren(...(members.length
        ? members.map((member) => el('li', {},
          el('button', {
            type: 'button',
            class: 'quiet wide',
            textContent: member.name,
            onclick: () => {
              state.draft.opponent = member;
              $('opponent-search').value = '';
              $('opponent-results').replaceChildren();
              renderOpponent();
            },
          })))
        : [el('li', { class: 'note', textContent: 'No members found.' })]));
    } catch (error) {
      say(error.message, true);
    }
  }, 300);
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
    state.draft = { ...freshDraft(), mode: draft.mode, date: draft.date, weekday: draft.weekday };
    renderOpponent();
    renderCourts();
    renderTimes();
  }
}

function wire() {
  $('pmt-login').addEventListener('submit', logInToPmt);
  $('github-login').addEventListener('submit', saveGithubToken);
  $('log-out').addEventListener('click', logOut);
  $('add-pick').addEventListener('submit', addPick);
  $('switch-button').addEventListener('click', () => {
    const next = !state.plan.live;
    changePlan((plan) => { plan.live = next; }, next ? 'Automatic booking is on.' : 'Automatic booking is off.');
  });
  for (const id of ['mode-once', 'mode-weekly']) {
    $(id).addEventListener('change', () => {
      state.draft.mode = $('mode-weekly').checked ? 'weekly' : 'once';
      refreshPreview();
    });
  }
  $('date').addEventListener('change', () => {
    state.draft.date = $('date').value;
    refreshPreview();
  });
  $('weekday').replaceChildren(...WEEKDAYS.map((day) => el('option', { value: day, textContent: day })));
  $('weekday').addEventListener('change', () => {
    state.draft.weekday = $('weekday').value;
    refreshPreview();
  });
  $('court').addEventListener('change', () => {
    state.draft.court = $('court').value ? Number($('court').value) : null;
  });
  $('opponent-search').addEventListener('input', searchMembers);
  $('opponent-clear').addEventListener('click', () => {
    state.draft.opponent = null;
    renderOpponent();
  });
  $('separately').addEventListener('change', () => {
    state.draft.separately = $('separately').checked;
    if (state.draft.separately) state.draft.opponent = null;
    renderOpponent();
  });
}

wire();
loadApp();
