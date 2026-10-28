/**
 * `/api/share-zip?token=<share token>` (spec §3, §7; rules editor spec §2): the optional ZIP download.
 * All logic lives in `src/zip-handler.ts`. `onRequest` receives every method
 * so the handler can answer `405` itself.
 */
import type { Env } from "../../src/config";
import { handleZipRequest } from "../../src/zip-handler";

export const onRequest: PagesFunction<Env> = (context) => handleZipRequest(context.request, context.env);
