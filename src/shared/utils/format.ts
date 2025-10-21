export const prettyBytes = (size?: number) => {
  if (!size || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export const prettyDate = (timestamp?: number) => {
  if (!timestamp) return "";

  const date = new Date(timestamp * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const rawTime = timeFormatter.format(date).replace(/\u202f/g, " ");

  if (isToday) {
    const compactTime = rawTime.replace(/\s*(AM|PM)$/i, "$1");
    return `Today, ${compactTime}`;
  }

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return `${dateFormatter.format(date)}, ${rawTime}`;
};

type ExpirationDescription = {
  summary: string;
  absolute?: string;
  relative?: string;
  isExpired: boolean;
  isExpiringSoon: boolean;
};

const expirationDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export const formatRelativeTime = (timestampMs: number, options?: { now?: number }): string => {
  const now = options?.now ?? Date.now();
  const diff = timestampMs - now;
  const divisions: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
    { amount: 60, unit: "minute" },
    { amount: 60, unit: "hour" },
    { amount: 24, unit: "day" },
    { amount: 7, unit: "week" },
    { amount: 4.34524, unit: "month" },
    { amount: 12, unit: "year" },
  ];

  let duration = diff / 1000;
  let unit: Intl.RelativeTimeFormatUnit = "second";

  for (const division of divisions) {
    if (Math.abs(duration) < division.amount) {
      unit = division.unit;
      break;
    }
    duration /= division.amount;
    unit = division.unit;
  }

  try {
    return relativeTimeFormatter.format(Math.round(duration), unit);
  } catch {
    return new Date(timestampMs).toLocaleString();
  }
};

export const describeExpiration = (
  expiresAt: number | null | undefined,
  options?: { now?: number; soonThresholdSeconds?: number },
): ExpirationDescription => {
  const nowSeconds = options?.now ?? Math.floor(Date.now() / 1000);
  const soonThreshold = options?.soonThresholdSeconds ?? 24 * 60 * 60;
  if (!expiresAt || !Number.isFinite(expiresAt)) {
    return {
      summary: "Never expires",
      absolute: undefined,
      relative: undefined,
      isExpired: false,
      isExpiringSoon: false,
    };
  }

  const diffSeconds = Math.floor(expiresAt - nowSeconds);
  const date = new Date(expiresAt * 1000);
  const absolute = expirationDateFormatter.format(date);

  if (diffSeconds <= 0) {
    return {
      summary: `Expired ${absolute}`,
      absolute,
      relative: undefined,
      isExpired: true,
      isExpiringSoon: false,
    };
  }

  let value = diffSeconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  if (diffSeconds >= 365 * 24 * 3600) {
    value = Math.round(diffSeconds / (365 * 24 * 3600));
    unit = "year";
  } else if (diffSeconds >= 30 * 24 * 3600) {
    value = Math.round(diffSeconds / (30 * 24 * 3600));
    unit = "month";
  } else if (diffSeconds >= 7 * 24 * 3600) {
    value = Math.round(diffSeconds / (7 * 24 * 3600));
    unit = "week";
  } else if (diffSeconds >= 24 * 3600) {
    value = Math.round(diffSeconds / (24 * 3600));
    unit = "day";
  } else if (diffSeconds >= 3600) {
    value = Math.round(diffSeconds / 3600);
    unit = "hour";
  } else {
    value = Math.max(1, Math.round(diffSeconds / 60));
    unit = "minute";
  }
  const relative = relativeTimeFormatter.format(value, unit);

  return {
    summary: `Expires ${absolute}${relative ? ` (${relative})` : ""}`,
    absolute,
    relative,
    isExpired: false,
    isExpiringSoon: diffSeconds <= soonThreshold,
  };
};
