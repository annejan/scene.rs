// Portals stories: the packs from index.json (made by the game's
// tools/stories_site.py), each with a button that writes it onto a
// Tanmatsu over WebUSB (badgelink.js) and a zip to download.

'use strict';

const DLC = '/sd/portals/dlc';
let badge = null;   // the badge while an install runs: opened for it, closed after
let busy = false;   // one install at a time: they share the badge

function el(card, sel) {
  return card.querySelector(sel);
}

function kb(bytes) {
  return bytes < 1024 ? bytes + ' bytes' : Math.round(bytes / 1024) + ' KB';
}

// WebUSB is Chrome's and Edge's, on a page served over HTTPS.
function usbNote() {
  const note = document.getElementById('usb-note');
  if (!('usb' in navigator)) {
    note.textContent = 'This browser cannot talk to USB devices. Chrome or Edge can; or download a story and copy it by hand (below).';
    note.hidden = false;
    return false;
  }
  if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) {
    note.textContent = 'On Linux the badge needs a udev rule before a browser may open it: badgelink\'s 60-badgelink.rules, in /etc/udev/rules.d/.';
    note.hidden = false;
  }
  return true;
}

function base64Bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// What went wrong, said so that someone can do something about it.
function explain(e) {
  const name = e && e.name ? e.name : '';
  if (name === 'NotFoundError') return 'No badge picked. Is it connected, and in BadgeLink mode (the purple diamond)?';
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'The browser may not open the badge. On Linux: the udev rule (see above).';
  if (name === 'NetworkError') return 'The badge is busy or was unplugged. Unplug it, plug it in, press the purple diamond, and try again.';
  if (name === 'BadgeLinkError' && (e.status === 'Timeout' || e.status === 'Disconnected'))
    return 'The badge did not answer. Is it in BadgeLink mode (the purple diamond), and is nothing else using it?';
  if (name === 'BadgeLinkError' && e.status === 'Unsupported') return e.message;
  if (name === 'BadgeLinkError') return 'The badge said: ' + e.message + '. Is there an SD card in it?';
  return (e && e.message) || String(e);
}

async function connect() {
  if (badge) return badge;
  badge = (await BadgeLink.reconnect()) || (await BadgeLink.request());
  await badge.sync();
  await badge.version();
  return badge;
}

async function install(pack, card) {
  if (busy) return;
  busy = true;
  const button = el(card, '.install');
  const status = el(card, '.status');
  const bar = el(card, '.bar');
  const progress = el(card, '.progress');
  button.disabled = true;
  status.className = 'status';
  status.textContent = 'Connecting to the badge…';
  try {
    const bl = await connect();
    status.textContent = 'Fetching the story…';
    const bundle = await (await fetch(pack.bundle, { cache: 'no-cache' })).json();
    const root = DLC + '/' + pack.id;
    // Its folders first, the shallowest first: /sd/portals, the dlc
    // folder, the pack's, and every folder in it.
    const dirs = new Set(['/sd/portals', DLC, root]);
    for (const f of bundle.files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(root + '/' + parts.slice(0, i).join('/'));
    }
    for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) await bl.mkdir(d);
    // Then its files, the bar filling with the bytes.
    const total = bundle.files.reduce((n, f) => n + f.size, 0);
    let done = 0;
    progress.hidden = false;
    for (const f of bundle.files) {
      status.textContent = 'Writing ' + f.path + '…';
      await bl.upload(root + '/' + f.path, base64Bytes(f.data), (sent) => {
        bar.style.width = (100 * (done + sent) / total).toFixed(1) + '%';
      });
      done += f.size;
    }
    bar.style.width = '100%';
    status.className = 'status ok';
    status.textContent = 'On the badge. Start Portals, then Stories: ' + pack.name + '.';
  } catch (e) {
    status.className = 'status error';
    status.textContent = explain(e);
  } finally {
    // Let go of the badge: badgelink, another tab or the next install
    // opens it afresh.
    if (badge) {
      try { await badge.close(); } catch (_) { /* gone already */ }
      badge = null;
    }
    button.disabled = false;
    busy = false;
  }
}

function show(packs, usb) {
  const list = document.getElementById('packs');
  const tpl = document.getElementById('pack-card');
  list.textContent = '';
  for (const pack of packs) {
    const card = tpl.content.firstElementChild.cloneNode(true);
    const still = el(card, '.still');
    if (pack.still) {
      still.src = pack.still;
      still.alt = 'A still from ' + pack.name;
    } else {
      still.remove();
    }
    el(card, '.name').textContent = pack.name;
    el(card, '.by').textContent = pack.author ? 'by ' + pack.author : '';
    el(card, '.about').textContent = pack.about;
    const facts = [pack.chambers + ' chambers'];
    if (pack.desk) facts.push('a story told from a desk');
    if (pack.music && pack.music !== 'calm') facts.push('its own music: ' + pack.music);
    facts.push(kb(pack.bytes));
    el(card, '.facts').textContent = facts.join(' · ');
    const zip = el(card, '.zip');
    zip.href = pack.zip;
    zip.setAttribute('download', pack.id + '.zip');
    const button = el(card, '.install');
    if (usb) button.addEventListener('click', () => install(pack, card));
    else button.disabled = true;
    list.appendChild(card);
  }
}

async function main() {
  const usb = usbNote();
  try {
    const index = await (await fetch('/stories/index.json', { cache: 'no-cache' })).json();
    show(index.packs, usb);
  } catch (e) {
    document.getElementById('packs').textContent = 'The stories could not be loaded: ' + explain(e);
  }
}

main();
