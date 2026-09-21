import type { Clock } from "./types.ts";

export class SystemClock implements Clock {
  readonly tz: string;
  constructor(tz: string) {
    this.tz = tz;
  }
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  readonly tz: string;
  private readonly at: Date;
  constructor(iso: string, tz: string) {
    this.at = new Date(iso);
    if (Number.isNaN(this.at.getTime())) throw new Error(`FixedClock: bad instant ${iso}`);
    this.tz = tz;
  }
  now(): Date {
    return new Date(this.at);
  }
}

// localDate() and the rest of the timezone maths moved to time.ts; import it from there.
