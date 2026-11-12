export interface Limit {
  id: string;
  label: string;
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
  /** Scoped limits (one model / feature) don't drive the leaf count. */
  scoped: boolean;
}

export type PlanState = 'ok' | 'stale' | 'error';

export interface PlanStatus {
  id: string;
  provider: string;
  plan: string;
  state: PlanState;
  message?: string;
  limits: Limit[];
  fetchedAt: number;
}

export interface PlanProvider {
  readonly id: string;
  fetch(): Promise<PlanStatus | undefined>; // undefined = not installed / not logged in, hide the tree
}

export async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'pixel-quota-left/0.1', Accept: 'application/json', ...headers }, signal: ctrl.signal });
    let body: any = undefined;
    try {
      body = await r.json();
    } catch {
      /* non-JSON */
    }
    return { status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function clampPct(n: unknown): number {
  return typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

export function windowLabel(seconds: number | undefined): string {
  if (!seconds) return 'Limit';
  const min = seconds / 60;
  if (min === 10080) return 'Weekly';
  if (min % 1440 === 0) return `${min / 1440}-day`;
  if (min % 60 === 0) return `${min / 60}-hour`;
  return `${Math.round(min)}-min`;
}
