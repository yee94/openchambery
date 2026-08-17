import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@opencode-ai/client', () => ({ OpenCode: { make: vi.fn() } }));

const { OpenCode } = await import('@opencode-ai/client');
const { registerSkillRoutes } = await import('./skill-routes.js');

describe('skill summary route', () => {
  it('returns compact normalized skill data without content or sources', async () => {
    OpenCode.make.mockReturnValue({
      skill: {
        list: vi.fn(async () => ({ data: [{
          name: 'skill',
          location: '/repo/.opencode/skills/skill/SKILL.md',
          description: ` ${'😀'.repeat(161)}\nnext `,
          content: 'secret skill content',
        }] })),
      },
    });
    const app = express();
    registerSkillRoutes(app, {
      fs: { existsSync: () => false },
      path: await import('node:path'),
      os: await import('node:os'),
      resolveProjectDirectory: async () => ({ directory: '/repo' }),
      resolveOptionalProjectDirectory: async () => ({ directory: '/repo' }),
      buildOpenCodeUrl: () => 'http://opencode-upstream:4096/',
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic example' }),
      getOpenCodePort: () => 4096,
      SKILL_SCOPE: { PROJECT: 'project', USER: 'user' },
      discoverSkills: () => [],
      mergeDiscoveredSkills: (primary) => primary,
    });

    const response = await request(app).get('/api/config/skills?summary=true&directory=%2Frepo').expect(200);

    expect(response.body).toEqual({
      skills: [{
        name: 'skill',
        path: '/repo/.opencode/skills/skill/SKILL.md',
        scope: 'project',
        source: 'opencode',
        description: `${'😀'.repeat(160)}…`,
      }],
    });
    expect(response.body.skills[0]).not.toHaveProperty('content');
    expect(response.body.skills[0]).not.toHaveProperty('sources');
    expect(OpenCode.make).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://opencode-upstream:4096',
      headers: { Authorization: 'Basic example' },
    }));
    expect(OpenCode.make.mock.calls[0][0].directory).toBeUndefined();
  });

  it('returns 500 when OpenCode skill list fails instead of an empty success', async () => {
    OpenCode.make.mockReturnValue({
      skill: {
        list: vi.fn(async () => { throw new Error('upstream sentinel'); }),
      },
    });
    const app = express();
    registerSkillRoutes(app, {
      fs: { existsSync: () => false },
      path: await import('node:path'),
      os: await import('node:os'),
      resolveProjectDirectory: async () => ({ directory: '/repo' }),
      resolveOptionalProjectDirectory: async () => ({ directory: '/repo' }),
      buildOpenCodeUrl: () => 'http://opencode-upstream:4096/',
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic example' }),
      getOpenCodePort: () => 4096,
      SKILL_SCOPE: { PROJECT: 'project', USER: 'user' },
      discoverSkills: () => [],
      mergeDiscoveredSkills: (primary) => primary,
    });

    const response = await request(app).get('/api/config/skills?summary=true&directory=%2Frepo').expect(500);
    expect(JSON.stringify(response.body)).not.toContain('sentinel');
    expect(response.body).toEqual({ error: 'Failed to list skills' });
  });
});
