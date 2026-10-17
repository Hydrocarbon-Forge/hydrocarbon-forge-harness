export type KeyContext = "prompt" | "running" | "dialog" | "global";

export interface KeybindingDef {
  key: string;
  action: string;
  description: string;
  context: KeyContext;
}

export interface KeyState {
  lastCtrlCTime?: number;
  lastEscTime?: number;
}

export interface KeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}
