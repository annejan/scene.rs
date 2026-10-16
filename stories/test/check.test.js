// Tests for ../check/check.js: diagnose() on cards made up here, then scan() and putRight()
// against badgemock (mock.sh), the badge's own BadgeLink code, on a folder standing in for /sd.
//
//   BADGEMOCK=$(stories/test/mock.sh | tail -1) node --test stories/test/*.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const BadgeLink = require('../badgelink.js');
const Check = require('../check/check.js');

const SITE = path.join(__dirname, '..');
const index = JSON.parse(fs.readFileSync(path.join(SITE, 'index.json'), 'utf8'));
const bundles = {};
for (const p of index.packs) bundles[p.id] = JSON.parse(fs.readFileSync(path.join(SITE, p.bundle), 'utf8'));

// A card as scan() reads it, from a list of [path, size] under dlc/ ('' size: a folder).
function card(entries, extra = {}) {
  extra = Object.assign({ outside: [{ path: '/sd/portals/dlc', name: 'dlc', dir: true }, { path: '/sd/portals/chambers', name: 'chambers', dir: true }] }, extra);
  const dlc = { name: 'dlc', dir: true, items: [] };
  for (const [p, size] of entries) {
    let node = dlc;
    const parts = p.split('/');
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      let next = node.items.find((n) => n.name === part);
      if (!next) {
        next = last && size !== '' ? { name: part, size } : { name: part, dir: true, items: [] };
        node.items.push(next);
      }
      node = next;
    });
  }
  return Object.assign({ base: '', app: { where: '/int/apps/com.annejan.portals', version: '0.13.2' }, dlc, packTexts: {}, loose: 0, outside: [] }, extra);
}

// A pack as the site has it, at `at` in dlc/ (all its files, sizes as in the bundle).
function whole(id, at = id, skip = []) {
  return bundles[id].files.filter((f) => !skip.includes(f.path)).map((f) => [at + '/' + f.path, f.size]);
}

const story = (d, id) => d.stories.find((s) => s.id === id);

test('all three, whole: fine', () => {
  const d = Check.diagnose(card([...whole('after-hours'), ...whole('hackfest'), ...whole('human-in-the-loop')]), index, bundles);
  assert.deepStrictEqual(d.stories.map((s) => s.state), ['ok', 'ok', 'ok']);
  assert.deepStrictEqual(d.others, []);
  assert.ok(d.notes.some((n) => n.level === 'ok' && n.line.includes('0.13.2')));
  assert.ok(!d.notes.some((n) => n.level === 'warn'), JSON.stringify(d.notes));
});

test('hackfest a folder too deep: nested, fixed by writing it where it goes and deleting the copy', () => {
  const d = Check.diagnose(card([...whole('after-hours'), ...whole('hackfest', 'hackfest/hackfest'), ...whole('human-in-the-loop')]), index, bundles);
  const h = story(d, 'hackfest');
  assert.strictEqual(h.state, 'nested');
  assert.match(h.line, /skips it/);   // 0.13.2 does not look a folder down
  assert.strictEqual(h.fix.files, bundles.hackfest.files.length);
  assert.deepStrictEqual(h.remove, ['/sd/portals/dlc/hackfest/hackfest']);
  const later = Check.diagnose(card(whole('hackfest', 'hackfest/hackfest'), { app: { where: 'x', version: '0.13.3' } }), index, bundles);
  assert.match(story(later, 'hackfest').line, /finds it there/);
});

test('copied in part: what is missing', () => {
  const d = Check.diagnose(card(whole('hackfest', 'hackfest', ['pack.txt', 'reflow.txt'])), index, bundles);
  const h = story(d, 'hackfest');
  assert.strictEqual(h.state, 'incomplete');
  assert.match(h.line, /2 of its \d+ files are missing \(pack\.txt, reflow\.txt\), pack\.txt among them/);
  assert.deepStrictEqual(h.fix.upload.sort(), ['pack.txt', 'reflow.txt']);
});

test('only desk/ made it: the game skips it, and so does the count', () => {
  const desk = whole('hackfest').filter(([p]) => p.startsWith('hackfest/desk/'));
  const d = Check.diagnose(card(desk), index, bundles);
  assert.strictEqual(story(d, 'hackfest').state, 'incomplete');
  assert.match(story(d, 'hackfest').line, /skips it/);
});

test('an older copy: plays, and can be brought up to date', () => {
  const files = whole('after-hours').map(([p, n]) => [p, p.endsWith('/pack.txt') ? n - 3 : n]);
  const a = story(Check.diagnose(card(files), index, bundles), 'after-hours');
  assert.strictEqual(a.state, 'changed');
  assert.match(a.line, /pack\.txt differs from this site's copy/);
  assert.deepStrictEqual(a.fix.upload, ['pack.txt']);
});

test('a zip, a zip elsewhere, a renamed folder, an empty one, one not from here', () => {
  const c = card([['hackfest.zip', 45661], ['Human in the loop', ''], ...whole('human-in-the-loop', 'hitl-copy'), ['mine/pack.txt', 30], ['mine/a.txt', 99], ['junk', '']], {
    packTexts: { 'hitl-copy': 'name: Human in the loop\nframe: desk\n', mine: 'name: My own\n' },
    outside: [{ path: '/sd/after-hours.zip', name: 'after-hours.zip', dir: false }],
  });
  const d = Check.diagnose(c, index, bundles);
  assert.strictEqual(story(d, 'hackfest').state, 'zip');
  assert.deepStrictEqual(story(d, 'hackfest').remove, ['/sd/portals/dlc/hackfest.zip']);
  assert.strictEqual(story(d, 'after-hours').state, 'misplaced');
  assert.deepStrictEqual(story(d, 'after-hours').remove, ['/sd/after-hours.zip']);
  assert.strictEqual(story(d, 'human-in-the-loop').state, 'renamed');
  assert.deepStrictEqual(d.others.map((o) => [o.name, o.state]).sort(), [['Human in the loop', 'empty'], ['junk', 'empty'], ['mine', 'other']]);
});

test('too many loose chambers: the last stories, A to Z, lose theirs', () => {
  const d = Check.diagnose(card([...whole('after-hours'), ...whole('hackfest'), ...whole('human-in-the-loop')], { loose: 50 }), index, bundles);
  const warn = d.notes.find((n) => n.level === 'warn' && /Too many chambers/.test(n.line));
  assert.ok(warn, JSON.stringify(d.notes));
  assert.match(warn.line, /hackfest, human-in-the-loop/);   // 20 + 50 + 14 = 84; +13 = 97 > 96
  assert.doesNotMatch(warn.line, /after-hours/);
});

test('no game, an old game, no dlc folder', () => {
  assert.ok(Check.diagnose(card([], { app: null, dlc: null }), index, bundles).notes.some((n) => /not installed/.test(n.line)));
  assert.ok(Check.diagnose(card([], { app: { where: 'x', version: '0.12.2' } }), index, bundles).notes.some((n) => /need 0\.12\.4/.test(n.line)));
  const none = Check.diagnose(card([], { dlc: null }), index, bundles);
  assert.deepStrictEqual(none.stories.map((s) => s.state), ['absent', 'absent', 'absent']);
  assert.ok(none.notes.some((n) => /no \/sd\/portals\/dlc folder/.test(n.line)));
  const root = Check.diagnose(card([], { outside: [{ path: '/sd/dlc', name: 'dlc', dir: true }] }), index, bundles);
  assert.ok(root.notes.some((n) => n.level === 'warn' && /dlc folder at \/sd\/dlc/.test(n.line)));
});

// ---------------------------------------------------------------------------------------------
// Against the badge's code

function fifoTransport(toBadge, fromBadge) {
  const out = fs.createWriteStream(toBadge);
  const input = fs.createReadStream(fromBadge);
  const queue = [], waiting = [];
  let ended = false;
  input.on('data', (b) => (waiting.length ? waiting.shift()(new Uint8Array(b)) : queue.push(new Uint8Array(b))));
  input.on('end', () => { ended = true; while (waiting.length) waiting.shift()(null); });
  return {
    write(bytes) { return new Promise((resolve, reject) => out.write(Buffer.from(bytes), (e) => (e ? reject(e) : resolve()))); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close() { out.end(); input.destroy(); return Promise.resolve(); },
  };
}

function unbundle(id, dir) {
  for (const f of bundles[id].files) {
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), Buffer.from(f.data, 'base64'));
  }
}

test('scan and put right, against badgemock', async (t) => {
  const mock = process.env.BADGEMOCK
    || execFileSync(path.join(__dirname, 'mock.sh'), [], { encoding: 'utf8' }).trim().split('\n').pop();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-'));
  const base = dir;   // stands in for the badge's root: base + /sd/portals/dlc
  const dlc = path.join(base, 'sd/portals/dlc');
  fs.mkdirSync(dlc, { recursive: true });
  fs.mkdirSync(path.join(base, 'int/apps/com.annejan.portals'), { recursive: true });
  fs.writeFileSync(path.join(base, 'int/apps/com.annejan.portals/metadata.json'), JSON.stringify({ version: '0.13.2' }));
  // The tester's card, as it might be: after-hours whole, hackfest a folder too deep, the loop
  // missing its pack.txt, and a zip.
  unbundle('after-hours', path.join(dlc, 'after-hours'));
  unbundle('hackfest', path.join(dlc, 'hackfest/hackfest'));
  unbundle('human-in-the-loop', path.join(dlc, 'human-in-the-loop'));
  fs.rmSync(path.join(dlc, 'human-in-the-loop/pack.txt'));
  fs.writeFileSync(path.join(dlc, 'stray.zip'), 'PK');
  fs.mkdirSync(path.join(base, 'sd/portals/chambers'));
  fs.writeFileSync(path.join(base, 'sd/portals/chambers/a.txt'), 'x');

  execFileSync('mkfifo', [path.join(dir, 'in'), path.join(dir, 'out')]);
  const log = fs.openSync(path.join(dir, 'mock.log'), 'w');
  const child = spawn(mock, [path.join(dir, 'in'), path.join(dir, 'out')], { stdio: ['ignore', log, log] });
  const bl = new BadgeLink(fifoTransport(path.join(dir, 'in'), path.join(dir, 'out')));
  t.after(async () => {
    await bl.close();
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await bl.sync();
  await bl.version();

  const c = await Check.scan(bl, null, base);
  assert.deepStrictEqual(c.app, { where: '/int/apps/com.annejan.portals', version: '0.13.2' });
  assert.strictEqual(c.loose, 1);
  assert.match(c.packTexts['hackfest/hackfest'], /^name: Off to Hackfest/m);
  let d = Check.diagnose(c, index, bundles);
  assert.deepStrictEqual(d.stories.map((s) => s.state), ['ok', 'nested', 'incomplete']);
  assert.deepStrictEqual(story(d, 'human-in-the-loop').fix.upload, ['pack.txt']);
  assert.deepStrictEqual(d.others.map((o) => o.name), ['stray.zip']);

  for (const id of ['hackfest', 'human-in-the-loop']) {
    const s = story(d, id);
    await Check.putRight(bl, index.packs.find((p) => p.id === id), bundles[id], s.fix.upload, null, base);
    if (s.state === 'nested') for (const p of s.remove) await bl.remove(p);
  }
  d = Check.diagnose(await Check.scan(bl, null, base), index, bundles);
  assert.deepStrictEqual(d.stories.map((s) => s.state), ['ok', 'ok', 'ok']);
  assert.ok(!fs.existsSync(path.join(dlc, 'hackfest/hackfest')));
  assert.ok(fs.readFileSync(path.join(dlc, 'hackfest/pack.txt'), 'utf8').startsWith('name: Off to Hackfest'));
});
