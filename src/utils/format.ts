export const prettyBytes = (size?: number) => {
  if (!size || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export const prettyDate = (timestamp?: number) => {
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleString();
};

