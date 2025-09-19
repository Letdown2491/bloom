const encoder = new TextEncoder();

const escapeQuotes = (value: string) => value.replace(/"/g, "%22");

export type MultipartField = {
  name: string;
  value: string;
};

export type MultipartFilePart = {
  field: string;
  fileName: string;
  contentType: string;
  size?: number;
  stream: ReadableStream<Uint8Array>;
};

export type MultipartStreamOptions = {
  boundary?: string;
  file: MultipartFilePart;
  fields?: MultipartField[];
  onProgress?: (loaded: number, total?: number) => void;
};

export type MultipartStreamResult = {
  boundary: string;
  stream: ReadableStream<Uint8Array>;
  contentLength?: number;
};

export function createMultipartStream(options: MultipartStreamOptions): MultipartStreamResult {
  const boundary = options.boundary || `----bloom-${Math.random().toString(16).slice(2)}`;
  const file = options.file;
  const fields = options.fields ?? [];
  const safeFileName = escapeQuotes(file.fileName || "upload.bin");
  const fileHeader = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeQuotes(file.field)}"; filename="${safeFileName}"\r\n` +
      `Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`
  );

  const fieldParts = fields.map(field =>
    encoder.encode(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${escapeQuotes(field.name)}"\r\n\r\n` +
        `${field.value}`
    )
  );

  const closing = encoder.encode(`\r\n--${boundary}--\r\n`);

  const fileReader = file.stream.getReader();
  let loaded = 0;
  const total = typeof file.size === "number" && Number.isFinite(file.size) ? Math.max(0, file.size) : undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(fileHeader);
      if (options.onProgress) {
        options.onProgress(0, total);
      }
    },
    async pull(controller) {
      const { done, value } = await fileReader.read();
      if (done) {
        for (const part of fieldParts) {
          controller.enqueue(part);
        }
        controller.enqueue(closing);
        controller.close();
        if (options.onProgress) {
          options.onProgress(loaded, total);
        }
        return;
      }
      if (value) {
        controller.enqueue(value);
        loaded += value.length;
        if (options.onProgress) {
          options.onProgress(loaded, total);
        }
      }
    },
    cancel(reason) {
      fileReader.cancel(reason).catch(() => undefined);
    },
  });

  let contentLength: number | undefined;
  if (typeof total === "number") {
    const headerLength = fileHeader.length;
    const fieldsLength = fieldParts.reduce((sum, part) => sum + part.length, 0);
    const closingLength = closing.length;
    contentLength = headerLength + total + fieldsLength + closingLength;
  }

  return {
    boundary,
    stream,
    contentLength,
  };
}
