'use client';

import { useEffect, useRef } from 'react';

/**
 * Canvas particle backdrop for the landing hero.
 *
 * Geometric field — outlined squares, filled circles, and plus marks in the
 * brand coral + ink, drifting with visible velocity, rotating, and repelling
 * the pointer. Three depth tiers give parallax (far = smaller, dimmer, slower).
 *
 * Engineering guarantees:
 *  - Pure canvas 2D + a single requestAnimationFrame loop (never stacked).
 *  - devicePixelRatio-aware; re-scales on resize via ResizeObserver.
 *  - Loop pauses when the tab is hidden or the hero scrolls out of view.
 *  - prefers-reduced-motion → one static frame, no animation (reacts to changes).
 *  - All listeners / observers / RAF torn down on unmount.
 *
 * Rendered aria-hidden and pointer-events:none so it never touches a11y or clicks.
 */

type Shape = 'square' | 'circle' | 'plus';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Home velocity restored after a pointer shove eases out. */
  baseVx: number;
  baseVy: number;
  size: number;
  shape: Shape;
  /** 0 = far, 1 = mid, 2 = near — drives opacity and speed scale. */
  tier: number;
  alpha: number;
  angle: number;
  spin: number;
}

// Particle colors are read from CSS custom properties at setup (and re-read on a
// color-scheme change), so light/dark are driven entirely by globals.css tokens:
//   --backdrop-particle / --backdrop-link  (ink-toned circles + connecting lines)
//   --backdrop-accent                      (coral squares + plus marks)
// Each is an "r, g, b" triple so we can vary alpha per particle/tier.
const FALLBACK_INK = '23, 24, 28'; // --ink #17181c
const FALLBACK_ACCENT = '233, 86, 74'; // --accent #e9564a

// Tuning — chosen for "clearly alive, never confetti".
// Three depth tiers: far (dim, small, slow) → near (brighter, larger, faster).
const TIERS = [
  { speed: 0.18, alpha: 0.06, size: 9 },
  { speed: 0.34, alpha: 0.11, size: 14 },
  { speed: 0.55, alpha: 0.17, size: 20 },
] as const;
const POINTER_RADIUS = 130; // repulsion field radius (CSS px)
const POINTER_FORCE = 0.9; // shove strength at the pointer center
const RETURN_EASE = 0.045; // how fast velocity relaxes back to base
const LINK_DIST = 118; // max distance for connecting lines (CSS px)
const LINK_ALPHA = 0.05; // very faint — reads engineered, not noisy

function countForWidth(width: number): number {
  if (width < 640) return 34;
  if (width < 1024) return 54;
  if (width < 1440) return 68;
  return 80;
}

function pickShape(r: number): Shape {
  if (r < 0.42) return 'circle';
  if (r < 0.8) return 'square';
  return 'plus';
}

export function HeroBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

    let width = 0;
    let height = 0;
    let dpr = 1;
    let particles: Particle[] = [];

    // Live colors, read from CSS custom properties and refreshed on scheme change.
    let inkColor = FALLBACK_INK;
    let linkColor = FALLBACK_INK;
    let accentColor = FALLBACK_ACCENT;

    function readColors() {
      const styles = getComputedStyle(document.documentElement);
      const read = (name: string, fallback: string) => {
        const v = styles.getPropertyValue(name).trim();
        return v || fallback;
      };
      inkColor = read('--backdrop-particle', FALLBACK_INK);
      linkColor = read('--backdrop-link', FALLBACK_INK);
      accentColor = read('--backdrop-accent', FALLBACK_ACCENT);
    }

    let rafId = 0;
    let running = false;
    let visibleInView = true;
    let lastTime = 0;

    // Pointer in CSS-pixel canvas space; active toggles the repulsion field.
    const pointer = { x: 0, y: 0, active: false };

    const rand = (min: number, max: number) => min + Math.random() * (max - min);

    function build() {
      const count = countForWidth(width);
      particles = Array.from({ length: count }, () => {
        const tier = Math.floor(Math.random() * TIERS.length);
        const cfg = TIERS[tier] ?? TIERS[0];
        const dir = Math.random() * Math.PI * 2;
        const vx = Math.cos(dir) * cfg.speed;
        const vy = Math.sin(dir) * cfg.speed;
        const shape = pickShape(Math.random());
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          vx,
          vy,
          baseVx: vx,
          baseVy: vy,
          size: cfg.size * rand(0.75, 1.15),
          shape,
          tier,
          alpha: cfg.alpha * rand(0.82, 1.15),
          angle: Math.random() * Math.PI * 2,
          // Near tiers spin a touch faster; sign randomised.
          spin: rand(0.002, 0.01) * (Math.random() < 0.5 ? -1 : 1) * (1 + tier * 0.4),
        };
      });
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
      if (reducedMotion.matches || !running) draw();
    }

    function drawParticle(p: Particle) {
      // Circles ink-toned, squares/plus coral-leaning — a cohesive two-hue field.
      const color = p.shape === 'circle' ? inkColor : accentColor;
      ctx!.save();
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.angle);
      const s = p.size;

      if (p.shape === 'circle') {
        ctx!.beginPath();
        ctx!.arc(0, 0, s / 2, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(${color}, ${p.alpha})`;
        ctx!.fill();
      } else if (p.shape === 'square') {
        ctx!.lineWidth = 1.4;
        ctx!.strokeStyle = `rgba(${color}, ${p.alpha + 0.05})`;
        ctx!.strokeRect(-s / 2, -s / 2, s, s);
      } else {
        // plus / cross
        const arm = s / 2;
        ctx!.lineWidth = 1.6;
        ctx!.lineCap = 'round';
        ctx!.strokeStyle = `rgba(${color}, ${p.alpha + 0.06})`;
        ctx!.beginPath();
        ctx!.moveTo(-arm, 0);
        ctx!.lineTo(arm, 0);
        ctx!.moveTo(0, -arm);
        ctx!.lineTo(0, arm);
        ctx!.stroke();
      }
      ctx!.restore();
    }

    function drawLinks() {
      // Only connect near/mid tiers so the far layer stays clean.
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        if (!a || a.tier === 0) continue;
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          if (!b || b.tier === 0) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK_DIST * LINK_DIST) continue;
          const t = 1 - Math.sqrt(d2) / LINK_DIST;
          ctx!.strokeStyle = `rgba(${linkColor}, ${LINK_ALPHA * t})`;
          ctx!.lineWidth = 1;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();
        }
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);
      drawLinks();
      for (const p of particles) drawParticle(p);
    }

    function step(p: Particle, dt: number) {
      // Pointer repulsion — inverse-falloff shove, strongest at the center.
      if (pointer.active) {
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (dist < POINTER_RADIUS && dist > 0.01) {
          const f = (1 - dist / POINTER_RADIUS) * POINTER_FORCE * (0.5 + p.tier * 0.35);
          p.vx += (dx / dist) * f;
          p.vy += (dy / dist) * f;
        }
      }

      // Relax velocity back toward the particle's home drift.
      p.vx += (p.baseVx - p.vx) * RETURN_EASE;
      p.vy += (p.baseVy - p.vy) * RETURN_EASE;

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;

      // Wrap around edges with a margin so shapes don't pop at the boundary.
      const m = p.size;
      if (p.x < -m) p.x = width + m;
      else if (p.x > width + m) p.x = -m;
      if (p.y < -m) p.y = height + m;
      else if (p.y > height + m) p.y = -m;
    }

    function frame(now: number) {
      // dt normalised to 60fps units; clamped so a resumed/hidden tab never
      // teleports the field across the screen.
      const raw = lastTime ? (now - lastTime) / 16.667 : 1;
      const dt = Math.min(raw, 2.2);
      lastTime = now;

      for (const p of particles) step(p, dt);
      draw();

      rafId = window.requestAnimationFrame(frame);
    }

    function start() {
      if (running || reducedMotion.matches) return;
      if (!visibleInView || document.hidden) return;
      running = true;
      lastTime = 0; // fresh delta baseline on resume
      rafId = window.requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    // --- Pointer: listen on window (canvas is pointer-events:none), map to canvas space.
    function onPointerMove(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
    }
    function onPointerLeave() {
      pointer.active = false;
    }

    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    function onReducedChange() {
      if (reducedMotion.matches) {
        stop();
        draw(); // settle to a clean static frame
      } else {
        start();
      }
    }

    // Re-read tokens when the OS color scheme flips; redraw so a paused/static
    // field (hidden tab, out of view, or reduced-motion) adopts the new colors.
    function onSchemeChange() {
      readColors();
      if (!running) draw();
    }

    // --- Wire up.
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    const io = new IntersectionObserver(
      (entries) => {
        visibleInView = entries[0]?.isIntersecting ?? true;
        if (visibleInView) start();
        else stop();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibility);
    reducedMotion.addEventListener('change', onReducedChange);
    darkScheme.addEventListener('change', onSchemeChange);

    readColors();
    resize();
    start();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      reducedMotion.removeEventListener('change', onReducedChange);
      darkScheme.removeEventListener('change', onSchemeChange);
    };
  }, []);

  return <canvas ref={canvasRef} className="hero-backdrop" aria-hidden="true" />;
}
