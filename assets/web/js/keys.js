// The keyboard (docs/design/web-ui.md, 4.4). Single keys act only when focus is not in a field. `g` then `e` opens the
// Engine; `?` opens the list of shortcuts in a dialog.

import { navItems } from "./sidebar.js";

const FIELD = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * `actions` supplies what the keys do: focusChat(), expandAll(), moveActor(step), openEngine(), toggleTheme(),
 * openHelp(), stop(), resume(), focusSelected(), and openDrawer(open).
 */
export function initKeys(actions) {
  let pendingG = false;
  let pendingTimer = null;

  const moveSidebar = (step) => {
    const items = navItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement);
    const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, current + step));
    items[next].focus();
    items[next].scrollIntoView({ block: "nearest" });
  };

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (FIELD.test(target.tagName) || target.isContentEditable);
    if (typing) {
      if (event.key === "Escape") target.blur();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const inSidebar = document.getElementById("side-list")?.contains(document.activeElement);

    if (pendingG) {
      pendingG = false;
      clearTimeout(pendingTimer);
      if (event.key === "e") {
        event.preventDefault();
        actions.openEngine();
        return;
      }
    }

    switch (event.key) {
      case "j":
      case "ArrowDown":
        if (inSidebar || event.key === "j") {
          event.preventDefault();
          moveSidebar(1);
        }
        return;
      case "k":
      case "ArrowUp":
        if (inSidebar || event.key === "k") {
          event.preventDefault();
          moveSidebar(-1);
        }
        return;
      case "/":
        event.preventDefault();
        actions.focusChat();
        return;
      case "g":
        pendingG = true;
        pendingTimer = setTimeout(() => {
          pendingG = false;
        }, 1000);
        return;
      case "e":
        actions.expandAll();
        return;
      case "[":
        actions.moveActor(-1);
        return;
      case "]":
        actions.moveActor(1);
        return;
      case "^":
        actions.moveActor("parent");
        return;
      case "c":
        actions.focusChat();
        return;
      case "s":
        actions.stop();
        return;
      case "r":
        actions.resume();
        return;
      case "t":
        actions.toggleTheme();
        return;
      case "?":
        event.preventDefault();
        actions.openHelp();
        return;
      case "Escape":
        if (!inSidebar) actions.focusSelected();
        actions.openDrawer(false);
        return;
      default:
        return;
    }
  });
}
