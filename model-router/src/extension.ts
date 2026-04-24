import * as vscode from 'vscode';
import { discover } from './discovery';
import { AntigravityRPC } from './rpc-client';
import { ApiServer } from './api-server';
import { MODEL_MAP, MODEL_LABELS } from './types';

const API_PORT = 18080;
const POLL_INTERVAL_MS = 3000;

let apiServer: ApiServer | null = null;
let rpc: AntigravityRPC | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Model Router');
  output.show(true);
  output.appendLine(`[${ts()}] ========================================`);
  output.appendLine(`[${ts()}] Model Router — Activating...`);

  try {
    // 1. Discover Go binary connection
    const conn = await discover();
    output.appendLine(`[${ts()}] Found language_server PID=${conn.pid} port=${conn.port} csrf=${conn.csrf.slice(0,8)}...`);

    // 2. Create RPC client
    rpc = new AntigravityRPC(conn);

    // 3. Verify connection & log initial state
    const configData = await rpc.getModelConfigData();
    const currentModel = configData.defaultOverrideModelConfig?.modelOrAlias?.model || 'none (using first in list)';
    output.appendLine(`[${ts()}] Current default override: ${currentModel}`);
    output.appendLine(`[${ts()}] Available models:`);
    for (const m of configData.clientModelConfigs || []) {
      const mid = m.modelOrAlias?.model || m.modelOrAlias?.alias || '?';
      const quota = m.quotaInfo ? `${Math.round(m.quotaInfo.remainingFraction * 100)}%` : '?';
      output.appendLine(`[${ts()}]   ${m.label?.padEnd(35)} ${mid.padEnd(40)} quota=${quota}`);
    }

    // 4. Start model change monitor
    output.appendLine(`[${ts()}] ========================================`);
    output.appendLine(`[${ts()}] Starting model change monitor (poll every ${POLL_INTERVAL_MS}ms)`);
    output.appendLine(`[${ts()}] ========================================`);
    startModelMonitor(rpc, output);

    // 5. Start HTTP API server for MCP bridge
    apiServer = new ApiServer(rpc);
    await apiServer.listen(API_PORT);
    output.appendLine(`[${ts()}] API server on 127.0.0.1:${API_PORT}`);

    // 6. Register VS Code commands
    context.subscriptions.push(
      vscode.commands.registerCommand('modelRouter.listModels', async () => {
        const models = await rpc!.listModels();
        const items = models.map(m => ({
          label: m.label,
          description: `${m.modelId} | Quota: ${Math.round(m.quotaRemaining * 100)}%`,
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a model to switch to',
        });
        if (selected) {
          const result = await rpc!.switchModel(selected.label);
          vscode.window.showInformationMessage(`Model switched: ${result.from} → ${result.to}`);
        }
      }),

      vscode.commands.registerCommand('modelRouter.switchModel', async (model?: string) => {
        if (!model) {
          model = await vscode.window.showInputBox({
            prompt: 'Model name (flash, sonnet, opus, gemini-pro-high, gemini-pro-low, gpt-oss)',
            placeHolder: 'flash',
          });
        }
        if (model) {
          const result = await rpc!.switchModel(model);
          vscode.window.showInformationMessage(`Model switched: ${result.from} → ${result.to}`);
        }
      }),

      vscode.commands.registerCommand('modelRouter.restoreModel', async () => {
        const restored = await rpc!.restoreModel();
        vscode.window.showInformationMessage(`Model restored: ${restored}`);
      }),
    );

    // 7. Cleanup on deactivation
    context.subscriptions.push({
      dispose: async () => {
        if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
        if (rpc?.getOriginalModel()) {
          try {
            await rpc.restoreModel();
            output.appendLine(`[${ts()}] Auto-restored model on deactivation`);
          } catch (e) {
            output.appendLine(`[${ts()}] Failed to auto-restore: ${e}`);
          }
        }
      },
    });

    output.appendLine(`[${ts()}] ✅ Activated successfully`);

  } catch (err: any) {
    output.appendLine(`[${ts()}] ❌ Activation failed: ${err.message}`);
    vscode.window.showErrorMessage(`Model Router failed: ${err.message}`);
  }
}

// ─── Model Change Monitor ────────────────────────────────────
interface ModelState {
  defaultOverride: string | null;
  quotas: Record<string, number>;
}

function startModelMonitor(rpc: AntigravityRPC, output: vscode.OutputChannel) {
  let lastState: ModelState | null = null;

  monitorTimer = setInterval(async () => {
    try {
      const data = await rpc.getModelConfigData();
      const currentOverride = data.defaultOverrideModelConfig?.modelOrAlias?.model || null;

      const quotas: Record<string, number> = {};
      for (const m of data.clientModelConfigs || []) {
        const mid = m.modelOrAlias?.model || '';
        quotas[mid] = m.quotaInfo?.remainingFraction ?? -1;
      }

      const newState: ModelState = { defaultOverride: currentOverride, quotas };

      if (lastState === null) {
        lastState = newState;
        return;
      }

      // Detect model change
      if (lastState.defaultOverride !== currentOverride) {
        const oldLabel = lastState.defaultOverride 
          ? (MODEL_LABELS[lastState.defaultOverride] || lastState.defaultOverride)
          : 'none';
        const newLabel = currentOverride 
          ? (MODEL_LABELS[currentOverride] || currentOverride)
          : 'none';

        // Determine reason
        let reason = 'unknown';
        if (!lastState.defaultOverride && currentOverride) {
          reason = 'MODEL_SET — override was set (user selected or API)';
        } else if (lastState.defaultOverride && !currentOverride) {
          reason = 'MODEL_CLEARED — override was removed (reset to default)';
        } else {
          reason = 'MODEL_SWITCHED — override changed to different model';
        }

        output.appendLine(`[${ts()}] ══════════════════════════════════`);
        output.appendLine(`[${ts()}] 🔄 MODEL CHANGE DETECTED`);
        output.appendLine(`[${ts()}]   From:   ${oldLabel} (${lastState.defaultOverride || 'null'})`);
        output.appendLine(`[${ts()}]   To:     ${newLabel} (${currentOverride || 'null'})`);
        output.appendLine(`[${ts()}]   Reason: ${reason}`);
        output.appendLine(`[${ts()}] ══════════════════════════════════`);
      }

      // Detect quota changes
      for (const mid of Object.keys(quotas)) {
        const oldQuota = lastState.quotas[mid];
        const newQuota = quotas[mid];
        if (oldQuota !== undefined && newQuota !== oldQuota) {
          const label = MODEL_LABELS[mid] || mid;
          const oldPct = Math.round(oldQuota * 100);
          const newPct = Math.round(newQuota * 100);
          const delta = newPct - oldPct;
          output.appendLine(`[${ts()}] 📊 QUOTA: ${label} ${oldPct}% → ${newPct}% (${delta > 0 ? '+' : ''}${delta}%)`);
        }
      }

      lastState = newState;
    } catch (e: any) {
      output.appendLine(`[${ts()}] ⚠️ Monitor error: ${e.message}`);
    }
  }, POLL_INTERVAL_MS);
}

// ─── Helpers ─────────────────────────────────────────────────
function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export async function deactivate() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  if (rpc?.getOriginalModel()) {
    try { await rpc.restoreModel(); } catch {}
  }
  if (apiServer) {
    await apiServer.stop();
  }
}
