import { describe, expect, test } from 'vitest'
import { resolveAssistantWorkspacePresentation } from './assistantWorkspaceState'

const readyCatalog = {
  capabilityPending: false,
  snapshotPending: false,
  capabilityError: false,
  supported: true,
  capabilityEnabled: true,
  snapshotEnabled: true,
  snapshotSettled: true,
  assistantCount: 1,
  hasAssistant: true,
}

describe('resolveAssistantWorkspacePresentation', () => {
  test('pending capability or snapshot is loading, not unavailable', () => {
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      capabilityPending: true,
      snapshotPending: true,
      snapshotSettled: false,
      hasAssistant: false,
      assistantCount: 0,
      snapshotEnabled: undefined,
    })).toBe('loading')
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      snapshotPending: true,
      snapshotSettled: false,
      hasAssistant: false,
      assistantCount: 0,
      snapshotEnabled: undefined,
    })).toBe('loading')
  })

  test('route assistant id stays loading until the snapshot settles', () => {
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      snapshotPending: true,
      snapshotSettled: false,
      hasAssistant: false,
      assistantCount: 0,
      snapshotEnabled: undefined,
    })).toBe('loading')
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      snapshotPending: false,
      snapshotSettled: false,
      hasAssistant: false,
    })).toBe('loading')
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      hasAssistant: false,
    })).toBe('unavailable')
  })

  test('unavailable stays for error, unsupported, disabled, and empty-after-success is onboarding', () => {
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      capabilityError: true,
      hasAssistant: false,
      assistantCount: 0,
    })).toBe('unavailable')
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      supported: false,
      hasAssistant: false,
      assistantCount: 0,
    })).toBe('unavailable')
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      capabilityEnabled: false,
      hasAssistant: false,
      assistantCount: 0,
    })).toBe('unavailable')
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      snapshotEnabled: false,
      hasAssistant: false,
      assistantCount: 0,
    })).toBe('unavailable')
    expect(resolveAssistantWorkspacePresentation({
      ...readyCatalog,
      assistantCount: 0,
      hasAssistant: false,
    })).toBe('onboarding')
    expect(resolveAssistantWorkspacePresentation(readyCatalog)).toBe('ready')
  })
})
