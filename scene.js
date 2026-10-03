// scene.rs: the deFEEST logo and Bawl-E, spinning over a sunny green hill that glitches into
// a demo on the drop. Plain WebGL for the logos (see tools/models.py), canvas 2D for the rest,
// music "Köln" from martin. No libraries, nothing inline.
'use strict';

// The track: 124 BPM, 46 bars, loops seamlessly. Sections from martin's productions/cities/score.txt.
const BPM = 124;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const SONG = 46 * BAR;
const SECTIONS = { intro: 0, build: 4 * BAR, drop: 10 * BAR, breakdown: 22 * BAR, climax: 26 * BAR, outro: 38 * BAR };
const GLITCH = 0.45; // seconds of glitch around each switch between the hill and the demo

const SCROLL_TEXT = 'scene.rs ... deFEEST and BawlSec say hi ... BawlSec: the CTF team that specializes in everything and nothing ... '
  + 'greetings to Badge.Team, Hacker Hotel, Trepaan, Poobrain, BornHack, Evoke, Outline, '
  + 'Revision and everyone at the parties ... music: Köln, from martin ... '
  + 'no Windows XP wallpapers were harmed in the making of this hill ... ';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sky = document.getElementById('sky');
const logos = document.getElementById('logos');
const front = document.getElementById('front');
const hint = document.getElementById('hint');

const ease = (a, b, t) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const smooth = (u) => u * u * (3 - 2 * u);
const mix = (a, b, u) => a + (b - a) * u;
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const rgb = (a, b, u) => `rgb(${hex(a).map((v, i) => Math.round(mix(v, hex(b)[i], u))).join(',')})`;

let W = 0, H = 0, dpr = 1;
const sx = sky.getContext('2d');
const fx = front.getContext('2d');

// ---------------------------------------------------------------------------------------------
// The hill (a homage, drawn here: sky, clouds, one green hill)

let hillDay = null, hillNight = null, clouds = [];
function makeHill() {
  const make = (night) => {
    const c = document.createElement('canvas');
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const top = H * 0.5;
    g.beginPath();
    g.moveTo(0, H * 0.66);
    g.bezierCurveTo(W * 0.18, top - H * 0.02, W * 0.42, top - H * 0.04, W * 0.62, top + H * 0.06);
    g.bezierCurveTo(W * 0.78, top + H * 0.12, W * 0.92, top + H * 0.12, W, top + H * 0.16);
    g.lineTo(W, H);
    g.lineTo(0, H);
    g.closePath();
    const grass = g.createLinearGradient(0, top - H * 0.04, 0, H);
    grass.addColorStop(0, night ? '#13300f' : '#6cbf2a');
    grass.addColorStop(0.45, night ? '#0d2309' : '#3f9415');
    grass.addColorStop(1, night ? '#061204' : '#25640a');
    g.fillStyle = grass;
    g.fill();
    // The sunlit side of the hill.
    g.save();
    g.clip();
    const sun = g.createRadialGradient(W * 0.3, top, 0, W * 0.3, top, W * 0.45);
    sun.addColorStop(0, night ? 'rgba(80, 120, 200, 0.12)' : 'rgba(220, 255, 120, 0.35)');
    sun.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, W, H);
    // A darker strip of field in front, with a few yellow flowers.
    g.fillStyle = night ? 'rgba(0, 0, 0, 0.35)' : 'rgba(20, 70, 0, 0.35)';
    g.beginPath();
    g.moveTo(0, H * 0.86);
    g.quadraticCurveTo(W * 0.5, H * 0.8, W, H * 0.84);
    g.lineTo(W, H);
    g.lineTo(0, H);
    g.fill();
    g.fillStyle = night ? 'rgba(200, 200, 120, 0.3)' : '#f6e85a';
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 70; i += 1) {
      g.beginPath();
      g.arc(rnd() * W, H * (0.86 + rnd() * 0.14), 1 + rnd() * 1.6, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    return c;
  };
  hillDay = make(false);
  hillNight = make(true);

  // Clouds: soft white puffs, rendered once each.
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  clouds = Array.from({ length: 9 }, (_, i) => {
    const w = Math.max(W, H) * (0.12 + rnd() * 0.16);
    const h = w * 0.55;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    for (let k = 0; k < 12; k += 1) {
      // Each puff stays inside the cloud's canvas: soft edges all round, nothing cut off.
      const r = h * (0.15 + rnd() * 0.2);
      const px = r + rnd() * (w - 2 * r);
      const py = h * 0.62 - rnd() * h * 0.22;
      const puff = g.createRadialGradient(px, py - r * 0.3, r * 0.1, px, py, r);
      puff.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      puff.addColorStop(0.6, 'rgba(255, 255, 255, 0.8)');
      puff.addColorStop(1, 'rgba(255, 255, 255, 0)');
      g.fillStyle = puff;
      g.fillRect(0, 0, w, h);
    }
    return { img: c, w, h, x: rnd(), y: 0.04 + (i % 5) * 0.075 + rnd() * 0.05, v: 0.004 + rnd() * 0.01 };
  });
}

// night 0 = midday, 0.5 = dusk, 1 = night
function drawHill(t, night, wind) {
  const horizon = night < 0.5 ? rgb('#a8d3f7', '#f39a5a', night * 2) : rgb('#f39a5a', '#1a2456', night * 2 - 1);
  const g = sx.createLinearGradient(0, 0, 0, H * 0.7);
  g.addColorStop(0, rgb('#1556c8', '#04081f', night));
  g.addColorStop(1, horizon);
  sx.fillStyle = g;
  sx.fillRect(0, 0, W, H);
  if (night > 0.3) drawStars(t, (night - 0.3) / 0.7 * 0.8, 0);
  sx.globalAlpha = 1 - 0.75 * night;
  for (const c of clouds) {
    const x = ((c.x + t * c.v * wind) % 1.3) * (W + c.w * 2) - c.w * 1.4;
    sx.drawImage(c.img, x, c.y * H, c.w, c.h);
  }
  sx.globalAlpha = 1;
  sx.drawImage(hillDay, 0, 0, W, H);
  if (night > 0) {
    sx.globalAlpha = night;
    sx.drawImage(hillNight, 0, 0, W, H);
    sx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The demo: stars and copper bars

const stars = Array.from({ length: 260 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() }));
function drawStars(t, alpha, speed) {
  sx.fillStyle = '#fff';
  for (const s of stars) {
    const z = (((s.z - t * speed) % 1) + 1) % 1 + 0.02;
    const x = W / 2 + (s.x / z) * W * 0.25;
    const y = H / 2 + (s.y / z) * H * 0.25;
    if (x < 0 || x > W || y < 0 || y > H) continue;
    sx.globalAlpha = alpha * Math.min(1, (1 - z) * 1.5);
    const r = Math.max(0.6, (1 - z) * 2.2);
    sx.fillRect(x, y, r, r);
  }
  sx.globalAlpha = 1;
}

function drawDemo(t, climax, kick) {
  sx.fillStyle = '#000';
  sx.fillRect(0, 0, W, H);
  drawStars(t, 1, 0.12 + 0.25 * kick + 0.15 * climax);
  const bars = 7;
  const h = H * 0.045;
  for (let i = 0; i < bars; i += 1) {
    const y = H * (0.52 + 0.3 * Math.sin(t * 1.4 + i * 0.55));
    const hue = (i * 360 / bars + t * (30 + 60 * climax)) % 360;
    const g = sx.createLinearGradient(0, y - h, 0, y + h);
    g.addColorStop(0, `hsla(${hue}, 90%, 20%, 0)`);
    g.addColorStop(0.5, `hsl(${hue}, 95%, ${60 + 20 * kick}%)`);
    g.addColorStop(1, `hsla(${hue}, 90%, 20%, 0)`);
    sx.fillStyle = g;
    sx.fillRect(0, y - h, W, h * 2);
  }
}

// ---------------------------------------------------------------------------------------------
// The logos, in WebGL

const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uMvp;
uniform mat4 uModel;
uniform mat3 uNormal;
varying vec3 vN;
varying vec3 vP;
void main() {
  vN = uNormal * aNrm;
  vP = (uModel * vec4(aPos, 1.0)).xyz;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;
const FS = `
precision mediump float;
varying vec3 vN;
varying vec3 vP;
uniform vec3 uColour;
uniform vec3 uLight;
uniform vec3 uEye;
uniform float uRainbow;
uniform float uTime;
uniform float uFlash;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float d = max(dot(n, uLight), 0.0);
  vec3 v = normalize(uEye - vP);
  float s = pow(max(dot(reflect(-uLight, n), v), 0.0), 28.0);
  vec3 rainbow = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + vP.x * 0.5 + vP.y * 0.35 + uTime * 0.4));
  vec3 base = mix(uColour, rainbow, uRainbow);
  gl_FragColor = vec4(base * (0.32 + 0.8 * d) + vec3(0.55 * s) + uFlash, 1.0);
}`;

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
const rotX = (a) => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
const rotY = (a) => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
const rotZ = (a) => [Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const move = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const size = (k) => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
const normalOf = (m) => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];   // uniform scale only

function startGL() {
  const gl = logos.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
  if (!gl) return null;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const at = { pos: gl.getAttribLocation(prog, 'aPos'), nrm: gl.getAttribLocation(prog, 'aNrm') };
  const u = {};
  for (const name of ['uMvp', 'uModel', 'uNormal', 'uColour', 'uLight', 'uEye', 'uRainbow', 'uTime', 'uFlash']) u[name] = gl.getUniformLocation(prog, name);
  gl.enable(gl.DEPTH_TEST);
  gl.enableVertexAttribArray(at.pos);
  gl.enableVertexAttribArray(at.nrm);

  const models = {};
  const load = (name, url) => fetch(url).then((r) => r.arrayBuffer()).then((buf) => {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let off = 4;
    models[name] = Array.from({ length: view.getUint32(0, true) }, () => {
      const colour = [view.getFloat32(off, true), view.getFloat32(off + 4, true), view.getFloat32(off + 8, true)];
      const count = view.getUint32(off + 12, true);
      off += 16;
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, bytes.slice(off, off + count * 12), gl.STATIC_DRAW);
      off += count * 12;
      return { colour, count, vbo };
    });
  }).catch(() => {});
  load('defeest', '/models/defeest.bin');
  load('bawle', '/models/bawl-e.bin');

  function draw(name, model, view, eye, colourBoost, rainbow, t, flash) {
    const parts = models[name];
    if (!parts) return;
    gl.uniformMatrix4fv(u.uMvp, false, mul(view, model));
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniformMatrix3fv(u.uNormal, false, normalOf(model));
    gl.uniform3fv(u.uEye, eye);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uFlash, flash);
    for (const p of parts) {
      gl.uniform3fv(u.uColour, p.colour.map((c) => Math.min(1, c * colourBoost)));
      // The rainbow goes over the yellow, never the blue: the lettering stays readable.
      gl.uniform1f(u.uRainbow, p.colour[2] > p.colour[0] + 0.3 ? 0 : rainbow);
      gl.bindBuffer(gl.ARRAY_BUFFER, p.vbo);
      gl.vertexAttribPointer(at.pos, 3, gl.SHORT, true, 12, 0);
      gl.vertexAttribPointer(at.nrm, 3, gl.BYTE, true, 12, 8);
      gl.drawArrays(gl.TRIANGLES, 0, p.count);
    }
  }

  return function render(s, demo, climax, kick, flash) {
    gl.viewport(0, 0, logos.width, logos.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const aspect = W / H;
    const fov = 0.7;
    // Far enough that the logo fits the width, closer in the demo; flying in at the top of the
    // song and out at its end, so the loop seam is a fly-through.
    const fit = Math.max(3.1, 1.05 / (0.8 * Math.tan(fov / 2) * aspect));
    const fly = 40 * (smooth(1 - ease(0, SECTIONS.build - BAR, s)) + smooth(ease(SONG - 2 * BAR, SONG, s)));
    const dist = fit * (1 - 0.12 * demo) + fly;
    const eye = [0, 0, dist];
    const view = mul(perspective(fov, aspect, 0.1, 200), move(0, -0.08, -dist));
    gl.uniform3fv(u.uLight, (() => { const l = [-0.4, 0.7, 0.6]; const n = Math.hypot(...l); return l.map((v) => v / n); })());

    // Swaying, so the lettering mostly reads; in the demo a full flip every four bars, in a beat.
    const flip = demo ? smooth(ease(0, BEAT, s % (4 * BAR))) * Math.PI * 2 : 0;
    const spin = 0.7 * Math.sin(s * (0.5 + 0.4 * demo)) + flip;
    const pulse = 1 + 0.07 * kick * demo;
    const lift = 0.12;
    const logo = mul(move(0, lift, 0), mul(size(pulse), mul(rotY(spin), mul(rotX(-Math.PI / 2 + 0.25 * Math.sin(s * 0.9)), rotZ(0)))));
    draw('defeest', logo, view, eye, 1, climax, s, flash);

    // Bawl-E circles the logo like a ring around it, facing us: round the outside of the
    // lettering, a little behind it over the top and a little in front underneath.
    const a = s * (0.9 + 0.6 * demo);
    const room = Math.min(1.5, 0.9 * dist * Math.tan(fov / 2) * aspect - 0.3);   // narrow screens
    const bawle = mul(move(Math.cos(a) * room, lift + 0.62 * Math.sin(a), -0.4 * Math.sin(a)),
      mul(size(0.36 * pulse), mul(rotY(-s * 1.6), rotX(0.2 * Math.sin(s)))));
    draw('bawle', bawle, view, eye, 1, climax * 0.8, s + 1, flash);
  };
}

// ---------------------------------------------------------------------------------------------
// The scroller and the glitch, in front

function drawScroller(t, demo, kick) {
  const size = Math.max(22, Math.min(H * 0.075, W * 0.09));
  fx.font = `900 ${size}px Impact, 'Arial Black', sans-serif`;
  fx.textBaseline = 'middle';
  fx.lineJoin = 'round';
  const speed = Math.max(120, W * 0.16);
  const span = fx.measureText(SCROLL_TEXT).width;
  let x = W - ((t * speed) % (span + W));
  const base = H * 0.8;
  for (const ch of SCROLL_TEXT) {
    const w = fx.measureText(ch).width;
    if (x > -w && x < W) {
      const y = base + Math.sin(x * 0.011 + t * 3) * size * (0.45 + 0.25 * demo) - kick * size * 0.12 * demo;
      fx.lineWidth = size * 0.16;
      fx.strokeStyle = demo > 0.5 ? '#000' : '#1240a8';
      fx.strokeText(ch, x, y);
      fx.fillStyle = demo > 0.5 ? `hsl(${(x * 0.3 + t * 90) % 360}, 95%, 65%)` : '#ffffff';
      fx.fillText(ch, x, y);
    }
    x += w;
  }
}

function drawGlitch(amount) {
  if (amount <= 0) return;
  // Slices of the background, torn sideways, and a few bars of solid RGB.
  const n = 8 + Math.floor(amount * 10);
  for (let i = 0; i < n; i += 1) {
    const y = Math.random() * H;
    const h = 4 + Math.random() * H * 0.06;
    const dx = (Math.random() - 0.5) * W * 0.25 * amount;
    fx.drawImage(sky, 0, y * dpr, sky.width, h * dpr, dx, y, W, h);
    if (Math.random() < 0.3) {
      fx.fillStyle = ['rgba(255,0,80,0.5)', 'rgba(0,255,200,0.5)', 'rgba(60,80,255,0.5)'][i % 3];
      fx.fillRect(0, y, W, h * 0.3);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Running it

function layout() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = innerWidth;
  H = innerHeight;
  for (const c of [sky, front]) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  logos.width = Math.round(W * Math.min(dpr, 1.5));
  logos.height = Math.round(H * Math.min(dpr, 1.5));
  sx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fx.setTransform(dpr, 0, 0, dpr, 0, 0);
  makeHill();
}

// Where in the song: the hill (and how dark), or the demo (and whether it's the climax).
function state(s) {
  const switches = [SECTIONS.drop, SECTIONS.breakdown, SECTIONS.climax, SECTIONS.outro];
  const demo = (s >= SECTIONS.drop && s < SECTIONS.breakdown) || (s >= SECTIONS.climax && s < SECTIONS.outro) ? 1 : 0;
  const glitch = Math.max(0, ...switches.map((w) => 1 - Math.abs(s - w) / GLITCH));
  const night = s < SECTIONS.drop ? 0 : s < SECTIONS.climax ? 1 : 1 - smooth(ease(SECTIONS.outro, SONG - BAR, s));
  const climax = s >= SECTIONS.climax && s < SECTIONS.outro ? 1 : 0;
  const drums = s >= SECTIONS.build && !(s >= SECTIONS.breakdown && s < SECTIONS.climax) && s < SECTIONS.outro + 4 * BAR;
  return { demo, glitch, night, climax, drums };
}

function start() {
  layout();
  addEventListener('resize', layout);
  let render = null;
  try { render = startGL(); } catch { render = null; }

  const music = new Audio();
  music.src = music.canPlayType('audio/ogg; codecs=opus') ? '/music/koeln.ogg' : '/music/koeln.m4a';
  music.loop = true;
  let needSound = false;
  const showHint = (on) => { needSound = on; hint.hidden = !on; };
  music.play().catch((e) => { if (e.name === 'NotAllowedError') showHint(true); });

  const t0 = performance.now();
  let mt0 = 0, latched = false;
  const clock = () => (performance.now() - t0) / 1000;
  function sound() {
    showHint(false);
    if (music.paused) music.currentTime = Math.max(0, clock() - mt0) % SONG;
    music.play().catch((e) => { if (e.name === 'NotAllowedError') showHint(true); });
  }
  front.addEventListener('click', () => { if (needSound) sound(); });
  addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('a')) return;
    if (needSound) sound();
    if (e.key === 'm' || e.key === 'M') music.muted = !music.muted;
    if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen?.().catch(() => {});
    }
  });

  function frame() {
    const t = clock();
    // Follow the music: latch on when it starts, and when they drift apart by more than 80 ms.
    if (!music.paused && music.currentTime > 0) {
      let off = (((t - mt0) % SONG) + SONG) % SONG - music.currentTime;
      off -= SONG * Math.round(off / SONG);
      if (!latched || Math.abs(off) > 0.08) mt0 += off;
      latched = true;
    }
    const s = (((t - mt0) % SONG) + SONG) % SONG;
    const st = state(s);
    const kick = st.drums ? Math.exp(-9 * (s % BEAT)) : 0;
    const flash = st.demo && s % (4 * BAR) < BEAT ? 0.25 * Math.exp(-6 * (s % (4 * BAR))) : 0;

    // A glitch flickers between the two worlds.
    const showDemo = st.glitch > 0 && Math.random() < st.glitch * 0.6 ? !st.demo : st.demo;
    if (showDemo) drawDemo(s, st.climax, kick);
    else drawHill(s, st.night, s < SECTIONS.drop ? 1 + 2 * ease(SECTIONS.build, SECTIONS.drop, s) : 1);

    if (render) render(s, st.demo, st.climax, kick, flash);

    fx.clearRect(0, 0, W, H);
    drawGlitch(st.glitch);
    drawScroller(t, st.demo, kick);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

if (reduceMotion) {
  document.documentElement.classList.add('still');
  layout();
  drawHill(0, 0, 0);
  addEventListener('resize', () => { layout(); drawHill(0, 0, 0); });
} else {
  start();
}
