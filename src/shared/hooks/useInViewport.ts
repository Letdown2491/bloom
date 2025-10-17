import { useCallback, useEffect, useRef, useState } from "react";

export function useInViewport<T extends Element>(options?: IntersectionObserverInit) {
  const [target, setTarget] = useState<T | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);

  const thresholdKey = Array.isArray(options?.threshold)
    ? options?.threshold.join(",")
    : options?.threshold ?? 0;

  const cleanupObserver = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  useEffect(() => {
    const element = target;
    if (!element) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsIntersecting(true);
      return;
    }

    const observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      setIsIntersecting(Boolean(entry?.isIntersecting));
    }, options);

    observerRef.current = observer;
    observer.observe(element);

    return () => {
      observer.disconnect();
      if (observerRef.current === observer) {
        observerRef.current = null;
      }
    };
  }, [target, options?.root, options?.rootMargin, thresholdKey]);

  useEffect(() => {
    return () => cleanupObserver();
  }, [cleanupObserver]);

  return [setTarget, isIntersecting] as const;
}
