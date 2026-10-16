import { bridge } from "./bridge";

export interface DialogFilter {
  name: string;
  extensions: string[];
}
export interface OpenDialogOptions {
  title?: string;
  multiple?: boolean;
  directory?: boolean;
  defaultPath?: string;
  filters?: DialogFilter[];
}
export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
}
export interface MessageDialogOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

export const open = (o: OpenDialogOptions = {}) => bridge.call("dialog:open", o) as Promise<string | string[] | null>;
export const save = (o: SaveDialogOptions = {}) => bridge.call("dialog:save", o) as Promise<string | null>;
export const ask = (msg: string, o: MessageDialogOptions | string = {}) =>
  bridge.call("dialog:ask", msg, typeof o === "string" ? { title: o } : o) as Promise<boolean>;
export const confirm = ask;
export const message = (msg: string, o: MessageDialogOptions | string = {}) =>
  bridge.call("dialog:message", msg, typeof o === "string" ? { title: o } : o) as Promise<void>;
