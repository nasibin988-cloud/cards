/**
 * Podcast audio finishing: ambient drone "bed" + segment-boundary
 * "bumpers". Both are synthesised at runtime via Web Audio API so we
 * ship zero asset files and the sound stays consistent across
 * browsers.
 *
 * Design choice: bed + bumpers play out of a SEPARATE Web Audio
 * pipeline parallel to the podcast's `<audio>` element. Browsers mix
 * them at the speakers automatically; we do NOT pipe the podcast
 * audio through `createMediaElementSource`, which keeps the audio
 * path simple and works equally well for the browser-TTS playback
 * (which doesn't expose an HTMLAudioElement at all).
 *
 * Both effects are gentle by default. Bed gain peaks at 0.04 so it
 * never competes with narration. Bumper is a soft two-tone (G + B
 * 5th), ~300ms, attenuated to 0.12.
 */

let _ctx: AudioContext | null = null;

function ctx(): AudioContext {
  if (typeof window === 'undefined') {
    throw new Error('audio-fx is browser-only');
  }
  if (!_ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    _ctx = new AC();
  }
  return _ctx;
}

/* ─── Drone bed ────────────────────────────────────────────────── */

export class DroneBed {
  private nodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private master: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    const ac = ctx();
    // Resume on a user gesture; AudioContext starts suspended in many
    // browsers and the caller is responsible for clicking a button first.
    if (ac.state === 'suspended') ac.resume().catch(() => {});

    const master = ac.createGain();
    master.gain.value = 0;
    master.connect(ac.destination);

    // Gentle low-pass so the harmonics aren't shrill at higher sample rates.
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.5;
    filter.connect(master);

    // Two oscillators a perfect fifth apart, very low. Long ambient hum.
    const freqs = [98, 147];        // G2 + D3, calming
    const types: OscillatorType[] = ['sine', 'sine'];
    this.nodes = freqs.map((f, i) => {
      const osc = ac.createOscillator();
      osc.type = types[i];
      osc.frequency.value = f;
      const g = ac.createGain();
      g.gain.value = i === 0 ? 0.6 : 0.35;
      osc.connect(g);
      g.connect(filter);
      osc.start();
      return { osc, gain: g };
    });

    // Slow LFO modulating the filter cutoff for breath. ~0.06 Hz = one
    // breath every 16 seconds.
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.06;
    const lfoGain = ac.createGain();
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    // Fade in over 3 seconds.
    master.gain.linearRampToValueAtTime(0.04, ac.currentTime + 3);

    this.master = master;
    this.filter = filter;
    this.lfo = lfo;
    this.lfoGain = lfoGain;
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    const ac = ctx();
    const m = this.master;
    if (m) {
      const now = ac.currentTime;
      m.gain.cancelScheduledValues(now);
      m.gain.setValueAtTime(m.gain.value, now);
      m.gain.linearRampToValueAtTime(0, now + 1.5);
    }
    // Tear down once fade completes.
    window.setTimeout(() => {
      for (const { osc } of this.nodes) {
        try { osc.stop(); osc.disconnect(); } catch { /* already stopped */ }
      }
      this.nodes = [];
      try { this.lfo?.stop(); this.lfo?.disconnect(); } catch { /* */ }
      try { this.lfoGain?.disconnect(); } catch { /* */ }
      try { this.filter?.disconnect(); } catch { /* */ }
      try { this.master?.disconnect(); } catch { /* */ }
      this.lfo = null;
      this.lfoGain = null;
      this.filter = null;
      this.master = null;
      this.running = false;
    }, 1700);
  }
}

/* ─── Segment-boundary bumper ─────────────────────────────────── */

/**
 * Play a soft two-tone chime. ~300ms total, peak gain 0.12.
 * Fire-and-forget; nodes self-clean on stop.
 */
export function playBumper(): void {
  const ac = ctx();
  if (ac.state === 'suspended') ac.resume().catch(() => {});

  const master = ac.createGain();
  master.gain.value = 0;
  master.connect(ac.destination);

  const tones = [
    { freq: 392, start: 0,    dur: 0.20, gain: 0.10 }, // G4
    { freq: 587, start: 0.10, dur: 0.22, gain: 0.08 }, // D5
  ];
  for (const t of tones) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = t.freq;
    const g = ac.createGain();
    const t0 = ac.currentTime + t.start;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(t.gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + t.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + t.dur + 0.05);
  }

  // Fade master in/out.
  const total = 0.35;
  master.gain.setValueAtTime(0, ac.currentTime);
  master.gain.linearRampToValueAtTime(1, ac.currentTime + 0.01);
  master.gain.linearRampToValueAtTime(0, ac.currentTime + total);
  window.setTimeout(() => {
    try { master.disconnect(); } catch { /* */ }
  }, (total + 0.1) * 1000);
}
