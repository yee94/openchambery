import { createHash } from 'node:crypto';
import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// All local hosts share this boundary, including desktop and VS Code. Form and
// session IDs are globally unique upstream identities; no URL or credential is stored.
export function createQuestionPauseStore(directory = process.env.OPENCHAMBER_QUESTION_PAUSE_DIR
  || join(homedir(), '.config', 'openchamber', 'question-pauses')) {
  const pathFor = (requestID, sessionID) => join(directory,
    createHash('sha256').update(JSON.stringify([sessionID, requestID])).digest('hex'));
  return {
    has(requestID, sessionID) {
      try {
        statSync(pathFor(requestID, sessionID));
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
    pause(requestID, sessionID) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        // Exclusive creation publishes an immutable hold atomically across processes.
        writeFileSync(pathFor(requestID, sessionID), '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    },
    remove(requestID, sessionID) {
      try {
        unlinkSync(pathFor(requestID, sessionID));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}
