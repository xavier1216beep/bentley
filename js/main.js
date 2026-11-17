/* ==========================================================================
   Continental GTC Speed — scroll-driven film site
   three.js  → renders the extracted video frames (shader crossfade + FX)
   GSAP      → master text timeline, counters, reveals, horizontal gallery
   ========================================================================== */
(() => {
  'use strict';

  /* ---------- Config ---------- */
  const CFG = {
    frames: 626,                       // number of extracted frames (10 fps of the 25 s film)
    src: (i) => `assets/frames/f_${String(i + 1).padStart(4, '0')}.webp`,
    duration: 25,                      // seconds, for the HUD timecode
    smoothing: 3.5,                      // frame follow: lower = floatier / smoother
    wheelStep: 0.65,                   // mouse-wheel distance multiplier (lower = slower)
    wheelEase: 4.5,                     // wheel glide: lower = longer, softer glide
    contactEmail: 'concierge@example.com' // enquiry form opens a mail draft to this address
  };

  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const hasGSAP = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
  const hasTHREE = typeof window.THREE !== 'undefined';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (hasGSAP) gsap.registerPlugin(ScrollTrigger);
  else document.documentElement.classList.add('no-gsap');

  const body = document.body;
  const film = $('#film');
  let canvas = $('#gl');
  const frames = new Array(CFG.frames);

  /* ---------- Preloader ---------- */
  function loadFrame(i) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { frames[i] = img; resolve(); };
      img.onerror = () => resolve();
      img.src = CFG.src(i);
    });
  }

  // Coarse-to-fine order (every 8th frame, then 4th, 2nd, rest): the page can start as soon as
  // the coarse pass is in, and every scroll position already has a near neighbour to show.
  function loadOrder() {
    const seen = new Set(), out = [];
    for (const step of [8, 4, 2, 1]) for (let i = 0; i < CFG.frames; i += step) if (!seen.has(i)) { seen.add(i); out.push(i); }
    return out;
  }
  function pick(i) {
    if (frames[i]) return frames[i];
    for (let d = 1; d < 24; d++) { if (frames[i - d]) return frames[i - d]; if (frames[i + d]) return frames[i + d]; }
    return null;
  }

  function preload(onProgress, onReady) {
    const queue = loadOrder();
    const readyAt = Math.ceil(CFG.frames / 4); // coarse passes (8 and 4) done -> safe to start
    let done = 0, ready = false;
    const worker = async () => {
      while (queue.length) {
        await loadFrame(queue.shift());
        done++;
        if (!ready && done >= readyAt) { ready = true; onReady(); }
        onProgress(Math.min(1, done / readyAt));
      }
    };
    return Promise.all(Array.from({ length: 10 }, worker));
  }

  /* ---------- Renderers ---------- */
  const VERT = `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  const FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uA, uB;
    uniform float uMix, uVel, uTime;
    uniform vec2 uRes, uImg, uPointer;

    vec2 cover(vec2 uv){
      float rs = uRes.x / uRes.y, ri = uImg.x / uImg.y;
      vec2 s = rs > ri ? vec2(1.0, ri / rs) : vec2(rs / ri, 1.0);
      return (uv - 0.5) * s + 0.5;
    }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main(){
      float v = clamp(abs(uVel), 0.0, 1.0);
      // gentle push-in that deepens with scroll speed, plus pointer parallax
      float zoom = 0.985 - v * 0.015;
      vec2 uv = (vUv - 0.5) * zoom + 0.5 + (uPointer - 0.5) * 0.012;
      uv = cover(uv);

      // chromatic aberration grows with velocity
      float ca = 0.0002 + v * 0.003;
      vec2 dir = normalize(uv - 0.5 + 1e-4);
      vec3 a = vec3(texture2D(uA, uv + dir * ca).r, texture2D(uA, uv).g, texture2D(uA, uv - dir * ca).b);
      vec3 b = vec3(texture2D(uB, uv + dir * ca).r, texture2D(uB, uv).g, texture2D(uB, uv - dir * ca).b);
      vec3 col = mix(a, b, uMix);

      // vignette + subtle grain
      vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
      col *= mix(0.74, 1.0, 1.0 - smoothstep(0.25, 1.15, length(q)));
      col += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.03;
      gl_FragColor = vec4(col, 1.0);
    }`;

  class WebGLFrames {
    constructor(cv) {
      const r = new THREE.WebGLRenderer({ canvas: cv, antialias: false, alpha: false, powerPreference: 'high-performance' });
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer = r;
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
      const mk = () => {
        const t = new THREE.Texture();
        t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
        return t;
      };
      this.tA = mk(); this.tB = mk(); this.errs = 0;
      this.uniforms = {
        uA: { value: this.tA }, uB: { value: this.tB }, uMix: { value: 0 }, uVel: { value: 0 }, uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) }, uImg: { value: new THREE.Vector2(1600, 900) }, uPointer: { value: new THREE.Vector2(.5, .5) }
      };
      const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      quad.frustumCulled = false; // vertex shader ignores the camera; never let culling hide the quad
      this.scene.add(quad);
      this.resize();
    }
    resize() {
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.uniforms.uRes.value.copy(s);
    }
    set(i, j) {
      const a = pick(i), b = pick(j);
      if (!a || !b) return;
      if (this.tA.image === a && this.tB.image === b) return;
      // moving along the sequence: reuse the texture that already holds the needed image
      if (this.tA.image === b || this.tB.image === a) {
        [this.tA, this.tB] = [this.tB, this.tA];
        this.uniforms.uA.value = this.tA; this.uniforms.uB.value = this.tB;
      }
      if (this.tA.image !== a) { this.tA.image = a; this.tA.needsUpdate = true; }
      if (this.tB.image !== b) { this.tB.image = b; this.tB.needsUpdate = true; }
    }
    draw(f, vel, time, pointer) {
      const i = Math.floor(f), j = Math.min(i + 1, CFG.frames - 1);
      this.set(i, j);
      const u = this.uniforms;
      u.uMix.value = i === j ? 0 : f - i; u.uVel.value = vel; u.uTime.value = time % 100; u.uPointer.value.set(pointer.x, pointer.y);
      this.renderer.render(this.scene, this.camera);
      const gl = this.renderer.getContext();
      if (gl.getError() !== gl.NO_ERROR && ++this.errs > 2) throw new Error('WebGL texture upload failed');
    }
  }

  // 2D renderer — used when WebGL/three.js is unavailable or blocked (e.g. page opened from file://,
  // where browsers refuse to upload local images as WebGL textures). drawImage still works there.
  class CanvasFrames {
    constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); this.ctx.imageSmoothingQuality = 'high'; this.resize(); }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      this.cv.width = Math.round(window.innerWidth * dpr); this.cv.height = Math.round(window.innerHeight * dpr);
      this.ctx.imageSmoothingQuality = 'high';
    }
    paint(img, zoom) {
      if (!img) return;
      const { width: w, height: h } = this.cv;
      const s = Math.max(w / img.naturalWidth, h / img.naturalHeight) * zoom;
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      this.ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    draw(f, vel) {
      const i = Math.floor(f), j = Math.min(i + 1, CFG.frames - 1), m = f - i;
      const zoom = 1.03 + Math.min(Math.abs(vel), 1) * 0.02;
      this.ctx.globalAlpha = 1; this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.cv.width, this.cv.height);
      this.paint(pick(i), zoom);
      if (m > 0.02 && j !== i) { this.ctx.globalAlpha = m; this.paint(pick(j), zoom); this.ctx.globalAlpha = 1; }
    }
  }

  let view;
  try {
    if (!hasTHREE) throw new Error('three.js not loaded');
    if (location.protocol === 'file:') throw new Error('opened from file:// — WebGL textures are blocked, using 2D canvas (run a local server for the full shader look)');
    view = new WebGLFrames(canvas);
  } catch (e) {
    console.warn('[film] falling back to 2D canvas:', e.message);
    view = new CanvasFrames(canvas);
  }
  window.addEventListener('resize', () => { view.resize(); if (hasGSAP) ScrollTrigger.refresh(); });

  /* ---------- Chapters + HUD ---------- */
  const chapters = $$('.chapter');
  const dotsEl = $('#hudDots');
  const hudTime = $('#hudTime');
  const hudBar = $('#hudBar');
  const scrollCue = $('#scrollCue');

  const ranges = chapters.map((el) => ({ s: +el.dataset.start, e: +el.dataset.end }));
  chapters.forEach((_, i) => {
    const li = document.createElement('li');
    li.addEventListener('click', () => scrollToProgress(ranges[i].s + (i === 0 ? 0 : (ranges[i].e - ranges[i].s) * 0.45)));
    dotsEl.appendChild(li);
  });
  const dots = $$('li', dotsEl);

  function filmMetrics() {
    const top = film.getBoundingClientRect().top + window.scrollY;
    return { top, dist: Math.max(1, film.offsetHeight - window.innerHeight) };
  }
  function scrollToProgress(p) {
    const m = filmMetrics();
    window.scrollTo({ top: m.top + m.dist * clamp(p), behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  function readProgress() {
    const m = filmMetrics();
    return clamp((window.scrollY - m.top) / m.dist);
  }

  // Master timeline — 1 unit of time == 100% of the film's scroll distance
  let master = null;
  if (hasGSAP) {
    master = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    chapters.forEach((el, i) => {
      const { s, e } = ranges[i];
      const f = Math.min(0.03, (e - s) * 0.3);
      const lines = $$('.line > span', el);
      const rest = $$('[data-fade]', el);
      if (i === 0) gsap.set(el, { autoAlpha: 1 });
      else {
        master.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: f * 0.5 }, s);
        master.fromTo(lines, { yPercent: 118 }, { yPercent: 0, duration: f, ease: 'power3.out', stagger: f * 0.22 }, s);
        master.fromTo(rest, { y: 30, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: f, ease: 'power2.out', stagger: f * 0.18 }, s + f * 0.35);
      }
      if (i < chapters.length - 1) {
        master.to(lines, { yPercent: -70, duration: f * 0.9, ease: 'power2.in', stagger: f * 0.1 }, e - f);
        master.to(rest, { y: -20, autoAlpha: 0, duration: f * 0.7, ease: 'power1.in' }, e - f);
        master.to(el, { autoAlpha: 0, duration: f * 0.5 }, e - f * 0.5);
      }
    });
    master.duration(1);
  }

  // No-GSAP fallback: plain opacity from progress
  function fallbackChapters(p) {
    chapters.forEach((el, i) => {
      const { s, e } = ranges[i];
      const f = 0.02;
      const o = clamp(Math.min((p - s) / f + (i === 0 ? 1 : 0), (e - p) / f));
      el.style.opacity = o; el.style.visibility = o > 0.01 ? 'visible' : 'hidden';
    });
  }

  /* ---------- Smooth wheel scrolling (inertia) ---------- */
  // Native wheel notches jump ~100px at once, which makes a frame sequence feel jerky.
  // We accumulate wheel input into a target and glide the real scroll position toward it.
  let sy = window.scrollY, ty = sy;
  const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;
  if (!reduceMotion) {
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey || menu.classList.contains('is-open') || body.classList.contains('is-loading')) return;
      e.preventDefault();
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 32; else if (e.deltaMode === 2) d *= window.innerHeight;
      ty = clamp(ty + d * CFG.wheelStep, 0, maxScroll());
    }, { passive: false });
    // keyboard, scrollbar drag, anchor links etc: adopt the browser's position instead of fighting it
    window.addEventListener('scroll', () => {
      if (Math.abs(window.scrollY - sy) > 3) { sy = ty = window.scrollY; }
    }, { passive: true });
  }
  function glideScroll(dt) {
    if (reduceMotion || Math.abs(ty - sy) < 0.4) return;
    sy += (ty - sy) * (1 - Math.exp(-dt * CFG.wheelEase));
    window.scrollTo({ top: sy, behavior: 'instant' });
  }

  /* ---------- Render loop ---------- */
  const pointer = { x: .5, y: .5, tx: .5, ty: .5 };
  window.addEventListener('pointermove', (e) => { pointer.tx = e.clientX / window.innerWidth; pointer.ty = 1 - e.clientY / window.innerHeight; }, { passive: true });

  let target = 0, current = 0, vel = 0, last = performance.now(), activeDot = -1, lastTime = '';
  let started = false;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    glideScroll(dt);
    target = readProgress();
    const k = reduceMotion ? 1 : 1 - Math.exp(-dt * CFG.smoothing);
    const prev = current;
    current += (target - current) * k;
    if (Math.abs(target - current) < 0.00002) current = target;
    // scroll "speed" → shader FX (smoothed, scaled so a brisk scroll ≈ 1)
    const raw = dt > 0 ? (current - prev) / dt * 9 : 0;
    vel += (raw - vel) * 0.15;
    pointer.x += (pointer.tx - pointer.x) * 0.05; pointer.y += (pointer.ty - pointer.y) * 0.05;

    const f = clamp(current) * (CFG.frames - 1);
    try {
      view.draw(f, reduceMotion ? 0 : vel, now / 1000, pointer);
    } catch (err) {
      console.error('[film] WebGL draw failed, switching to 2D canvas:', err);
      const fresh = canvas.cloneNode(false); canvas.replaceWith(fresh); // a canvas that held a WebGL context can't become 2D
      canvas = fresh; view = new CanvasFrames(canvas);
    }

    if (master) master.progress(clamp(current)); else fallbackChapters(current);

    // HUD
    hudBar.style.transform = `scaleX(${current.toFixed(4)})`;
    const sec = Math.floor(current * CFG.duration);
    const t = `00:${String(sec).padStart(2, '0')}`;
    if (t !== lastTime) { hudTime.textContent = t; lastTime = t; }
    let a = ranges.findIndex((r) => current >= r.s - 0.005 && current <= r.e + 0.005);
    if (a !== activeDot && a !== -1) { dots.forEach((d, i) => d.classList.toggle('is-active', i === a)); activeDot = a; }
    scrollCue.style.opacity = current > 0.015 ? 0 : .85;

    requestAnimationFrame(frame);
  }

  /* ---------- Navigation ---------- */
  const nav = $('#nav');
  const burger = $('#burger');
  const menu = $('#mobileMenu');
  let lastY = window.scrollY;
  function onScroll() {
    const y = window.scrollY;
    nav.classList.toggle('nav--solid', y > 60);
    if (!menu.classList.contains('is-open')) nav.classList.toggle('nav--hidden', y > lastY && y > 140);
    if (y < lastY) nav.classList.remove('nav--hidden');
    lastY = y;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  function setMenu(open) {
    menu.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-hidden', String(!open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    body.style.overflow = open ? 'hidden' : '';
    nav.classList.remove('nav--hidden');
  }
  burger.addEventListener('click', () => setMenu(!menu.classList.contains('is-open')));
  $$('a', menu).forEach((a) => a.addEventListener('click', () => setMenu(false)));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  /* ---------- Page animations (GSAP) ---------- */
  function setupPage() {
    $('#year').textContent = new Date().getFullYear();

    // counters
    $$('[data-count]').forEach((el) => {
      const end = parseFloat(el.dataset.count), dec = +(el.dataset.dec || 0), sep = el.dataset.sep;
      const fmt = (v) => (sep ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec));
      if (!hasGSAP || reduceMotion) { el.textContent = fmt(end); return; }
      const o = { v: 0 };
      ScrollTrigger.create({
        trigger: el, start: 'top 88%', once: true,
        onEnter: () => gsap.to(o, { v: end, duration: 2.2, ease: 'power3.out', onUpdate: () => { el.textContent = fmt(o.v); } })
      });
    });

    if (!hasGSAP) return;

    // generic reveals
    gsap.set('[data-reveal]', { y: 40, autoAlpha: 0 });
    ScrollTrigger.batch('[data-reveal]', {
      start: 'top 90%', once: true,
      onEnter: (els) => gsap.to(els, { y: 0, autoAlpha: 1, duration: 1.1, ease: 'power3.out', stagger: 0.09, overwrite: true })
    });

    // horizontal gallery — CSS sticky (no pin-spacer), so later layout shifts can't make it overlap neighbours
    const hs = $('#details');
    const track = $('#track');
    if (hs && track) {
      const dist = () => Math.max(0, track.scrollWidth - window.innerWidth + 2 * parseFloat(getComputedStyle(track).paddingLeft));
      const sizeHs = () => { hs.style.height = (dist() + window.innerHeight) + 'px'; };
      sizeHs();
      gsap.to(track, {
        x: () => -dist(), ease: 'none',
        scrollTrigger: {
          trigger: hs, start: 'top top', end: 'bottom bottom', scrub: 0.8, invalidateOnRefresh: true,
          onRefreshInit: sizeHs
        }
      });
    }

    // fonts / late images change section heights: re-measure once everything has settled
    const settle = () => ScrollTrigger.refresh();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
    window.addEventListener('load', settle);
    setTimeout(settle, 1500);
  }

  /* ---------- Plan buttons → prefill form ---------- */
  $$('[data-plan]').forEach((a) => a.addEventListener('click', () => {
    const sel = $('#interest'); const v = a.dataset.plan;
    if (sel) Array.from(sel.options).forEach((o) => { if (o.text === v) sel.value = o.value || o.text; });
  }));

  /* ---------- Contact form (opens a drafted email; nothing is sent from the page) ---------- */
  const form = $('#contactForm');
  const note = $('#formNote');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let ok = true;
    $$('[required]', form).forEach((inp) => {
      const bad = !inp.value.trim() || (inp.type === 'email' && !/^\S+@\S+\.\S+$/.test(inp.value));
      inp.closest('.field').classList.toggle('is-invalid', bad); if (bad) ok = false;
    });
    note.classList.toggle('is-error', !ok);
    if (!ok) { note.textContent = 'Please add your name and a valid email address.'; return; }
    const d = Object.fromEntries(new FormData(form));
    const subject = encodeURIComponent(`Enquiry: ${d.interest} — ${d.name}`);
    const text = encodeURIComponent(`Name: ${d.name}\nEmail: ${d.email}\nPhone: ${d.phone || '-'}\nInterested in: ${d.interest}\n\n${d.message || ''}`);
    note.textContent = 'Thank you — opening a drafted email for you to send.';
    window.location.href = `mailto:${CFG.contactEmail}?subject=${subject}&body=${text}`;
  });

  /* ---------- Boot ---------- */
  const loader = $('#loader');
  const loaderBar = $('#loaderBar');
  const loaderPct = $('#loaderPct');

  function reveal() {
    if (started) return; started = true;
    body.classList.remove('is-loading');
    window.scrollTo(0, 0);
    last = performance.now();
    requestAnimationFrame(frame);
    setupPage();
    if (hasGSAP) {
      ScrollTrigger.refresh();
      const refresh = () => ScrollTrigger.refresh();
      window.addEventListener('load', refresh);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
      setTimeout(refresh, 1500); setTimeout(refresh, 5000);
      const hero = chapters[0];
      gsap.fromTo($$('.line > span', hero), { yPercent: 118 }, { yPercent: 0, duration: 1.4, ease: 'power4.out', stagger: .12, delay: .35 });
      gsap.fromTo($$('[data-fade]', hero), { y: 24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 1.1, ease: 'power3.out', stagger: .12, delay: .8 });
      gsap.fromTo(nav, { autoAlpha: 0, y: -24 }, { autoAlpha: 1, y: 0, duration: 1, ease: 'power3.out', delay: .6, clearProps: 'transform,opacity,visibility' });
      gsap.to(loader, { autoAlpha: 0, duration: .9, ease: 'power2.inOut' });
    } else {
      loader.style.display = 'none';
    }
  }

  preload((p) => {
    loaderPct.textContent = Math.round(p * 100);
    loaderBar.style.transform = `scaleX(${p})`;
  }, reveal);

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
})();
