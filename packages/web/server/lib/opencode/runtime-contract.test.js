import { describe, expect, it } from 'vitest';
import {
  RUNTIME_CONTRACT_MIN_VERIFIED,
  classifyRuntimeVersionBand,
  createRevokedRuntimeContract,
  evaluateRuntimeContract,
  formatRuntimeContractBlockedError,
  isRuntimeContractDiagnosticPath,
  isRuntimeContractExecutionPath,
  runtimeContractExecutionBlockedBody,
  shouldBlockRuntimeContractExecution,
  versionMeetsMinimum,
} from './runtime-contract.js';

describe('runtime contract admission (ticket 11)', () => {
  it('records minimum verified bound from pin', () => {
    expect(RUNTIME_CONTRACT_MIN_VERIFIED).toBe('2.0.12');
  });

  it('classifies version bands with a 2.x floor only', () => {
    expect(classifyRuntimeVersionBand('2.0.12')).toBe('verified');
    expect(classifyRuntimeVersionBand('2.0.14')).toBe('verified');
    expect(classifyRuntimeVersionBand('2.0.15')).toBe('verified');
    expect(classifyRuntimeVersionBand('2.1.0')).toBe('verified');
    expect(classifyRuntimeVersionBand('2.0.5')).toBe('below-min');
    expect(classifyRuntimeVersionBand('1.18.18')).toBe('1x');
    expect(classifyRuntimeVersionBand('not-a-version')).toBe('invalid');
    expect(classifyRuntimeVersionBand(null)).toBe('unknown');
  });

  it('admits verified serve for core protocol and optional caps', () => {
    const result = evaluateRuntimeContract({
      serveVersion: '2.0.12',
      cliVersion: '2.0.12',
      reachable: true,
      authenticated: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    expect(result.phase).toBe('ready');
    expect(result.protocolCompatible).toBe(true);
    expect(result.executionAllowed).toBe(true);
    expect(result.capabilities['core.protocol'].available).toBe(true);
    expect(result.capabilities['session.queuedInput'].available).toBe(true);
    expect(result.capabilities['session.background'].available).toBe(true);
    expect(result.capabilities['session.generationFallback'].available).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('limits older 2.x and keeps diagnostic dimensions explicit', () => {
    const result = evaluateRuntimeContract({
      serveVersion: '2.0.5',
      cliVersion: '2.0.5',
      reachable: true,
      authenticated: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    expect(result.phase).toBe('incompatible');
    expect(result.protocolCompatible).toBe(false);
    expect(result.executionAllowed).toBe(false);
    expect(result.reasons).toContain('below-min-verified');
    expect(result.capabilities['core.protocol'].available).toBe(false);
  });

  it('admits newer 2.x above the documented floor for execution', () => {
    const result = evaluateRuntimeContract({
      serveVersion: '2.0.15',
      reachable: true,
      authenticated: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    expect(result.versionBand).toBe('verified');
    expect(result.phase).toBe('ready');
    expect(result.protocolCompatible).toBe(true);
    expect(result.executionAllowed).toBe(true);
    expect(result.capabilities['core.protocol'].available).toBe(true);
    expect(result.maxVerifiedVersion).toBeNull();
  });

  it('rejects 1.x and unparseable versions for execution', () => {
    const oneX = evaluateRuntimeContract({
      serveVersion: '1.18.18',
      reachable: true,
      authenticated: true,
      healthOk: true,
    });
    expect(oneX.phase).toBe('incompatible');
    expect(oneX.executionAllowed).toBe(false);
    expect(oneX.reasons).toContain('1x-version');

    const bad = evaluateRuntimeContract({
      serveVersion: 'totally-bogus',
      reachable: true,
      authenticated: true,
      healthOk: true,
    });
    expect(bad.phase).toBe('unknown');
    expect(bad.executionAllowed).toBe(false);
  });

  it('separates auth failure, unreachable, migration block, and cli/serve mismatch', () => {
    expect(evaluateRuntimeContract({ reachable: false }).phase).toBe('unreachable');
    expect(evaluateRuntimeContract({
      reachable: true,
      authenticated: false,
      serveVersion: '2.0.12',
      healthOk: true,
    }).phase).toBe('unauthenticated');

    const migration = evaluateRuntimeContract({
      serveVersion: '2.0.12',
      reachable: true,
      authenticated: true,
      healthOk: true,
      migrationAdmitTranscript: false,
      migrationPhase: 'running',
    });
    expect(migration.phase).toBe('migration-blocked');
    expect(migration.executionAllowed).toBe(false);
    expect(migration.migrationExecutable).toBe(false);

    const mismatch = evaluateRuntimeContract({
      serveVersion: '2.0.12',
      cliVersion: '2.0.14',
      reachable: true,
      authenticated: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    expect(mismatch.versionMismatch).toBe(true);
    expect(mismatch.reasons).toContain('cli-serve-version-mismatch');
    // Mismatch is diagnostic; admission still follows serve version.
    expect(mismatch.executionAllowed).toBe(true);
  });

  it('classifies diagnostic vs execution proxy paths', () => {
    expect(isRuntimeContractDiagnosticPath('GET', '/api/info')).toBe(true);
    expect(isRuntimeContractDiagnosticPath('GET', '/api/health')).toBe(true);
    expect(isRuntimeContractDiagnosticPath('POST', '/api/info')).toBe(false);
    expect(isRuntimeContractExecutionPath('POST', '/api/session/ses_1/prompt')).toBe(true);
    expect(isRuntimeContractExecutionPath('POST', '/api/session/ses_1/prompt_async')).toBe(true);
    expect(isRuntimeContractExecutionPath('GET', '/api/session/ses_1/message')).toBe(false);
    // Stop-task remains available when execution is limited.
    expect(isRuntimeContractExecutionPath('POST', '/api/session/ses_1/interrupt')).toBe(false);
    expect(isRuntimeContractExecutionPath('POST', '/api/session/ses_1/abort')).toBe(false);
    expect(versionMeetsMinimum('2.0.14', '2.0.12')).toBe(true);
    expect(versionMeetsMinimum('2.0.1', '2.0.12')).toBe(false);
  });

  it.each([
    '/api/session/ses_1/generate',
    '/api/session/ses_1/background',
    '/api/session/ses_1/inbox/msg_1/steer',
    '/api/session/ses_1/inbox/msg_1/queue',
    '/api/session/ses_1/form/form_1/reply',
    '/api/session/ses_1/model',
    '/api/session/ses_1/agent',
  ])('limits the execution control endpoint %s for an unverified runtime', (path) => {
    expect(shouldBlockRuntimeContractExecution('POST', path, { executionAllowed: false })).toBe(true);
    expect(shouldBlockRuntimeContractExecution('POST', path, { executionAllowed: true })).toBe(false);
    expect(shouldBlockRuntimeContractExecution('GET', path, { executionAllowed: false })).toBe(false);
  });

  it('keeps stopping and cancelling pending work available under limited execution', () => {
    const contract = { executionAllowed: false };
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/interrupt', contract)).toBe(false);
    expect(shouldBlockRuntimeContractExecution('DELETE', '/api/session/ses_1/inbox/msg_1', contract)).toBe(false);
    expect(shouldBlockRuntimeContractExecution('PATCH', '/api/session/ses_1/inbox/msg_1', contract)).toBe(true);
  });

  it('exposes upgrade guidance in blocked execution responses for below-min serve', () => {
    const contract = evaluateRuntimeContract({
      serveVersion: '2.0.5',
      reachable: true,
      authenticated: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    const body = runtimeContractExecutionBlockedBody(contract);
    expect(body.error).toContain('2.0.12');
    expect(body.error).toMatch(/Settings → About/i);
    expect(formatRuntimeContractBlockedError(contract)).toBe(body.error);
  });

  it('production default blocks execution when contract is null (no silent bypass)', () => {
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/prompt', null)).toBe(true);
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/prompt', undefined)).toBe(true);
    expect(shouldBlockRuntimeContractExecution('GET', '/api/session/ses_1/message', null)).toBe(false);
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/interrupt', null)).toBe(false);
  });

  it('requires explicit executionAllowed === true (pending / undefined still block)', () => {
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/prompt', { executionAllowed: true })).toBe(false);
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/prompt', {})).toBe(true);
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/prompt', { executionAllowed: false })).toBe(true);
    const revoked = createRevokedRuntimeContract('instance-revoked', { instanceGeneration: 3 });
    expect(revoked.executionAllowed).toBe(false);
    expect(revoked.phase).toBe('pending');
    expect(revoked.instanceGeneration).toBe(3);
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/prompt', revoked)).toBe(true);
  });

  it('DI factory may allow missing contract only when explicitly opted in', () => {
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/prompt', null, {
      allowMissingContract: true,
    })).toBe(false);
    // Opt-in does not open denied contracts.
    expect(shouldBlockRuntimeContractExecution('POST', '/api/session/ses_1/prompt', {
      executionAllowed: false,
    }, { allowMissingContract: true })).toBe(true);
  });
});
