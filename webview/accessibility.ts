const FOCUSABLE = [
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ModalHandle {
  dispose(): void;
}

export function activateModal(
  backdrop: HTMLElement,
  initialFocus: HTMLElement,
  onEscape: () => void,
): ModalHandle {
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  document.body.classList.add("modal-open");
  backdrop.tabIndex = -1;
  const background = Array.from(document.body.children).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element !== backdrop,
  );
  const previousInert = background.map((element) => element.inert);
  for (const element of background) {
    element.inert = true;
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(
      backdrop.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      backdrop.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (!backdrop.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", keydown, true);
  window.setTimeout(() => initialFocus.focus(), 0);

  return {
    dispose() {
      document.removeEventListener("keydown", keydown, true);
      background.forEach((element, index) => {
        element.inert = previousInert[index];
      });
      document.body.classList.remove("modal-open");
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    },
  };
}
