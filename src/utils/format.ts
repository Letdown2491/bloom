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
