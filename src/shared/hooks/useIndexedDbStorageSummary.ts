import { useCallback, useEffect, useMemo, useState } from "react";

import { measureIndexedDbUsage, type IndexedDbMeasurement } from "../utils/indexedDbMetrics";

type IndexedDbSummaryState = {
  supported: boolean;
  measuring: boolean;
  measurement: IndexedDbMeasurement | null;
  error?: string;
};

export type IndexedDbStorageSummary = {
  supported: boolean;
  measuring: boolean;
  measurement: IndexedDbMeasurement | null;
  error?: string;
  totalBytes: number;
  refresh: () => Promise<IndexedDbMeasurement | null>;
};

const hasIndexedDbSupport = (): boolean =>
  typeof window !== "undefined" && typeof indexedDB !== "undefined";

export const useIndexedDbStorageSummary = (): IndexedDbStorageSummary => {
  const initialSupport = hasIndexedDbSupport();
  const [state, setState] = useState<IndexedDbSummaryState>({
    supported: initialSupport,
    measuring: false,
    measurement: null,
    error: undefined,
  });

  const refresh = useCallback(async (): Promise<IndexedDbMeasurement | null> => {
    if (!hasIndexedDbSupport()) {
      setState({
        supported: false,
        measuring: false,
        measurement: null,
        error: undefined,
      });
      return null;
    }
    setState(prev => ({
      supported: true,
      measuring: true,
      measurement: prev.measurement,
      error: undefined,
    }));
    try {
      const measurement = await measureIndexedDbUsage();
      setState({
        supported: measurement.supported,
        measuring: false,
        measurement,
        error: undefined,
      });
      return measurement;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to inspect IndexedDB usage.";
      setState(prev => ({
        supported: prev.supported,
        measuring: false,
        measurement: prev.measurement,
        error: message,
      }));
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!hasIndexedDbSupport()) {
      setState({
        supported: false,
        measuring: false,
        measurement: null,
        error: undefined,
      });
      return;
    }
    setState(prev => ({
      supported: true,
      measuring: true,
      measurement: prev.measurement,
      error: undefined,
    }));
    void (async () => {
      try {
        const measurement = await measureIndexedDbUsage();
        if (!cancelled) {
          setState({
            supported: measurement.supported,
            measuring: false,
            measurement,
            error: undefined,
          });
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : "Failed to inspect IndexedDB usage.";
          setState(prev => ({
            supported: prev.supported,
            measuring: false,
            measurement: prev.measurement,
            error: message,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalBytes = useMemo(() => state.measurement?.totalBytes ?? 0, [state.measurement]);

  return {
    supported: state.supported,
    measuring: state.measuring,
    measurement: state.measurement,
    error: state.error,
    totalBytes,
    refresh,
  };
};
