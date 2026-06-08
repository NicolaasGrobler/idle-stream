// Single source of truth for repo + download links and the build-time
// GitHub star count. Used by Nav, Hero, FinalCta, and Footer.

export const GITHUB_OWNER = "openidle-dev";
export const GITHUB_REPO  = "idle-stream";
export const GITHUB_URL   = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

// The Windows installer's filename now carries the release version
// (WirelessMulticamStudio-Setup-<v>.exe), so there's no fixed download URL to
// hardcode — callers resolve the latest release's actual asset via
// getLatestRelease() and fall back to the releases page.

/**
 * Fetch the live star count at build time. Returns `null` on any failure
 * (no network, rate-limited, repo private) so callers can render gracefully
 * instead of breaking the build.
 */
export async function getStarCount(): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "wireless-multicam-studio-landing",
        },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the latest published release's version and the direct download URL of
 * its Windows installer asset, at build time. Resolving the actual asset (rather
 * than a fixed `/releases/latest/download/<name>` URL) keeps the download link
 * valid even though the installer filename now carries the version. Returns
 * `null` on any failure so callers fall back to the releases page with no label.
 */
export async function getLatestRelease(): Promise<
  { version: string; downloadUrl: string } | null
> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "wireless-multicam-studio-landing",
        },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tag_name?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const version = (data.tag_name ?? "").replace(/^v/, "");
    const exe = (data.assets ?? []).find((a) =>
      a.name.toLowerCase().endsWith(".exe"),
    );
    if (!version || !exe) return null;
    return { version, downloadUrl: exe.browser_download_url };
  } catch {
    return null;
  }
}

/** Compact star formatting: 1234 → "1.2k", 12345 → "12k", 0 → "0". */
export function formatStars(n: number): string {
  if (n >= 10_000) return `${Math.floor(n / 1000)}k`;
  if (n >= 1_000)  return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
