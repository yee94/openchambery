const prefix = '/api/openchamber/message-queue';
const statusFor = (error) => ({ validation_error: 400, not_found: 404, revision_conflict: 409, row_version_conflict: 409, idempotency_conflict: 409, generation_conflict: 409, authority_conflict: 409, scope_locked: 409, reserved: 409, reservation_expired: 409, reservation_generation_conflict: 409, reservation_token_mismatch: 409, attachment_unavailable: 404, attachment_total_limit: 413, admission_payload_limit: 413, attachment_store_not_found: 404, attachment_store_max_bytes: 413, attachment_store_size_mismatch: 400, attachment_store_hash_mismatch: 400, attachment_store_aborted: 499 })[error?.code] ?? 500;
const publicCode = (error) => statusFor(error) === 500 ? 'internal_error' : error.code;
const unsupported = (res) => res.status(501).json({ code: 'unavailable' });
const send = (res, action) => { try { res.json(action()); } catch (error) { res.status(statusFor(error)).json({ code: publicCode(error) }); } };

export const registerMessageQueueRoutes = (app, { messageQueueService, messageQueueRuntime }) => {
  const runtime = () => messageQueueRuntime ?? (messageQueueService ? { service: messageQueueService, status: () => ({ capability: true, ...messageQueueService.getAuthority(), worker: { paused: true, active: 0 } }) } : null);
  app.get(`${prefix}/status`, (_req, res) => runtime() ? send(res, () => runtime().status()) : unsupported(res));
  app.get(prefix, (_req, res) => messageQueueService ? send(res, () => messageQueueService.snapshot()) : unsupported(res));
  app.get(`${prefix}/scopes/:scopeID`, (req, res) => messageQueueService ? send(res, () => messageQueueService.getScope(req.params.scopeID, { offset: Number(req.query?.offset ?? 0), limit: Number(req.query?.limit ?? 8), expectedRevision: req.query?.expectedRevision === undefined ? undefined : Number(req.query.expectedRevision) })) : unsupported(res));
  app.post(`${prefix}/items`, (req, res) => {
    if (!messageQueueService) return unsupported(res);
    try { const result = messageQueueService.admit(req.body); runtime()?.wake?.(); res.json(result); } catch (error) { res.status(statusFor(error)).json({ code: publicCode(error) }); }
  });
  app.post(`${prefix}/imports`, (req, res) => messageQueueService ? send(res, () => messageQueueService.createImport(req.body)) : unsupported(res));
  app.get(`${prefix}/imports/:importID`, (req, res) => messageQueueService ? send(res, () => messageQueueService.getImportDetails(req.params.importID)) : unsupported(res));
  app.post(`${prefix}/imports/:importID/items`, (req, res) => messageQueueService ? send(res, () => messageQueueService.stageImport({ ...(req.body ?? {}), importID: req.params.importID })) : unsupported(res));
  app.post(`${prefix}/imports/:importID/seal`, (req, res) => messageQueueService ? send(res, () => messageQueueService.sealImport({ ...(req.body ?? {}), importID: req.params.importID })) : unsupported(res));
  app.post(`${prefix}/imports/:importID/activate`, async (req, res) => { if (!messageQueueService) return unsupported(res); try { const result=messageQueueService.activateImport({ ...(req.body ?? {}), importID:req.params.importID }); await runtime()?.start?.(); runtime()?.wake?.(); res.json(result); } catch(error) { res.status(statusFor(error)).json({ code: publicCode(error) }); } });
  app.post(`${prefix}/imports/:importID/late-commit`, async (req, res) => { if (!messageQueueService) return unsupported(res); try { const result=messageQueueService.commitLateImport({ ...(req.body ?? {}), importID:req.params.importID }); if (messageQueueService.getAuthority().authority === 'active') { await runtime()?.start?.(); runtime()?.wake?.(); } res.json(result); } catch(error) { res.status(statusFor(error)).json({ code: publicCode(error) }); } });
  app.post(`${prefix}/imports/:importID/abandon`, (req, res) => messageQueueService ? send(res, () => messageQueueService.abandonImport({ ...(req.body ?? {}), importID:req.params.importID })) : unsupported(res));
  app.post(`${prefix}/authority/pause`, async (req, res) => { if (!messageQueueService) return unsupported(res); try { const result=messageQueueService.pauseAuthority(req.body); await runtime()?.worker?.stop?.(); res.json(result); } catch(error) { res.status(statusFor(error)).json({ code: publicCode(error) }); } });
  app.post(`${prefix}/authority/resume`, async (req, res) => { if (!messageQueueService) return unsupported(res); try { const result=messageQueueService.resumeAuthority(req.body); await runtime()?.start?.(); runtime()?.wake?.(); res.json(result); } catch(error) { res.status(statusFor(error)).json({ code: publicCode(error) }); } });
  app.patch(`${prefix}/items/:queueItemID`, (req, res) => messageQueueService ? send(res, () => messageQueueService.edit({ ...(req.body ?? {}), queueItemID: req.params.queueItemID })) : unsupported(res));
  app.delete(`${prefix}/items/:queueItemID`, (req, res) => messageQueueService ? send(res, () => messageQueueService.remove({ ...(req.body ?? {}), queueItemID: req.params.queueItemID })) : unsupported(res));
  app.post(`${prefix}/items/:queueItemID/reserve`, (req, res) => messageQueueService ? send(res, () => messageQueueService.reserveForEdit({ ...(req.body ?? {}), queueItemID: req.params.queueItemID })) : unsupported(res));
  app.post(`${prefix}/items/:queueItemID/release`, (req, res) => {
    if (!messageQueueService) return unsupported(res);
    try { const result = messageQueueService.releaseEditReservation({ ...(req.body ?? {}), queueItemID: req.params.queueItemID }); runtime()?.wake?.(); res.json(result); } catch (error) { res.status(statusFor(error)).json({ code: publicCode(error) }); }
  });
  app.post(`${prefix}/items/:queueItemID/edit-reservations/:token/renew`, (req, res) => messageQueueService ? send(res, () => messageQueueService.renewEditReservation({ ...(req.body ?? {}), queueItemID: req.params.queueItemID, token: req.params.token })) : unsupported(res));
  app.delete(`${prefix}/items/:queueItemID/reserved-remove`, (req, res) => messageQueueService ? send(res, () => messageQueueService.reservedRemove({ ...(req.body ?? {}), queueItemID: req.params.queueItemID })) : unsupported(res));
  app.post(`${prefix}/items/:queueItemID/send`, (req, res) => {
    if (!messageQueueService) return unsupported(res);
    try { const result = messageQueueService.manualSend({ ...(req.body ?? {}), queueItemID: req.params.queueItemID }); runtime()?.wake?.(); res.json(result); } catch (error) { res.status(statusFor(error)).json({ code: publicCode(error) }); }
  });
  app.put(`${prefix}/scopes/:scopeID/order`, (req, res) => messageQueueService ? send(res, () => messageQueueService.reorder({ ...(req.body ?? {}), scopeID: req.params.scopeID })) : unsupported(res));
  app.get(`${prefix}/items/:queueItemID/attachments/:attachmentID/content`, async (req, res) => {
    const current = runtime(); if (!current) return unsupported(res);
    try {
      const content = current.service.getItemAttachment(req.params.queueItemID, req.params.attachmentID, { runtimeKey: current.service.getRuntimeKey() });
      const opened = await current.attachmentStore.openAttachment(content.attachment, content.item);
      const filename = String(opened.filename).replace(/[\r\n"]/g, '_');
      res.set('Content-Type', opened.mime); res.set('Content-Length', String(opened.size)); res.set('Content-Disposition', `attachment; filename="${filename}"`);
      opened.stream.once('error', (error) => { if (!res.headersSent) res.status(statusFor(error)).json({ code: publicCode(error) }); else res.destroy(error); });
      opened.stream.pipe(res);
    } catch (error) { res.status(statusFor(error)).json({ code: publicCode(error) }); }
  });
  app.get(`${prefix}/worktrees/order`, (req, res) => messageQueueService ? send(res, () => messageQueueService.getWorktreeOrder(req.query?.projectDirectory)) : unsupported(res));
  app.put(`${prefix}/worktrees/order`, (req, res) => messageQueueService ? send(res, () => messageQueueService.setWorktreeOrder(req.body)) : unsupported(res));
  app.post(`${prefix}/attachments/uploads`, (req, res) => messageQueueService ? send(res, () => messageQueueService.createAttachmentUpload(req.body)) : unsupported(res));
  app.put(`${prefix}/attachments/uploads/:uploadID`, async (req, res) => {
    const current = runtime(); if (!current) return unsupported(res);
    const headerValue = (value) => Array.isArray(value) ? value[0] : value; const uploadToken = headerValue(req.headers['x-message-queue-upload-token']); const expectedSize = Number(headerValue(req.headers['x-message-queue-content-length']) ?? headerValue(req.headers['content-length'])); const expectedSha256 = headerValue(req.headers['x-message-queue-sha256']); const controller = new AbortController();
    req.once?.('aborted', () => controller.abort());
    try { const runtimeKey = current.service.getRuntimeKey(); let ready; current.service.getAttachmentUpload({ uploadID: req.params.uploadID, uploadToken }, { runtimeKey }); await current.attachmentStore.writeUpload({ uploadID: req.params.uploadID, stream: req, expectedSize, expectedSha256, signal: controller.signal, onStored: (stored) => { ready = current.service.markAttachmentReady({ uploadID: req.params.uploadID, uploadToken, objectHash: stored.storageKey, storageKey: stored.storageKey, sizeBytes: stored.size }, { runtimeKey }); } }); res.json(ready); }
    catch (error) { res.status(statusFor(error)).json({ code: publicCode(error) }); }
  });
};
