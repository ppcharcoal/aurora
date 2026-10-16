import { bridge } from "./bridge";

const win = {
  show: () => bridge.call("win:show") as Promise<void>,
  minimize: () => bridge.call("win:minimize") as Promise<void>,
  toggleMaximize: () => bridge.call("win:toggleMaximize") as Promise<void>,
  close: () => bridge.call("win:close") as Promise<void>,
  isMaximized: () => bridge.call("win:isMaximized") as Promise<boolean>,
  async onResized(cb: () => void): Promise<() => void> {
    return bridge.on("window://resized", () => cb());
  },
};

export function getCurrentWindow() {
  return win;
}
