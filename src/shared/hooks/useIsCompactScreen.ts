import { useEffect, useState } from "react";

export const useIsCompactScreen = (breakpoint = 640): boolean => {
  const [isCompact, setIsCompact] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = `(max-width: ${breakpoint - 1}px)`;
    const media = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setIsCompact((event as MediaQueryList).matches);
    };

    handleChange(media);

    if (typeof media.addEventListener === "function") {
      const listener = (event: MediaQueryListEvent) => handleChange(event);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    }

    if (typeof media.addListener === "function") {
      const legacyListener = (event: MediaQueryListEvent) => handleChange(event);
      media.addListener(legacyListener);
      return () => media.removeListener(legacyListener);
    }

    return () => undefined;
  }, [breakpoint]);

  return isCompact;
};
