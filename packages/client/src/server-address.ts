/** Canonical server origin, shared by browser, desktop profiles and launch configuration. */
export function serverOrigin(value: string): string {
  try {
    const address = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("invalidUrl");
  }
}
