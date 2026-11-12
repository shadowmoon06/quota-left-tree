import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Limit, PlanProvider, PlanStatus, cap, clampPct, getJson } from './types';

interface ClaudeOauth {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

/**
 * Uses the same account endpoint as Claude Code's /usage command. Undocumented: it may change.
 * The token is only ever sent to api.anthropic.com. We never refresh it ourselves (that would
 * rotate Claude Code's refresh token); Claude Code refreshes it whenever it runs.
 */
export class ClaudePlanProvider implements PlanProvider {
  readonly id = 'claude';

  constructor(private readonly configDir: () => string) {}

  private async readOauth(): Promise<ClaudeOauth | undefined> {
    const dir = this.configDir() || process.env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim() || path.join(os.homedir(), '.claude');
    try {
      const raw = await fs.promises.readFile(path.join(dir, '.credentials.json'), 'utf8');
      return JSON.parse(raw)?.claudeAiOauth;
    } catch {
      /* fall through */
    }
    if (process.platform === 'darwin') {
      // macOS stores Claude Code credentials in the login keychain.
      const raw = await new Promise<string>((resolve) =>
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (err, out) => resolve(err ? '' : out)),
      );
      try {
        return raw ? JSON.parse(raw)?.claudeAiOauth : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async fetch(): Promise<PlanStatus | undefined> {
    const oauth = await this.readOauth();
    if (!oauth?.accessToken) return undefined;
    const base: PlanStatus = {
      id: this.id,
      provider: 'Claude',
      plan: cap(oauth.subscriptionType ?? 'plan'),
      state: 'ok',
      limits: [],
      fetchedAt: Date.now(),
    };
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
      return { ...base, state: 'error', message: 'Login token expired. Run Claude Code once to refresh it.' };
    }
    const { status, body } = await getJson('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${oauth.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    });
    if (status === 401 || status === 403) {
      return { ...base, state: 'error', message: 'Not authorized. Run Claude Code once to refresh your login.' };
    }
    if (status !== 200 || !body) {
      return { ...base, state: 'error', message: `Usage endpoint returned HTTP ${status}.` };
    }
    return { ...base, limits: parseLimits(body) };
  }
}

function parseLimits(body: any): Limit[] {
  const out: Limit[] = [];
  if (Array.isArray(body.limits) && body.limits.length) {
    for (const l of body.limits) {
      if (typeof l?.percent !== 'number') continue;
      const scopeName = l.scope?.model?.display_name ?? l.scope?.surface ?? null;
      out.push({
        id: String(l.kind ?? out.length) + (scopeName ? ':' + scopeName : ''),
        label: labelFor(l.kind, l.group, scopeName),
        usedPercent: clampPct(l.percent),
        resetsAt: l.resets_at ? Date.parse(l.resets_at) || undefined : undefined,
        scoped: !!l.scope,
      });
    }
    return out;
  }
  // Older response shape.
  const legacy: [string, string, boolean][] = [
    ['five_hour', '5-hour', false],
    ['seven_day', 'Weekly', false],
    ['seven_day_opus', 'Weekly · Opus', true],
    ['seven_day_sonnet', 'Weekly · Sonnet', true],
  ];
  for (const [key, label, scoped] of legacy) {
    const w = body[key];
    if (w && typeof w.utilization === 'number') {
      out.push({ id: key, label, usedPercent: clampPct(w.utilization), resetsAt: Date.parse(w.resets_at) || undefined, scoped });
    }
  }
  return out;
}

function labelFor(kind: string, group: string, scope: string | null): string {
  const base = kind === 'session' || group === 'session' ? '5-hour' : group === 'weekly' ? 'Weekly' : cap(String(group ?? kind ?? 'Limit'));
  return scope ? `${base} · ${scope}` : base;
}
