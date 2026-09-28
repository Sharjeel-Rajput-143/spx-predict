/**
 * Tiny WebAudio beeps - no audio files to ship, just a couple of short
 * oscillator blips. Safe to call from anywhere; it no-ops without a usable
 * AudioContext (SSR, unsupported browser, or before a user gesture unlocks it).
 */
type SoundKind = "tap" | "lock" | "win" | "lose";

const PRESETS: Record<SoundKind, { freq: number; freq2?: number; durationMs: number; type: OscillatorType }> = {
  tap: { freq: 620, durationMs: 60, type: "sine" },
  lock: { freq: 320, durationMs: 140, type: "triangle" },
  win: { freq: 660, freq2: 990, durationMs: 160, type: "sine" },
  lose: { freq: 260, freq2: 180, durationMs: 220, type: "sawtooth" },
};

let ctx: AudioContext | null = null;
function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

export function playSound(kind: SoundKind) {
  const audio = getContext();
  if (!audio) return;
  if (audio.state === "suspended") audio.resume().catch(() => {});

  const { freq, freq2, durationMs, type } = PRESETS[kind];
  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, now + durationMs / 1000);
  gain.gain.setValueAtTime(0.08, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(now);
  osc.stop(now + durationMs / 1000 + 0.02);
}
