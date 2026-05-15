/**
 * Moves `element` under a top-level `.print-isolation-root` wrapper, opens the system print dialog,
 * then restores `element` into `restoreParent` when the dialog closes. Hides the rest of the app
 * via `body:has(.print-isolation-root)` rules in `index.css`.
 */
export function printElementIsolated(element: HTMLElement, restoreParent: Element | null): void {
  if (!restoreParent) {
    window.print();
    return;
  }
  const parent = restoreParent;

  const wrapper = document.createElement('div');
  wrapper.className = 'print-isolation-root';
  const shell = document.createElement('div');
  shell.className = 'print-isolation-shell';
  wrapper.appendChild(shell);
  shell.appendChild(element);
  document.body.appendChild(wrapper);

  let restored = false;
  const mq = window.matchMedia('print');

  function restore() {
    if (restored) return;
    restored = true;
    window.removeEventListener('afterprint', onAfterPrint);
    mq.removeEventListener('change', onMqChange);
    if (wrapper.parentNode) {
      parent.appendChild(element);
      wrapper.remove();
    }
  }

  function onAfterPrint() {
    restore();
  }

  function onMqChange() {
    if (!mq.matches) restore();
  }

  window.addEventListener('afterprint', onAfterPrint);
  mq.addEventListener('change', onMqChange);
  window.print();
}
