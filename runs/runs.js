// scene.rs/runs: the boards (data/board.json, written by the worker), a run's
// splits (data/run/<id>.json), and the upload -- a recording picked from the
// badge over WebUSB (badgelink.js) or from a file, sent to submit.php; then
// asked after (data/status/<id>.json) until the worker has replayed it.

'use strict';

const DATA = '/runs/data/';
const FILMS = 'https://vidr.nl/portals/';  // each run's film, when made (server/films), and the queue
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

let asked = 0;  // the latest run asked for: an answer for an older one is let go

async function showRun(id) {
  const box = $('detail');
  const me = ++asked;
  if (!/^[0-9a-f]{16}$/.test(id)) { box.hidden = true; current = null; stopFilm(); return; }
  try {
    const r = await json(`${DATA}run/${id}.json`);
    if (me !== asked) return;
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
    showFilm(r);
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
    if (me === asked) { box.hidden = true; current = null; stopFilm(); }
  }
}

// --- Its film -----------------------------------------------------------------

// Made on vidr.nl (server/films/render.py) for the best few on each board, and for
// any run on request (want.php), kept while people watch them. With each film,
// <id>.json: where each run is in it ("chapters") and which make of it this is
// ("v", to ask for the film by, so a film made again is never an old one from a
// cache). Films from before there were chapters have only their poster to say so.
let filmAsk = 0;    // the latest look for a film: an answer for an older one is let go
let chapters = [];  // [{start, end, row}] of the film shown

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function stopFilm() {
  filmAsk++;
  const film = $('detail-film');
  film.pause();
  film.removeAttribute('src');
  film.removeAttribute('poster');
  film.load();  // removing src alone does not stop it
  film.hidden = true;
  for (const ch of chapters) ch.row.classList.remove('playing');
  chapters = [];
  $('film-none').hidden = true;
}

// The film's make ("?v=…"), or null when there is none yet.
async function filmThere(r) {
  try {
    const res = await fetch(`${FILMS}${r.id}.json`, { cache: 'no-cache' });
    if (res.ok) {
      const info = await res.json();
      return { v: `?v=${info.v || 0}`, chapters: info.chapters };
    }
  } catch (e) { /* no answer: as if none */ }
  const poster = await new Promise((ok) => {  // a film from before the chapters
    const probe = new Image();
    probe.onload = () => ok(true);
    probe.onerror = () => ok(false);
    probe.src = `${FILMS}${r.id}.jpg?t=${Date.now()}`;
  });
  return poster ? { v: `?t=${Date.now()}`, chapters: null } : null;
}

async function showFilm(r) {
  if (r !== current) return;
  stopFilm();
  const me = filmAsk;
  const got = await filmThere(r);
  if (me !== filmAsk) return;
  if (!got) {
    const where = await whereFilm(r, 0);
    if (me !== filmAsk) return;
    if (where.at === 'failed') return noFilm(r, where.say, false);
    if (where.at === 'making' || where.at === 'queued') {
      noFilm(r, where.say, false);
      return waitFilm(r, Date.now());
    }
    return noFilm(r, 'No film of this run yet.', true);
  }
  const film = $('detail-film');
  film.onerror = () => { if (me === filmAsk) noFilm(r, 'No film of this run yet.', true); };
  film.poster = `${FILMS}${r.id}.jpg${got.v}`;
  film.preload = 'metadata';
  film.src = `${FILMS}${r.id}.mp4${got.v}`;
  film.hidden = false;
  if (got.chapters) seekable(r, got.chapters);
}

function noFilm(r, say, button) {
  if (r !== current) return;
  $('detail-film').hidden = true;
  $('film-none').hidden = false;
  $('film-say').textContent = say;
  $('film-make').hidden = !button;
}

// Each split's time a button to its chamber in the film, matched by name in order
// (a run the film does not have is passed over); the chamber playing marked.
function seekable(r, got) {
  if (r !== current || !Array.isArray(got)) return;
  const rows = [...$('detail-rows').children];
  chapters = [];
  let k = 0;
  r.runs.forEach((c, i) => {
    let j = k;
    while (j < got.length && got[j].name !== c.name) j++;
    if (j >= got.length) return;
    k = j + 1;
    const ch = { start: +got[j].start, end: +got[j].end, row: rows[i] };
    chapters.push(ch);
    const cell = rows[i].children[1];
    const b = el('button', { type: 'button', class: 'seek', text: cell.textContent,
      'aria-label': `${cell.textContent}: watch ${short(c.name)} in the film` });
    b.addEventListener('click', () => {
      const film = $('detail-film');
      film.currentTime = ch.start;
      film.play().catch(() => {});
      film.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    cell.textContent = '';
    cell.append(b);
  });
}

$('detail-film').addEventListener('timeupdate', () => {
  const t = $('detail-film').currentTime;
  for (const ch of chapters) ch.row.classList.toggle('playing', t >= ch.start && t < ch.end);
});

// Where the run is at the renderer (vidr.nl/portals/queue.json): 'making', 'queued', 'failed',
// 'absent' (the queue, newer than the ask, does not have it), or 'unknown'.
async function whereFilm(r, since) {
  try {
    const q = await (await fetch(`${FILMS}queue.json`, { cache: 'no-cache' })).json();
    const failed = (q.failed || []).find((f) => f.id === r.id);
    if (failed) return { at: 'failed', say: `This run could not be filmed: ${failed.why}.` };
    if (q.making && q.making.id === r.id) return { at: 'making', say: 'Filming it right now: it shows here when it is ready.' };
    const n = (q.queue || []).findIndex((f) => f.id === r.id);
    if (n >= 0) return { at: 'queued', say: `Number ${n + 1} in the queue (vidr.nl): it shows here when it is ready.` };
    if (Date.parse(q.updated) > since + 60000) return { at: 'absent' };
  } catch (e) { /* the queue is only a nicety */ }
  return { at: 'unknown', say: 'The film is being made: a few minutes. It shows here when it is ready.' };
}

async function makeFilm() {
  const r = current;
  if (!r) return;
  const say = $('film-say');
  say.focus();  // the button goes: the status keeps the place
  $('film-make').hidden = true;
  say.textContent = 'Asking…';
  const since = Date.now();
  try {
    const form = new FormData();
    form.append('id', r.id);
    const res = await (await fetch('/runs/want.php', { method: 'POST', body: form })).json();
    if (!res.ok) throw new Error(res.error || 'no');
  } catch (e) {
    return noFilm(r, `That did not work: ${e.message}.`, true);
  }
  if (r !== current) return;
  say.textContent = 'Asked: the film is being made, in a few minutes. It shows here when it is ready.';
  waitFilm(r, since);
}

// Asked after every 30 s while the renderer has it (two hours at most), and shown when made.
async function waitFilm(r, since) {
  const say = $('film-say');
  const me = filmAsk;
  let absent = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(30000);
    if (me !== filmAsk || r !== current) return;
    if (document.hidden) continue;
    if (await filmThere(r)) { if (me === filmAsk) showFilm(r); return; }
    const where = await whereFilm(r, since);
    if (me !== filmAsk || r !== current) return;
    if (where.at === 'failed') return noFilm(r, where.say, false);
    absent = where.at === 'absent' ? absent + 1 : 0;
    if (absent >= 2) return noFilm(r, 'No film came of it: try again later.', true);
    if (where.say) say.textContent = where.say;
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
$('film-make').addEventListener('click', makeFilm);

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
