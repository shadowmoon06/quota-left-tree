import * as vscode from 'vscode';
import { ClaudePlanProvider } from './providers/claude';
import { CodexPlanProvider } from './providers/codex';
import { PlanProvider, PlanStatus } from './providers/types';

export interface PlanView extends PlanStatus {
  /** % left on the binding (most-used, unscoped) limit; drives the leaf count. */
  leftPercent: number | null;
  bindingId?: string;
}

const cfg = () => vscode.workspace.getConfiguration('quotaLeft');

class PlanService implements vscode.Disposable {
  private readonly providers: { key: string; p: PlanProvider }[] = [
    { key: 'claude', p: new ClaudePlanProvider(() => cfg().get<string>('claude.configDir', '')) },
    { key: 'codex', p: new CodexPlanProvider(() => cfg().get<string>('codex.home', '')) },
  ];
  private readonly emitter = new vscode.EventEmitter<PlanView[]>();
  readonly onDidUpdate = this.emitter.event;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  latest?: PlanView[];

  start(): void {
    this.schedule();
    void this.refresh();
  }

  schedule(): void {
    if (this.timer) clearInterval(this.timer);
    const sec = Math.max(30, cfg().get<number>('refreshIntervalSeconds', 120));
    this.timer = setInterval(() => void this.refresh(), sec * 1000);
  }

  refresh(): Promise<void> {
    this.running ??= this.doRefresh().finally(() => (this.running = undefined));
    return this.running;
  }

  private async doRefresh(): Promise<void> {
    const enabled = this.providers.filter(({ key }) => cfg().get<boolean>(`${key}.enabled`, true));
    const results = await Promise.all(
      enabled.map(({ p }) =>
        p.fetch().catch((e): PlanStatus => ({
          id: p.id, provider: p.id, plan: '', state: 'error', message: String(e?.message ?? e), limits: [], fetchedAt: Date.now(),
        })),
      ),
    );
    this.latest = results.filter((r): r is PlanStatus => !!r).map(toView);
    this.emitter.fire(this.latest);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.emitter.dispose();
  }
}

function toView(s: PlanStatus): PlanView {
  const main = s.limits.filter((l) => !l.scoped);
  const pool = main.length ? main : s.limits;
  if (!pool.length) return { ...s, leftPercent: null };
  const binding = pool.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  return { ...s, leftPercent: 100 - binding.usedPercent, bindingId: binding.id };
}

class PlansViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly extUri: vscode.Uri, private readonly service: PlanService) {
    service.onDidUpdate((plans) => this.view?.webview.postMessage({ type: 'update', plans }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const uri = (f: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    view.webview.html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('plans.css')}">
<title>Quota Left</title>
</head><body>
<div id="plans"><div class="empty">Checking your plans…</div></div>
<div class="footer"><span id="updated"></span> <a href="#" id="refresh">refresh</a></div>
<script nonce="${nonce}" src="${uri('plans.js')}"></script>
</body></html>`;
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready' && this.service.latest) view.webview.postMessage({ type: 'update', plans: this.service.latest });
      else if (msg?.type === 'refresh') await this.service.refresh();
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const service = new PlanService();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.command = 'quotaLeft.open';
  status.text = '$(sync~spin) Quota Left';
  status.show();

  context.subscriptions.push(
    service,
    status,
    vscode.window.registerWebviewViewProvider('quotaLeft.view', new PlansViewProvider(context.extensionUri, service), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    service.onDidUpdate((plans) => {
      const md = new vscode.MarkdownString('**Quota left**\n\n');
      const parts = plans.map((p) => {
        md.appendMarkdown(`**${p.provider} ${p.plan}**${p.state !== 'ok' ? ` (${p.state})` : ''}\n`);
        for (const l of p.limits) md.appendMarkdown(`- ${l.label}: ${Math.round(100 - l.usedPercent)}% left\n`);
        if (p.message) md.appendMarkdown(`\n_${p.message}_\n`);
        md.appendMarkdown('\n');
        return `${p.provider} ${p.leftPercent === null ? '?' : Math.round(p.leftPercent) + '%'}`;
      });
      status.text = `$(pulse) ${parts.length ? parts.join(' · ') + ' left' : 'no plans'}`;
      status.tooltip = md;
    }),
    vscode.commands.registerCommand('quotaLeft.refresh', () => service.refresh()),
    vscode.commands.registerCommand('quotaLeft.open', () => vscode.commands.executeCommand('workbench.view.extension.quotaLeft')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('quotaLeft')) return;
      if (e.affectsConfiguration('quotaLeft.refreshIntervalSeconds')) service.schedule();
      void service.refresh();
    }),
  );
  service.start();
}

export function deactivate(): void {}
