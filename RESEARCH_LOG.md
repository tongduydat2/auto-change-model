# Research Log: Antigravity Multi-Model Router

**Date:** 2026-04-12
**Goal:** Build undetectable per-subtask model routing system within Antigravity IDE

---

## 1. Architecture Overview

### Original Approaches Considered

| Approach | Description | Verdict |
|----------|-------------|---------|
| A. Internal RPC | VS Code extension calls Go binary RPC to switch model | ❌ Failed — model selection uses bidi stream, global state |
| B. External API | MCP tool calls Gemini/Claude API directly for subtasks | ✅ Recommended |
| C. Proxy intercept | MITM proxy between IDE and backend | ❌ Risky, detectable |

### Final Recommendation: Approach B (External API)
- Agent delegates subtasks to external model APIs (Gemini, Claude)
- Zero interaction with Antigravity internals
- Zero fingerprint risk, zero ToS risk
- Each subtask = independent API call with own context

---

## 2. Antigravity Internals — What We Learned

### 2.1 Go Binary (`language_server_linux_x64`)

**Process discovery:**
```bash
ps aux | grep language_server_linux | grep -v grep
# Extract: --csrf_token <TOKEN>
# Extract PID → ss -tlnp | grep "pid=<PID>,"  → listening ports
```

**Three port types:**
| Port Type | Protocol | Purpose |
|-----------|----------|---------|
| HTTPS port | TLS | gRPC to Codeium cloud |
| HTTP port | HTTP/ConnectRPC | Local RPC (IDE ↔ Go binary) |
| Extension server ports (x2) | HTTP/ConnectRPC | Per-window extension comm |

**Finding HTTP port:** Probe each port with `GetCascadeModelConfigData` — the one returning 200 is the HTTP port.

### 2.2 ConnectRPC Protocol

All RPCs use ConnectRPC (JSON over HTTP POST):
```
POST /exa.language_server_pb.LanguageServerService/<MethodName>
Headers:
  Content-Type: application/json
  Connect-Protocol-Version: 1
  x-codeium-csrf-token: <csrf_token>
Body: JSON payload
```

### 2.3 RPC Methods Tested

| Method | Status | Notes |
|--------|--------|-------|
| `GetCascadeModelConfigData` | ✅ 200 | Returns model list, quotas, current override |
| `SendActionToChatPanel` (LS port) | ❌ 400 | Wrong port — this is a passthrough |
| `SendActionToChatPanel` (ext port) | ✅ 200 | Works but only CLEARS model, can't SET |
| `SetUserSettings` | ❌ 501 | Not implemented |
| `InitializeCascadePanelState` | ❌ 501 | Not implemented |
| `SetChatModel` / `SelectModel` | ❌ 404 | Don't exist |

### 2.4 Model Selection Architecture (CRITICAL FINDING)

```
User clicks model selector in UI
    ↓
Webview sends postMessage to extension.js (action CHAT_CHANGE_MODEL = 18)
    ↓
Extension.js sends through BIDI STREAM (ChatClientServerService.StartChatClientRequestStream)
    ↓
Go binary updates state (defaultOverrideModelConfig)
    ↓
Go binary sends update back through bidi stream
    ↓
Extension.js forwards to webview → UI updates
```

**Key insight:** Model selection goes through a **bidirectional streaming RPC** (`ChatClientServerService`), NOT a unary RPC. External callers CANNOT join this stream.

### 2.5 Model Selection is GLOBAL

**CRITICAL:** When you change model in one window, ALL windows change.
- `defaultOverrideModelConfig` is stored in Go binary's global state
- All connected extension instances share this state
- Per-turn switch via RPC would break ALL other sessions

### 2.6 Proto Schema (Decoded from extension.js)

**ChatClientServerService (bidi stream):**
```protobuf
service ChatClientServerService {
  rpc StartChatClientRequestStream(StartChatClientRequestStreamRequest)
    returns (ChatClientRequest);  // bidi stream
}

message ChatClientRequest {
  oneof request {
    AddCascadeInputRequest add_cascade_input = 1;
    SendActionToChatPanelRequest send_action_to_chat_panel = 2;
    InitialAckRequest initial_ack = 3;
    RefreshCustomizationRequest refresh_customization = 4;
  }
}

message SendActionToChatPanelRequest {
  int32 action_type = 1;  // CHAT_CHANGE_MODEL = 18
  string payload = 2;     // model ID (format unclear)
}
```

**LanguageServerService (unary RPCs):**
```protobuf
message GetCascadeModelConfigDataResponse {
  repeated ClientModelConfig client_model_configs = 1;
  optional DefaultOverrideModelConfig default_override_model_config = 3;
}

message ClientModelConfig {
  string label = 1;
  ModelOrAlias model_or_alias = 2;
  bool supports_images = 3;
  bool is_recommended = 4;
  QuotaInfo quota_info = 5;
  repeated string allowed_tiers = 6;
}
```

### 2.7 Available Models (as of 2026-04-12)

| Label | Model ID | Quota |
|-------|----------|-------|
| Gemini 3 Flash | MODEL_PLACEHOLDER_M47 | 100% |
| Claude Sonnet 4.6 (Thinking) | MODEL_PLACEHOLDER_M35 | 60-80% |
| Claude Opus 4.6 (Thinking) | MODEL_PLACEHOLDER_M26 | 60-80% |
| GPT-OSS 120B (Medium) | MODEL_OPENAI_GPT_OSS_120B_MEDIUM | 60-80% |
| Gemini 3.1 Pro (High) | MODEL_PLACEHOLDER_M37 | 100% |
| Gemini 3.1 Pro (Low) | MODEL_PLACEHOLDER_M36 | 100% |

### 2.8 VS Code Extension Commands (Antigravity)

Registered dynamically (not in package.json):
```
antigravity.captureTraces
antigravity.endDemoMode
antigravity.handleAuthRefresh
antigravity.importWindsurfExtensions
antigravity.importWindsurfSettings
antigravity.killLanguageServerAndReloadWindow
antigravity.killRemoteExtensionHost
antigravity.onManagerTerminalCommandData/Start/Finish
antigravity.onShellCommandCompletion
antigravity.openPersistentLanguageServerLog
antigravity.resetOnboardingBackend
antigravity.simulateSegFault
antigravity.startDemoMode
antigravity.togglePersistentLanguageServer
antigravity.readTerminal
```
**No model-related commands exposed.**

### 2.9 Webview Action Enums

```javascript
e[e.CHAT_OPEN_SETTINGS=14]="CHAT_OPEN_SETTINGS"
e[e.CHAT_OPEN_CONTEXT_SETTINGS=15]="CHAT_OPEN_CONTEXT_SETTINGS"
e[e.CHAT_WITH_CODEBASE=16]="CHAT_WITH_CODEBASE"
e[e.CHAT_NEW_CONVERSATION=17]="CHAT_NEW_CONVERSATION"
e[e.CHAT_CHANGE_MODEL=18]="CHAT_CHANGE_MODEL"
e[e.CHAT_TOGGLE_FOCUS_INSERT_TEXT=34]="CHAT_TOGGLE_FOCUS_INSERT_TEXT"
```

---

## 3. What Was Built (Prototype)

### 3.1 VS Code Extension (`model-router/`)

**Files:**
- `src/types.ts` — Model ID mappings, TypeScript interfaces
- `src/discovery.ts` — Auto-discovers Go binary port + CSRF from process tree
- `src/rpc-client.ts` — ConnectRPC client for model queries
- `src/api-server.ts` — HTTP API server (port 18080) for MCP bridge
- `src/extension.ts` — Extension entry with model change monitor (3s poll)

**What works:**
- ✅ Process discovery (PID, port, CSRF)
- ✅ Model list query via `GetCascadeModelConfigData`
- ✅ Quota monitoring
- ✅ Model change detection (polling)
- ✅ HTTP API server for external tool calls

**What doesn't work:**
- ❌ Model switching (requires bidi stream, not unary RPC)
- ❌ Per-window model override (global state)

### 3.2 MCP Bridge (`mcp-bridge/`)

**Files:**
- `index.js` — stdio MCP server with 5 tools

**Tools defined:**
1. `get_current_model` — Get current model from RPC
2. `list_models` — List available models with quota
3. `request_model_switch` — Switch model (blocked by bidi stream issue)
4. `restore_model` — Restore original model
5. `delegate_subtask` — Delegate task to cheaper model

### 3.3 Build & Install

```bash
# Build extension
cd model-router
npm install
npx tsc -p ./
npx -y @vscode/vsce@latest package --no-dependencies --allow-missing-repository

# Install
antigravity-server --install-extension model-router-0.1.0.vsix --force

# Uninstall
antigravity-server --uninstall-extension undefined_publisher.model-router
```

---

## 4. Key Blockers & Why Approach A Failed

### Blocker 1: Bidi Stream
Model selection flows through `ChatClientServerService.StartChatClientRequestStream` — a bidirectional streaming RPC that the extension.js maintains. External callers cannot join or replicate this stream without implementing the full ChatClient protocol.

### Blocker 2: Global State
`defaultOverrideModelConfig` is shared across ALL connected windows. Switching model in one window affects all others. This makes per-turn switching unsafe in a multi-window setup.

### Blocker 3: Payload Format Unknown
Even on the extension server port where `SendActionToChatPanel` returned 200:
- `actionType: 18, payload: "MODEL_PLACEHOLDER_M47"` → cleared override, didn't SET
- All other payload formats had no effect
- The exact JSON structure for setting a specific model is undocumented

---

## 5. Next Steps: Approach B (External API)

### Architecture
```
Agent (Opus/Sonnet) → MCP Tool call → delegate_subtask()
                                          ↓
                                    MCP Bridge (Node.js)
                                          ↓
                                    External API call
                                    (Gemini API / Claude API)
                                          ↓
                                    Return result to agent
```

### Implementation Plan
1. **MCP Bridge** — Reuse `mcp-bridge/index.js`, replace extension HTTP calls with direct API calls
2. **API Keys** — Use Gemini API (free tier for Flash) or Claude API
3. **Tools** — Keep `delegate_subtask()`, remove switch/restore (not needed)
4. **No VS Code extension needed** — All logic in MCP bridge
5. **Safe** — No internal RPC, no ToS risk, no fingerprint

### Cost
- Gemini Flash: Free tier (15 RPM, 1M TPD)
- Claude Sonnet: ~$3/M input, $15/M output
- Per-subtask only (simple tasks) → minimal cost

---

## 6. Useful Commands Reference

```bash
# Discover Go binary
ps aux | grep language_server_linux | grep -v grep

# Extract CSRF and ports
CSRF=$(ps aux | grep language_server_linux | grep -v grep | grep -oP '\\-\\-csrf_token\\s+\\K\\S+')
PID=$(ps aux | grep language_server_linux | grep -v grep | awk '{print $2}' | head -1)
ss -tlnp | grep "pid=$PID,"

# Query current model (using Antigravity's bundled node)
NODE=/home/tongdat/.antigravity-server/bin/1.21.9-cc6cd32816d350ee4a1ea2b4694b43f749418957/node

# Get model config
curl -s http://127.0.0.1:<HTTP_PORT>/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData \
  -H "Content-Type: application/json" \
  -H "Connect-Protocol-Version: 1" \
  -H "x-codeium-csrf-token: $CSRF" \
  -d '{}' | python3 -m json.tool

# Extension server ports (per-window)
ps aux | grep language_server_linux | grep -oP 'extension_server_port\\s+\\d+\\s+--extension_server_csrf_token\\s+\\S+'
```

---

## 7. File Structure (Current)

```
auto-change-model/
├── RESEARCH_LOG.md          ← This file
├── README.md
├── model-router/            ← VS Code extension (prototype, not installable)
│   ├── package.json
│   ├── tsconfig.json
│   ├── .vscodeignore
│   └── src/
│       ├── types.ts         ← Model IDs, interfaces
│       ├── discovery.ts     ← Process discovery logic (reusable)
│       ├── rpc-client.ts    ← ConnectRPC client (reusable)
│       ├── api-server.ts    ← HTTP API for MCP bridge
│       └── extension.ts     ← Extension entry + model monitor
└── mcp-bridge/              ← MCP server (needs rework for Approach B)
    ├── package.json
    └── index.js             ← 5 MCP tools
```
