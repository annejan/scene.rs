# scene.rs

The front page of [scene.rs](https://scene.rs/), home of deFEEST (demoscene) and
[BawlSec](https://bawlsec.com/) ([CTFtime](https://ctftime.org/team/70972)): the deFEEST
logo and Bawl-E spin over a sunny green hill, which glitches into a demo (stars, copper
bars, a rainbow) on the drop of "Köln", the track from deFEEST's
[martin](https://github.com/annejan/martin). Plus a sine scroller with greetings, the
prods on pouët, and a link to [/pets](https://scene.rs/pets/).

Plain HTML, CSS and JavaScript: canvas 2D for the hill, the demo and the scroller, and a
small WebGL renderer for the two logos. No libraries, nothing inline. Browsers start the
music after a click or key press; M mutes, F goes fullscreen. With reduced motion the hill
stands still.

- `index.html`, `scene.css`, `scene.js`: the page. The scroll text is `SCROLL_TEXT` at the
  top of `scene.js`; the timeline follows the score's sections (`SECTIONS`).
- `models/*.bin`: the logos, made by `tools/models.py` from the Collada files in `collada/`.
- `music/koeln.ogg`, `music/koeln.m4a`: the track.
- `.htaccess`: the security headers. `/pets` (not in this repository) gets
  `'wasm-unsafe-eval'` for its WebAssembly.

Deploy: copy `index.html`, `scene.css`, `scene.js`, `.htaccess`, `models/` and `music/` to
the web root. No build step. `collada/` and `tools/` are the sources, not served.

## Licence

The code is MIT, and so is the music. The deFEEST logo and Bawl-E are not: see
`REUSE.toml` and `LICENSES/`.
