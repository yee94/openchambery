import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMetadataStore, registerSessionMetadataRoutes } from './routes.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-metadata-routes-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const mount = (overrides = {}) => {
  const store = overrides.sessionMetadataStore
    ?? createSessionMetadataStore({ dataDir: makeDataDir() });
  const broadcastGlobalUiEvent = overrides.broadcastGlobalUiEvent ?? vi.fn();
  const app = express();
  registerSessionMetadataRoutes(app, {
    sessionMetadataStore: store,
    sessionArchiveService: overrides.sessionArchiveService ?? null,
    broadcastGlobalUiEvent,
    onMetadataWritten: overrides.onMetadataWritten,
  });
  return { app, store, broadcastGlobalUiEvent };
};

describe('registerSessionMetadataRoutes', () => {
  it('merge-patches metadata and broadcasts the full merged object', async () => {
    const { app, store, broadcastGlobalUiEvent } = mount();

    const first = await request(app)
      .put('/api/openchamber/sessions/ses_1/metadata')
      .send({ patch: { openchamber: { assist: { recap: 'a' } } } })
      .expect(200);
    expect(first.body.metadata).toEqual({ openchamber: { assist: { recap: 'a' } } });

    const second = await request(app)
      .put('/api/openchamber/sessions/ses_1/metadata')
      .send({ patch: { openchamber: { goal: { status: 'active' } } }, directory: '/repo' })
      .expect(200);
    expect(second.body.metadata).toEqual({
      openchamber: { assist: { recap: 'a' }, goal: { status: 'active', executionGeneration: 0 } },
    });
    await expect(store.get('ses_1')).resolves.toEqual(second.body.metadata);
    expect(broadcastGlobalUiEvent).toHaveBeenLastCalledWith({
      type: 'openchamber:session-metadata',
      properties: { sessionID: 'ses_1', metadata: second.body.metadata },
    });
  });

  it('notifies the metadata listener with the session directory', async () => {
    const onMetadataWritten = vi.fn();
    const { app } = mount({ onMetadataWritten });

    await request(app)
      .put('/api/openchamber/sessions/ses_2/metadata')
      .send({ patch: { openchamber: { goal: { id: 'g1', status: 'active', objective: 'ship' } } }, directory: '/repo' })
      .expect(200);

    expect(onMetadataWritten).toHaveBeenCalledWith({
      sessionID: 'ses_2',
      directory: '/repo',
      metadata: {
        openchamber: {
          goal: { id: 'g1', status: 'active', objective: 'ship', executionGeneration: 0 },
        },
      },
    });
  });

  it('rejects a blank session id and a non-object patch with 400', async () => {
    const { app } = mount();
    await request(app)
      .put('/api/openchamber/sessions/%20%20/metadata')
      .send({ patch: { a: 1 } })
      .expect(400);
    await request(app)
      .put('/api/openchamber/sessions/ses_1/metadata')
      .send({})
      .expect(400);
    await request(app)
      .put('/api/openchamber/sessions/ses_1/metadata')
      .send({ patch: 'nope' })
      .expect(400);
    await request(app)
      .put('/api/openchamber/sessions/ses_1/metadata')
      .send({ patch: ['a'] })
      .expect(400);
  });

  it('does not answer a failed store load as empty success', async () => {
    const store = {
      setSessionMetadata: async () => {
        throw new Error('session metadata is unavailable: its file could not be read');
      },
    };
    const { app } = mount({ sessionMetadataStore: store });
    const res = await request(app)
      .put('/api/openchamber/sessions/ses_1/metadata')
      .send({ patch: { a: 1 } })
      .expect(503);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/could not be read/) });
  });

  it('archives via PUT /archive and returns the projected session', async () => {
    const setArchive = vi.fn(async ({ sessionID, archivedAt }) => ({
      session: {
        id: sessionID,
        title: 'Alpha',
        directory: '/repo',
        time: { created: 1, updated: 2, archived: archivedAt },
        metadata: { openchamber: { archive: { archivedAt } } },
      },
    }));
    const { app } = mount({
      sessionArchiveService: { setArchive },
    });

    const res = await request(app)
      .put('/api/openchamber/sessions/ses_1/archive')
      .send({ archivedAt: 99, directory: '/repo' })
      .expect(200);

    expect(setArchive).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      archivedAt: 99,
      directory: '/repo',
    });
    expect(res.body.session).toMatchObject({
      id: 'ses_1',
      time: { archived: 99 },
    });
  });

  it('rejects archive without a finite archivedAt', async () => {
    const { app } = mount({
      sessionArchiveService: { setArchive: vi.fn() },
    });
    await request(app)
      .put('/api/openchamber/sessions/ses_1/archive')
      .send({})
      .expect(400);
  });
});
