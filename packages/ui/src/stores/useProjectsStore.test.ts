import { beforeEach, describe, expect, test } from 'bun:test';
import { createProjectIdFromPath } from '@/lib/projectId';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { reorderProjectEntriesById, useProjectsStore } from './useProjectsStore';

describe('useProjectsStore moveProjectToTop', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [
        { id: 'alpha', path: '/workspace/alpha', label: 'Alpha' },
        { id: 'beta', path: '/workspace/beta', label: 'Beta' },
        { id: 'gamma', path: '/workspace/gamma', label: 'Gamma' },
      ],
      activeProjectId: 'beta',
    });
  });

  test('promotes only the conversation project while preserving the remaining order', () => {
    useProjectsStore.getState().moveProjectToTop('gamma');

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([
      'gamma',
      'alpha',
      'beta',
    ]);
    expect(useProjectsStore.getState().activeProjectId).toBe('beta');
  });

  test('does not replace the project list when the project is already first or missing', () => {
    const initial = useProjectsStore.getState().projects;

    useProjectsStore.getState().moveProjectToTop('alpha');
    expect(useProjectsStore.getState().projects).toBe(initial);

    useProjectsStore.getState().moveProjectToTop('missing');
    expect(useProjectsStore.getState().projects).toBe(initial);
  });
});

describe('useProjectsStore instance-scoped order', () => {
  const seedProjects = () => {
    const alpha = createProjectIdFromPath('/workspace/alpha');
    const beta = createProjectIdFromPath('/workspace/beta');
    const gamma = createProjectIdFromPath('/workspace/gamma');
    useProjectsStore.setState({
      projects: [
        { id: alpha, path: '/workspace/alpha', label: 'Alpha' },
        { id: beta, path: '/workspace/beta', label: 'Beta' },
        { id: gamma, path: '/workspace/gamma', label: 'Gamma' },
      ],
      activeProjectId: alpha,
      manualProjectOrder: [alpha, beta, gamma],
    });
    return { alpha, beta, gamma };
  };

  test('keeps independent manual order across two relay instances that share the UI origin', () => {
    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-a@wss://relay.example',
    });
    const ids = seedProjects();
    useProjectsStore.getState().reorderProjectsById(ids.gamma, ids.alpha);
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([ids.gamma, ids.alpha, ids.beta]);

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-b@wss://relay.example',
    });
    useProjectsStore.getState().resetForRuntimeSwitch();
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([]);

    seedProjects();
    useProjectsStore.getState().reorderProjectsById(ids.beta, ids.alpha);
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([ids.beta, ids.alpha, ids.gamma]);

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-a@wss://relay.example',
    });
    useProjectsStore.getState().resetForRuntimeSwitch();
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([ids.gamma, ids.alpha, ids.beta]);
    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([
      ids.gamma,
      ids.alpha,
      ids.beta,
    ]);
  });
});

describe('reorderProjectEntriesById', () => {
  test('moves registry entries by their ids when visual order differs from store order', () => {
    const projects = [
      { id: 'alpha', path: '/workspace/alpha' },
      { id: 'beta', path: '/workspace/beta' },
      { id: 'gamma', path: '/workspace/gamma' },
    ];

    expect(reorderProjectEntriesById(projects, 'gamma', 'alpha').map((project) => project.id)).toEqual([
      'gamma', 'alpha', 'beta',
    ]);
  });
});
