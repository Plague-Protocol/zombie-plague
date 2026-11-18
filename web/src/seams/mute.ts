// Sound on or off: one choice for the whole site (the header's speaker, the cold open's button, the game's HUD), kept on
// this device. Changing it anywhere tells the rest, so the speaker in the header and the one in the game always agree.
const KEY = 'zp.muted';
const EVENT = 'zp-mute';

export function isMuted(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function setMuted(m: boolean): void {
  try { localStorage.setItem(KEY, m ? '1' : '0'); } catch { /* this visit only */ }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: m }));
}
export function onMute(f: (muted: boolean) => void): void {
  window.addEventListener(EVENT, (e) => f((e as CustomEvent<boolean>).detail));
}
