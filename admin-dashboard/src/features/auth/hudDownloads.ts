/** Provider-specific ZIPs share a binary, but never each other's setup files. */
export function hudDownloads(url: string | null): Array<{ label: string; url: string }> {
  if (!url) return [];
  // New package naming is an explicit sibling-pair contract. Legacy URLs remain unchanged.
  if (/\/FCM-HUD-[^/?]+-zfe\.zip$/.test(url)) {
    return [{ label: 'ZFE', url }, { label: 'xScal', url: url.replace(/-zfe\.zip$/, '-xscal.zip') }];
  }
  return [{ label: 'ZFE / xScal', url }];
}
