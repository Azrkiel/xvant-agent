import {
  hostTime,
  type HostTime,
} from '../../../packages/storage/src/host-clock.ts';
import type { ClockSample } from '../../../packages/storage/src/schedule.ts';

/** Absolute deadlines use a clock that advances through suspend and rollback.
 * A forward wall correction can expire work but cannot replenish its budget. */
export class DaemonClock {
  #last: ClockSample | null = null;
  readonly host: () => HostTime;
  readonly wall: () => number;

  constructor(host: () => HostTime = hostTime, wall: () => number = Date.now) {
    this.host = host;
    this.wall = wall;
  }

  restore(previous: ClockSample | null): void {
    this.#last = previous;
  }

  sample(): ClockSample {
    const current = this.host();
    const elapsed =
      this.#last?.boot === current.boot
        ? Math.max(0, current.uptime - this.#last.uptime)
        : 0;
    const time = Math.max(this.wall(), (this.#last?.time ?? 0) + elapsed);
    return (this.#last = { ...current, time });
  }

  now = (): number => this.sample().time;
}
