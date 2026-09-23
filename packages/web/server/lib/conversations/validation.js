const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'input', 'directory', 'messageID', 'model', 'parts',
  'title', 'parentID', 'agent', 'variant', 'metadata', 'skills',
]);
const ALLOWED_PART_TYPES = new Set(['text', 'file', 'agent']);

const validateNonEmptyString = (value, label) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${label} must be a non-empty string`;
  }
  return null;
};

const asOptionalNonEmptyString = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asOptionalObject = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
};

const validateTextPart = (part) => {
  if (typeof part.text !== 'string' || part.text.trim().length === 0) {
    return 'Text part must have a non-empty "text" string field';
  }
  const sanitized = { type: 'text', text: part.text };
  if (typeof part.synthetic === 'boolean') sanitized.synthetic = part.synthetic;
  if (typeof part.ignored === 'boolean') sanitized.ignored = part.ignored;
  if (typeof part.id === 'string') sanitized.id = part.id;
  if (part.time && typeof part.time === 'object' && !Array.isArray(part.time)) sanitized.time = part.time;
  if (part.metadata && typeof part.metadata === 'object' && !Array.isArray(part.metadata)) sanitized.metadata = part.metadata;
  return { error: null, sanitized };
};

const validateFilePart = (part) => {
  if (typeof part.mime !== 'string' || part.mime.trim().length === 0) return 'File part must have a non-empty "mime" string field';
  if (typeof part.url !== 'string' || part.url.trim().length === 0) return 'File part must have a non-empty "url" string field';
  const sanitized = { type: 'file', mime: part.mime, url: part.url };
  if (typeof part.filename === 'string') sanitized.filename = part.filename;
  if (typeof part.id === 'string') sanitized.id = part.id;
  if (part.source && typeof part.source === 'object' && !Array.isArray(part.source)) sanitized.source = part.source;
  return { error: null, sanitized };
};

const validateAgentPart = (part) => {
  if (typeof part.name !== 'string' || part.name.trim().length === 0) return 'Agent part must have a non-empty "name" string field';
  const sanitized = { type: 'agent', name: part.name };
  if (typeof part.id === 'string') sanitized.id = part.id;
  if (part.source && typeof part.source === 'object' && !Array.isArray(part.source)) sanitized.source = part.source;
  return { error: null, sanitized };
};

const validatePartShape = (part) => {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return 'Each part must be an object';
  }
  if (typeof part.type !== 'string' || !ALLOWED_PART_TYPES.has(part.type)) {
    return `Part type must be one of: ${Array.from(ALLOWED_PART_TYPES).join(', ')}`;
  }
  switch (part.type) {
    case 'text': return validateTextPart(part);
    case 'file': return validateFilePart(part);
    case 'agent': return validateAgentPart(part);
    default: return `Unsupported part type: ${part.type}`;
  }
};

const validateModelRef = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${label} must be an object with providerID and modelID`;
  }
  if (typeof value.providerID !== 'string' || value.providerID.trim().length === 0) {
    return `${label}.providerID must be a non-empty string`;
  }
  if (typeof value.modelID !== 'string' || value.modelID.trim().length === 0) {
    return `${label}.modelID must be a non-empty string`;
  }
  return null;
};

export const validateConversationInput = (body) => {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  // Reject unknown top-level keys that would alter semantics
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`Unknown field "${key}" is not allowed`);
    }
  }

  // input.type
  if (!body.input || typeof body.input !== 'object') {
    errors.push('input must be an object');
  } else if (body.input.type !== 'prompt') {
    errors.push('input.type must be "prompt"');
  }

  // directory (required)
  const dirErr = validateNonEmptyString(body.directory, 'directory');
  if (dirErr) errors.push(dirErr);

  // messageID (required)
  const messageIDErr = validateNonEmptyString(body.messageID, 'messageID');
  if (messageIDErr) errors.push(messageIDErr);

  // model (required)
  const modelErr = validateModelRef(body.model, 'model');
  if (modelErr) errors.push(modelErr);

  // parts (required, at least one content-carrying part)
  const sanitizedParts = [];
  if (!Array.isArray(body.parts)) {
    errors.push('parts must be an array');
  } else if (body.parts.length === 0) {
    errors.push('parts must contain at least one part');
  } else {
    for (let i = 0; i < body.parts.length; i++) {
      const result = validatePartShape(body.parts[i]);
      if (typeof result === 'string') {
        errors.push(`parts[${i}]: ${result}`);
      } else if (result.error) {
        errors.push(`parts[${i}]: ${result.error}`);
      } else {
        sanitizedParts.push(result.sanitized);
      }
    }
    if (errors.length === 0 && !sanitizedParts.some((p) => p.type === 'text' || p.type === 'file' || p.type === 'agent')) {
      errors.push('parts must contain at least one content-carrying part (text, file, or agent)');
    }
  }

  // Optional fields
  let skills;
  if (body.skills !== undefined) {
    if (!Array.isArray(body.skills) || body.skills.some((skill) =>
      !skill || typeof skill.id !== 'string' || !skill.id.trim())) {
      errors.push('skills must be an array of non-empty skill ids');
    } else {
      skills = body.skills.map((skill) => ({ id: skill.id }));
    }
  }
  const title = asOptionalNonEmptyString(body.title);
  if (title === null) errors.push('title must be a non-empty string if provided');

  const parentID = asOptionalNonEmptyString(body.parentID);
  if (parentID === null) errors.push('parentID must be a non-empty string if provided');

  const agent = asOptionalNonEmptyString(body.agent);
  if (agent === null) errors.push('agent must be a non-empty string if provided');

  const variant = asOptionalNonEmptyString(body.variant);
  if (variant === null) errors.push('variant must be a non-empty string if provided');

  const metadata = asOptionalObject(body.metadata);
  if (metadata === null) errors.push('metadata must be an object if provided');

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    sanitized: {
      directory: body.directory.trim(),
      messageID: body.messageID.trim(),
      model: {
        providerID: body.model.providerID.trim(),
        modelID: body.model.modelID.trim(),
      },
      parts: sanitizedParts,
      ...(skills?.length ? { skills } : {}),
      title,
      parentID,
      agent,
      variant,
      metadata,
    },
  };
};
