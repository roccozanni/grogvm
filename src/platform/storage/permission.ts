/**
 * Browsers do not persist File System Access permissions across sessions,
 * even for a handle that was previously granted. We have to re-query and
 * re-request before reading anything from a stored handle.
 */
export async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const opts: FileSystemHandlePermissionDescriptor = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
