import type { FileReference } from "@intrica/contracts";
export const isLocalFile = (url: string) =>
  Boolean(url) &&
  !url.startsWith("#") &&
  !url.startsWith("//") &&
  (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^(sandbox|file|intrica-file):/i.test(url));
/** Model text must use scoped file references, never the owner's HTTP file routes. */
export const isOwnerFileUrl = (url: string) => {
  try {
    return /^\/api\/(?:v2\/)?(?:workspace|files|assets|nodes)(?:\/|$)/.test(
      new URL(url, location.href).pathname,
    );
  } catch {
    return true;
  }
};
export function encodeFileReference(reference: FileReference): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(reference))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
