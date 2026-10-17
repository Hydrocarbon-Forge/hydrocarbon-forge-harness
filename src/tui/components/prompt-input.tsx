import type { PermissionMode } from "../../contracts/index.js";

export interface PromptInputProps {
  prompt: string;
  permissionMode: PermissionMode;
  banner?: string;
  focused?: boolean;
}

export function formatPromptPrefix(mode: PermissionMode): string {
  return `[${mode}] > `;
}

export function renderPromptInput(props: PromptInputProps): string {
  const bannerLine = props.banner ? `${props.banner}\n` : "";
  const prefix = formatPromptPrefix(props.permissionMode);
  return `${bannerLine}${prefix}${props.prompt}`;
}

export function PromptInput(props: PromptInputProps): string {
  return renderPromptInput(props);
}
