import { readFileSync } from 'node:fs';

export interface HostTime {
  boot: string;
  uptime: number;
}

/** Linux uptime includes suspend. The boot ID disambiguates uptime after reboot. */
export function hostTime(): HostTime {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const uptime = Math.floor(
    Number.parseFloat(readFileSync('/proc/uptime', 'utf8')) * 1000,
  );
  if (!boot || !Number.isSafeInteger(uptime))
    throw new Error('HOST_CLOCK_UNAVAILABLE');
  return { boot, uptime };
}

export interface HostLease {
  expires: number;
  boot?: string | null;
  uptimeExpiry?: number | null;
}

export function leaseActive(
  lease: HostLease,
  now: () => number,
  host?: () => HostTime,
): boolean {
  if (
    lease.boot &&
    lease.uptimeExpiry != null &&
    (host || process.platform === 'linux')
  ) {
    if (lease.uptimeExpiry <= 0) return false;
    const clock = (host ?? hostTime)();
    return lease.boot === clock.boot && lease.uptimeExpiry > clock.uptime;
  }
  return lease.expires > now();
}
