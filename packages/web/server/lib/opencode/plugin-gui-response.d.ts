export function preparePluginGuiRequest(
  method: string,
  requestPath: string,
  headers: Record<string, string>,
): { headers: Record<string, string>; revision: string | null } | null;

export function projectPluginGuiResponse(response: Response, requestedRevision: string | null): Promise<Response>;
