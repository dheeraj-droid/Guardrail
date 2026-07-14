'use client';

import { useEffect, useRef } from 'react';

/**
 * Ambient canvas backdrop for the dashboard — a dimmer, sparser echo of the
 * landing hero's particle field (src/app/HeroBackdrop.tsx). Same living product,
 * turned way down so content legibility always wins.
 *
 * Deliberately quieter than the hero:
 *  - ~40% of the particle count for a given width.
 *  - Roughly half the per-particle alpha; no connecting lines.
 *  - No pointer repulsion — the dashboard is a working surface, not a showpiece.
 *
 * Engineering guarantees (mirrors the hero):
 *  - Pure canvas 2D + a single requestAnimationFrame loop (never stacked).
 *  - devicePixelRatio-aware; re-scales on resize via ResizeObserver.
 *  - Loop pauses when the tab is hidden or the canvas scrolls out of view.
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
//   --backdrop-particle  (ink-toned circles)
//   --backdrop-accent    (coral squares + plus marks)
// Each is an "r, g, b" triple so we can vary alpha per particle/tier.
const FALLBACK_INK = '23, 24, 28'; // --ink #17181c
const FALLBACK_ACCENT = '233, 86, 74'; // --accent #e9564a

// Tuning — deliberately dimmer/slower than the hero's TIERS so this reads as
// ambience, never decoration competing with the cards.
const TIERS = [
  { speed: 0.12, alpha: 0.03, size: 9 },
  { speed: 0.24, alpha: 0.055, size: 14 },
  { speed: 0.38, alpha: 0.08, size: 19 },
] as const;

function countForWidth(width: number): number {
  if (width < 640) return 14;
  if (width < 1024) return 22;
  if (width < 1440) return 28;
  return 34;
}

function pickShape(r: number): Shape {
  if (r < 0.42) return 'circle';
  if (r < 0.8) return 'square';
  return 'plus';
}

export function DashboardBackdrop() {
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
    let accentColor = FALLBACK_ACCENT;

    function readColors() {
      const styles = getComputedStyle(document.documentElement);
      const read = (name: string, fallback: string) => {
        const v = styles.getPropertyValue(name).trim();
        return v || fallback;
      };
      inkColor = read('--backdrop-particle', FALLBACK_INK);
      accentColor = read('--backdrop-accent', FALLBACK_ACCENT);
    }

    let rafId = 0;
    let running = false;
    let visibleInView = true;
    let lastTime = 0;

    const rand = (min: number, max: number) => min + Math.random() * (max - min);

    function build() {
      const count = countForWidth(width);
      particles = Array.from({ length: count }, () => {
        const tier = Math.floor(Math.random() * TIERS.length);
        const cfg = TIERS[tier] ?? TIERS[0];
        const dir = Math.random() * Math.PI * 2;
        const shape = pickShape(Math.random());
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          vx: Math.cos(dir) * cfg.speed,
          vy: Math.sin(dir) * cfg.speed,
          size: cfg.size * rand(0.75, 1.15),
          shape,
          tier,
          alpha: cfg.alpha * rand(0.82, 1.15),
          angle: Math.random() * Math.PI * 2,
          spin: rand(0.0015, 0.007) * (Math.random() < 0.5 ? -1 : 1) * (1 + tier * 0.4),
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
        ctx!.strokeStyle = `rgba(${color}, ${p.alpha + 0.03})`;
        ctx!.strokeRect(-s / 2, -s / 2, s, s);
      } else {
        const arm = s / 2;
        ctx!.lineWidth = 1.6;
        ctx!.lineCap = 'round';
        ctx!.strokeStyle = `rgba(${color}, ${p.alpha + 0.04})`;
        ctx!.beginPath();
        ctx!.moveTo(-arm, 0);
        ctx!.lineTo(arm, 0);
        ctx!.moveTo(0, -arm);
        ctx!.lineTo(0, arm);
        ctx!.stroke();
      }
      ctx!.restore();
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);
      for (const p of particles) drawParticle(p);
    }

    function step(p: Particle, dt: number) {
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
      document.removeEventListener('visibilitychange', onVisibility);
      reducedMotion.removeEventListener('change', onReducedChange);
      darkScheme.removeEventListener('change', onSchemeChange);
    };
  }, []);

  return <canvas ref={canvasRef} className="dashboard-backdrop" aria-hidden="true" />;
}
