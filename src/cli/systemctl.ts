import { UI_UNIT_NAME } from "../util/systemd-unit.js";

// The systemctl and loginctl commands the web UI service prints, and runs for `ui install-service --enable` and
// `ui uninstall-service --disable` (web-ui design, 8.4). They live in the CLI, where the command lines are named.

/** The commands that enable the unit now, as printed and as run by `install-service --enable`. */
export function enableCommandsOf(): Array<[string, string[]]> {
  return [
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "enable", "--now", UI_UNIT_NAME]],
  ];
}

/** The commands that stop and disable the unit, in the order they run. */
export function disableCommandsOf(): Array<[string, string[]]> {
  return [
    ["systemctl", ["--user", "disable", "--now", UI_UNIT_NAME]],
    ["systemctl", ["--user", "daemon-reload"]],
  ];
}

/** The command line a person would type for one of the commands. */
export function commandLineOf([command, args]: [string, string[]]): string {
  return [command, ...args].join(" ");
}
