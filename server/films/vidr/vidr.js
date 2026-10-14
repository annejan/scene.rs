// vidr.nl: the speedrun board's films (server/films/render.py writes /portals/queue.json, and
// with each film <id>.json: its chapters and which make of it it is, "v").
'use strict';

const FILMS = '/portals/';
const RUN = 'https://scene.rs/runs/#run=';
const $ = (id) => document.getElementById(id);
let made = [];
let lastQueue = '';  // queue.json as last shown: the page is built again only when it changes

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}

function clock(t) {
  if (t == null) return '–';
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, '0');
  return m ? `${m}:${s}` : `${(+t).toFixed(2)} s`;
}

// "03  The fling" -> "The fling"
const short = (s) => String(s || '').replace(/^\d+\s+/, '');
const title = (f) => (f.what === 'all twenty' ? 'All twenty test chambers' : short(f.what) || 'A run');
const ver = (f) => (f && f.v ? `?v=${f.v}` : '');

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function line(f) {
  return el('span', {}, el('strong', { text: f.nick }), ` · ${title(f)}, ${clock(f.total)}`,
    f.tas ? el('span', { class: 'tas', text: 'TAS' }) : '');
}

function render(q) {
  const making = $('making');
  making.textContent = '';
  if (q.making) {
    making.append(el('span', { class: 'reel', 'aria-hidden': 'true' }),
      el('p', {}, line(q.making), el('br'), el('span', { class: 'quiet', text: `on the ${q.making.physics} physics, frame by frame` })));
  } else {
    making.append(el('p', { class: 'quiet', text: 'Nothing right now.' }));
  }
  const list = $('queue');
  list.textContent = '';
  for (const f of q.queue) list.append(el('li', {}, line(f)));
  $('queue-empty').hidden = q.queue.length > 0;

  made = q.made;
  const grid = $('fresh');
  const focused = grid.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
  grid.textContent = '';
  for (const f of q.made) {
    const a = el('a', { href: `#${f.id}` },
      el('span', { class: 'thumb' }, el('img', { src: `${FILMS}${f.id}.jpg${ver(f)}`, alt: '', loading: 'lazy' }),
        el('span', { class: 'len', text: clock(f.total) })),
      el('span', { class: 'title' }, title(f), f.tas ? el('span', { class: 'tas', text: 'TAS' }) : ''),
      el('span', { class: 'chan', text: `${f.nick} · ${f.physics} physics · ${ago(f.at)}` }));
    grid.append(el('li', {}, a));
  }
  if (!q.made.length) grid.append(el('li', { class: 'quiet', text: 'No films yet.' }));
  if (focused) {  // a keyboard user stays where they were
    const again = grid.querySelector(`a[href="${focused}"]`);
    if (again) again.focus({ preventScroll: true });
  }
  play();
}

function stats(q) {
  const gb = (b) => (b / 2 ** 30).toFixed(b < 2 ** 30 ? 2 : 1);
  $('stats').textContent = `${q.films} films, ${gb(q.bytes)} of ${gb(q.cache)} GB. Updated ${ago(q.updated)}.`;
}

// The theatre: the film in the address (#<id>), its chapters a list of jumps.
let shown = null;  // the film in the theatre
let marks = [];

async function play() {
  const id = location.hash.slice(1);
  const box = $('theatre');
  const player = $('player');
  if (!/^[0-9a-f]{16}$/.test(id)) {
    if (shown) {
      player.pause();
      player.removeAttribute('src');
      player.load();
      shown = null;
    }
    box.hidden = true;
    return;
  }
  const f = made.find((m) => m.id === id);
  $('theatre-title').textContent = f ? `${f.nick}: ${title(f)}, ${clock(f.total)}${f.tas ? ' (TAS)' : ''}` : 'A run';
  $('theatre-meta').textContent = f ? `On the ${f.physics} physics. Filmed ${ago(f.at)}.` : '';
  $('theatre-run').href = RUN + id;
  if (box.hidden) {
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (shown === id) return;
  shown = id;
  const list = $('chapters');
  list.textContent = '';
  marks = [];
  let info = null;
  try {
    const res = await fetch(`${FILMS}${id}.json`, { cache: 'no-cache' });
    if (res.ok) info = await res.json();
  } catch (e) { /* a film from before the chapters */ }
  if (shown !== id) return;
  const v = info ? ver(info) : ver(f) || `?t=${Date.now()}`;
  player.poster = `${FILMS}${id}.jpg${v}`;
  player.src = `${FILMS}${id}.mp4${v}`;
  const got = info && Array.isArray(info.chapters) ? info.chapters : [];
  if (got.length < 2) return;  // one chamber: the film is it
  for (const c of got) {
    const b = el('button', { type: 'button' }, el('span', { text: short(c.name) }),
      el('span', { class: 'len', text: c.exit === false ? '–' : clock(c.time) }));
    b.addEventListener('click', () => {
      player.currentTime = c.start;
      player.play().catch(() => {});
    });
    const li = el('li', {}, b);
    list.append(li);
    marks.push({ start: +c.start, end: +c.end, li });
  }
}

$('player').addEventListener('timeupdate', () => {
  const t = $('player').currentTime;
  for (const m of marks) m.li.classList.toggle('playing', t >= m.start && t < m.end);
});

async function load() {
  try {
    const res = await fetch(`${FILMS}queue.json`, { cache: 'no-cache' });
    const text = await res.text();
    const q = JSON.parse(text);
    if (text !== lastQueue) {
      lastQueue = text;
      render(q);
    }
    stats(q);
  } catch (e) {
    $('making').textContent = 'The renderer is not answering just now.';
  }
}

window.addEventListener('hashchange', play);
load();
setInterval(() => { if (!document.hidden) load(); }, 20000);
