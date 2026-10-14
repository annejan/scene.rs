// Tests for ../badgelink.js: the wire bits on their own, then the client against badgemock, the
// badge's own BadgeLink C code running on this machine (built by mock.sh), over two FIFOs.
//
//   node --test stories/test/          (BADGEMOCK=/path/to/badgemock to skip the build)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const BadgeLink = require('../badgelink.js');
const { BadgeLinkError } = BadgeLink;
const { cobsEncode, cobsDecode, crc32, decodePacket, encodeSync } = BadgeLink._wire;

// ---------------------------------------------------------------------------------------------
// Wire format

test('CRC32 is zlib\'s', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.strictEqual(crc32(new Uint8Array(0)), 0);
  assert.strictEqual(crc32(Buffer.from('6789'), crc32(Buffer.from('12345'))), 0xcbf43926);
});

test('COBS round trips, and leaves no zero inside a frame', () => {
  const cases = [[], [0], [0, 0], [1], [1, 0, 2]];
  for (const n of [253, 254, 255, 508, 509, 1000]) cases.push(new Array(n).fill(7), [...new Array(n).fill(7), 0]);
  for (let k = 0; k < 200; k++) cases.push(Array.from({ length: k * 23 }, () => (Math.random() < 0.1 ? 0 : (Math.random() * 256) | 0)));
  for (const c of cases) {
    const data = Uint8Array.from(c);
    const enc = cobsEncode(data);
    assert.ok(!enc.includes(0));
    assert.deepStrictEqual(cobsDecode(enc), data);
  }
  assert.deepStrictEqual(cobsEncode(Uint8Array.from([0x11, 0x22, 0x00, 0x33])), Uint8Array.from([3, 0x11, 0x22, 2, 0x33]));
});

test('protobuf: a sync packet reads back', () => {
  const p = decodePacket(encodeSync(0xfedcba98));
  assert.strictEqual(p.serial, 0xfedcba98);
  assert.strictEqual(p.sync, true);
});

test('a silent badge times out, with retries', async () => {
  let writes = 0;
  const silent = { write: async () => { writes++; }, read: () => new Promise(() => {}), close: async () => {} };
  const bl = new BadgeLink(silent, { syncTimeout: 20 });
  await assert.rejects(bl.sync(), (e) => e instanceof BadgeLinkError && e.status === 'Timeout');
  assert.strictEqual(writes, 1 + 3);   // the zero byte, then three sync packets
});

// ---------------------------------------------------------------------------------------------
// Against the badge's code

// A transport over the mock's two FIFOs.
function fifoTransport(toBadge, fromBadge) {
  const out = fs.createWriteStream(toBadge);
  const input = fs.createReadStream(fromBadge);
  const queue = [], waiting = [];
  let ended = false;
  input.on('data', (b) => (waiting.length ? waiting.shift()(new Uint8Array(b)) : queue.push(new Uint8Array(b))));
  input.on('end', () => { ended = true; while (waiting.length) waiting.shift()(null); });
  return {
    dropWrites: 0,          // the test can make the line lose frames
    writes: 0,
    write(bytes) {
      this.writes++;
      if (this.dropWrites > 0 && bytes.length > 1000) { this.dropWrites--; return Promise.resolve(); }
      return new Promise((resolve, reject) => out.write(Buffer.from(bytes), (e) => (e ? reject(e) : resolve())));
    },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close() { out.end(); input.destroy(); return Promise.resolve(); },
  };
}

test('BadgeLink against badgemock', async (t) => {
  const mock = process.env.BADGEMOCK
    || execFileSync(path.join(__dirname, 'mock.sh'), [], { encoding: 'utf8' }).trim().split('\n').pop();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badgelink-'));
  const sd = path.join(dir, 'sd');   // the "SD card": the mock uses real paths, so keep them here
  fs.mkdirSync(sd);
  execFileSync('mkfifo', [path.join(dir, 'in'), path.join(dir, 'out')]);
  const log = fs.openSync(path.join(dir, 'mock.log'), 'w');
  const child = spawn(mock, [path.join(dir, 'in'), path.join(dir, 'out')], { stdio: ['ignore', log, log] });
  const line = fifoTransport(path.join(dir, 'in'), path.join(dir, 'out'));
  const bl = new BadgeLink(line);
  t.after(async () => {
    await bl.close();
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('sync', () => bl.sync());

  await t.test('version: v2 (the badge offers v3)', async () => {
    assert.strictEqual(await bl.version(), 2);
  });

  const apps = `${sd}/portals`;
  await t.test('mkdir, then mkdir again', async () => {
    assert.strictEqual(await bl.mkdir(apps), true);
    assert.ok(fs.statSync(apps).isDirectory());
    assert.strictEqual(await bl.mkdir(apps), false);
  });

  // ~100 KB with long zero-free runs and zero runs, for COBS's edge cases.
  const data = new Uint8Array(100 * 1024 + 123);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 256) | 0;
  data.fill(1, 5000, 6000);
  data.fill(0, 9000, 9500);
  const file = `${apps}/pack.zip`;

  await t.test('upload 100 KB with progress', async () => {
    const seen = [];
    const t0 = Date.now();
    await bl.upload(file, data, (sent, total) => seen.push([sent, total]));
    t.diagnostic(`100 KB in ${Date.now() - t0} ms over the mock`);
    assert.deepStrictEqual(seen[0], [0, data.length]);
    assert.deepStrictEqual(seen[seen.length - 1], [data.length, data.length]);
    assert.strictEqual(seen.length, 1 + Math.ceil(data.length / BadgeLink.CHUNK));
    assert.ok(Buffer.from(data).equals(fs.readFileSync(file)));
  });

  await t.test('list', async () => {
    assert.deepStrictEqual(await bl.list(apps), [{ name: 'pack.zip', isDir: false }]);
  });

  await t.test('stat', async () => {
    const s = await bl.stat(file);
    assert.strictEqual(s.size, data.length);
    assert.strictEqual(s.isDir, false);
    assert.ok(Math.abs(s.mtime - Date.now()) < 60000);
    assert.strictEqual((await bl.stat(apps)).isDir, true);
  });

  await t.test('errors carry the badge\'s status', async () => {
    await assert.rejects(bl.stat(`${sd}/nope`), (e) => e instanceof BadgeLinkError && e.code === 2 && e.status === 'StatusNotFound');
    await assert.rejects(bl.mkdir(`${sd}/no/such`), (e) => e.status === 'StatusNotFound');
    await assert.rejects(bl.upload(`${sd}/no/such.zip`, data), (e) => e.status === 'StatusNotFound');
    await assert.rejects(bl.mkdir(file), (e) => e.status === 'StatusIsFile');   // a file is in the way
    await assert.rejects(bl.list(`${sd}/nope`), (e) => e.status === 'StatusNotFound');
    await bl.stat(file);   // and the line still works
  });

  await t.test('a lost chunk is sent again', async () => {
    line.dropWrites = 1;
    await bl.upload(`${apps}/again.zip`, data.subarray(0, 20000));
    assert.strictEqual(line.dropWrites, 0);
    assert.ok(Buffer.from(data.subarray(0, 20000)).equals(fs.readFileSync(`${apps}/again.zip`)));
  });

  await t.test('a failed upload is aborted, and the badge drops the half file', async () => {
    line.dropWrites = 3;   // every try of the first chunk
    bl.options.chunkTimeout = 200;
    await assert.rejects(bl.upload(`${apps}/half.zip`, data), (e) => e.status === 'Timeout');
    bl.options.chunkTimeout = 2000;
    await bl.stat(file);   // the abort got through: the badge takes requests again
    assert.ok(!fs.existsSync(`${apps}/half.zip`));
  });

  await t.test('list past one answer (16 entries each)', async () => {
    for (let i = 0; i < 20; i++) await bl.upload(`${apps}/f${i}`, Uint8Array.of(i));
    await bl.upload(`${apps}/empty`, new Uint8Array(0));
    const names = (await bl.list(apps)).map((e) => e.name).sort();
    assert.strictEqual(names.length, 23);
    assert.ok(names.includes('f19') && names.includes('empty'));
    assert.strictEqual((await bl.stat(`${apps}/empty`)).size, 0);
  });

  await t.test('sync again resets to v1; version gets v2 back', async () => {
    await bl.sync();
    assert.strictEqual(bl.protocol, 1);
    assert.strictEqual(await bl.version(), 2);
  });
});
