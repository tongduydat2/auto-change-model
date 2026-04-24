export interface ConnectionInfo {
  port: number;
  csrf: string;
  pid: number;
}

export interface ModelInfo {
  label: string;
  modelId: string;
  supportsImages: boolean;
  quotaRemaining: number;
  quotaResetTime: string;
}

export interface ModelConfigData {
  clientModelConfigs: Array<{
    label: string;
    modelOrAlias: { model?: string; alias?: string };
    supportsImages?: boolean;
    isRecommended?: boolean;
    quotaInfo?: { remainingFraction: number; resetTime: string };
    allowedTiers?: string[];
  }>;
  defaultOverrideModelConfig?: {
    modelOrAlias: { model?: string };
  };
}

// Friendly name → Model ID mapping
export const MODEL_MAP: Record<string, string> = {
  'flash':          'MODEL_PLACEHOLDER_M47',
  'gemini-3-flash': 'MODEL_PLACEHOLDER_M47',
  'sonnet':         'MODEL_PLACEHOLDER_M35',
  'claude-sonnet':  'MODEL_PLACEHOLDER_M35',
  'opus':           'MODEL_PLACEHOLDER_M26',
  'claude-opus':    'MODEL_PLACEHOLDER_M26',
  'gemini-pro-high':'MODEL_PLACEHOLDER_M37',
  'gemini-pro-low': 'MODEL_PLACEHOLDER_M36',
  'gpt-oss':        'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
};

// Reverse mapping
export const MODEL_LABELS: Record<string, string> = {
  'MODEL_PLACEHOLDER_M47': 'Gemini 3 Flash',
  'MODEL_PLACEHOLDER_M35': 'Claude Sonnet 4.6 (Thinking)',
  'MODEL_PLACEHOLDER_M26': 'Claude Opus 4.6 (Thinking)',
  'MODEL_PLACEHOLDER_M37': 'Gemini 3.1 Pro (High)',
  'MODEL_PLACEHOLDER_M36': 'Gemini 3.1 Pro (Low)',
  'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 'GPT-OSS 120B (Medium)',
};
