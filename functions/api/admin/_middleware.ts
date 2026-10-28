/**
 * Gate for every `/api/admin/*` request (admin UI spec §9): verifies the
 * Cloudflare Access JWT and the CSRF checks in `src/access.ts`, then passes the
 * caller's email to the handler as `context.data.accessEmail`.
 */
import { authenticateAdmin, certsKeySource } from "../../../src/access";
import type { AdminData } from "../../../src/admin-api";
import type { Env } from "../../../src/config";

export const onRequest: PagesFunction<Env, string, AdminData> = async (context) => {
  const result = await authenticateAdmin(context.request, context.env, (config) =>
    certsKeySource(config.teamDomain, fetch, caches.default),
  );
  if (result instanceof Response) return result;
  context.data.accessEmail = result.email;
  return context.next();
};
