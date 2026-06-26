import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { usePathname } from "expo-router";
import { getActiveAccountContext } from "../../lib/accountContexts";
import { loadTeamBranding } from "../../lib/teamBranding";

function findOrCreateIconLink(rel: string, fallbackHref: string) {
  const existing = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = rel;
  link.href = fallbackHref;
  document.head.appendChild(link);
  return link;
}

export function TeamBrandingEffect() {
  const pathname = usePathname();
  const [refreshToken, setRefreshToken] = useState(0);
  const fallbackIconHrefRef = useRef<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    let cancelled = false;

    async function applyBranding() {
      const icon =
        document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
        document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');
      if (!fallbackIconHrefRef.current) {
        fallbackIconHrefRef.current = icon?.href ?? "/favicon.ico";
      }

      try {
        const context = await getActiveAccountContext();
        const teamId = String(context?.teamId ?? "").trim();
        if (!teamId) throw new Error("No active team context.");
        const branding = await loadTeamBranding(teamId);
        if (cancelled) return;

        const nextHref = branding.logoUrl || fallbackIconHrefRef.current || "/favicon.ico";
        const iconLink = findOrCreateIconLink("icon", fallbackIconHrefRef.current || "/favicon.ico");
        const shortcutIconLink = findOrCreateIconLink("shortcut icon", fallbackIconHrefRef.current || "/favicon.ico");
        iconLink.href = nextHref;
        shortcutIconLink.href = nextHref;
      } catch (error) {
        if (cancelled) return;
        const fallbackHref = fallbackIconHrefRef.current || "/favicon.ico";
        const iconLink = findOrCreateIconLink("icon", fallbackHref);
        const shortcutIconLink = findOrCreateIconLink("shortcut icon", fallbackHref);
        iconLink.href = fallbackHref;
        shortcutIconLink.href = fallbackHref;
        console.warn("[team-branding] favicon fallback applied", error);
      }
    }

    void applyBranding();
    return () => {
      cancelled = true;
    };
  }, [pathname, refreshToken]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const refresh = () => setRefreshToken((value) => value + 1);
    window.addEventListener("training-app-team-branding-updated", refresh);
    return () => {
      window.removeEventListener("training-app-team-branding-updated", refresh);
    };
  }, []);

  return null;
}
