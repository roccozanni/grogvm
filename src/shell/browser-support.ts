export interface UnsupportedReason {
  missing: string[];
  isBrave: boolean;
}

export type BrowserHint = 'brave-fs-api' | null;

export function checkBrowserSupport(): UnsupportedReason | null {
  const missing: string[] = [];

  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
    missing.push('File System Access API (showDirectoryPicker)');
  }
  if (typeof indexedDB === 'undefined') {
    missing.push('IndexedDB');
  }

  if (missing.length === 0) return null;

  return { missing, isBrave: detectBrave() };
}

function detectBrave(): boolean {
  return typeof navigator !== 'undefined' && 'brave' in navigator;
}

export function pickHint(reason: UnsupportedReason): BrowserHint {
  if (reason.isBrave && reason.missing.some((m) => /file system access/i.test(m))) {
    return 'brave-fs-api';
  }
  return null;
}

export function renderUnsupported(reason: UnsupportedReason): HTMLElement {
  const div = document.createElement('div');
  div.className = 'unsupported';
  div.innerHTML = `
    <h1>Unsupported browser</h1>
    <p>This app needs a Chromium-based browser (Chrome, Edge, Arc, Brave) on desktop.</p>
    <p>Missing: <code></code></p>
  `;
  div.querySelector('code')!.textContent = reason.missing.join(', ');

  const hint = pickHint(reason);
  if (hint === 'brave-fs-api') {
    div.appendChild(renderBraveFsHint());
  }

  return div;
}

function renderBraveFsHint(): HTMLElement {
  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML = `
    <p><strong>Looks like you're on Brave.</strong> Brave disables the
    File System Access API by default. To enable it:</p>
    <ol>
      <li>Open <code>brave://flags/#file-system-access-api</code></li>
      <li>Set it to <strong>Enabled</strong></li>
      <li>Relaunch Brave</li>
    </ol>
    <p>Per-site Shields don't cover this one — it's a global flag.</p>
  `;
  return note;
}
