// check.js: what is on a Tanmatsu's SD card for Portals' stories, and why a story the player
// put on it is not in the game's Stories list. Reads the card over WebUSB (../badgelink.js),
// compares it with the stories on this site (../index.json and each pack's bundle), and
// puts right what it can: a story copied in part, unzipped a folder too deep, or still a zip.
//
// Three parts. scan() reads the card: only lists, stats and small downloads, it changes
// nothing. diagnose() is plain data in, plain data out (the tests run it on its own).
// The page (bottom) draws the result, and writes only when a button is pressed.
'use strict';

(function () {
  const SD = '/sd';
  const PORTALS = '/sd/portals';
  const DLC = '/sd/portals/dlc';
  const CHAMBERS = '/sd/portals/chambers';
  const APPS = ['/int/apps/com.annejan.portals', '/sd/apps/com.annejan.portals'];
  // The game's own limits (main/chamber.h, main/pack.h): the chamber list holds 96, the 20
  // built-in chambers first, then the card's loose ones, then each story's, A to Z.
  const CHAMBER_MAX = 96;
  const BUILTIN = 20;
  const PACK_MAX = 16;
  const NOT_FOUND = 2;   // BadgeLink's StatusNotFound
  const MAX_ENTRIES = 600;   // a card with more under dlc/ than this is not read to the end

  // -------------------------------------------------------------------------------------------
  // Scan: the card as it is

  async function listOrNull(bl, path) {
    try {
      return await bl.list(path);
    } catch (e) {
      if (e && e.name === 'BadgeLinkError' && e.code === NOT_FOUND) return null;
      throw e;
    }
  }

  async function textOrNull(bl, path) {
    try {
      return new TextDecoder().decode(await bl.download(path));
    } catch (e) {
      if (e && e.name === 'BadgeLinkError' && e.code === NOT_FOUND) return null;
      throw e;
    }
  }

  // A folder and everything in it, `depth` folders down: { name, dir: true, items: [...] } and
  // { name, size } for a file. `budget` counts entries, so a huge card stops being read.
  async function walk(bl, path, name, depth, budget, onStep) {
    const node = { name, dir: true, items: [] };
    const list = await listOrNull(bl, path);
    if (!list) return node;
    for (const e of list) {
      if (budget.left-- <= 0) {
        node.cut = true;
        break;
      }
      const p = path + '/' + e.name;
      if (onStep) onStep(p);
      if (e.isDir) node.items.push(depth > 0 ? await walk(bl, p, e.name, depth - 1, budget, onStep) : { name: e.name, dir: true, items: [], cut: true });
      else node.items.push({ name: e.name, size: (await bl.stat(p)).size });
    }
    return node;
  }

  // What the card holds for Portals: the game's version, the dlc folder (four folders deep, every
  // file's size, each pack.txt's text), the loose chambers, and anything story-like left
  // outside dlc (in /sd or /sd/portals).
  // `base` goes before every path: '' on a badge, a folder standing in for it in the tests.
  async function scan(bl, onStep, base = '') {
    const out = { base, app: null, dlc: null, packTexts: {}, loose: 0, outside: [] };
    for (const dir of APPS) {
      const meta = await textOrNull(bl, base + dir + '/metadata.json');
      if (meta) {
        try {
          out.app = { where: dir, version: JSON.parse(meta).version || '' };
        } catch (_) {
          out.app = { where: dir, version: '' };
        }
        break;
      }
    }
    const budget = { left: MAX_ENTRIES };
    if (await listOrNull(bl, base + DLC)) {
      out.dlc = await walk(bl, base + DLC, 'dlc', 3, budget, onStep);
      // Each pack.txt, one folder down and two: what a story there calls itself.
      for (const a of out.dlc.items.filter((n) => n.dir)) {
        for (const [rel, node] of [[a.name, a], ...a.items.filter((n) => n.dir).map((b) => [a.name + '/' + b.name, b])]) {
          if (node.items.some((n) => !n.dir && n.name === 'pack.txt')) out.packTexts[rel] = await textOrNull(bl, base + DLC + '/' + rel + '/pack.txt');
        }
      }
    }
    const loose = await listOrNull(bl, base + CHAMBERS);
    if (loose) out.loose = loose.filter((e) => !e.isDir && /\.txt$/i.test(e.name)).length;
    for (const dir of [SD, PORTALS]) {
      const list = (await listOrNull(bl, base + dir)) || [];
      for (const e of list) out.outside.push({ path: base + dir + '/' + e.name, name: e.name, dir: e.isDir });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Diagnose: the card against the site's stories

  function child(node, name) {
    return node && node.items ? node.items.find((n) => n.name === name) : undefined;
  }

  function at(node, rel) {
    let n = node;
    for (const part of rel.split('/')) n = child(n, part);
    return n;
  }

  function packName(text) {
    const m = /^\s*name:\s*(.+?)\s*$/m.exec(text || '');
    return m ? m[1] : '';
  }

  // Chamber files in a folder: its .txt but pack.txt (as the game counts a pack with no list).
  function chamberFiles(node) {
    return node.items.filter((n) => !n.dir && /\.txt$/i.test(n.name) && n.name !== 'pack.txt').length;
  }

  // Where a folder in dlc keeps its pack, as the game looks (main/pack.c): in it, or -- the
  // game from 0.13.3 on -- in the one folder in it, if that has a pack.txt.
  function packFolder(node) {
    if (child(node, 'pack.txt') || chamberFiles(node) > 0) return { rel: '', node, nested: false };
    const dirs = node.items.filter((n) => n.dir);
    if (dirs.length === 1 && child(dirs[0], 'pack.txt')) return { rel: dirs[0].name, node: dirs[0], nested: true };
    return null;
  }

  // The bundle's files against a folder on the card: which are missing, which differ in size.
  function compare(bundle, node) {
    const missing = [], differ = [];
    for (const f of bundle.files) {
      const n = at(node, f.path);
      if (!n || n.dir) missing.push(f.path);
      else if (n.size !== f.size) differ.push(f.path);
    }
    return { missing, differ };
  }

  function versionAtLeast(v, want) {
    const a = String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
    const b = want.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
    return true;
  }

  // `card` is scan()'s result; `index` the site's index.json; `bundles` each pack's bundle by id.
  // Returns { stories: [...], others: [...], notes: [...] }: a story each, the site's order, with
  // `state` one of ok | changed | incomplete | nested | zip | misplaced | renamed | absent, a
  // line saying it, and `fix` (what "Put it right" does) where there is one.
  function diagnose(card, index, bundles) {
    const stories = [], others = [], notes = [];
    const dlcPath = (card.base || '') + DLC;
    const dlc = card.dlc;
    const folders = dlc ? dlc.items.filter((n) => n.dir) : [];
    const zips = dlc ? dlc.items.filter((n) => !n.dir && /\.zip$/i.test(n.name)) : [];
    const claimed = new Set();
    const nestedOk = card.app && versionAtLeast(card.app.version, '0.13.3');

    for (const pack of index.packs) {
      const bundle = bundles[pack.id];
      const s = { id: pack.id, name: pack.name, chambers: pack.chambers, state: 'absent', line: '', fix: null, remove: [] };
      const node = child(dlc, pack.id);
      const install = (paths) => ({ upload: paths, files: paths.length });
      if (node && node.dir) {
        claimed.add(pack.id);
        const where = packFolder(node);
        if (!where) {
          const all = bundle ? bundle.files.map((f) => f.path) : [];
          const c = bundle ? compare(bundle, node) : { missing: all };
          s.state = 'incomplete';
          s.line = node.items.length === 0
            ? `Its folder is there, empty. The game skips it.`
            : `Its folder is there without a pack.txt or chambers: copied in part. The game skips it.`;
          s.fix = install(c.missing.concat(c.differ || []));
        } else if (where.nested) {
          s.state = 'nested';
          s.line = `Unzipped a folder too deep: its pack.txt is in dlc/${pack.id}/${where.rel}/, not dlc/${pack.id}/. ` +
            (nestedOk ? 'This game finds it there, but older ones do not.' : 'The game looks only in dlc/' + pack.id + '/, so it skips it.');
          s.fix = install(bundle ? bundle.files.map((f) => f.path) : []);
          s.remove = [dlcPath + '/' + pack.id + '/' + where.rel];
        } else if (bundle) {
          const c = compare(bundle, node);
          if (c.missing.length) {
            s.state = 'incomplete';
            s.line = `${c.missing.length} of its ${bundle.files.length} files ${c.missing.length === 1 ? 'is' : 'are'} missing` +
              (c.missing.includes('pack.txt') ? ', pack.txt among them: the game plays what it finds, not the story.' : ': copied in part.');
            s.fix = install(c.missing.concat(c.differ));
          } else if (c.differ.length) {
            s.state = 'changed';
            s.line = `On the card and complete, but ${c.differ.length} of its files ${c.differ.length === 1 ? 'differs' : 'differ'} from this site's: an older copy, or edited. It plays.`;
            s.fix = install(c.differ);
          } else {
            s.state = 'ok';
            s.line = 'On the card, every file as it is here.';
          }
        } else {
          s.state = 'ok';
          s.line = 'On the card.';
        }
      }
      // Not in its own folder: in another folder of dlc, by its pack.txt's name?
      if (s.state === 'absent') {
        for (const f of folders) {
          const text = card.packTexts[f.name];
          if (!claimed.has(f.name) && text && packName(text) === pack.name) {
            claimed.add(f.name);
            s.state = 'renamed';
            s.folder = f.name;
            s.line = `On the card as dlc/${f.name}/. It plays from there, saved as ${f.name}.`;
            break;
          }
        }
      }
      if (s.state === 'absent') {
        const zip = zips.find((z) => z.name.toLowerCase().startsWith(pack.id.toLowerCase()));
        const away = card.outside.find((o) => o.name === pack.id || o.name.toLowerCase() === pack.id + '.zip');
        if (zip) {
          s.state = 'zip';
          s.line = `Its zip is in dlc/ as ${zip.name}, not unzipped. The game reads folders, not zips.`;
          s.remove = [dlcPath + '/' + zip.name];
        } else if (away) {
          s.state = 'misplaced';
          s.line = `It is at ${away.path}${away.dir ? '/' : ''}, outside ${DLC}/: the game does not look there.`;
          s.remove = [away.path];
        } else {
          s.line = 'Not on the card.';
        }
        if (bundle) s.fix = install(bundle.files.map((f) => f.path));
      }
      for (const z of zips) if (s.state !== 'zip' && z.name.toLowerCase() === pack.id + '.zip') claimed.add(z.name);
      stories.push(s);
    }

    // Everything else in dlc.
    for (const f of folders) {
      if (claimed.has(f.name)) continue;
      const where = packFolder(f);
      const text = card.packTexts[f.name] || (where && where.nested ? card.packTexts[f.name + '/' + where.rel] : null);
      if (!where) others.push({ name: f.name, state: 'empty', line: 'No pack.txt and no chambers in it: the game lists it as "no chamber in it".' });
      else if (where.nested) others.push({ name: f.name, state: 'nested', line: `A story ${text ? '("' + packName(text) + '") ' : ''}a folder too deep, in ${f.name}/${where.rel}/.` });
      else others.push({ name: f.name, state: 'other', line: `A story not from this site${text && packName(text) ? ': "' + packName(text) + '"' : ''}. Nothing to check.` });
    }
    for (const z of zips) {
      if (claimed.has(z.name) || stories.some((s) => s.remove.includes(dlcPath + '/' + z.name))) continue;
      others.push({ name: z.name, state: 'zip', line: 'A zip: the game reads folders, not zips. Unzip it into dlc/ on a computer.' });
    }

    // The game itself, and its limits.
    if (!card.app) notes.push({ level: 'warn', line: 'Portals is not installed on this badge (no com.annejan.portals in /int/apps or /sd/apps).' });
    else if (!versionAtLeast(card.app.version, '0.12.4'))
      notes.push({ level: 'warn', line: `Portals ${card.app.version || '(no version)'} is installed: stories need 0.12.4 or later. Update it at annejan.com/portals.` });
    else notes.push({ level: 'ok', line: `Portals ${card.app.version} is installed (${card.app.where}).` });
    if (!dlc) notes.push({ level: 'warn', line: `There is no ${DLC} folder on the card yet: no story is on it.` });
    for (const o of card.outside)
      if (o.dir && o.name === 'dlc' && o.path !== dlcPath) notes.push({ level: 'warn', line: `There is a dlc folder at ${o.path}: the game reads ${DLC} only. Move the stories in it there.` });
    if (folders.length > PACK_MAX)
      notes.push({ level: 'warn', line: `${folders.length} folders in dlc/: the game reads the first ${PACK_MAX}, A to Z.` });
    if (dlc && dlc.cut) notes.push({ level: 'warn', line: `More than ${MAX_ENTRIES} files under dlc/: not all were read.` });
    // The chamber list: built-in, loose, then each story, A to Z.
    let used = BUILTIN + card.loose;
    const playing = [];
    for (const f of folders.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const where = packFolder(f);
      if (!where || (where.nested && !nestedOk)) continue;
      const s = stories.find((x) => x.id === f.name || x.folder === f.name);
      playing.push({ name: f.name, n: s ? s.chambers : chamberFiles(where.node) });
    }
    const full = [];
    for (const p of playing) {
      if (used + p.n > CHAMBER_MAX) full.push(p.name);
      used += p.n;
    }
    if (full.length)
      notes.push({ level: 'warn', line: `Too many chambers: the game holds ${CHAMBER_MAX} (${BUILTIN} built in, ${card.loose} loose in ${CHAMBERS}, then each story's, A to Z). ` +
        `No room for all of ${full.join(', ')}: move some loose chambers off the card.` });
    else if (card.loose) notes.push({ level: 'ok', line: `${card.loose} loose chamber${card.loose === 1 ? '' : 's'} in ${CHAMBERS}: room for every story (${used} of ${CHAMBER_MAX}).` });
    return { stories, others, notes };
  }

  // Put a story right: its folders, then the files `fix.upload` names, from the bundle. Then
  // what `remove` names (a copy a folder too deep, a zip), only if asked.
  async function putRight(bl, pack, bundle, paths, onStep, base = '') {
    const root = base + DLC + '/' + pack.id;
    const want = bundle.files.filter((f) => paths.includes(f.path));
    const dirs = new Set([base + PORTALS, base + DLC, root]);
    for (const f of want) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(root + '/' + parts.slice(0, i).join('/'));
    }
    for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) await bl.mkdir(d);
    let n = 0;
    for (const f of want) {
      if (onStep) onStep(f.path, ++n, want.length);
      await bl.upload(root + '/' + f.path, base64Bytes(f.data));
    }
  }

  function base64Bytes(b64) {
    if (typeof atob !== 'function') return new Uint8Array(Buffer.from(b64, 'base64'));
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  const Check = { scan, diagnose, putRight, versionAtLeast, DLC };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Check;
    return;
  }
  globalThis.Check = Check;

  // -------------------------------------------------------------------------------------------
  // The page

  const $ = (id) => document.getElementById(id);
  let badge = null;
  let busy = false;
  let index = null;
  const bundles = {};

  function explain(e) {
    const name = e && e.name ? e.name : '';
    if (name === 'NotFoundError') return 'No badge picked. Is it connected, and in BadgeLink mode (the purple diamond)?';
    if (name === 'SecurityError' || name === 'NotAllowedError') return 'The browser may not open the badge. On Linux: badgelink\'s udev rule, 60-badgelink.rules.';
    if (name === 'NetworkError') return 'The badge is busy or was unplugged. Unplug it, plug it in, press the purple diamond, and try again.';
    if (name === 'BadgeLinkError' && (e.status === 'Timeout' || e.status === 'Disconnected'))
      return 'The badge did not answer. Is it in BadgeLink mode (the purple diamond), and is nothing else using it?';
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

  async function release() {
    if (!badge) return;
    try { await badge.close(); } catch (_) { /* gone already */ }
    badge = null;
  }

  async function loadSite() {
    if (index) return;
    index = await (await fetch('/stories/index.json', { cache: 'no-cache' })).json();
    await Promise.all(index.packs.map(async (p) => {
      bundles[p.id] = await (await fetch('/stories/' + p.bundle, { cache: 'no-cache' })).json();
    }));
  }

  const LABEL = {
    ok: 'Fine', changed: 'Plays, older copy', incomplete: 'Copied in part', nested: 'A folder too deep',
    zip: 'Still a zip', misplaced: 'In the wrong place', renamed: 'Fine, other folder', absent: 'Not on the card',
    empty: 'No story in it', other: 'Not from this site',
  };
  const GOOD = new Set(['ok', 'renamed', 'other']);

  function row(list, title, s, actions) {
    const li = document.createElement('li');
    li.className = 'item ' + (GOOD.has(s.state) ? 'good' : s.state === 'changed' || s.state === 'absent' ? 'meh' : 'bad');
    const head = document.createElement('p');
    head.className = 'head';
    const strong = document.createElement('strong');
    strong.textContent = title;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = LABEL[s.state] || s.state;
    head.append(strong, ' ', tag);
    const line = document.createElement('p');
    line.className = 'line';
    line.textContent = s.line;
    li.append(head, line);
    if (actions && actions.length) {
      const bar = document.createElement('div');
      bar.className = 'actions';
      bar.append(...actions);
      li.append(bar);
    }
    list.append(li);
    return li;
  }

  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  // A delete asks twice: the first press arms it, the second within five seconds deletes.
  function armed(b, then) {
    if (!b.dataset.armed) {
      b.dataset.armed = '1';
      const was = b.textContent;
      b.dataset.was = was;
      b.textContent = 'Sure? Press again';
      setTimeout(() => {
        if (b.dataset.armed) {
          delete b.dataset.armed;
          b.textContent = was;
        }
      }, 5000);
      return;
    }
    delete b.dataset.armed;
    b.textContent = b.dataset.was;
    then();
  }

  function setStatus(text, cls) {
    const st = $('status');
    st.className = 'status' + (cls ? ' ' + cls : '');
    st.textContent = text;
  }

  async function run(what, fn) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      setStatus(explain(e), 'error');
    } finally {
      await release();
      busy = false;
      document.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  async function check() {
    await run('check', async () => {
      setStatus('Fetching the stories from this site…');
      await loadSite();
      setStatus('Connecting to the badge…');
      const bl = await connect();
      setStatus('Reading the card…');
      const card = await scan(bl, (p) => setStatus('Reading ' + p.replace(DLC + '/', 'dlc/') + '…'));
      show(card);
    });
  }

  function show(card) {
    const d = diagnose(card, index, bundles);
    const out = $('result');
    out.hidden = false;
    const notes = $('notes');
    notes.replaceChildren();
    for (const n of d.notes) {
      const li = document.createElement('li');
      li.className = n.level;
      li.textContent = n.line;
      notes.append(li);
    }
    const list = $('stories');
    list.replaceChildren();
    for (const s of d.stories) {
      const pack = index.packs.find((p) => p.id === s.id);
      const actions = [];
      if (s.fix && s.state !== 'ok' && s.state !== 'renamed') {
        const label = s.state === 'absent' ? 'Put it on' : s.state === 'changed' ? 'Bring it up to date' : 'Put it right';
        actions.push(button(label, 'install', () => fix(pack, s)));
      }
      if (s.state !== 'nested') for (const p of s.remove)   // a fix deletes the copy a folder too deep itself
        actions.push(button('Delete ' + p.replace(DLC + '/', 'dlc/'), 'restart', (b) => armed(b, () => remove(p))));
      row(list, s.name, s, actions);
    }
    const others = $('others');
    others.replaceChildren();
    $('others-box').hidden = d.others.length === 0;
    for (const o of d.others) {
      const actions = o.state === 'zip' || o.state === 'empty'
        ? [button('Delete dlc/' + o.name, 'restart', (b) => armed(b, () => remove(DLC + '/' + o.name)))] : [];
      row(others, o.name, o, actions);
    }
    const bad = d.stories.filter((s) => !GOOD.has(s.state) && s.state !== 'absent' && s.state !== 'changed').length;
    setStatus(bad ? `${bad} stor${bad === 1 ? 'y needs' : 'ies need'} putting right: see below.` : 'Checked. Nothing on the card stops a story from showing.', bad ? '' : 'ok');
  }

  async function fix(pack, s) {
    await run('fix', async () => {
      const bl = await connect();
      await putRight(bl, pack, bundles[pack.id], s.fix.upload, (p, n, of) => setStatus(`Writing ${p} (${n} of ${of})…`));
      // A copy a folder too deep goes once the right one is there: two would be two stories.
      if (s.state === 'nested') for (const p of s.remove) {
        setStatus('Deleting the copy a folder too deep…');
        await bl.remove(p);
      }
      setStatus('Reading the card again…');
      show(await scan(bl));
    });
  }

  async function remove(path) {
    await run('remove', async () => {
      const bl = await connect();
      setStatus('Deleting ' + path + '…');
      await bl.remove(path);
      setStatus('Reading the card again…');
      show(await scan(bl));
    });
  }

  function start() {
    if (!('usb' in navigator)) {
      $('usb-note').textContent = 'This browser cannot talk to USB devices. Chrome or Edge can.';
      $('usb-note').hidden = false;
      $('check').disabled = true;
      return;
    }
    if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) {
      $('usb-note').textContent = 'On Linux the badge needs a udev rule before a browser may open it: badgelink\'s 60-badgelink.rules, in /etc/udev/rules.d/.';
      $('usb-note').hidden = false;
    }
    $('check').addEventListener('click', check);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
