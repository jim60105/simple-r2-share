/**
 * `/s/<token>/` (rules editor spec §2): the share page. All logic lives in `src/share-handler.ts`.
 * `onRequest` receives every method so the handler can answer `405` itself.
 */
import type { Env } from "../../src/config";
import { handleShareRequest } from "../../src/share-handler";

export const onRequest: PagesFunction<Env> = (context) => handleShareRequest(context.request, context.env);
