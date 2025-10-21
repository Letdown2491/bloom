import { encode } from "blurhash";

export async function computeBlurhash(
  file: File,
): Promise<{ hash: string; width: number; height: number } | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    const width = Math.min(bitmap.width, 128);
    const height = Math.min(bitmap.height, 128);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Unable to get canvas context");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const hash = encode(imageData.data, imageData.width, imageData.height, 4, 4);
    return { hash, width: bitmap.width, height: bitmap.height };
  } catch (error) {
    console.warn("Failed to compute blurhash", error);
    return undefined;
  }
}
