import { bridge } from "./bridge";

export type UnlistenFn = () => void;
export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export async function listen<T>(event: string, handler: (e: Event<T>) => void): Promise<UnlistenFn> {
  return bridge.on(event, (payload) => handler({ event, id: 0, payload: payload as T }));
}
