import React from "react";

export type SwitchControlProps = {
  id?: string;
  checked: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
  labelledBy?: string;
  label?: string;
  theme?: "dark" | "light";
};

export const SwitchControl: React.FC<SwitchControlProps> = ({
  id,
  checked,
  onToggle,
  disabled,
  labelledBy,
  label,
  theme = "dark",
}) => {
  const isLightTheme = theme === "light";
  const activeTrackClass = isLightTheme ? "border-blue-600 bg-blue-600" : "border-emerald-500/80 bg-emerald-400/90";
  const inactiveTrackClass = "border-slate-500/80 bg-slate-600/70";

  const trackClass = disabled
    ? "cursor-not-allowed border-slate-600 bg-slate-700/70 opacity-60"
    : checked
      ? activeTrackClass
      : inactiveTrackClass;

  const knobPosition = checked ? "right-1" : "left-1";
  const knobColor = checked
    ? isLightTheme
      ? "border-blue-600 text-blue-600"
      : "border-emerald-500 text-emerald-500"
    : "border-slate-500 text-slate-500";

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={`relative inline-flex h-8 w-16 flex-shrink-0 items-center rounded-full border transition duration-300 ease-out ${trackClass}`}
      onClick={() => {
        if (disabled) return;
        onToggle(!checked);
      }}
    >
      {!labelledBy && label ? <span className="sr-only">{label}</span> : null}
      <span
        className={`pointer-events-none absolute top-1 bottom-1 flex aspect-square items-center justify-center rounded-full border-2 bg-white text-base transition-all duration-300 ease-out ${
          knobPosition
        } ${knobColor}`}
      >
        <span className="sr-only">{checked ? "Enabled" : "Disabled"}</span>
      </span>
    </button>
  );
};
