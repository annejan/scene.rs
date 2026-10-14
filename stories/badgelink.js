// badgelink.js: a small BadgeLink client for the browser (WebUSB), to put files on a Tanmatsu
// badge: files on its SD card and flash, and apps. BadgeLink is the badge's own file and app protocol (badge.team's
// esp32-component-badgelink, the same one tools/badgelink.py speaks). No libraries: the bits of
// protobuf, COBS and CRC32 it needs are written out here. Works as a browser global
// (`BadgeLink`, `BadgeLinkError`) and as a Node module, so the tests can run it against the
// badge's own C code (see test/).
//
//   const bl = await BadgeLink.request();     // or BadgeLink.reconnect() for a known badge
//   await bl.sync();
//   await bl.version();
//   await bl.mkdir('/sd/portals');
//   await bl.upload('/sd/portals/x.json', bytes, (sent, total) => ...);
//   const bytes = await bl.download('/int/apps/com.example/metadata.json');
//   await bl.appfsUpload({ slug, title, version }, bytes, (sent, total) => ...);   // an app binary
//   await bl.appfsList();                     // [{ slug, title, version, size }]
//   await bl.startApp(slug, arg);
//   await bl.close();
//
// On the wire: each packet is a protobuf `Packet` (badgelink.proto), then its CRC32 (4 bytes,
// little-endian), COBS-encoded and ended with a zero byte. The host sends one request and
// waits for its answer; the badge answers with the same serial number.
'use strict';

(function () {
  const VENDOR_ID = 0x16d0;      // MCH2022 / Tanmatsu
  const PRODUCT_ID = 0x0f9a;
  const CLIENT_VERSION = 2;      // protocol version this client asks for (v2: streaming CRC)
  const CHUNK = 4096;            // largest upload chunk the badge takes (Chunk.data is 4096 bytes)

  // Defaults, in milliseconds. tools/badgelink.py uses 250 / 500 / 10000 over pyusb; a browser
  // and an SD card that stops to allocate a cluster want more room.
  // eraseTimeout: an app upload starts by erasing flash for the whole binary, which takes a while.
  const DEFAULTS = { syncTimeout: 500, timeout: 1000, chunkTimeout: 2000, xferTimeout: 10000, eraseTimeout: 30000, tries: 3 };

  // StatusCode from badgelink.proto, by number.
  const STATUS = ['StatusOk', 'StatusNotSupported', 'StatusNotFound', 'StatusMalformed',
    'StatusInternalError', 'StatusIllegalState', 'StatusNoSpace', 'StatusNotEmpty',
    'StatusIsFile', 'StatusIsDir', 'StatusExists'];
  const MESSAGES = ['ok', 'not supported', 'not found', 'malformed request', 'internal error',
    'illegal state', 'no space left', 'directory not empty', 'is a file', 'is a directory',
    'already exists'];
  const OK = 0, NOT_SUPPORTED = 1, EXISTS = 10;

  // FsActionType and XferReq from badgelink.proto.
  const FS_LIST = 0, FS_MKDIR = 2, FS_UPLOAD = 3, FS_DOWNLOAD = 4, FS_STAT = 5;
  const XFER_CONTINUE = 0, XFER_ABORT = 1, XFER_FINISH = 2;

  // An error from the badge (`code` is its StatusCode, `status` the name), or from this side
  // (`code` -1, `status` 'Timeout', 'Disconnected' or 'BadResponse').
  class BadgeLinkError extends Error {
    constructor(code, status, message) {
      super(message);
      this.name = 'BadgeLinkError';
      this.code = code;
      this.status = status;
    }
    static fromStatus(code, what) {
      const message = (MESSAGES[code] || `status ${code}`) + (what ? `: ${what}` : '');
      return new BadgeLinkError(code, STATUS[code] || `Status${code}`, message);
    }
  }
  const timeoutError = () => new BadgeLinkError(-1, 'Timeout', 'the badge did not answer');
  const disconnected = (e) => new BadgeLinkError(-1, 'Disconnected', 'badge disconnected' + (e ? `: ${e.message || e}` : ''));
  const badResponse = (why) => new BadgeLinkError(-1, 'BadResponse', why);

  // -------------------------------------------------------------------------------------------
  // CRC32 (zlib's, as esp_crc32_le(0, ...) on the badge)

  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  function crc32(bytes, crc = 0) {
    crc = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return ~crc >>> 0;
  }

  // -------------------------------------------------------------------------------------------
  // COBS: no zero bytes inside a frame, so a zero byte can end it

  function cobsEncode(data) {
    const out = new Uint8Array(data.length + Math.ceil(data.length / 254) + 1);
    let codeAt = 0, o = 1, code = 1;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0) {
        out[codeAt] = code; codeAt = o++; code = 1;
      } else {
        out[o++] = data[i];
        if (++code === 0xff) { out[codeAt] = code; codeAt = o++; code = 1; }
      }
    }
    out[codeAt] = code;
    return out.subarray(0, o);
  }

  function cobsDecode(data) {
    const out = new Uint8Array(data.length);
    let i = 0, o = 0;
    while (i < data.length) {
      const code = data[i++];
      if (code === 0 || i + code - 1 > data.length) return null;
      for (let k = 1; k < code; k++) out[o++] = data[i++];
      if (code < 0xff && i < data.length) out[o++] = 0;
    }
    return out.subarray(0, o);
  }

  // -------------------------------------------------------------------------------------------
  // Protobuf, only what BadgeLink needs: varints (wire type 0) and bytes/strings/messages (2)

  const utf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder();

  class Writer {
    constructor() { this.bytes = []; }
    varint(n) {   // n: a Number up to 2^53
      while (n >= 0x80) { this.bytes.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
      this.bytes.push(n);
      return this;
    }
    uint(field, n) { return this.varint(field << 3).varint(n); }
    raw(field, data) {
      this.varint((field << 3) | 2).varint(data.length);
      for (let i = 0; i < data.length; i++) this.bytes.push(data[i]);
      return this;
    }
    string(field, s) { return this.raw(field, utf8.encode(s)); }
    message(field, w) { return this.raw(field, w.bytes); }
    done() { return Uint8Array.from(this.bytes); }
  }

  // Read a message into { field: [values] }: Numbers for varints, Uint8Arrays for the rest.
  function readMessage(buf) {
    const fields = {};
    let i = 0;
    const varint = () => {
      let n = 0, scale = 1, b;
      do {
        if (i >= buf.length) throw badResponse('truncated varint');
        b = buf[i++];
        n += (b & 0x7f) * scale;
        scale *= 0x80;
      } while (b & 0x80);
      return n;
    };
    while (i < buf.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key & 7;
      let value;
      if (wire === 0) value = varint();
      else if (wire === 2) { const len = varint(); value = buf.subarray(i, i + len); i += len; }
      else if (wire === 1) { value = null; i += 8; }
      else if (wire === 5) { value = null; i += 4; }
      else throw badResponse('unknown wire type ' + wire);
      if (i > buf.length) throw badResponse('truncated field');
      (fields[field] = fields[field] || []).push(value);
    }
    return fields;
  }
  const one = (f, n, dflt = 0) => (f[n] ? f[n][f[n].length - 1] : dflt);

  // Packet { serial = 1; oneof { Request request = 2; Response response = 3; bool sync = 4; } }
  function encodeSync(serial) { return new Writer().uint(1, serial).uint(4, 1).done(); }
  function encodeRequest(serial, request) { return new Writer().uint(1, serial).message(2, request).done(); }

  // Request { oneof { Chunk upload_chunk = 1; FsActionReq fs_action = 3; XferReq xfer_ctrl = 6;
  //                   VersionReq version_req = 7; ... } }
  function fsAction(type, path, extra = {}) {   // FsActionReq { type, path, crc32, list_offset, size }
    const a = new Writer().uint(1, type).string(2, path);
    if (extra.crc32) a.uint(3, extra.crc32);
    if (extra.offset) a.uint(4, extra.offset);
    if (extra.size) a.uint(5, extra.size);
    return new Writer().message(3, a);
  }
  // AppfsActionReq { type = 1; oneof { AppfsMetadata metadata = 2; string slug = 3; } crc32 = 4; list_offset = 5 }
  function appfsAction(type, extra = {}) {
    const a = new Writer().uint(1, type);
    if (extra.metadata) {   // AppfsMetadata { slug, title, version, size }
      const m = extra.metadata;
      a.message(2, new Writer().string(1, m.slug).string(2, m.title).uint(3, m.version).uint(4, m.size));
    }
    if (extra.slug) a.string(3, extra.slug);
    if (extra.crc32) a.uint(4, extra.crc32);
    if (extra.offset) a.uint(5, extra.offset);
    return new Writer().message(2, a);
  }
  const startAppReq = (slug, arg) => new Writer().message(5, new Writer().string(1, slug).string(2, arg || ''));
  const uploadChunk = (position, data) => new Writer().message(1, new Writer().uint(2, position).raw(3, data));
  const xferCtrl = (what) => new Writer().uint(6, what);   // in a oneof: written even when 0
  const versionReq = (v) => new Writer().message(7, new Writer().uint(1, v));

  function appfsMetadata(bytes) {   // AppfsMetadata { slug = 1; title = 2; version = 3; size = 4 }
    const m = readMessage(bytes);
    const str = (f) => fromUtf8.decode(one(m, f, new Uint8Array(0)));
    return { slug: str(1), title: str(2), version: one(m, 3), size: one(m, 4) };
  }

  // The parts of a Packet the client reads: serial, sync, and the Response.
  function decodePacket(payload) {
    const p = readMessage(payload);
    const packet = { serial: one(p, 1), sync: !!one(p, 4), response: null };
    if (p[3]) {
      const r = readMessage(one(p, 3));
      const resp = packet.response = { status: one(r, 1) };
      if (r[4]) {   // FsActionResp { stat = 1; crc32 = 2; list = 3; usage = 4; size = 5 }
        const f = readMessage(one(r, 4));
        resp.fs = { crc32: one(f, 2), size: one(f, 5) };
        if (f[1]) {   // FsStat { size, mtime, ctime, atime, is_dir }
          const s = readMessage(one(f, 1));
          resp.fs.stat = { size: one(s, 1), mtime: one(s, 2), ctime: one(s, 3), atime: one(s, 4), isDir: !!one(s, 5) };
        }
        if (f[3]) {   // FsDirentList { repeated FsDirent list = 1; total_size = 2 }
          const l = readMessage(one(f, 3));
          resp.fs.list = {
            entries: (l[1] || []).map((e) => {
              const d = readMessage(e);
              return { name: fromUtf8.decode(one(d, 1, new Uint8Array(0))), isDir: !!one(d, 2) };
            }),
            total: one(l, 2),
          };
        }
      }
      if (r[2]) {   // Chunk { position = 2; data = 3 }: a download's next piece
        const c = readMessage(one(r, 2));
        resp.chunk = { position: one(c, 2), data: one(c, 3, new Uint8Array(0)) };
      }
      if (r[3]) {   // AppfsActionResp { metadata = 1; crc32 = 2; list = 3; usage = 4; size = 5 }
        const a = readMessage(one(r, 3));
        resp.appfs = { crc32: one(a, 2), size: one(a, 5) };
        if (a[1]) resp.appfs.metadata = appfsMetadata(one(a, 1));
        if (a[3]) {   // AppfsList { repeated AppfsMetadata list = 1; total_size = 2 }
          const l = readMessage(one(a, 3));
          resp.appfs.list = { entries: (l[1] || []).map(appfsMetadata), total: one(l, 2) };
        }
      }
      if (r[6]) {   // VersionResp { server_version = 1; negotiated_version = 2 }
        const v = readMessage(one(r, 6));
        resp.version = { server: one(v, 1), negotiated: one(v, 2) };
      }
    }
    return packet;
  }

  // -------------------------------------------------------------------------------------------
  // The client

  const wait = (ms) => {
    let timer;
    const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms, TIMEOUT); });
    return { promise, cancel: () => clearTimeout(timer) };
  };
  const TIMEOUT = Symbol('timeout');

  class BadgeLink {
    // transport: { write(Uint8Array): Promise, read(): Promise<Uint8Array|null>, close(): Promise }.
    // read() gives whatever bytes came in next, or null once the line is closed.
    constructor(transport, options = {}) {
      this.transport = transport;
      this.options = Object.assign({}, DEFAULTS, options);
      this.serial = 0;
      this.synced = false;
      this.protocol = 1;          // until version() says otherwise
      this._rx = new Uint8Array(0);
      this._reading = null;       // the read() in flight; kept across timeouts, never dropped
      this._queue = Promise.resolve();
    }

    // Ask the user to pick the badge (needs a click), then open it.
    static async request(options) {
      const device = await usb().requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
      return new BadgeLink(await openUsb(device), options);
    }

    // Open a badge the user allowed before, without asking. Null when there is none.
    static async reconnect(options) {
      const devices = await usb().getDevices();
      const device = devices.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
      return device ? new BadgeLink(await openUsb(device), options) : null;
    }

    // One operation at a time: the protocol is one request, one answer.
    _serialize(fn) {
      const run = this._queue.then(fn, fn);
      this._queue = run.catch(() => {});
      return run;
    }

    // Agree on a serial number with the badge. Also resets the badge to protocol v1.
    sync() { return this._serialize(() => this._sync()); }

    async _sync() {
      await this._write(new Uint8Array([0]));   // end whatever half frame the badge holds
      for (let attempt = 0; attempt < this.options.tries; attempt++) {
        this.serial = (Math.random() * 0x100000000) >>> 0;
        await this._send(encodeSync(this.serial));
        const packet = await this._receive(this.options.syncTimeout, (p) => p.sync && p.serial === this.serial);
        if (packet) {
          this.synced = true;
          this.protocol = 1;
          return;
        }
      }
      throw timeoutError();
    }

    // Ask for protocol v2, settle for v1 from older badges. Returns the version in use.
    version() {
      return this._serialize(async () => {
        try {
          const resp = await this._request(versionReq(CLIENT_VERSION), this.options.timeout);
          this.protocol = resp.version ? resp.version.negotiated : 1;
        } catch (e) {
          if (!(e instanceof BadgeLinkError) || (e.code !== NOT_SUPPORTED && e.status !== 'Timeout')) throw e;
          this.protocol = 1;
        }
        return this.protocol;
      });
    }

    // Make a directory (not its parents). True if made, false if it was already there.
    mkdir(path) {
      return this._serialize(async () => {
        try {
          await this._request(fsAction(FS_MKDIR, path), this.options.timeout, path);
          return true;
        } catch (e) {
          if (!(e instanceof BadgeLinkError) || e.code !== EXISTS) throw e;
          const stat = await this._stat(path);
          if (!stat.isDir) throw BadgeLinkError.fromStatus(8, path);   // a file is in the way
          return false;
        }
      });
    }

    // List a directory: [{ name, isDir }]. The badge sends up to 16 per answer.
    list(path) {
      return this._serialize(async () => {
        const out = [];
        for (let offset = 0; ;) {
          const resp = await this._request(fsAction(FS_LIST, path, { offset }), this.options.chunkTimeout, path);
          const list = resp.fs && resp.fs.list;
          if (!list) throw badResponse('no directory list');
          out.push(...list.entries);
          offset += list.entries.length;
          if (offset >= list.total || list.entries.length === 0) break;
        }
        return out.filter((e) => e.name !== '.' && e.name !== '..');
      });
    }

    // { size, isDir, mtime, ctime, atime } (times in ms since 1970).
    stat(path) { return this._serialize(() => this._stat(path)); }

    async _stat(path) {
      const resp = await this._request(fsAction(FS_STAT, path), this.options.timeout, path);
      if (!resp.fs || !resp.fs.stat) throw badResponse('no stat');
      return resp.fs.stat;
    }

    // Write a file: announce size and CRC32, send 4 KB chunks, then finish. The badge checks the
    // CRC32 at the end and deletes the file if it does not match.
    upload(path, data, onProgress) {
      return this._serialize(() => this._sendFile(
        fsAction(FS_UPLOAD, path, { crc32: crc32(data), size: data.length }), this.options.xferTimeout, data, onProgress, path));
    }

    // Write an app binary to AppFS, the badge's flash for apps, as `slug` (replacing it). The
    // launcher shows `title`; `version` is the app's revision number. Same CRC check as upload().
    appfsUpload({ slug, title, version }, data, onProgress) {
      const metadata = { slug, title: title || slug, version: version || 0, size: data.length };
      return this._serialize(() => this._sendFile(
        appfsAction(FS_UPLOAD, { metadata, crc32: crc32(data) }), this.options.eraseTimeout, data, onProgress, slug));
    }

    // The apps in AppFS: [{ slug, title, version, size }].
    appfsList() {
      return this._serialize(async () => {
        const out = [];
        for (let offset = 0; ;) {
          const resp = await this._request(appfsAction(FS_LIST, { offset }), this.options.chunkTimeout, 'AppFS');
          const list = resp.appfs && resp.appfs.list;
          if (!list) throw badResponse('no app list');
          out.push(...list.entries);
          offset += list.entries.length;
          if (offset >= list.total || list.entries.length === 0) break;
        }
        return out;
      });
    }

    // Read a file: its size first, then piece by piece. CRC32 checked: up front in v1, at the end in v2.
    download(path, onProgress) {
      return this._serialize(async () => {
        const first = await this._request(fsAction(FS_DOWNLOAD, path), this.options.xferTimeout, path);
        if (!first.fs) throw badResponse('no download size');
        const total = first.fs.size || 0;
        let expected = this.protocol === 1 ? first.fs.crc32 || 0 : null;
        const out = new Uint8Array(total);
        let pos = 0;
        try {
          if (onProgress) onProgress(0, total);
          while (pos < total) {
            const resp = await this._request(xferCtrl(XFER_CONTINUE), this.options.chunkTimeout, path);
            const c = resp.chunk;
            if (!c || (c.position || 0) !== pos || !c.data.length || pos + c.data.length > total) throw badResponse('bad download chunk');
            out.set(c.data, pos);
            pos += c.data.length;
            if (onProgress) onProgress(pos, total);
          }
          const end = await this._request(xferCtrl(XFER_FINISH), this.options.xferTimeout, path);
          if (expected === null) expected = end.fs ? end.fs.crc32 || 0 : null;
        } catch (e) {
          this.serial = (this.serial + 1) >>> 0;
          await this._send(encodeRequest(this.serial, xferCtrl(XFER_ABORT))).catch(() => {});
          throw e;
        }
        if (expected !== null && crc32(out) !== expected >>> 0) throw badResponse('download CRC32 does not match');
        return out;
      });
    }

    // Start an installed app (an AppFS slug), with an argument for it (a script's path, say).
    // The badge leaves BadgeLink to run it.
    startApp(slug, arg) {
      return this._serialize(() => this._request(startAppReq(slug, arg), this.options.timeout, slug));
    }

    // An upload's start (`first`), its 4 KB chunks, then finish. On a failure, the badge is told to
    // drop the half file.
    async _sendFile(first, firstTimeout, data, onProgress, what) {
      const total = data.length;
      await this._request(first, firstTimeout, what);
      try {
        if (onProgress) onProgress(0, total);
        for (let pos = 0; pos < total; pos += CHUNK) {
          const piece = data.subarray(pos, Math.min(total, pos + CHUNK));
          await this._request(uploadChunk(pos, piece), this.options.chunkTimeout, what);
          if (onProgress) onProgress(pos + piece.length, total);
        }
        await this._request(xferCtrl(XFER_FINISH), this.options.xferTimeout, what);
      } catch (e) {
        // It does not answer an abort.
        this.serial = (this.serial + 1) >>> 0;
        await this._send(encodeRequest(this.serial, xferCtrl(XFER_ABORT))).catch(() => {});
        throw e;
      }
    }

    async close() {
      this.synced = false;
      await this.transport.close();
    }

    // Send a request, wait for the answer with its serial, retry on silence like badgelink.py.
    // A retry reuses the serial: the badge drops a serial it has already seen, so a retry only
    // helps when the request itself was lost.
    async _request(request, timeout, what) {
      if (!this.synced) await this._sync();
      this.serial = (this.serial + 1) >>> 0;
      const serial = this.serial;
      const frame = encodeRequest(serial, request);
      for (let attempt = 0; attempt < this.options.tries; attempt++) {
        await this._send(frame);
        const packet = await this._receive(timeout, (p) => !p.sync && p.serial === serial);
        if (!packet) continue;
        if (!packet.response) throw badResponse('packet without a response');
        if (packet.response.status !== OK) throw BadgeLinkError.fromStatus(packet.response.status, what);
        return packet.response;
      }
      throw timeoutError();
    }

    async _send(payload) {
      const crc = crc32(payload);
      const body = new Uint8Array(payload.length + 4);
      body.set(payload);
      body.set([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24], payload.length);
      const encoded = cobsEncode(body);
      const frame = new Uint8Array(encoded.length + 1);   // the trailing zero ends the frame
      frame.set(encoded);
      await this._write(frame);
    }

    async _write(bytes) {
      try {
        await this.transport.write(bytes);
      } catch (e) {
        throw disconnected(e);
      }
    }

    // Wait for a packet that `wanted` accepts; skip stale answers and damaged frames.
    // Null on timeout.
    async _receive(ms, wanted) {
      const deadline = Date.now() + ms;
      for (;;) {
        const frame = await this._frame(deadline);
        if (!frame) return null;
        if (frame.length < 5) continue;
        const body = cobsDecode(frame);
        if (!body || body.length < 5) continue;
        const payload = body.subarray(0, body.length - 4);
        const crc = (body[body.length - 4] | (body[body.length - 3] << 8) | (body[body.length - 2] << 16) | (body[body.length - 1] << 24)) >>> 0;
        if (crc !== crc32(payload)) continue;
        let packet;
        try { packet = decodePacket(payload); } catch (e) { continue; }
        if (wanted(packet)) return packet;
      }
    }

    // The next zero-ended frame (without the zero), or null at the deadline.
    async _frame(deadline) {
      for (;;) {
        const zero = this._rx.indexOf(0);
        if (zero >= 0) {
          const frame = this._rx.slice(0, zero);
          this._rx = this._rx.slice(zero + 1);
          return frame;
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        if (!this._reading) {
          this._reading = this.transport.read().then((data) => ({ data }), (error) => ({ error }));
        }
        const timer = wait(left);
        const got = await Promise.race([this._reading, timer.promise]);
        timer.cancel();
        if (got === TIMEOUT) return null;
        this._reading = null;
        if (got.error || got.data === null) {
          this.synced = false;
          throw disconnected(got.error);
        }
        if (got.data.length) {
          const joined = new Uint8Array(this._rx.length + got.data.length);
          joined.set(this._rx);
          joined.set(got.data, this._rx.length);
          this._rx = joined;
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // WebUSB: the badge's vendor interface (0) with one bulk endpoint each way (1 OUT, 0x81 IN,
  // 32-byte packets), as tanmatsu-launcher's usb_device.c declares it

  function usb() {
    if (typeof navigator === 'undefined' || !navigator.usb) {
      throw new BadgeLinkError(-1, 'Unsupported', 'this browser has no WebUSB (try Chrome or Edge)');
    }
    return navigator.usb;
  }

  async function openUsb(device) {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const ifaces = device.configuration.interfaces;
    const iface = ifaces.find((i) => i.alternate.interfaceClass === 0xff) || ifaces[0];
    await device.claimInterface(iface.interfaceNumber);
    const eps = iface.alternate.endpoints;
    const epOut = eps.find((e) => e.direction === 'out' && e.type === 'bulk');
    const epIn = eps.find((e) => e.direction === 'in' && e.type === 'bulk');
    if (!epOut || !epIn) throw new BadgeLinkError(-1, 'Unsupported', 'no BadgeLink endpoints on this device');
    return {
      device,
      async write(bytes) {
        const r = await device.transferOut(epOut.endpointNumber, bytes);
        if (r.status !== 'ok') throw new Error('transfer out: ' + r.status);
      },
      // One packet at a time: the badge sends no zero-length packet after a full one, so
      // asking for more could wait for data that never comes.
      async read() {
        const r = await device.transferIn(epIn.endpointNumber, epIn.packetSize);
        if (r.status === 'stall') { await device.clearHalt('in', epIn.endpointNumber); return new Uint8Array(0); }
        return r.data ? new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength) : new Uint8Array(0);
      },
      async close() {
        try { await device.releaseInterface(iface.interfaceNumber); } catch (e) { /* already gone */ }
        try { await device.close(); } catch (e) { /* already gone */ }
      },
    };
  }

  BadgeLink.BadgeLinkError = BadgeLinkError;
  BadgeLink.CHUNK = CHUNK;
  BadgeLink.VENDOR_ID = VENDOR_ID;
  BadgeLink.PRODUCT_ID = PRODUCT_ID;
  BadgeLink.crc32 = crc32;
  // For the tests.
  BadgeLink._wire = { cobsEncode, cobsDecode, crc32, readMessage, decodePacket, encodeSync };

  if (typeof module !== 'undefined' && module.exports) module.exports = BadgeLink;
  else {
    globalThis.BadgeLink = BadgeLink;
    globalThis.BadgeLinkError = BadgeLinkError;
  }
})();
