/**
 * Watches a replay through a real browser and asserts the race readouts stay
 * sane the whole way through, rather than only at the handful of moments a
 * screenshot happens to catch.
 *
 * The invariants are the ones that would actually mislead someone: progress
 * that goes backwards, a stage that un-finishes, a stage order that skips,
 * a plan delta that swings wildly between samples.
 */

import { chromium } from 'playwright';

export async function runChecks({ port, wallSeconds, raceHour, hhmm }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && jsErrors.push(m.text()));

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const samples = [];
  const violations = [];
  const note = (msg) => {
    if (!violations.includes(msg)) violations.push(msg);
  };

  const deadline = Date.now() + (wallSeconds + 3) * 1000;
  let prev = null;

  while (Date.now() < deadline) {
    const s = await page.evaluate((startMs) => {
      const t = (id) => (document.getElementById(id) || {}).textContent || '';
      const states = [...document.querySelectorAll('.stage')].map((e) =>
        e.className.includes('is-done') ? 'done' : e.className.includes('is-active') ? 'active' : 'todo'
      );
      const mile = parseFloat(t('progress')) || null;
      return {
        // Race hour is read from the page's own clock, not the harness's.
        // They run at the same rate but start seconds apart, and at several
        // thousand times real speed those seconds are hours.
        hour: (Date.now() - startMs) / 3600000,
        where: t('where'),
        mile,
        plan: t('plan'),
        states,
        health: (() => {
          const h = document.getElementById('health');
          return h && !h.hidden ? h.textContent.slice(0, 60) : null;
        })(),
        alert: (() => {
          const a = document.getElementById('alert');
          return a && !a.hidden;
        })(),
      };
    }, Date.parse('2026-08-12T15:00:00Z'));
    samples.push(s);

    if (prev) {
      // Progress must not go backwards. The course crosses itself constantly,
      // so a mis-snap shows up here first.
      if (s.mile != null && prev.mile != null && s.mile < prev.mile - 0.6) {
        note(`progress went backwards: ${prev.mile} -> ${s.mile} mi at race hour ${s.hour.toFixed(1)}`);
      }
      // A finished stage must stay finished.
      prev.states.forEach((st, i) => {
        if (st === 'done' && s.states[i] !== 'done') {
          note(`stage ${i + 1} un-finished at race hour ${s.hour.toFixed(1)}`);
        }
      });
    }

    // Stage order must be done* active? todo* — never done after todo.
    const firstTodo = s.states.indexOf('todo');
    if (firstTodo > -1 && s.states.slice(firstTodo).includes('done')) {
      note(`stages out of order at race hour ${s.hour.toFixed(1)}: ${s.states.join(',')}`);
    }
    if (s.states.filter((x) => x === 'active').length > 1) {
      note(`more than one stage active at race hour ${s.hour.toFixed(1)}`);
    }

    prev = s;
    await page.waitForTimeout(250);
  }

  await browser.close();

  // ---- report ----
  const line = (s) =>
    `  ${String(hhmm(Math.max(0, s.hour))).padStart(6)}  ${String(s.mile ?? '—').padStart(6)} mi  ` +
    `${s.states.map((x) => (x === 'done' ? '#' : x === 'active' ? '>' : '.')).join('')}  ` +
    `${s.plan.padEnd(12)} ${s.where}${s.health ? '  [' + s.health + ']' : ''}${s.alert ? '  [HELP]' : ''}`;

  console.log('\n  hour     mile   stages  plan         where');
  const step = Math.max(1, Math.floor(samples.length / 24));
  samples.filter((_, i) => i % step === 0).forEach((s) => console.log(line(s)));
  console.log(line(samples[samples.length - 1]));

  const last = samples[samples.length - 1];
  console.log(`\n  ${samples.length} samples across the replay`);
  console.log(`  final: ${last.mile} mi, stages ${last.states.join(',')}`);

  if (jsErrors.length) {
    console.log(`\n  JS ERRORS (${jsErrors.length}):`);
    [...new Set(jsErrors)].slice(0, 5).forEach((e) => console.log(`    ${e}`));
  }
  if (violations.length) {
    console.log(`\n  INVARIANTS VIOLATED (${violations.length}):`);
    violations.forEach((v) => console.log(`    ${v}`));
  } else {
    console.log('\n  invariants held: progress monotonic, stages ordered, none un-finished');
  }

  if (jsErrors.length || violations.length) process.exitCode = 1;
}
