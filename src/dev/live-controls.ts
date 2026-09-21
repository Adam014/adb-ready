import type { ExpoControlAction, ExpoControlResult } from "./expo-controls.js";

export interface DevLiveControls {
  execute(action: ExpoControlAction, signal?: AbortSignal): Promise<ExpoControlResult>;
  preset: "expo";
}

export interface DevLiveControlsBinding {
  dispose(): void;
  stopRequested: Promise<void>;
}

export type DevLiveControlsReady = (
  controls: DevLiveControls,
) => DevLiveControlsBinding | undefined;
