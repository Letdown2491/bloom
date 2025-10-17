export async function resizeImage(file: File, maxWidth: number, maxHeight: number): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(maxWidth / bitmap.width, maxHeight / bitmap.height, 1);
  const targetWidth = Math.round(bitmap.width * ratio);
  const targetHeight = Math.round(bitmap.height * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, file.type || "image/jpeg", 0.9));
  if (!blob) return file;
  return new File([blob], file.name, { type: blob.type, lastModified: Date.now() });
}

export async function stripImageMetadata(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, file.type || "image/jpeg", 0.9));
  if (!blob) return file;
  return new File([blob], file.name, { type: blob.type, lastModified: Date.now() });
}

