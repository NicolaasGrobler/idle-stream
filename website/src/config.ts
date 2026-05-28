// Single source of truth for repo + download links and the build-time
// GitHub star count. Used by Nav, Hero, FinalCta, and Footer.

export const GITHUB_OWNER = "openidle-dev";
export const GITHUB_REPO  = "idle-stream";
export const GITHUB_URL   = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

// Direct download of the latest published Windows installer.
// GitHub redirects /releases/latest/download/<asset> to the asset of the
// most recent published release, so the URL stays valid across version bumps
// as long as the installer filename doesn't change.
export const INSTALLER_FILENAME = "WirelessMulticamStudio-Setup.exe";
export const DOWNLOAD_URL =
  `${GITHUB_URL}/releases/latest/download/${INSTALLER_FILENAME}`;

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

/** Compact star formatting: 1234 → "1.2k", 12345 → "12k", 0 → "0". */
export function formatStars(n: number): string {
  if (n >= 10_000) return `${Math.floor(n / 1000)}k`;
  if (n >= 1_000)  return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
