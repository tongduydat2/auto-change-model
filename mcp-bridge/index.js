#!/usr/bin/env node

/**
 * MCP Bridge — Thin stdio MCP server that forwards tool calls
 * to the Model Router VS Code extension's HTTP API.
 * 
 * This runs as a separate process spawned by the IDE,
 * but the actual RPC calls are made by the extension (same PID as Antigravity).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "http://127.0.0.1:18080";

// Helpers
async function apiCall(path, body = null) {
  const opts = {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${path} failed (${res.status}): ${err}`);
  }
  return res.json();
}

// Server setup
const server = new Server(
  { name: "model-router", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_current_model",
      description: "Get the currently selected model in the IDE",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_models",
      description:
        "List all available models with quota info. Use this to see what models are available before switching.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "request_model_switch",
      description:
        "Switch to a different model for the next response. Saves the current model for auto-restore. " +
        "Use friendly names: flash, sonnet, opus, gemini-pro-high, gemini-pro-low, gpt-oss. " +
        "IMPORTANT: Always call restore_model() after you're done with the switched model.",
      inputSchema: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description:
              "Model name: flash (simple tasks), sonnet (debug/code), opus (architecture), gemini-pro-high, gemini-pro-low, gpt-oss",
          },
        },
        required: ["model"],
      },
    },
    {
      name: "restore_model",
      description:
        "Restore the original model that was active before request_model_switch was called. " +
        "ALWAYS call this after using request_model_switch.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "delegate_subtask",
      description:
        "Delegate a simple subtask to a cheaper model. The subtask runs on the specified model, " +
        "and the result is returned to you. Your current model is NOT changed. " +
        "Use for: summarize, explain, list, format, translate, simple Q&A. " +
        "Do NOT delegate: complex reasoning, architecture, security analysis.",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The subtask to delegate (clear, self-contained instruction)",
          },
          model: {
            type: "string",
            description: "Model for the subtask: flash (recommended for simple tasks), sonnet, opus",
            default: "flash",
          },
          context: {
            type: "string",
            description: "Optional context to include with the subtask",
          },
        },
        required: ["task"],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "get_current_model":
        result = await apiCall("/current-model");
        break;

      case "list_models":
        result = await apiCall("/models");
        break;

      case "request_model_switch":
        result = await apiCall("/switch-model", { model: args.model });
        break;

      case "restore_model":
        result = await apiCall("/restore-model");
        break;

      case "delegate_subtask":
        result = await apiCall("/delegate", {
          task: args.task,
          model: args.model || "flash",
          context: args.context || "",
        });
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
