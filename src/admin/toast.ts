/**
 * The single toast (admin UI spec §6.7). A new message replaces the current
 * one. Success messages leave after 5 seconds; errors stay until closed so
 * the text (a short URL that could not be copied) can be selected by hand.
 * The region is a polite live region, so it never takes focus.
 */
import { icon } from "./icons";

const SUCCESS_MS = 5000;

let timer: ReturnType<typeof setTimeout> | undefined;

export interface ToastMessage {
  readonly kind: "success" | "error";
  readonly title: string;
  readonly text: string;
}

export function showToast(region: HTMLElement, message: ToastMessage): void {
  clearTimeout(timer);
  const toast = document.createElement("div");
  toast.className = message.kind === "error" ? "toast toast--error" : "toast";
  toast.append(icon(message.kind === "error" ? "close" : "check", "toast__icon"));

  const body = document.createElement("div");
  body.className = "toast__body";
  const title = document.createElement("b");
  title.className = "toast__title";
  title.textContent = message.title;
  const text = document.createElement("span");
  text.className = "toast__text";
  text.textContent = message.text;
  text.title = message.text;
  body.append(title, text);
  toast.append(body);

  if (message.kind === "error") {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast__close";
    close.setAttribute("aria-label", "Dismiss");
    close.append(icon("close", ""));
    close.addEventListener("click", () => toast.remove());
    toast.append(close);
  } else {
    timer = setTimeout(() => toast.remove(), SUCCESS_MS);
  }
  region.replaceChildren(toast);
}
