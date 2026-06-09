// Browsers don't persist File System Access permissions across sessions, even
// for a previously granted handle — re-query and re-request before reading.
export async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const opts: FileSystemHandlePermissionDescriptor = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
