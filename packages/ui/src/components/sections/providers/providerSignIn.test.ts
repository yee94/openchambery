import { describe, expect, it } from 'vitest';
import {
  consoleAccountConnected,
  findSignInIntegration,
  getSignInIntegrationId,
  methodsForSignIn,
  signInIntegrationIdForOAuth,
  signInOAuthMethods,
} from './providerSignIn';

describe('getSignInIntegrationId', () => {
  it('maps OpenCode Go sign-in to the Console integration', () => {
    expect(getSignInIntegrationId('opencode-go')).toBe('opencode');
    expect(getSignInIntegrationId('opencode')).toBe('opencode');
    expect(getSignInIntegrationId('openai')).toBe('openai');
  });

  it('treats only a Console OAuth grant as Go credentials', () => {
    expect(consoleAccountConnected({
      id: 'opencode',
      connections: [{ type: 'credential', method: 'oauth' }],
    })).toBe(true);
    expect(consoleAccountConnected({
      id: 'opencode',
      connections: [{ type: 'credential', method: 'key' }],
    })).toBe(false);
    expect(consoleAccountConnected(undefined)).toBe(false);
    expect(findSignInIntegration('opencode-go', [
      { id: 'opencode-go', connections: [{ type: 'credential', method: 'oauth' }] },
      { id: 'opencode', connections: [{ type: 'credential', method: 'oauth' }] },
    ])?.id).toBe('opencode');
  });

  it('starts OAuth on Console and keeps Go service-account keys on opencode-go', () => {
    const methods = {
      opencode: [{ id: 'device', type: 'oauth' }],
      'opencode-go': [{ id: 'go-key', type: 'key' }, { id: 'fake-oauth', type: 'oauth' }],
    };
    expect(methodsForSignIn('opencode-go', methods)).toEqual(methods.opencode);
    expect(signInOAuthMethods({ methods: methods['opencode-go'] }).map((method) => method.id)).toEqual(['fake-oauth']);
    expect(signInOAuthMethods({ methods: methods.opencode }).map((method) => method.id)).toEqual(['device']);
    expect(signInIntegrationIdForOAuth('opencode-go', {
      opencode: 'opencode',
      'opencode-go': 'opencode-go',
    })).toBe('opencode');
    expect(signInIntegrationIdForOAuth('openai', { openai: 'openai-int' })).toBe('openai-int');
  });
});
