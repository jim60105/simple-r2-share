/**
 * `/api/admin/rules` (admin UI spec §5.1, §5.2): read and save the rules file.
 * Access is checked by `_middleware.ts`; all logic lives in `src/admin-api.ts`.
 */
import { handleRulesRequest, type AdminData } from "../../../src/admin-api";
import type { Env } from "../../../src/config";

export const onRequest: PagesFunction<Env, string, AdminData> = (context) =>
  handleRulesRequest(context.request, context.env, context.data.accessEmail);
