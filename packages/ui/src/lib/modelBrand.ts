/**
 * 模型品牌图标匹配（对齐 agent-tracker resolveModelIconUrl）
 * 聚合 Provider 下按模型名识别品牌，不再依赖固定 Provider ID。
 */

/** 可识别的品牌 token（长名优先排序后用于匹配） */
const MODEL_BRAND_BASE = [
  'claudecodeinternal',
  'codexinternal',
  'codebuddy',
  'geminicli',
  'claude',
  'composer',
  'cursor',
  'deepseek',
  'doubao',
  'gemini',
  'gemma',
  'glm',
  'gpt',
  'grok',
  'hunyuan',
  'hy',
  'imate',
  'kimi',
  'knot',
  'longcat',
  'minimax',
  'mistral',
  'llama',
  'qwen',
  'seed',
  'tapd',
  'with',
  'yuanbao',
  'claw',
  'echo',
  'gongfeng',
  'ernie',
  'baichuan',
] as const;

const MODEL_BRAND_NAMES = [...MODEL_BRAND_BASE].sort((a, b) => b.length - a.length);

/** 品牌别名 → 已有图标文件名（对齐 model-id / 定价族） */
const MODEL_BRAND_ALIASES: Record<string, string> = {
  hy3: 'hy',
  hunyuan3: 'hy',
  hunyuan: 'hy',
  moonshot: 'kimi',
  anthropic: 'claude',
  openai: 'gpt',
  chatgpt: 'gpt',
  codex: 'gpt',
  xai: 'grok',
  google: 'gemini',
  aliyun: 'qwen',
  dashscope: 'qwen',
  zhipu: 'glm',
  zhipuai: 'glm',
  'z-ai': 'glm',
  zai: 'glm',
  zaicodingplan: 'glm',
  zhipuaicodingplan: 'glm',
  tencent: 'hy',
  meta: 'llama',
  'meta-llama': 'llama',
};

/** 渠道后缀（剥除后再匹配） */
const MODEL_CHANNEL_SUFFIXES = [
  '-volc-ioa',
  '-ioa',
  '-official',
  '-external',
  '-internal',
  '-preview',
] as const;

/** 品牌 → 本地 model-icons / provider-logos 候选 ID */
const BRAND_LOGO_CANDIDATES: Record<string, readonly string[]> = {
  claude: ['claude', 'anthropic'],
  gpt: ['gpt', 'openai'],
  gemini: ['google', 'gemini'],
  gemma: ['google', 'gemma', 'gemini'],
  grok: ['grok'],
  kimi: ['kimi'],
  glm: ['zai-coding-plan', 'zhipuai-coding-plan', 'glm'],
  qwen: ['qwen'],
  hy: ['hunyuan', 'hy'],
  hunyuan: ['hunyuan', 'hy'],
  deepseek: ['deepseek'],
  minimax: ['minimax'],
  doubao: ['doubao'],
  longcat: ['longcat'],
  seed: ['seed'],
  cursor: ['cursor', 'composer'],
  composer: ['cursor', 'composer'],
};

const normalizeModelKey = (name: string | null | undefined): string => {
  return String(name || '')
    .trim()
    .toLowerCase();
};

/** 去掉非字母数字，便于子串匹配（claude-3-5-sonnet → claude35sonnet） */
const stripModelName = (name: string | null | undefined): string => {
  return normalizeModelKey(name).replace(/[^a-z0-9]/g, '');
};

/**
 * 对齐 shared canonicalizeModelId：剥渠道后缀 / 上下文窗口标记后再匹配品牌
 */
export const canonicalizeModelForBrand = (model: string | null | undefined): string => {
  let current = normalizeModelKey(model)
    .replace(/[._]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of MODEL_CHANNEL_SUFFIXES) {
      if (current.endsWith(suffix) && current.length > suffix.length) {
        current = current.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }

  // 剥上下文窗口标记（-1m / -200k 等以 m 结尾的）
  if (/(^|-)\d+m$/.test(current)) {
    current = current.replace(/-\d+m$/, '');
  }

  if (MODEL_BRAND_ALIASES[current]) {
    return MODEL_BRAND_ALIASES[current];
  }

  // hy3 / hunyuan-3 等短别名
  if (current === 'hy3' || current === 'hunyuan-3' || current === 'hunyuan3') {
    return 'hy';
  }

  return current;
};

/**
 * 对已 strip 的 key 做三级模糊匹配：子串包含 → 反向包含 → 最长公共前缀
 */
const matchBrandFromStripped = (stripped: string): string | null => {
  if (!stripped) return null;
  const key = stripped.toLowerCase();

  for (const brand of MODEL_BRAND_NAMES) {
    if (key.includes(brand)) return brand;
  }

  if (key.length >= 3) {
    for (const brand of MODEL_BRAND_NAMES) {
      if (brand.includes(key)) return brand;
    }
  }

  let best: string | null = null;
  let bestLen = 0;
  for (const brand of MODEL_BRAND_NAMES) {
    let prefixLen = 0;
    const minLen = Math.min(key.length, brand.length);
    for (let i = 0; i < minLen; i++) {
      if (key[i] !== brand[i]) break;
      prefixLen++;
    }
    if (prefixLen >= 3 && prefixLen > bestLen) {
      bestLen = prefixLen;
      best = brand;
    }
  }
  return best;
};

const applyBrandAlias = (brand: string): string => {
  return MODEL_BRAND_ALIASES[brand] || brand;
};

/**
 * 从模型名（优先）+ Provider 名（兜底）解析品牌 ID。
 * 例：openrouter + claude-sonnet-4-5 → claude；boxai + glm-5.2-ioa → glm
 */
export const resolveModelBrand = (
  modelName: string | null | undefined,
  providerName?: string | null,
): string | null => {
  const keys: string[] = [];
  const canonical = canonicalizeModelForBrand(modelName);
  const modelKey = stripModelName(canonical);
  const rawKey = stripModelName(modelName);
  const providerKey = stripModelName(providerName);

  if (modelKey) keys.push(modelKey);
  if (rawKey && rawKey !== modelKey) keys.push(rawKey);
  if (providerKey) keys.push(providerKey);
  if (modelKey && providerKey) {
    keys.push(providerKey + modelKey, modelKey + providerKey);
  }

  for (const stripped of keys) {
    const brand = matchBrandFromStripped(stripped);
    if (brand) return applyBrandAlias(brand);
  }

  // o 系列（o3 / o4-mini）归到 gpt
  if (/(^|-)o\d/.test(canonical) || /^o\d/.test(modelKey)) {
    return 'gpt';
  }

  // Provider 别名直接命中（anthropic / openai / google …）
  if (providerKey && MODEL_BRAND_ALIASES[providerKey]) {
    return MODEL_BRAND_ALIASES[providerKey];
  }

  return null;
};

/**
 * 品牌对应的本地 logo 查找候选（model-icons / provider-logos）
 * 按候选表顺序查找；表外品牌交由通用 fallback 展示
 */
export const getModelBrandLogoCandidates = (brand: string | null | undefined): string[] => {
  if (!brand) return [];
  const mapped = applyBrandAlias(brand);
  const extras = BRAND_LOGO_CANDIDATES[mapped];
  return extras ? [...new Set(extras.filter(Boolean))] : [];
};
