/**
 * `/api/admin/folders` (admin UI spec §5.3): one level of folders.
 * Access is checked by `_middleware.ts`; all logic lives in `src/admin-api.ts`.
 */
import { handleFoldersRequest, type AdminData } from "../../../src/admin-api";
import type { Env } from "../../../src/config";

export const onRequest: PagesFunction<Env, string, AdminData> = (context) =>
  handleFoldersRequest(context.request, context.env);
