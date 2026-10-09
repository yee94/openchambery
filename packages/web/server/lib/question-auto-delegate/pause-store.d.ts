export interface QuestionPauseStore {
  has(requestID: string, sessionID: string): boolean;
  pause(requestID: string, sessionID: string): void;
  remove(requestID: string, sessionID: string): void;
}

export function createQuestionPauseStore(directory?: string): QuestionPauseStore;
