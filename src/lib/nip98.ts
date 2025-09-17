import type { EventTemplate, SignTemplate, SignedEvent } from "./blossomClient";

function encodeAuthHeader(event: SignedEvent) {
  const payload = JSON.stringify(event);
  const base64 = btoa(unescape(encodeURIComponent(payload)));
  return `Nostr ${base64}`;
}

export type Nip98AuthOptions = {
  url: string;
  method: string;
  payloadHash?: string;
  extraTags?: string[][];
};

export async function buildNip98AuthHeader(signTemplate: SignTemplate, options: Nip98AuthOptions) {
  const method = options.method.toUpperCase();
  const tags: string[][] = [["u", options.url], ["method", method]];
  if (options.payloadHash) {
    tags.push(["payload", options.payloadHash]);
  }
  if (options.extraTags) {
    for (const tag of options.extraTags) {
      if (Array.isArray(tag) && tag.length >= 2) {
        tags.push(tag);
      }
    }
  }
  const template: EventTemplate = {
    kind: 27235,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags,
  };
  const signed = await signTemplate(template);
  return encodeAuthHeader(signed);
}
