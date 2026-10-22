# The browser UI and its service

Substrate has a browser UI. It shows the jobs of every project registered on this machine (the runs in
`$XDG_STATE_HOME/substrate/projects.json`), not only the project in the current directory. The UI runs as a background
service, so it is up even when no `substrate` command is running. The design is in `docs/design/web-ui.md`.

- It listens on the loopback interface only and is reached as `localhost`. It is not reachable from other machines. It
  has no login: anyone who can open the URL on this machine can see the runs and stop or resume them.
- The port is chosen once and kept. It is stored in `ui.json`, in the same directory as `settings.json`
  (`$SUBSTRATE_CONFIG_DIR`, else `~/.config/substrate`). The URL stays the same across restarts and across the
  service. Nothing in the repository holds a port.

## Start, stop and status

```text
substrate ui start            start it in the background (if not running) and print its URL
substrate ui status           running or stopped, the URL, the pid, uptime, projects, running jobs, service state
substrate ui stop             stop it (SIGTERM, up to 15 s); --force kills it if it does not stop
substrate ui serve            run it in the foreground (what the service runs; stops on Ctrl+C)
```

`ui start` and `ui status` take `--output-format json`. `start` then prints `{"url","pid"}`; `status` prints the
running state, URL, pid, uptime, project and job counts and the service state. Running `ui start` twice is safe: the
second call prints the same URL.

The background process writes its pid to `ui.pid` and its output to `ui.log`, both under
`$XDG_STATE_HOME/substrate` (default `~/.local/state/substrate`). A pid file whose process is gone, or is not a
`ui serve`, is stale and is ignored. Substrate never signals a pid it cannot confirm is its own.

To find the URL later, run `substrate ui status`. A port already in use by something else is replaced: the UI takes a
new free port, saves it in `ui.json`, and prints a one-line notice.

## Installing the service (Linux, systemd)

```text
substrate ui install-service          write the user unit and print the commands
substrate ui install-service --enable write the unit, then run the systemctl commands
substrate ui uninstall-service        remove the unit and print the commands to stop it
substrate ui uninstall-service --disable   stop and disable it, then remove the unit
```

`install-service` writes `~/.config/systemd/user/substrate-ui.service` (or `$XDG_CONFIG_HOME/systemd/user/`). The unit
runs `ui serve` with the absolute path of the Node binary and of the bundled CLI, restarts it on failure after two
seconds, and starts it at login. Without `--enable` it runs nothing: it prints these commands, which you run yourself:

```text
systemctl --user daemon-reload
systemctl --user enable --now substrate-ui.service
loginctl enable-linger <your user>
```

`loginctl enable-linger` is needed only if the UI must run before you log in, or after a reboot without a login. It is
printed and never run by Substrate. On macOS and Windows the service commands exit `2`; use `substrate ui start`.

`status` reports whether the unit file exists. It never calls systemctl.

## Troubleshooting

- **The service runs, but a resumed run cannot find `claude`, `opencode` or `agy`.** A systemd user service gets a
  minimal `PATH`. `install-service` writes the `PATH` of the shell it ran in into the unit. If you change your `PATH`
  (or install a harness later), run `substrate ui install-service` again and then `systemctl --user daemon-reload` and
  `systemctl --user restart substrate-ui.service`.
- **The UI stops when you log out.** Enable lingering with `loginctl enable-linger <your user>`.
- **`status` says stopped, but the service is running.** Your shell and the service must agree on
  `XDG_STATE_HOME` and `SUBSTRATE_CONFIG_DIR`. `install-service` copies those two variables into the unit when they are
  set in the shell that ran it; run it again after changing them.
- **`start` says it did not answer.** Read `ui.log` in `$XDG_STATE_HOME/substrate` (the last lines are also printed).
- **`substrate ui serve` says the UI is already running.** One UI runs per machine. Use `substrate ui status`, then
  `substrate ui stop` (or `systemctl --user stop substrate-ui.service` when the service runs it).
- **`ui.json` is corrupt.** Delete it. The next start picks a new port.
