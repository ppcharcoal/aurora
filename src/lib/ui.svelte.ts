import type { Route } from "./types";
import type { IconName } from "./components/Icon.svelte";

type ToastKind = "info" | "error" | "success";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  action?: () => void;
  submenu?: MenuItem[];
  danger?: boolean;
  divider?: boolean;
}

interface PromptState {
  title: string;
  placeholder: string;
  value: string;
  resolve: (v: string | null) => void;
}

class UI {
  route = $state<Route>({ name: "home" });
  history: Route[] = [];
  queueOpen = $state(false);
  /** Phone layout (the Android app, or a very narrow window): bottom tabs instead of the sidebar. */
  phone = $state(false);
  /** Phone: the full-screen now-playing view is open. */
  sheetOpen = $state(false);
  searchMode = $state<"songs" | "albums">("songs");
  toasts = $state<Toast[]>([]);
  menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  promptState = $state<PromptState | null>(null);
  private nextToast = 1;

  go(route: Route) {
    this.history.push(this.route);
    if (this.history.length > 50) this.history.shift();
    this.route = route;
  }

  back() {
    const prev = this.history.pop();
    if (prev) this.route = prev;
  }

  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  toast(text: string, kind: ToastKind = "info", ms = 4200) {
    // The same message again (e.g. several missing files in a row): keep one.
    const same = this.toasts.find((t) => t.text === text && t.kind === kind);
    const id = same?.id ?? this.nextToast++;
    if (!same) this.toasts.push({ id, kind, text });
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => this.dismiss(id), ms));
  }

  error = (e: unknown) => {
    const text = e instanceof Error ? e.message : String(e);
    console.error(e);
    this.toast(text, "error", 7000);
  };

  dismiss(id: number) {
    this.timers.delete(id);
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  openMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect?.();
    // Right-click opens at the pointer; a button click opens under the button.
    const fromButton = e.type === "click" && r;
    this.menu = {
      x: fromButton ? r.right : e.clientX,
      y: fromButton ? r.bottom + 4 : e.clientY,
      items,
    };
  }

  closeMenu() {
    this.menu = null;
  }

  prompt(title: string, placeholder = "", value = ""): Promise<string | null> {
    this.promptState?.resolve(null);
    return new Promise((resolve) => {
      this.promptState = { title, placeholder, value, resolve };
    });
  }

  settlePrompt(v: string | null) {
    const p = this.promptState;
    this.promptState = null;
    p?.resolve(v);
  }
}

export const ui = new UI();
