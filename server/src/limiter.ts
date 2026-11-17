/** A token bucket per key (an address, an account): `burst` at once, refilled at `perMinute`. */
export class Limiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private burst: number, private perMinute: number, private now: () => number = Date.now) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (t - v.at > 600_000) this.buckets.delete(k);
    return ok;
  }
}
