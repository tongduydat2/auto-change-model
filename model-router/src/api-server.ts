import * as http from 'http';
import { AntigravityRPC } from './rpc-client';
import { MODEL_MAP, MODEL_LABELS } from './types';

const MAX_DELEGATES_PER_MINUTE = 3;
const MIN_DELAY_MS = 5000;

/**
 * HTTP API server that receives tool calls from the MCP bridge.
 * Runs inside the extensionHost process.
 */
export class ApiServer {
  private server: http.Server | null = null;
  private rpc: AntigravityRPC;
  private lastDelegateTime = 0;
  private delegateCount = 0;
  private delegateResetTime = 0;

  constructor(rpc: AntigravityRPC) {
    this.rpc = rpc;
  }

  async listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(port, '127.0.0.1', () => {
        console.log(`[model-router] API server listening on 127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // Only accept from localhost
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const body = await readBody(req);
    const path = req.url || '';

    try {
      let result: unknown;

      switch (path) {
        case '/models':
          result = await this.rpc.listModels();
          break;

        case '/current-model':
          result = { model: await this.rpc.getCurrentModel() };
          break;

        case '/switch-model': {
          const { model } = JSON.parse(body);
          result = await this.rpc.switchModel(model);
          break;
        }

        case '/restore-model':
          result = { restored: await this.rpc.restoreModel() };
          break;

        case '/delegate': {
          const { task, model, context, maxTokens } = JSON.parse(body);
          result = await this.handleDelegate(task, model, context, maxTokens);
          break;
        }

        case '/health':
          result = { status: 'ok', originalModel: this.rpc.getOriginalModel() };
          break;

        default:
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Unknown endpoint: ${path}` }));
          return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleDelegate(
    task: string,
    model: string,
    context?: string,
    _maxTokens?: number,
  ): Promise<{ result: string; model: string; duration_ms: number }> {
    // Rate limiting
    const now = Date.now();
    if (now - this.delegateResetTime > 60000) {
      this.delegateCount = 0;
      this.delegateResetTime = now;
    }
    if (this.delegateCount >= MAX_DELEGATES_PER_MINUTE) {
      throw new Error(`Rate limit: max ${MAX_DELEGATES_PER_MINUTE} delegates/minute`);
    }
    if (now - this.lastDelegateTime < MIN_DELAY_MS) {
      const wait = MIN_DELAY_MS - (now - this.lastDelegateTime);
      await new Promise(r => setTimeout(r, wait));
    }

    this.lastDelegateTime = Date.now();
    this.delegateCount++;

    const start = Date.now();
    const modelId = MODEL_MAP[model] || model;

    // 1. Save current model
    const currentModel = await this.rpc.getCurrentModel();

    // 2. Switch to target model
    await this.rpc.switchModel(modelId);

    try {
      // 3. The actual subtask would be processed by the agent
      //    For now, return a placeholder indicating the model was switched
      //    The real implementation will use StartCascade + SendMessage + Stream
      const prompt = context ? `${context}\n\nTask: ${task}` : task;

      return {
        result: `[Delegated to ${MODEL_LABELS[modelId] || model}] Task: ${prompt}`,
        model: MODEL_LABELS[modelId] || model,
        duration_ms: Date.now() - start,
      };
    } finally {
      // 4. ALWAYS restore original model
      if (currentModel !== modelId) {
        await this.rpc.switchModel(currentModel);
      }
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
  });
}
