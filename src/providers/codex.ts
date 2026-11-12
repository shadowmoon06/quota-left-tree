import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Limit, PlanProvider, PlanStatus, cap, clampPct, getJson, windowLabel } from './types';

/**
 * Uses the ChatGPT backend endpoint the Codex CLI uses for its usage display. Undocumented.
 * The token is only ever sent to chatgpt.com. If the call fails, falls back to the most recent
 * rate-limit snapshot in the Codex session logs (marked stale).
 */
export class CodexPlanProvider implements PlanProvider {
  readonly id = 'codex';

  constructor(private readonly homeOverride: () => string) {}

  private home(): string {
    return this.homeOverride() || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  }

  async fetch(): Promise<PlanStatus | undefined> {
    let auth: any;
    try {
      auth = JSON.parse(await fs.promises.readFile(path.join(this.home(), 'auth.json'), 'utf8'));
    } catch {
      return undefined;
    }
    const tok = auth?.tokens;
    if (!tok?.access_token) return undefined; // API-key login: no subscription plan to track
    const base: PlanStatus = { id: this.id, provider: 'Codex', plan: 'ChatGPT', state: 'ok', limits: [], fetchedAt: Date.now() };

    let failure: string;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${tok.access_token}` };
      if (tok.account_id) headers['ChatGPT-Account-Id'] = tok.account_id;
      const { status, body } = await getJson('https://chatgpt.com/backend-api/wham/usage', headers);
      if (status === 200 && body?.rate_limit) {
        return { ...base, plan: cap(body.plan_type ?? 'ChatGPT'), limits: parseLive(body) };
      }
      failure = status === 401 || status === 403
        ? 'Not authorized. Run Codex once to refresh your login.'
        : `Usage endpoint returned HTTP ${status}.`;
    } catch (e: any) {
      failure = `Usage endpoint unreachable (${e?.name === 'AbortError' ? 'timeout' : e?.message ?? e}).`;
    }

    const fromLogs = await latestLoggedLimits(path.join(this.home(), 'sessions'));
    if (fromLogs) {
      return { ...base, state: 'stale', message: `${failure} Showing the last value from Codex logs.`, limits: fromLogs.limits, fetchedAt: fromLogs.ts };
    }
    return { ...base, state: 'error', message: failure };
  }
}

function parseLive(body: any): Limit[] {
  const out: Limit[] = [];
  const add = (w: any, id: string, prefix: string, scoped: boolean) => {
    if (!w || typeof w.used_percent !== 'number') return;
    out.push({
      id,
      label: (prefix ? prefix + ' · ' : '') + windowLabel(w.limit_window_seconds),
      usedPercent: clampPct(w.used_percent),
      resetsAt: w.reset_at ? w.reset_at * 1000 : undefined,
      scoped,
    });
  };
  add(body.rate_limit.primary_window, 'primary', '', false);
  add(body.rate_limit.secondary_window, 'secondary', '', false);
  const cr = body.code_review_rate_limit;
  if (cr) {
    add(cr.primary_window, 'review-primary', 'Code review', true);
    add(cr.secondary_window, 'review-secondary', 'Code review', true);
  }
  if (Array.isArray(body.additional_rate_limits)) {
    body.additional_rate_limits.forEach((r: any, i: number) => {
      const name = r?.limit_name ?? r?.name ?? `Extra ${i + 1}`;
      const rl = r?.rate_limit ?? r;
      add(rl?.primary_window, `extra${i}-p`, name, true);
      add(rl?.secondary_window, `extra${i}-s`, name, true);
    });
  }
  return out;
}

/** Newest token_count rate-limit snapshot in sessions/YYYY/MM/DD/rollout-*.jsonl. */
async function latestLoggedLimits(sessions: string): Promise<{ ts: number; limits: Limit[] } | undefined> {
  const newestDirs = async (dir: string) => {
    try {
      return (await fs.promises.readdir(dir)).sort().reverse().map((d) => path.join(dir, d));
    } catch {
      return [];
    }
  };
  const files: string[] = [];
  for (const y of await newestDirs(sessions))
    for (const m of await newestDirs(y))
      for (const d of await newestDirs(m)) {
        files.push(...(await newestDirs(d)).filter((f) => f.endsWith('.jsonl')));
        if (files.length >= 5) break;
      }
  let best: { ts: number; limits: Limit[] } | undefined;
  for (const f of files.slice(0, 5)) {
    let text: string;
    try {
      const st = await fs.promises.stat(f);
      const len = Math.min(st.size, 512 * 1024);
      const fh = await fs.promises.open(f, 'r');
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      await fh.close();
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').reverse()) {
      if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
      try {
        const rec = JSON.parse(line);
        const rl = rec?.payload?.rate_limits;
        const ts = Date.parse(rec.timestamp);
        if (!rl || (best && ts <= best.ts)) break;
        const limits: Limit[] = [];
        for (const [id, w] of [['primary', rl.primary], ['secondary', rl.secondary]] as const) {
          if (!w || typeof w.used_percent !== 'number') continue;
          const resetsAt = w.resets_at ? w.resets_at * 1000 : undefined;
          const expired = resetsAt !== undefined && resetsAt < Date.now();
          limits.push({
            id,
            label: windowLabel((w.window_minutes ?? 0) * 60),
            usedPercent: expired ? 0 : clampPct(w.used_percent),
            resetsAt: expired ? undefined : resetsAt,
            scoped: false,
          });
        }
        if (limits.length) best = { ts, limits };
      } catch {
        /* partial line */
      }
      break;
    }
  }
  return best;
}
