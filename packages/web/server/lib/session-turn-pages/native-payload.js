/** HTTP-only projection of provider replay data. Business input/output is opaque. */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const withoutNative = (value) => {
  if (!isRecord(value) || !Object.hasOwn(value, 'native')) return value;
  const next = { ...value };
  delete next.native;
  return next;
};

const projectMessage = (value) => {
  if (!isRecord(value)) return value;
  let next = withoutNative(value);
  if (Array.isArray(value.content)) {
    const content = value.content.map(withoutNative);
    if (content.some((item, index) => item !== value.content[index])) next = { ...next, content };
  }
  // Exact responses may already wrap the message in { info, parts }.
  if (isRecord(value.info)) {
    const info = projectMessage(value.info);
    if (info !== value.info) next = { ...next, info };
  }
  return next;
};

/** Strip only message.native and message.content[].native; preserve envelope/cursors. */
export const stripSessionMessageNativePayload = (payload) => {
  if (Array.isArray(payload)) {
    const next = payload.map(projectMessage);
    return next.some((item, index) => item !== payload[index]) ? next : payload;
  }
  if (!isRecord(payload)) return payload;
  if (Array.isArray(payload.data)) {
    const data = stripSessionMessageNativePayload(payload.data);
    return data === payload.data ? payload : { ...payload, data };
  }
  return projectMessage(payload);
};
