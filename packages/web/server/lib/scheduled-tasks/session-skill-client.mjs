import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const scheduledTaskSkillCommand = (executable, script, encoded, operation) => {
  const args = [executable, script, encoded, operation];
  if (process.platform === 'win32') {
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const ps = `$env:ELECTRON_RUN_AS_NODE='1'; & ${args.map(quote).join(' ')}`;
    return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
  }
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `ELECTRON_RUN_AS_NODE=1 ${args.map(quote).join(' ')}`;
};

async function main() {
  let taskID;
  let input;
  try {
    const [encoded, operation] = process.argv.slice(2);
    const binding = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const operations = ['list', 'get', 'create', 'update', 'pause', 'resume', 'delete'];
    if (!['check', 'describe', ...operations].includes(operation)) throw new Error('Invalid operation');
    const origin = new URL(binding.hostOrigin);
    if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Invalid Host binding');
    const registration = JSON.parse(await readFile(binding.registrationFile, 'utf8'));
    if (new URL(registration.url).origin !== binding.upstreamOrigin || typeof registration.password !== 'string' || !registration.password) {
      throw new Error('OpenCode service binding changed');
    }
    if (operations.includes(operation) && !(operation === 'list' && process.stdin.isTTY)) {
      let text = '';
      for await (const chunk of process.stdin) {
        text += chunk;
        if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Task input exceeds 64 KiB');
      }
      input = text.trim() ? JSON.parse(text) : {};
      taskID = operation === 'create' ? randomUUID() : input.taskId;
    }
    const response = await fetch(new URL('/api/yuri/session-skills/scheduled-task', origin), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}`,
      },
      body: JSON.stringify({ sessionID: binding.sessionID, operation, ...(input ? { input, taskID } : {}) }),
    });
    const result = await response.json();
    if (!response.ok) {
      // Only Host-owned codes cross this boundary. Neither credentials nor raw
      // upstream errors, response bodies or task prompts are printed.
      throw new Error(`Scheduled task API HTTP ${response.status}`);
    }
    if (['create', 'update', 'pause', 'resume'].includes(operation)) {
      if (result.task?.id !== taskID || (operation === 'create' && result.created !== true) || typeof result.schedulerSynced !== 'boolean') throw new Error('Incomplete mutation result');
      const { id, name, enabled, schedule, state } = result.task;
      console.log(JSON.stringify({ projectId: result.projectId, task: { id, name, enabled, schedule, nextRunAt: state?.nextRunAt }, schedulerSynced: result.schedulerSynced }));
    } else if (operation === 'list') {
      if (!Array.isArray(result.tasks) || !Array.isArray(result.failedProjectIds)) throw new Error('Incomplete task list');
      console.log(JSON.stringify({ tasks: result.tasks.map(({ id, projectId, own, currentProject, name, enabled, schedule, state }) => ({ id, projectId, own, currentProject, name, enabled, schedule, nextRunAt: state?.nextRunAt })), failedProjectIds: result.failedProjectIds }));
    } else if (operation === 'get') {
      if (result.task?.id !== taskID) throw new Error('Incomplete task result');
      console.log(JSON.stringify({ projectId: result.projectId, task: result.task }));
    } else if (operation === 'delete') {
      if (result.deleted !== true || result.taskId !== taskID || typeof result.schedulerSynced !== 'boolean') throw new Error('Incomplete mutation result');
      console.log(JSON.stringify({ projectId: result.projectId, taskId: taskID, deleted: true, schedulerSynced: result.schedulerSynced }));
    } else if (operation === 'describe') {
      console.log(JSON.stringify({ ...result, commands: Object.fromEntries(operations.map((op) => [op, scheduledTaskSkillCommand(process.execPath, process.argv[1], encoded, op)])) }));
    } else {
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    const message = typeof error?.message === 'string' && /^(Scheduled task API HTTP \d+|Incomplete (mutation result|task result|task list)|OpenCode service binding changed|Invalid (operation|Host binding)|Task input exceeds 64 KiB)$/.test(error.message)
      ? error.message : 'Built-in scheduled task connection failed';
    console.error(JSON.stringify({ error: message, ...(taskID ? { taskID, projectId: input?.projectId, recovery: 'Result not confirmed. Use the bound list/get commands to check this ID; do not blindly retry.' } : {}) }));
    process.exitCode = 1;
  }
}

let directEntry = false;
try {
  directEntry = Boolean(process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url);
} catch {
  // Electron launch flags and eval callers need not supply a script filename.
}
if (directEntry) await main();
