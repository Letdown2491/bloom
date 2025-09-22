import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

type SelectionContextValue = {
  selected: Set<string>;
  isSelected: (sha: string) => boolean;
  toggle: (sha: string) => void;
  selectMany: (shas: string[], value: boolean) => void;
  replace: (shas: string[]) => void;
  clear: () => void;
};

const SelectionContext = createContext<SelectionContextValue | undefined>(undefined);

export const SelectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const isSelected = useCallback((sha: string) => selected.has(sha), [selected]);

  const toggle = useCallback((sha: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(sha)) {
        next.delete(sha);
      } else {
        next.add(sha);
      }
      return next;
    });
  }, []);

  const selectMany = useCallback((shas: string[], value: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      shas.forEach(sha => {
        if (value) {
          next.add(sha);
        } else {
          next.delete(sha);
        }
      });
      return next;
    });
  }, []);

  const replace = useCallback((shas: string[]) => {
    setSelected(new Set(shas));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const value = useMemo<SelectionContextValue>(
    () => ({ selected, isSelected, toggle, selectMany, replace, clear }),
    [selected, isSelected, toggle, selectMany, replace, clear]
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};

export const useSelection = () => {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useSelection must be used within SelectionProvider");
  return ctx;
};
