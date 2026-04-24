import { execSync } from 'child_process';
import * as http from 'http';
import { ConnectionInfo } from './types';

/**
 * Auto-discover the Antigravity language server connection info.
 * Finds the CSRF token from process args and probes ports to find the HTTP port.
 */
export async function discover(): Promise<ConnectionInfo> {
  // Step 1: Find language_server process and extract csrf_token
  const psOutput = execSync(
    "ps aux | grep language_server_linux | grep -v grep",
    { encoding: 'utf-8', timeout: 5000 }
  );

  const lines = psOutput.trim().split('\n');
  let csrf = '';
  let pid = 0;

  for (const line of lines) {
    const csrfMatch = line.match(/--csrf_token\s+(\S+)/);
    const pidMatch = line.match(/^\S+\s+(\d+)/);
    if (csrfMatch && pidMatch) {
      csrf = csrfMatch[1];
      pid = parseInt(pidMatch[1], 10);
      break;
    }
  }

  if (!csrf || !pid) {
    throw new Error('Could not find language_server process or CSRF token');
  }

  // Step 2: Find listening ports for this PID
  const ssOutput = execSync(
    `ss -tlnp 2>/dev/null | grep "pid=${pid},"`,
    { encoding: 'utf-8', timeout: 5000 }
  );

  const ports: number[] = [];
  const portRegex = /127\.0\.0\.1:(\d+)/g;
  let match;
  while ((match = portRegex.exec(ssOutput)) !== null) {
    ports.push(parseInt(match[1], 10));
  }

  if (ports.length === 0) {
    throw new Error(`No listening ports found for PID ${pid}`);
  }

  // Step 3: Probe each port to find the HTTP (not HTTPS) port
  const httpPort = await findHttpPort(ports, csrf);
  if (!httpPort) {
    throw new Error(`Could not find HTTP port among: ${ports.join(', ')}`);
  }

  return { port: httpPort, csrf, pid };
}

/**
 * Probe ports to find the one that accepts ConnectRPC JSON requests.
 */
async function findHttpPort(ports: number[], csrf: string): Promise<number | null> {
  for (const port of ports) {
    try {
      const ok = await probePort(port, csrf);
      if (ok) { return port; }
    } catch {
      // Port doesn't work, try next
    }
  }
  return null;
}

function probePort(port: number, csrf: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
      },
    }, (res) => {
      clearTimeout(timeout);
      // 200 = correct port, anything else = wrong port
      resolve(res.statusCode === 200);
      res.resume(); // drain
    });

    req.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });

    req.write('{}');
    req.end();
  });
}
