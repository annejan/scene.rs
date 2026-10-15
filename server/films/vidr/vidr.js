// vidr.nl: the speedrun board's films (server/films/render.py writes /portals/queue.json, and
// with each film <id>.json: its chapters and which make of it it is, "v"); and the C64 demos'
// (/c64/films.json, written where they are filmed: {"films": [{"id", "title", "artist", "length",
// "at", "v", "d64", "chapters": [{"name", "start", "end"}]}]}, each with <id>.mp4 and <id>.jpg).
'use strict';

const FILMS = '/portals/';
const C64 = '/c64/';
const RUN = 'https://scene.rs/runs/#run=';
const $ = (id) => document.getElementById(id);
let made = [];
let demos = null;  // films.json's films, once read
let lastDemos = '';
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

// A film's length, the way a video's is told: 3:07
function mmss(t) {
  if (t == null) return '–';
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

// The theatre: the film in the address (#<id> a run's, #c64/<id> a demo's), its chapters a list of jumps.
let shown = null;  // the address of the film in the theatre
let marks = [];

// What the address asks for: the film's files, its words, and where it leads; null for none (yet).
function wanted() {
  const h = location.hash.slice(1);
  if (/^[0-9a-f]{16}$/.test(h)) {
    const f = made.find((m) => m.id === h);
    return {
      key: h, base: FILMS + h, c64: false, v: ver(f),
      title: f ? `${f.nick}: ${title(f)}, ${clock(f.total)}${f.tas ? ' (TAS)' : ''}` : 'A run',
      meta: f ? `On the ${f.physics} physics. Filmed ${ago(f.at)}.` : '',
      link: RUN + h, linkText: 'The splits, the recording, and onto your badge, on scene.rs →',
    };
  }
  const m = /^c64\/([a-z0-9][a-z0-9_-]{0,47})$/.exec(h);
  const d = m && demos && demos.find((x) => x.id === m[1]);
  if (!d) return null;
  const disk = /^[\w.-]+\.d64$/.test(d.d64 || '') ? d.d64 : '';
  return {
    key: h, base: C64 + d.id, c64: true, v: ver(d), chapters: d.chapters,
    title: d.artist ? `${d.artist}, ${d.title}` : d.title,
    meta: `A Commodore 64 demo, ${mmss(d.length)}. Filmed by VICE off its disk${d.at ? ` ${ago(d.at)}` : ''}.`,
    link: disk && C64 + disk, download: disk,
    linkText: 'The disk, for your C64 or VICE (.d64) →',
  };
}

async function play() {
  const box = $('theatre');
  const player = $('player');
  const w = wanted();
  if (!w) {
    if (shown) {
      player.pause();
      player.removeAttribute('src');
      player.load();
      shown = null;
    }
    box.hidden = true;
    return;
  }
  $('theatre-title').textContent = w.title;
  $('theatre-meta').textContent = w.meta;
  const link = $('theatre-link');
  link.textContent = w.linkText;
  link.href = w.link;
  link.parentElement.hidden = !w.link;
  if (w.download) link.setAttribute('download', w.download);
  else link.removeAttribute('download');
  box.classList.toggle('c64', w.c64);
  if (box.hidden) {
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (shown === w.key) return;
  shown = w.key;
  const list = $('chapters');
  list.textContent = '';
  marks = [];
  let info = w.c64 ? w : null;
  if (!w.c64) {
    try {
      const res = await fetch(`${w.base}.json`, { cache: 'no-cache' });
      if (res.ok) info = await res.json();
    } catch (e) { /* a film from before the chapters */ }
    if (shown !== w.key) return;
  }
  const v = w.c64 ? w.v : (info ? ver(info) : w.v || `?t=${Date.now()}`);
  player.poster = `${w.base}.jpg${v}`;
  player.src = `${w.base}.mp4${v}`;
  const got = info && Array.isArray(info.chapters) ? info.chapters : [];
  if (got.length < 2) return;  // one chamber: the film is it
  for (const c of got) {
    // a run's chamber says its time in the run; a demo's part, where it starts
    const len = w.c64 ? mmss(c.start) : c.exit === false ? '–' : clock(c.time);
    const b = el('button', { type: 'button' }, el('span', { text: short(c.name) }),
      el('span', { class: 'len', text: len }));
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

// The C64 shelf: hidden until there is a demo on it.
function shelf(list) {
  const grid = $('demo-films');
  const focused = grid.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
  grid.textContent = '';
  for (const d of list) {
    grid.append(el('li', {}, el('a', { href: `#c64/${d.id}` },
      el('span', { class: 'thumb' }, el('img', { src: `${C64}${d.id}.jpg${ver(d)}`, alt: '', loading: 'lazy' }),
        el('span', { class: 'len', text: mmss(d.length) })),
      el('span', { class: 'title', text: d.title }),
      el('span', { class: 'chan', text: [d.artist, d.at && `filmed ${ago(d.at)}`].filter(Boolean).join(' · ') }))));
  }
  $('demos').hidden = !list.length;
  if (focused) {
    const again = grid.querySelector(`a[href="${focused}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

async function loadDemos() {
  try {
    const res = await fetch(`${C64}films.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const text = await res.text();
    if (text === lastDemos) return;
    lastDemos = text;
    const got = JSON.parse(text).films;
    demos = (Array.isArray(got) ? got : []).filter((d) => d && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(d.id) && d.title);
  } catch (e) {
    if (demos) return;  // keep what is shown
    demos = [];
  }
  shelf(demos);
  play();
}

window.addEventListener('hashchange', play);
load();
loadDemos();
setInterval(() => { if (!document.hidden) { load(); loadDemos(); } }, 20000);
