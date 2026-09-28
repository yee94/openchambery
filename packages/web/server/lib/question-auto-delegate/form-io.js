/** Native OpenCode form IO shared by Web and the VS Code host. */
export function createQuestionFormIO(upstream) {
  const formPath = (sessionID, requestID) => {
    if (!sessionID) throw new Error('Question form requires a sessionID');
    return `/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(requestID)}`;
  };
  return {
    async listQuestions(directory) {
      const result = await upstream('/form', { directory });
      if (!result.ok) return null;
      const rows = result.body?.data;
      if (!Array.isArray(rows)) return null;
      return rows.filter((form) => form?.metadata?.kind === 'question');
    },
    async postReply(requestID, directory, answers, sessionID) {
      const path = formPath(sessionID, requestID);
      const result = await upstream(path, { directory });
      // A failed schema read never means the answer POST was dispatched.
      if (!result.ok) return { ...result, notSent: true, uncertain: false };
      const form = result.body?.data;
      if (form?.id !== requestID || form?.sessionID !== sessionID
        || form.metadata?.kind !== 'question' || !Array.isArray(form.fields) || !form.fields.length) {
        throw new Error('Invalid question form schema');
      }
      const answer = Object.fromEntries(form.fields.map((field, index) => {
        if (!field.key || (field.type !== 'string' && field.type !== 'multiselect')) {
          throw new Error('Unsupported question form field');
        }
        const values = (answers[index] ?? []).map((value) =>
          field.options?.find((option) => (option.label || option.value) === value)?.value ?? value);
        return [field.key, field.type === 'multiselect' ? values : values[0] ?? ''];
      }));
      return upstream(`${path}/reply`, { directory, method: 'POST', body: { answer } });
    },
    async postReject(requestID, directory, _body, sessionID) {
      return upstream(`${formPath(sessionID, requestID)}/cancel`, { directory, method: 'POST' });
    },
  };
}
