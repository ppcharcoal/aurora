import type { IconName } from "./components/Icon.svelte";
import { native, type NativeOutput } from "./native";
import { isAndroid, isLinux } from "./platform";
import { settings } from "./settings.svelte";
import { ui } from "./ui.svelte";

export type OutputKind = NativeOutput["kind"];

/** Anything that can play to a chosen device. */
type Sink = HTMLMediaElement | AudioContext;

export interface OutputDevice {
  id: string;
  label: string;
  kind: OutputKind;
}

export const iconFor = (k: OutputKind): IconName =>
  k === "bluetooth" ? "bluetooth" : k === "wired" ? "headphones" : k === "usb" ? "usb" : k === "hdmi" ? "device" : k === "car" ? "car" : "speaker";

/** Guess the kind of device from its name (Windows only gives names). */
function kindOf(label: string): OutputKind {
  const l = label.toLowerCase();
  if (/bluetooth|airpods|buds|wh-|wf-|jbl|bose|sony|beats|hands-free|hfp|a2dp/.test(l)) return "bluetooth";
  if (/headphone|headset|earphone|słuchawki/.test(l)) return "wired";
  if (/hdmi|display|nvidia|amd high definition|monitor|tv/.test(l)) return "hdmi";
  if (/usb|dac|interface|focusrite|scarlett/.test(l)) return "usb";
  if (/speaker|głośnik|realtek|audio/.test(l)) return "speaker";
  return "other";
}

/**
 * Which device plays the music.
 *
 * Windows: every <audio> element Aurora uses is routed with setSinkId().
 * WebView2 only shares device names after a one-time media permission, so the
 * list may need one "Show my devices" click (Aurora asks for the microphone
 * for a split second and stops at once; nothing is recorded).
 *
 * Android: the native playback service routes ExoPlayer to the chosen device.
 * In the car, Android Auto always takes over the sound.
 */
class AudioOutput {
  devices = $state.raw<OutputDevice[]>([]);
  /** Windows is hiding the device names until access is granted. */
  needsAccess = $state(false);
  /** The chosen device isn't connected right now; the default plays instead. */
  missing = $state(false);
  busy = $state(false);
  /** Audio elements, and the visualizer's AudioContext once audio flows through it. */
  private els = new Set<Sink>();
  private started = false;

  /** The device actually in use (null = system default). */
  active = $derived.by(() => {
    const want = settings.value.audioOutput;
    if (!want || this.missing) return null;
    return this.devices.find((d) => d.id === want.id) ?? { id: want.id, label: want.label, kind: kindOf(want.label) };
  });

  async init() {
    if (this.started) return;
    this.started = true;
    if (isAndroid) {
      await native.on<{ devices: NativeOutput[] }>("outputs", (e) => this.setNative(e.devices)).catch(() => {});
      await this.refresh();
      const want = settings.value.audioOutput;
      if (want) native.call("output", { id: want.id }).catch(() => {});
      return;
    }
    if (isLinux) return; // the system's sound settings choose the device
    navigator.mediaDevices?.addEventListener("devicechange", () => this.refresh().then(() => this.applyAll()));
    await this.refresh();
    await this.applyAll();
  }

  /** Every audio element (or AudioContext) that should follow the chosen device. */
  attach(el: Sink) {
    this.els.add(el);
    if (!isAndroid) this.apply(el, this.sinkId()).catch(() => {});
  }

  private setNative(list: NativeOutput[]) {
    this.devices = list;
    const want = settings.value.audioOutput;
    this.missing = !!want && !list.some((d) => d.id === want.id);
  }

  async refresh(askAccess = false) {
    this.busy = true;
    try {
      if (isAndroid) {
        const r = await native.call<{ devices: NativeOutput[] }>("outputs");
        this.setNative(r.devices);
        return;
      }
      const md = navigator.mediaDevices;
      if (isLinux || !md?.enumerateDevices) return;
      if (askAccess) {
        try {
          const s = await md.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
        } catch (e) {
          const name = e instanceof DOMException ? e.name : "";
          ui.toast(
            name === "NotFoundError"
              ? "Windows only lists speakers to apps after a microphone check, and this PC has no microphone. Use Windows sound settings → Volume mixer → Aurora to pick the output."
              : "Windows didn't allow the device check. Settings → Privacy → Microphone → let desktop apps use it, or pick the output in Windows sound settings → Volume mixer.",
            "error",
            9000,
          );
        }
      }
      const all = await md.enumerateDevices();
      const outs = all.filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
      this.needsAccess = !outs.length || outs.every((d) => !d.label);
      this.devices = outs.filter((d) => d.label).map((d) => ({ id: d.deviceId, label: d.label, kind: kindOf(d.label) }));
      // Same device, new id (e.g. after a driver update): follow it by name.
      const want = settings.value.audioOutput;
      if (want && !this.devices.some((d) => d.id === want.id)) {
        const same = this.devices.find((d) => d.label === want.label);
        if (same) settings.set("audioOutput", { id: same.id, label: same.label });
      }
    } finally {
      this.busy = false;
    }
  }

  async select(d: OutputDevice | null) {
    settings.set("audioOutput", d ? { id: d.id, label: d.label } : null);
    this.missing = false;
    if (isAndroid) {
      await native.call("output", { id: d?.id ?? null }).catch(ui.error);
      return;
    }
    await this.applyAll(true);
  }

  private sinkId() {
    return this.missing ? "" : (settings.value.audioOutput?.id ?? "");
  }

  private async apply(el: Sink, id: string) {
    const m = el as { sinkId?: unknown; setSinkId?: (id: string) => Promise<void> };
    if (!m.setSinkId || (m.sinkId ?? "") === id) return;
    await m.setSinkId(id);
  }

  private async applyAll(announce = false) {
    if (isAndroid) return;
    const want = settings.value.audioOutput;
    const wasMissing = this.missing;
    // A device we know is gone: don't even try.
    this.missing = !!want && !this.needsAccess && !this.devices.some((d) => d.id === want.id);
    try {
      for (const el of this.els) await this.apply(el, this.sinkId());
    } catch {
      this.missing = true;
      for (const el of this.els) await this.apply(el, "").catch(() => {});
    }
    if (want && this.missing && (announce || !wasMissing)) {
      ui.toast(`${want.label} isn't connected, so the default speakers play for now. Aurora switches back when it's there again.`, "info", 6000);
    } else if (want && wasMissing && !this.missing) {
      ui.toast(`Playing on ${want.label} again`, "success", 2500);
    }
  }
}

export const output = new AudioOutput();
