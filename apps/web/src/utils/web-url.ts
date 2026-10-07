export function safeWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Bare domains are accepted only when the entire value is a web address. */
export function bookmarkUrl(value: string): string | null {
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) return safeWebUrl(input);
  if (
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(input)
  )
    return safeWebUrl(`https://${input}`);
  return null;
}
