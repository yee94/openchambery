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
      manualProjectOrder: [],
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

  test('advances manual order alongside the registry so manual sorting keeps the promoted project first', () => {
    useProjectsStore.setState({
      manualProjectOrder: ['alpha', 'beta', 'gamma'],
    });

    useProjectsStore.getState().moveProjectToTop('gamma');

    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['gamma', 'alpha', 'beta']);
    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([
      'gamma',
      'alpha',
      'beta',
    ]);
  });

  test('prepends a project missing from manual order so new activity outranks untouched projects', () => {
    useProjectsStore.setState({
      projects: [
        { id: 'alpha', path: '/workspace/alpha', label: 'Alpha' },
        { id: 'beta', path: '/workspace/beta', label: 'Beta' },
        { id: 'delta', path: '/workspace/delta', label: 'Delta' },
      ],
      manualProjectOrder: ['alpha', 'beta'],
    });

    useProjectsStore.getState().moveProjectToTop('delta');

    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['delta', 'alpha', 'beta']);
  });

  test('updates manual order without touching the registry when the project is already first', () => {
    const initial = useProjectsStore.getState().projects;
    useProjectsStore.setState({
      manualProjectOrder: ['beta', 'alpha', 'gamma'],
    });

    useProjectsStore.getState().moveProjectToTop('alpha');

    expect(useProjectsStore.getState().projects).toBe(initial);
    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['alpha', 'beta', 'gamma']);
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

describe('useProjectsStore synchronizeFromSettings', () => {
  test('rebases the manual order onto the server projects order so cross-runtime drags and promotions apply locally', () => {
    const alpha = createProjectIdFromPath('/workspace/alpha');
    const beta = createProjectIdFromPath('/workspace/beta');
    const gamma = createProjectIdFromPath('/workspace/gamma');
    useProjectsStore.setState({
      projects: [
        { id: alpha, path: '/workspace/alpha', label: 'Alpha' },
        { id: beta, path: '/workspace/beta', label: 'Beta' },
        { id: gamma, path: '/workspace/gamma', label: 'Gamma' },
      ],
      activeProjectId: beta,
      manualProjectOrder: [alpha, beta, gamma],
    });

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [
        { id: gamma, path: '/workspace/gamma', label: 'Gamma' },
        { id: alpha, path: '/workspace/alpha', label: 'Alpha' },
        { id: beta, path: '/workspace/beta', label: 'Beta' },
      ],
    });

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([gamma, alpha, beta]);
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([gamma, alpha, beta]);
  });

  test('keeps the local manual order when only the active project changed', () => {
    const alpha = createProjectIdFromPath('/workspace/alpha');
    const beta = createProjectIdFromPath('/workspace/beta');
    const projects = [
      { id: alpha, path: '/workspace/alpha', label: 'Alpha' },
      { id: beta, path: '/workspace/beta', label: 'Beta' },
    ];
    useProjectsStore.setState({
      projects,
      activeProjectId: alpha,
      manualProjectOrder: [beta, alpha],
    });

    useProjectsStore.getState().synchronizeFromSettings({ projects });

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([alpha, beta]);
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([beta, alpha]);
    expect(useProjectsStore.getState().activeProjectId).toBeNull();
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

describe('useProjectsStore addProject', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [
        { id: 'alpha', path: '/workspace/alpha', label: 'Alpha' },
        { id: 'beta', path: '/workspace/beta', label: 'Beta' },
      ],
      activeProjectId: 'alpha',
      manualProjectOrder: [],
    });
  });

  test('prepends the new project to the registry', () => {
    const entry = useProjectsStore.getState().addProject('/workspace/delta');
    expect(entry).not.toBeNull();
    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([
      entry!.id,
      'alpha',
      'beta',
    ]);
  });

  test('prepends the new project id to manualProjectOrder', () => {
    useProjectsStore.setState({
      manualProjectOrder: ['beta', 'alpha'],
    });

    const entry = useProjectsStore.getState().addProject('/workspace/delta');
    expect(entry).not.toBeNull();
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([entry!.id, 'beta', 'alpha']);
  });

  test('seeds manualProjectOrder with only the new id when order was empty', () => {
    const entry = useProjectsStore.getState().addProject('/workspace/delta');
    expect(entry).not.toBeNull();
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([entry!.id]);
  });

  test('activates an existing path without duplicating the project', () => {
    const before = useProjectsStore.getState().projects;
    const existing = useProjectsStore.getState().addProject('/workspace/beta');
    expect(existing?.id).toBe('beta');
    expect(useProjectsStore.getState().projects).toBe(before);
    expect(useProjectsStore.getState().activeProjectId).toBe('beta');
    expect(useProjectsStore.getState().projects.filter((project) => project.path === '/workspace/beta')).toHaveLength(1);
  });
});
