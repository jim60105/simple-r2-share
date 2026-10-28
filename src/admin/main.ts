/**
 * Admin page entry point (admin UI spec §7): wires the store, the view, the
 * clipboard and the page buttons, then loads. Bundled into
 * public/admin/app.js by scripts/build-admin.mjs.
 */
import { formatSyncedTime } from "../format";
import { shortUrl, View, type Dom } from "./render";
import { Store } from "./store";
import { showToast } from "./toast";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`admin: #${id} is missing from index.html`);
  return node as T;
}

const dom: Dom = {
  brandName: byId("brand-name"),
  email: byId("user-email"),
  stats: byId("stats"),
  banners: byId("banners"),
  folders: byId("folders"),
  actionbar: byId("actionbar"),
  pendingCount: byId("pending-count"),
  unsupportedNote: byId("unsupported-note"),
  discard: byId("discard"),
  save: byId("save"),
};
const toastRegion = byId("toast");

/** Set before an intentional reload so the unsaved-changes prompt does not ask twice. */
let leaving = false;

async function copy(segments: readonly string[]): Promise<void> {
  let url = "";
  try {
    url = shortUrl(segments);
    await navigator.clipboard.writeText(url);
    showToast(toastRegion, { kind: "success", title: "SHORT URL COPIED", text: url });
  } catch (error) {
    console.error("admin: copying the short URL failed", error);
    showToast(toastRegion, { kind: "error", title: "COPY FAILED", text: url || "This folder has no short URL." });
  }
}

async function save(): Promise<void> {
  if (await store.save()) {
    const when = store.savedAt === null ? "" : formatSyncedTime(new Date(store.savedAt));
    showToast(toastRegion, { kind: "success", title: "RULES SAVED", text: `Saved ${when}` });
  }
}

function reload(): void {
  leaving = true;
  location.reload();
}

const store = new Store(() => view.render());
const view = new View(store, dom, {
  copy: (segments) => void copy(segments),
  save: () => void save(),
  reload,
});

// Keep the page bottom padding equal to the fixed action bar, whose height
// depends on the width and on whether its text wraps.
new ResizeObserver(() => {
  if (!dom.actionbar.hidden) {
    document.documentElement.style.setProperty("--actionbar-space", `${dom.actionbar.offsetHeight}px`);
  }
}).observe(dom.actionbar);

dom.save.addEventListener("click", () => void save());
dom.discard.addEventListener("click", () => store.discard());
addEventListener("beforeunload", (event) => {
  if (leaving || store.changed.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
});

void store.load();
