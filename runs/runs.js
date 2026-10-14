// scene.rs/runs: the boards (data/board.json, written by the worker), a run's
// splits (data/run/<id>.json), and the upload -- a recording picked from the
// badge over WebUSB (badgelink.js) or from a file, sent to submit.php; then
// asked after (data/status/<id>.json) until the worker has replayed it.

'use strict';

const DATA = '/runs/data/';
const FILMS = 'https://annejan.com/portals/runs/';  // each run's film, when made (server/films)
const ON_BADGE = ['/sd/portals/recordings', '/sd/portals/ghosts'];
let boardData = null;
let side = 'real';
let picked = null;  // {name, text, source}

const $ = (id) => document.getElementById(id);

function clock(s) {
  if (s == null) return '–';
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(2).padStart(5, '0');
  return m ? `${m}:${r}` : `${(+s).toFixed(2)} s`;
}

// "01  The gap" -> "The gap", chambers' names as their files have them.
function short(name) {
  return String(name || '').replace(/^\d+\s+/, '');
}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

async function json(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// --- The boards -----------------------------------------------------------

function boardKeys(physics) {
  const b = (boardData && boardData.boards[physics]) || {};
  const keys = Object.keys(b);
  const order = (k) => (k === 'twenty' ? '0' : k.startsWith('story:') ? '1' + k : '2' + k);
  return keys.sort((a, c) => order(a).localeCompare(order(c)));
}

function fillPickers() {
  const ph = $('physics');
  const want = new URLSearchParams(location.hash.slice(1));
  ph.textContent = '';
  for (const p of boardData.physics) ph.append(el('option', { value: p, text: `Portals ${p} physics${p === boardData.physics[0] ? ' (now)' : ''}` }));
  // The newest physics that has a board, unless the address asks for one.
  const has = boardData.physics.find((p) => Object.keys(boardData.boards[p] || {}).length);
  if (has) ph.value = has;
  if (want.get('physics')) ph.value = want.get('physics');
  fillBoards(want.get('board'));
}

function fillBoards(want) {
  const sel = $('board');
  const b = boardData.boards[$('physics').value] || {};
  const before = want || sel.value;
  sel.textContent = '';
  const groups = { twenty: null, story: el('optgroup', { label: 'Stories' }), chamber: el('optgroup', { label: 'One chamber' }) };
  for (const k of boardKeys($('physics').value)) {
    const opt = el('option', { value: k, text: k === 'twenty' ? 'All twenty test chambers' : short(b[k].name) });
    if (k === 'twenty') sel.append(opt);
    else groups[k.startsWith('story:') ? 'story' : 'chamber'].append(opt);
  }
  if (groups.story.children.length) sel.append(groups.story);
  if (groups.chamber.children.length) sel.append(groups.chamber);
  if (before && [...sel.options].some((o) => o.value === before)) sel.value = before;
  showBoard();
}

function showBoard() {
  const rows = $('rows');
  rows.textContent = '';
  const physics = $('physics').value;
  const b = ((boardData.boards[physics] || {})[$('board').value] || { real: [], tas: [] })[side] || [];
  $('empty').hidden = b.length > 0;
  b.forEach((e, i) => {
    const who = el('a', { href: `#run=${e.id}`, text: e.nick });
    const video = e.video ? el('a', { href: e.video, rel: 'nofollow noopener noreferrer', text: 'watch' }) : '';
    rows.append(el('tr', {}, el('td', { text: String(i + 1) }), el('td', {}, who),
      el('td', { class: 'num', text: clock(e.time) }), el('td', { text: e.date }), el('td', {}, video)));
  });
  for (const btn of document.querySelectorAll('.sides button')) btn.setAttribute('aria-pressed', String(btn.dataset.side === side));
}

function showRecent() {
  const list = $('recent');
  list.textContent = '';
  for (const r of boardData.recent || []) {
    const what = r.chambers === 20 ? 'all twenty' : r.chambers === 1 ? short(r.first) : `${r.chambers} chambers`;
    list.append(el('li', {}, el('a', { href: `#run=${r.id}`, text: r.nick }), ` ${what}, ${clock(r.total)}`,
      r.tas ? el('span', { class: 'tag', text: 'TAS' }) : '', el('span', { class: 'when', text: `${r.date} · ${r.physics} physics` })));
  }
  if (!list.children.length) list.append(el('li', { text: 'Nothing yet.' }));
}

async function showRun(id) {
  const box = $('detail');
  if (!/^[0-9a-f]{16}$/.test(id)) { box.hidden = true; return; }
  try {
    const r = await json(`${DATA}run/${id}.json`);
    $('detail-title').textContent = `${r.nick}: ${clock(r.total)}${r.tas ? ' (TAS)' : ''}`;
    $('detail-head').textContent = `${r.date}, made on Portals ${r.version || '?'}, replayed on the ${r.physics} physics; ` +
      (r.kind === 'frames' ? 'recorded on a badge, frame by frame.' : 'a script.') + (r.complete ? '' : ' It does not reach every exit.');
    const rows = $('detail-rows');
    rows.textContent = '';
    for (const c of r.runs) rows.append(el('tr', {}, el('td', { text: short(c.name) }),
      el('td', { class: 'num', text: c.exit ? clock(c.time) : '–' }), el('td', { text: c.exit ? 'yes' : c.why || 'no' })));
    $('detail-note').hidden = !r.note;
    $('detail-note').textContent = r.note || '';
    current = r;
    // Its film, if the renderer has made it (server/films: annejan.com/portals/runs/).
    const film = $('detail-film');
    film.hidden = true;
    film.onloadedmetadata = () => { film.hidden = false; };
    film.onerror = () => { film.hidden = true; };
    film.poster = `${FILMS}${id}.jpg`;
    film.src = `${FILMS}${id}.mp4`;
    film.preload = 'metadata';
    $('detail-status').textContent = '';
    // A ghost file (its version: the physics and the chamber's signature) of one chamber: raceable.
    $('to-ghost').hidden = !(r.runs.length === 1 && /^\d+\.\d+\.\d+ L[0-9a-f]+$/.test(r.version || '') &&
      !String(r.runs[0].chamber || '').includes('/'));
    $('to-badge').disabled = $('to-ghost').disabled = !('usb' in navigator);
    $('detail-download').href = DATA + r.recording;
    $('detail-download').setAttribute('download', `portals-run-${id}.txt`);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    box.hidden = true;
  }
}

// --- Onto the badge -----------------------------------------------------------

let current = null;  // the run shown

// A name for a file or a folder on the card: letters, digits, - and _.
function safe(s, max) {
  return (String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'run').slice(0, max);
}

async function toBadge(asGhost) {
  const r = current;
  const say2 = (t, kind) => { $('detail-status').className = 'status' + (kind ? ' ' + kind : ''); $('detail-status').textContent = t; };
  if (!r) return;
  let bl = null;
  try {
    say2('Fetching the recording…');
    const text = await (await fetch(DATA + r.recording, { cache: 'no-cache' })).text();
    say2('Connecting to the badge…');
    bl = (await BadgeLink.reconnect()) || (await BadgeLink.request());
    await bl.sync();
    await bl.version();
    let dirs, path;
    if (asGhost) {
      const who = safe(r.nick, 23);
      dirs = ['/sd/portals', '/sd/portals/ghosts', '/sd/portals/ghosts/rivals', `/sd/portals/ghosts/rivals/${who}`];
      path = `/sd/portals/ghosts/rivals/${who}/${r.runs[0].chamber}.txt`;
    } else {
      dirs = ['/sd/portals', '/sd/portals/recordings'];
      path = `/sd/portals/recordings/${safe(r.nick, 30)}-${r.id.slice(0, 6)}.txt`;
    }
    for (const d of dirs) await bl.mkdir(d);
    say2('Writing it…');
    await bl.upload(path, new TextEncoder().encode(text));
    say2(asGhost ? `On the badge: ${r.nick}'s ghost races you in ${short(r.runs[0].name)}.`
      : 'On the badge: Portals, Esc → Watch a recording.', 'ok');
  } catch (e) {
    say2(e && e.name === 'NotFoundError' ? 'No badge picked. Is it in BadgeLink mode (the purple diamond)?' : `It did not go: ${e.message || e}`, 'error');
  } finally {
    if (bl) try { await bl.close(); } catch (_) { /* gone */ }
  }
}

$('to-badge').addEventListener('click', () => toBadge(false));
$('to-ghost').addEventListener('click', () => toBadge(true));

function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('run')) showRun(h.get('run'));
}

// --- Picking a recording ---------------------------------------------------

function pick(name, text, source) {
  picked = { name, text, source };
  const first = text.match(/^name:\s*(.*)$/m);
  const chambers = (text.match(/^chamber:/gm) || []).length;
  $('picked').textContent = `${name}: ${first ? first[1] + ', ' : ''}${chambers} chamber${chambers === 1 ? '' : 's'}.`;
  $('send').disabled = false;
}

$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  if (f.size > 512 * 1024) { $('picked').textContent = 'That file is over 512 KB: not a recording.'; return; }
  pick(f.name, await f.text(), 'file');
});

$('connect').addEventListener('click', async () => {
  const list = $('files');
  let bl = null;
  $('picked').textContent = 'Connecting to the badge…';
  try {
    bl = (await BadgeLink.reconnect()) || (await BadgeLink.request());
    await bl.sync();
    await bl.version();
    list.textContent = '';
    for (const dir of ON_BADGE) {
      let entries = [];
      try { entries = await bl.list(dir); } catch (_) { continue; }  // none on this card
      for (const e of entries.filter((x) => !x.isDir && /\.txt$/.test(x.name) && !/-times\.txt$/.test(x.name))) {
        const ghost = dir.endsWith('ghosts');
        const label = ghost ? `Your best in ${e.name.replace(/\.txt$/, '')} (ghost)` : e.name;
        const btn = el('button', { type: 'button', 'aria-pressed': 'false' }, label, el('small', { text: ` ${dir}` }));
        btn.addEventListener('click', async () => {
          for (const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
          btn.setAttribute('aria-pressed', 'true');
          $('picked').textContent = 'Reading it from the badge…';
          let link = null;
          try {
            link = (await BadgeLink.reconnect()) || (await BadgeLink.request());
            await link.sync();
            const bytes = await link.download(`${dir}/${e.name}`);
            pick(e.name, new TextDecoder().decode(bytes), 'badge');
          } catch (err) {
            $('picked').textContent = `It could not be read: ${err.message || err}`;
          } finally {
            if (link) try { await link.close(); } catch (_) { /* gone */ }
          }
        });
        list.append(el('li', {}, btn));
      }
    }
    list.hidden = !list.children.length;
    $('picked').textContent = list.children.length ? 'Pick one.' : 'No recordings on the badge yet: Record a run first.';
  } catch (e) {
    $('picked').textContent = e && e.name === 'NotFoundError' ? 'No badge picked. Is it in BadgeLink mode?' : `The badge: ${e.message || e}`;
  } finally {
    if (bl) try { await bl.close(); } catch (_) { /* gone */ }
  }
});

for (const r of document.querySelectorAll('input[name=kind]')) {
  r.addEventListener('change', () => {
    const bug = document.querySelector('input[name=kind]:checked').value === 'bug';
    $('run-fields').hidden = bug;
    $('bug-fields').hidden = !bug;
    $('send').textContent = bug ? 'Send the bug report' : 'Upload';
  });
}

// --- Sending, and asking after it -------------------------------------------

function say(text, kind) {
  $('status').className = 'status' + (kind ? ' ' + kind : '');
  $('status').textContent = text;
}

async function follow(id, bug) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, i ? 5000 : 3000));
    let s;
    try { s = await json(`${DATA}status/${id}.json`); } catch (_) { continue; }  // not replayed yet
    const rep = s.replay || {};
    if (s.state === 'bug') {
      say(`Thank you: the bug report is in. ${rep.ok ? `The replay: ${rep.complete ? 'it reached every exit' : 'it did not reach every exit'}.` : ''}`, 'ok');
    } else if (s.state === 'refused') {
      say(`Not listed: ${s.why}.`, 'error');
    } else {
      say(`Listed: ${clock(rep.total)} on the ${s.physics} physics${s.tas ? ', as TAS' : ''}${rep.complete ? '' : ' (it does not reach every exit: the chambers it finished count)'}.`, 'ok');
      await load();
      location.hash = `run=${id}`;
    }
    return;
  }
  say('Uploaded; the replay is taking a while. Look again in a few minutes.', 'ok');
}

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!picked) return;
  const bug = document.querySelector('input[name=kind]:checked').value === 'bug';
  const fd = new FormData();
  fd.append('recording', new Blob([picked.text], { type: 'text/plain' }), picked.name);
  fd.append('kind', bug ? 'bug' : 'run');
  fd.append('nick', bug ? $('bug-nick').value : $('nick').value);
  fd.append('tas', $('tas').checked ? '1' : '');
  fd.append('video', bug ? '' : $('video').value);
  fd.append('note', bug ? $('note-bug').value : $('note-run').value);
  fd.append('contact', bug ? $('contact').value : '');
  fd.append('source', picked.source);
  fd.append('website', $('website').value);
  $('send').disabled = true;
  say('Uploading…');
  try {
    const r = await fetch('/runs/submit.php', { method: 'POST', body: fd });
    const out = await r.json();
    if (!out.ok) { say(out.error || 'It was not taken.', 'error'); $('send').disabled = false; return; }
    say(bug ? 'Sent. Replaying it…' : 'Uploaded. The game is replaying it, frame by frame (up to a minute)…');
    follow(out.id, bug);
  } catch (e) {
    say(`It did not go: ${e.message || e}`, 'error');
    $('send').disabled = false;
  }
});

// --- Start ------------------------------------------------------------------

async function load() {
  boardData = await json(`${DATA}board.json`);
  fillPickers();
  showRecent();
}

$('physics').addEventListener('change', () => fillBoards());
$('board').addEventListener('change', showBoard);
for (const btn of document.querySelectorAll('.sides button')) btn.addEventListener('click', () => { side = btn.dataset.side; showBoard(); });
window.addEventListener('hashchange', route);
if (!('usb' in navigator)) { $('connect').disabled = true; }
load().then(route).catch(() => { $('rows').textContent = ''; $('rows').append(el('tr', {}, el('td', { colspan: '5', text: 'The boards could not be loaded.' }))); });
