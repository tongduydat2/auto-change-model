import * as http from 'http';
import { ConnectionInfo, ModelConfigData, ModelInfo, MODEL_MAP, MODEL_LABELS } from './types';

/**
 * ConnectRPC client for the Antigravity Go binary.
 * All calls originate from the extensionHost process (same PID as Antigravity).
 */
export class AntigravityRPC {
  private conn: ConnectionInfo;
  private originalModel: string | null = null;

  constructor(conn: ConnectionInfo) {
    this.conn = conn;
  }

  // ─── Model Queries ─────────────────────────────────────────

  async getModelConfigData(): Promise<ModelConfigData> {
    return this.rpc('GetCascadeModelConfigData', {});
  }

  async getCurrentModel(): Promise<string> {
    const data = await this.getModelConfigData();
    return data.defaultOverrideModelConfig?.modelOrAlias?.model || 'unknown';
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await this.getModelConfigData();
    return (data.clientModelConfigs || []).map(m => ({
      label: m.label,
      modelId: m.modelOrAlias?.model || m.modelOrAlias?.alias || '',
      supportsImages: m.supportsImages || false,
      quotaRemaining: m.quotaInfo?.remainingFraction ?? -1,
      quotaResetTime: m.quotaInfo?.resetTime || '',
    }));
  }

  // ─── Model Switching ───────────────────────────────────────

  /**
   * Switch to a different model. Saves the original for restore.
   * @param modelName Friendly name (e.g., "flash") or raw model ID
   */
  async switchModel(modelName: string): Promise<{ from: string; to: string }> {
    const modelId = MODEL_MAP[modelName] || modelName;
    const current = await this.getCurrentModel();

    if (!this.originalModel) {
      this.originalModel = current;
    }

    if (current === modelId) {
      return { from: current, to: modelId };
    }

    // Try setting via SendActionToChatPanel with model selection
    // This mimics what the UI does when user clicks model selector
    await this.rpc('SendActionToChatPanel', {
      action: {
        case: 'setDefaultModel',
        value: {
          modelOrAlias: { model: modelId },
        },
      },
    });

    return {
      from: MODEL_LABELS[current] || current,
      to: MODEL_LABELS[modelId] || modelId,
    };
  }

  /**
   * Restore to the original model saved before the first switch.
   */
  async restoreModel(): Promise<string> {
    if (!this.originalModel) {
      return 'No model to restore (no switch was made)';
    }

    const target = this.originalModel;
    this.originalModel = null;

    await this.rpc('SendActionToChatPanel', {
      action: {
        case: 'setDefaultModel',
        value: {
          modelOrAlias: { model: target },
        },
      },
    });

    return MODEL_LABELS[target] || target;
  }

  getOriginalModel(): string | null {
    return this.originalModel;
  }

  // ─── Low-level RPC ─────────────────────────────────────────

  private rpc(method: string, body: unknown): Promise<any> {
    const path = `/exa.language_server_pb.LanguageServerService/${method}`;
    const payload = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`RPC ${method} timeout`)), 10000);

      const req = http.request({
        hostname: '127.0.0.1',
        port: this.conn.port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': this.conn.csrf,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          clearTimeout(timeout);
          if (res.statusCode !== 200) {
            reject(new Error(`RPC ${method} returned ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            reject(new Error(`RPC ${method} invalid JSON: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`RPC ${method} error: ${err.message}`));
      });

      req.write(payload);
      req.end();
    });
  }
}
