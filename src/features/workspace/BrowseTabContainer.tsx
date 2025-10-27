import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FilterMode, SharingFilter } from "../../shared/types/filter";
import { useWorkspace } from "./WorkspaceContext";
import { useSelection } from "../selection/SelectionContext";
import { usePrivateLibrary } from "../../app/context/PrivateLibraryContext";
import { useFolderLists } from "../../app/context/FolderListContext";
import { MoveDialog } from "./ui/MoveDialog";
import type { MoveDialogDestination } from "./ui/MoveDialog";
import { useAudio } from "../../app/context/AudioContext";
import { matchesFilter, createAudioTrack } from "../browse/browseUtils";
import { useAudioMetadataMap } from "../browse/useAudioMetadata";
import type { StatusMessageTone } from "../../shared/types/status";
import type { SharePayload, ShareMode } from "../share/ui/ShareComposer";
import type { BlossomBlob, SignTemplate } from "../../shared/api/blossomClient";
import { extractSha256FromUrl } from "../../shared/api/blossomClient";
import type { ManagedServer } from "../../shared/types/servers";
import type { TabId } from "../../shared/types/tabs";
import { deleteUserBlob, buildAuthorizationHeader } from "../../shared/api/blossomClient";
import { deleteNip96File } from "../../shared/api/nip96Client";
import { deleteSatelliteFile } from "../../shared/api/satelliteClient";
import { useNdk, useCurrentPubkey } from "../../app/context/NdkContext";
import {
  isMusicBlob,
  isImageBlob,
  isVideoBlob,
  isDocumentBlob,
  isPdfBlob,
} from "../../shared/utils/blobClassification";
import { PRIVATE_PLACEHOLDER_SHA, PRIVATE_SERVER_NAME } from "../../shared/constants/private";
import {
  applyFolderUpdate,
  getBlobMetadataName,
  normalizeFolderPathInput,
  rememberFolderPath,
} from "../../shared/utils/blobMetadataStore";
import type { BlobAudioMetadata } from "../../shared/utils/blobMetadataStore";
import {
  deriveNameFromPath,
  isPrivateFolderName,
  type FolderListVisibility,
} from "../../shared/domain/folderList";
import { type BlobReplicaSummary } from "../browse/ui/BlobList";
import { isListLikeBlob } from "../browse/ui/components/blobPreview";
import type { DefaultSortOption, SortDirection } from "../../app/context/UserPreferencesContext";
import { buildNip98AuthHeader } from "../../shared/api/nip98";
import { decryptPrivateBlob } from "../../shared/domain/privateEncryption";
import type { Track } from "../../app/context/AudioContext";
import type { PrivateListEntry } from "../../shared/domain/privateList";
import { useDialog } from "../../app/context/DialogContext";
import type { FolderShareHint, ShareFolderRequest } from "../../shared/types/shareFolder";
import { usePrivateLinks } from "../privateLinks/hooks/usePrivateLinks";
import type { PrivateLinkRecord } from "../../shared/domain/privateLinks";
import { publishNip94Metadata, extractExtraNip94Tags } from "../../shared/api/nip94Publisher";
import { usePreferredRelays } from "../../app/hooks/usePreferredRelays";
import { useFolderManifest } from "./hooks/useFolderManifest";

type MetadataSyncTarget = {
  blob: BlossomBlob;
  folderPath: string | null;
};

type MetadataSyncContext = {
  successMessage?: (count: number) => string;
  errorMessage?: (count: number) => string;
};

const BrowsePanelLazy = React.lazy(() =>
  import("../browse/BrowseTab").then(module => ({ default: module.BrowsePanel })),
);

const normalizeServerUrl = (value: string) => value.replace(/\/+$/, "");
const NEW_FOLDER_OPTION_VALUE = "__bloom_move_create_new_folder__";

const normalizeMatchUrl = (value?: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
};

type SearchField =
  | "artist"
  | "album"
  | "title"
  | "genre"
  | "year"
  | "type"
  | "mime"
  | "server"
  | "folder";

type SearchFlag =
  | "private"
  | "public"
  | "shared"
  | "shared-folder"
  | "shared-file"
  | "shared-link"
  | "audio"
  | "image"
  | "video"
  | "document"
  | "pdf";

type SearchTokenSignature = {
  name: string | null;
  label: string | null;
  type: string | null;
  folderPath: string | null;
  serverUrl: string | null;
  targetPath: string | null;
  size: number | null;
  privateSize: number | null;
  uploaded: number | null;
  privateUpdatedAt: number | null;
  privateName: string | null;
  privateFolderPath: string | null;
  privateType: string | null;
  privateServersRef: readonly string[] | null;
  privateMetadataRef: Record<string, unknown> | null;
  privateAudioRef: Record<string, unknown> | null;
  audioMetadataRef: BlobAudioMetadata | undefined;
};

type CachedSearchTokens = {
  signature: SearchTokenSignature;
  textCandidates: string[];
  fieldCandidates: Partial<Record<SearchField, string[]>>;
  resolvedSize?: number;
  resolvedDuration?: number;
  resolvedYear?: number;
  resolvedUploaded?: number;
};

type SizeComparison = {
  operator: ">" | ">=" | "<" | "<=" | "=";
  value: number;
};

type NumberComparison = {
  operator: SizeComparison["operator"];
  value: number;
};

type ParsedSearchQuery = {
  textTerms: string[];
  excludedTextTerms: string[];
  fieldTerms: Partial<Record<SearchField, string[]>>;
  excludedFieldTerms: Partial<Record<SearchField, string[]>>;
  sizeComparisons: SizeComparison[];
  durationComparisons: NumberComparison[];
  yearComparisons: NumberComparison[];
  beforeTimestamps: number[];
  afterTimestamps: number[];
  onRanges: DateRangeFilter[];
  includeFlags: SearchFlag[];
  excludeFlags: SearchFlag[];
  isActive: boolean;
};

type DateRangeFilter = {
  start: number;
  end: number;
};

const SEARCH_FIELD_ALIASES: Record<string, SearchField> = {
  artist: "artist",
  album: "album",
  title: "title",
  song: "title",
  genre: "genre",
  year: "year",
  type: "type",
  mime: "mime",
  ext: "type",
  server: "server",
  host: "server",
  folder: "folder",
  path: "folder",
};

const IS_FLAG_ALIASES: Record<string, SearchFlag | undefined> = {
  private: "private",
  encrypted: "private",
  public: "public",
  shared: "shared",
  "shared-folder": "shared-folder",
  "shared-folders": "shared-folder",
  "folder-share": "shared-folder",
  "folder-shares": "shared-folder",
  "shared-file": "shared-file",
  "shared-files": "shared-file",
  "file-share": "shared-file",
  "file-shares": "shared-file",
  "shared-link": "shared-link",
  "shared-links": "shared-link",
  "private-link": "shared-link",
  "private-links": "shared-link",
  audio: "audio",
  audios: "audio",
  music: "audio",
  sound: "audio",
  image: "image",
  images: "image",
  photo: "image",
  picture: "image",
  video: "video",
  videos: "video",
  document: "document",
  documents: "document",
  doc: "document",
  text: "document",
  pdf: "pdf",
  pdfs: "pdf",
};

const extractExtension = (value?: string | null) => {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const match = /\.([^.\\/]+)$/.exec(trimmed);
  return match?.[1];
};

const tokenizeSearchInput = (input: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    if (char === '"' || char === "'") {
      if (quote === char) {
        quote = null;
        continue;
      }
      if (!quote) {
        quote = char;
        continue;
      }
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const toUtcSeconds = (year: number, monthIndex: number, day: number) =>
  Math.floor(Date.UTC(year, monthIndex, day) / 1000);

const getUtcStartOfDaySeconds = (date: Date) =>
  Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);

const parseCalendarDateRange = (value: string): DateRangeFilter | null => {
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(normalized)) return null;

  const [yearPart, monthPart, dayPart] = normalized.split("-");
  const year = Number(yearPart);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return null;

  if (!monthPart) {
    const start = toUtcSeconds(year, 0, 1);
    const end = toUtcSeconds(year + 1, 0, 1);
    return { start, end };
  }

  const month = Number(monthPart);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  if (!dayPart) {
    const start = toUtcSeconds(year, month - 1, 1);
    const end = month === 12 ? toUtcSeconds(year + 1, 0, 1) : toUtcSeconds(year, month, 1);
    return { start, end };
  }

  const day = Number(dayPart);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const startMs = Date.UTC(year, month - 1, day);
  const check = new Date(startMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  const start = Math.floor(startMs / 1000);
  const end = Math.floor(Date.UTC(year, month - 1, day + 1) / 1000);
  return { start, end };
};

const parseRelativeOffsetSeconds = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) return null;
  const match =
    /^([+-]?\d+(?:\.\d+)?)(?:\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks))?$/.exec(
      normalized,
    );
  if (!match) return null;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude)) return null;
  const unitRaw = match[2]?.toLowerCase() ?? "s";
  const multiplier = unitRaw.startsWith("w")
    ? 60 * 60 * 24 * 7
    : unitRaw.startsWith("d")
      ? 60 * 60 * 24
      : unitRaw.startsWith("h")
        ? 60 * 60
        : unitRaw.startsWith("m") && unitRaw !== "ms"
          ? 60
          : 1;
  const seconds = magnitude * multiplier;
  if (!Number.isFinite(seconds)) return null;
  return Math.round(seconds);
};

const createDayRangeFromDate = (date: Date): DateRangeFilter => {
  const start = getUtcStartOfDaySeconds(date);
  return { start, end: start + 60 * 60 * 24 };
};

const parseRelativeDateRange = (value: string): DateRangeFilter | null => {
  const offsetSeconds = parseRelativeOffsetSeconds(value);
  if (offsetSeconds == null) return null;
  const target = new Date(Date.now() + offsetSeconds * 1000);
  return createDayRangeFromDate(target);
};

const parseRelativeDatePoint = (value: string): number | null => {
  const offsetSeconds = parseRelativeOffsetSeconds(value);
  if (offsetSeconds == null) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds + offsetSeconds;
};

const parseNamedDateRange = (value: string): DateRangeFilter | null => {
  switch (value) {
    case "today":
      return createDayRangeFromDate(new Date());
    case "yesterday": {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - 1);
      return createDayRangeFromDate(date);
    }
    case "tomorrow": {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + 1);
      return createDayRangeFromDate(date);
    }
    default:
      return null;
  }
};

const resolveDateRangeToken = (token: string): DateRangeFilter | null => {
  const normalized = token.trim();
  if (!normalized) return null;
  const named = parseNamedDateRange(normalized);
  if (named) return named;
  const relative = parseRelativeDateRange(normalized);
  if (relative) return relative;
  return parseCalendarDateRange(normalized);
};

const parseDateRange = (value: string): DateRangeFilter | null => {
  const normalized = value.trim();
  if (!normalized) return null;

  const rangeSeparator = /\.\.\.?/;
  if (rangeSeparator.test(normalized)) {
    const parts = normalized
      .split(rangeSeparator)
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length !== 2) return null;
    const [startRaw, endRaw] = parts as [string, string];
    const startRange = resolveDateRangeToken(startRaw);
    const endRange = resolveDateRangeToken(endRaw);
    if (!startRange || !endRange) return null;
    if (endRange.end <= startRange.start) return null;
    return { start: startRange.start, end: endRange.end };
  }

  return resolveDateRangeToken(normalized);
};

const parseDatePoint = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) return null;
  const relative = parseRelativeDatePoint(normalized);
  if (relative != null) return relative;
  const range = resolveDateRangeToken(normalized);
  return range ? range.start : null;
};

const NUMBER_RANGE_SEPARATOR = /\.\.\.?/;

const parseDurationValue = (value: string): number | null => {
  const match =
    /^(\d+(?:\.\d+)?)(?:\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours))?$/i.exec(
      value.trim(),
    );
  if (!match) return null;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude)) return null;
  const unitRaw = match[2]?.toLowerCase() ?? "s";
  const multiplier = unitRaw.startsWith("h")
    ? 60 * 60
    : unitRaw.startsWith("m") && unitRaw !== "ms"
      ? 60
      : unitRaw === "ms"
        ? 0.001
        : 1;
  const seconds = magnitude * multiplier;
  if (!Number.isFinite(seconds)) return null;
  return seconds >= 0 ? seconds : null;
};

const parseDurationComparison = (value: string): NumberComparison | null => {
  const match =
    /^(?<op>>=|<=|>|<|=)?\s*(?<number>\d+(?:\.\d+)?)(?:\s*(?<unit>ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours))?$/i.exec(
      value.trim(),
    );
  if (!match || !match.groups) return null;
  const rawNumber = Number(match.groups.number);
  if (!Number.isFinite(rawNumber)) return null;
  const unitRaw = match.groups.unit?.toLowerCase() ?? "s";
  const multiplier = unitRaw.startsWith("h")
    ? 60 * 60
    : unitRaw.startsWith("m") && unitRaw !== "ms"
      ? 60
      : unitRaw === "ms"
        ? 0.001
        : 1;
  const seconds = rawNumber * multiplier;
  if (!Number.isFinite(seconds)) return null;
  return { operator: (match.groups.op as NumberComparison["operator"]) ?? ">=", value: seconds };
};

const parseYearComparison = (value: string): NumberComparison | null => {
  const match = /^(?<op>>=|<=|>|<|=)?\s*(?<number>\d{1,4})$/.exec(value.trim());
  if (!match || !match.groups) return null;
  const rawNumber = Number(match.groups.number);
  if (!Number.isFinite(rawNumber)) return null;
  return { operator: (match.groups.op as NumberComparison["operator"]) ?? "=", value: rawNumber };
};

const appendRangeComparisons = (
  target: NumberComparison[],
  range: { min?: number | null; max?: number | null },
) => {
  if (typeof range.min === "number") {
    target.push({ operator: ">=", value: range.min });
  }
  if (typeof range.max === "number") {
    target.push({ operator: "<=", value: range.max });
  }
};

const parseSizeComparison = (value: string): SizeComparison | null => {
  const SIZE_REGEX = /^(?<op>>=|<=|>|<|=)?\s*(?<number>\d+(?:\.\d+)?)\s*(?<unit>kb|mb|gb|tb|b)?$/i;
  const match = SIZE_REGEX.exec(value.trim());
  if (!match || !match.groups) return null;
  const operator = (match.groups.op as SizeComparison["operator"]) ?? ">=";
  const rawNumber = Number(match.groups.number);
  if (!Number.isFinite(rawNumber)) return null;
  const unit = match.groups.unit?.toLowerCase() ?? "b";
  const multiplier =
    unit === "tb"
      ? 1024 ** 4
      : unit === "gb"
        ? 1024 ** 3
        : unit === "mb"
          ? 1024 ** 2
          : unit === "kb"
            ? 1024
            : 1;
  return {
    operator,
    value: rawNumber * multiplier,
  };
};

const parseSearchQuery = (value: string): ParsedSearchQuery => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return {
      textTerms: [],
      excludedTextTerms: [],
      fieldTerms: {},
      excludedFieldTerms: {},
      sizeComparisons: [],
      durationComparisons: [],
      yearComparisons: [],
      beforeTimestamps: [],
      afterTimestamps: [],
      onRanges: [],
      includeFlags: [],
      excludeFlags: [],
      isActive: false,
    };
  }

  const tokens = tokenizeSearchInput(trimmed);
  const textTerms: string[] = [];
  const excludedTextTerms: string[] = [];
  const fieldTerms: Partial<Record<SearchField, string[]>> = {};
  const excludedFieldTerms: Partial<Record<SearchField, string[]>> = {};
  const sizeComparisons: SizeComparison[] = [];
  const durationComparisons: NumberComparison[] = [];
  const yearComparisons: NumberComparison[] = [];
  const beforeTimestamps: number[] = [];
  const afterTimestamps: number[] = [];
  const onRanges: DateRangeFilter[] = [];
  const includeFlags: SearchFlag[] = [];
  const excludeFlags: SearchFlag[] = [];

  tokens.forEach(token => {
    if (!token) return;
    let working = token;
    let isNegated = false;
    if (working.startsWith("not:")) {
      working = working.slice(4);
      isNegated = true;
      if (!working) return;
    }

    const separatorIndex = working.indexOf(":");
    if (separatorIndex > 0) {
      const key = working.slice(0, separatorIndex).trim();
      const rawValue = working.slice(separatorIndex + 1).trim();
      if (key && rawValue) {
        if (key === "size") {
          if (!isNegated) {
            const parts = rawValue.split("...");
            let parsedAny = false;
            parts.forEach(part => {
              const comparison = parseSizeComparison(part);
              if (comparison) {
                sizeComparisons.push(comparison);
                parsedAny = true;
              }
            });
            if (parsedAny) {
              return;
            }
          }
        } else if (key === "duration") {
          if (!isNegated) {
            if (NUMBER_RANGE_SEPARATOR.test(rawValue)) {
              const segments = rawValue.split(NUMBER_RANGE_SEPARATOR);
              if (segments.length === 2) {
                const [minRaw, maxRaw] = segments as [string, string];
                const minValue = minRaw ? parseDurationValue(minRaw) : undefined;
                const maxValue = maxRaw ? parseDurationValue(maxRaw) : undefined;
                if ((minRaw && minValue == null) || (maxRaw && maxValue == null)) {
                  // fall through to treat as text term
                } else {
                  const normalizedMin = typeof minValue === "number" ? minValue : undefined;
                  const normalizedMax = typeof maxValue === "number" ? maxValue : undefined;
                  if (
                    typeof normalizedMin === "number" &&
                    typeof normalizedMax === "number" &&
                    normalizedMax < normalizedMin
                  ) {
                    appendRangeComparisons(durationComparisons, {
                      min: normalizedMax,
                      max: normalizedMin,
                    });
                  } else {
                    appendRangeComparisons(durationComparisons, {
                      min: normalizedMin,
                      max: normalizedMax,
                    });
                  }
                  return;
                }
              }
            } else {
              const comparison = parseDurationComparison(rawValue);
              if (comparison) {
                durationComparisons.push(comparison);
                return;
              }
            }
          }
        } else if (key === "year") {
          if (!isNegated) {
            if (NUMBER_RANGE_SEPARATOR.test(rawValue)) {
              const segments = rawValue.split(NUMBER_RANGE_SEPARATOR);
              if (segments.length === 2) {
                const [minRaw, maxRaw] = segments as [string, string];
                const minValue = minRaw ? Number(minRaw.trim()) : undefined;
                const maxValue = maxRaw ? Number(maxRaw.trim()) : undefined;
                const minResolved =
                  typeof minValue === "number" && Number.isFinite(minValue)
                    ? Math.floor(minValue)
                    : undefined;
                const maxResolved =
                  typeof maxValue === "number" && Number.isFinite(maxValue)
                    ? Math.floor(maxValue)
                    : undefined;
                if ((minRaw && minResolved == null) || (maxRaw && maxResolved == null)) {
                  // fall through unless both are valid
                } else if (
                  typeof minResolved === "number" &&
                  typeof maxResolved === "number" &&
                  maxResolved < minResolved
                ) {
                  appendRangeComparisons(yearComparisons, { min: maxResolved, max: minResolved });
                  return;
                } else {
                  appendRangeComparisons(yearComparisons, { min: minResolved, max: maxResolved });
                  return;
                }
              }
            } else {
              const comparison = parseYearComparison(rawValue);
              if (comparison) {
                yearComparisons.push(comparison);
                return;
              }
            }
          }
        } else if (key === "before") {
          if (!isNegated) {
            const point = parseDatePoint(rawValue);
            if (point !== null) {
              beforeTimestamps.push(point);
              return;
            }
          }
        } else if (key === "after") {
          if (!isNegated) {
            const point = parseDatePoint(rawValue);
            if (point !== null) {
              afterTimestamps.push(point);
              return;
            }
          }
        } else if (key === "on") {
          if (!isNegated) {
            const range = parseDateRange(rawValue);
            if (range) {
              onRanges.push(range);
              return;
            }
          }
        } else if (key === "is") {
          const flag = IS_FLAG_ALIASES[rawValue];
          if (flag) {
            if (isNegated) {
              if (!excludeFlags.includes(flag)) {
                excludeFlags.push(flag);
              }
            } else if (!includeFlags.includes(flag)) {
              includeFlags.push(flag);
            }
            return;
          }
        } else {
          const alias = SEARCH_FIELD_ALIASES[key];
          if (alias) {
            const target = isNegated ? excludedFieldTerms : fieldTerms;
            const values = target[alias] ?? [];
            values.push(rawValue);
            target[alias] = values;
            return;
          }
        }
      }
    }

    if (working) {
      if (isNegated) {
        excludedTextTerms.push(working);
      } else {
        textTerms.push(working);
      }
    }
  });

  const hasFieldValues = Object.values(fieldTerms).some(list => (list?.length ?? 0) > 0);
  const hasExcludedFieldValues = Object.values(excludedFieldTerms).some(
    list => (list?.length ?? 0) > 0,
  );
  const isActive =
    textTerms.length > 0 ||
    excludedTextTerms.length > 0 ||
    sizeComparisons.length > 0 ||
    durationComparisons.length > 0 ||
    yearComparisons.length > 0 ||
    beforeTimestamps.length > 0 ||
    afterTimestamps.length > 0 ||
    onRanges.length > 0 ||
    includeFlags.length > 0 ||
    excludeFlags.length > 0 ||
    hasFieldValues ||
    hasExcludedFieldValues;

  return {
    textTerms,
    excludedTextTerms,
    fieldTerms,
    excludedFieldTerms,
    sizeComparisons,
    durationComparisons,
    yearComparisons,
    beforeTimestamps,
    afterTimestamps,
    onRanges,
    includeFlags,
    excludeFlags,
    isActive,
  };
};

type FolderNode = {
  path: string;
  name: string;
  parent: string | null;
  children: Set<string>;
  items: BlossomBlob[];
  latestUploaded: number;
};

type FolderScope = "aggregated" | "server" | "private";

type MoveDialogState =
  | { kind: "blob"; blob: BlossomBlob; currentPath: string | null; isPrivate: boolean }
  | {
      kind: "folder";
      path: string;
      name: string;
      currentParent: string | null;
      scope: FolderScope;
      isPrivate: boolean;
    };

const folderPlaceholderSha = (scope: FolderScope, path: string, variant: "node" | "up") => {
  const encodedPath = encodeURIComponent(path || "__root__");
  return `__folder__:${scope}:${encodedPath}:${variant}`;
};

const getParentFolderPath = (path: string): string | null => {
  if (!path) return null;
  const segments = path.split("/");
  segments.pop();
  if (segments.length === 0) return "";
  return segments.join("/");
};

const buildFolderIndex = (blobs: readonly BlossomBlob[]): Map<string, FolderNode> => {
  const root: FolderNode = {
    path: "",
    name: "",
    parent: null,
    children: new Set(),
    items: [],
    latestUploaded: 0,
  };
  const nodes = new Map<string, FolderNode>();
  nodes.set("", root);

  const applyLatestUploaded = (path: string, uploaded: number) => {
    if (!uploaded) return;
    const node = nodes.get(path);
    if (!node) return;
    if (uploaded > node.latestUploaded) {
      node.latestUploaded = uploaded;
    }
  };

  blobs.forEach(blob => {
    const normalizedPath = normalizeFolderPathInput(blob.folderPath ?? undefined);
    const uploadedValue = typeof blob.uploaded === "number" ? blob.uploaded : 0;

    applyLatestUploaded("", uploadedValue);

    if (!normalizedPath) {
      root.items.push(blob);
      return;
    }
    const segments = normalizedPath.split("/");
    let parentPath = "";
    segments.forEach(segment => {
      const currentPath = parentPath ? `${parentPath}/${segment}` : segment;
      if (!nodes.has(currentPath)) {
        nodes.set(currentPath, {
          path: currentPath,
          name: segment,
          parent: parentPath,
          children: new Set(),
          items: [],
          latestUploaded: 0,
        });
      }
      const parentNode = nodes.get(parentPath);
      if (parentNode) {
        parentNode.children.add(currentPath);
      }
      applyLatestUploaded(currentPath, uploadedValue);
      parentPath = currentPath;
    });
    const leafNode = nodes.get(parentPath);
    if (leafNode) {
      leafNode.items.push(blob);
    }
  });

  return nodes;
};

type BuildFolderViewOptions = {
  activePath: string;
  scope: FolderScope;
  serverUrl?: string | null;
  serverType?: BlossomBlob["serverType"];
  requiresAuth?: boolean;
  resolveFolderName?: (path: string) => string;
};

const createFolderPlaceholder = (
  options: BuildFolderViewOptions & {
    path: string;
    name: string;
    targetPath: string | null;
    isParent?: boolean;
    latestUploaded?: number;
  },
): BlossomBlob => {
  const {
    scope,
    path,
    name,
    serverUrl,
    serverType,
    requiresAuth,
    targetPath,
    isParent = false,
    latestUploaded,
  } = options;
  const placeholder: BlossomBlob = {
    sha256: folderPlaceholderSha(scope, path, isParent ? "up" : "node"),
    name,
    type: "application/x-directory",
    size: 0,
    serverUrl: serverUrl ?? undefined,
    serverType,
    requiresAuth: Boolean(requiresAuth),
    uploaded: latestUploaded ?? 0,
    url: undefined,
    folderPath: targetPath ?? null,
    __bloomFolderPlaceholder: true,
    __bloomFolderScope: scope,
    __bloomFolderTargetPath: targetPath,
    __bloomFolderIsParentLink: isParent,
  };
  return placeholder;
};

const buildFolderViewFromIndex = (
  index: Map<string, FolderNode>,
  allBlobs: readonly BlossomBlob[],
  options: BuildFolderViewOptions,
): { list: BlossomBlob[]; parentPath: string | null } => {
  const targetPath = options.activePath;
  const node = index.get(targetPath) ?? index.get("");
  if (!node) {
    return { list: allBlobs.slice(), parentPath: null };
  }
  const childPaths = Array.from(node.children);
  childPaths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const childPlaceholders = childPaths.map(path => {
    const childNode = index.get(path);
    const defaultName = childNode?.name ?? path.split("/").pop() ?? path;
    const folderName = options.resolveFolderName ? options.resolveFolderName(path) : defaultName;
    return createFolderPlaceholder({
      ...options,
      path,
      name: folderName,
      targetPath: path,
      latestUploaded: childNode?.latestUploaded,
    });
  });
  const parentPath = getParentFolderPath(targetPath);
  const list: BlossomBlob[] = [];
  list.push(...childPlaceholders);
  list.push(...node.items);
  return { list, parentPath };
};

export type BrowseTabContainerProps = {
  active: boolean;
  onStatusMetricsChange: (metrics: { count: number; size: number }) => void;
  onRequestRename: (blob: BlossomBlob) => void;
  onRequestFolderRename: (target: FolderRenameTarget) => void;
  onRequestShare: (payload: SharePayload, options?: { mode?: ShareMode }) => void;
  onShareFolder: (request: ShareFolderRequest) => void;
  onUnshareFolder: (request: ShareFolderRequest) => void;
  folderShareBusyPath?: string | null;
  onSetTab: (tab: TabId) => void;
  showStatusMessage: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  viewMode: "grid" | "list";
  filterMode: FilterMode;
  sharingFilter: SharingFilter;
  onlyPrivateLinks: boolean;
  filterMenuRef: React.RefObject<HTMLDivElement>;
  isFilterMenuOpen: boolean;
  onCloseFilterMenu: () => void;
  onBrowseTabChange: (tabId: string) => void;
  showGridPreviews: boolean;
  showListPreviews: boolean;
  homeResetKey: number;
  defaultSortOption: DefaultSortOption;
  sortDirection: SortDirection;
  onNavigationChange?: (navigation: BrowseNavigationState | null) => void;
  searchTerm: string;
  onActiveListChange?: (state: BrowseActiveListState | null) => void;
  restoreActiveList?: BrowseActiveListState | null;
  restoreActiveListKey?: number | null;
  onRestoreActiveList?: () => void;
};

export type BrowseActiveListState =
  | { type: "private"; serverUrl: string | null }
  | { type: "folder"; scope: FolderScope; path: string; serverUrl?: string | null };

type ActiveListState = BrowseActiveListState;

export type FolderRenameTarget = {
  path: string;
  scope: FolderScope;
  serverUrl?: string | null;
};

export type BrowseNavigationSegment = {
  id: string;
  label: string;
  onNavigate: () => void;
  visibility?: FolderListVisibility | null;
};

export type BrowseNavigationState = {
  segments: BrowseNavigationSegment[];
  canNavigateUp: boolean;
  onNavigateHome: () => void;
  onNavigateUp: () => void;
};

export const BrowseTabContainer: React.FC<BrowseTabContainerProps> = ({
  active,
  onStatusMetricsChange,
  onRequestRename,
  onRequestFolderRename,
  onRequestShare,
  onShareFolder,
  onUnshareFolder,
  folderShareBusyPath = null,
  onSetTab,
  showStatusMessage,
  viewMode,
  filterMode,
  sharingFilter,
  onlyPrivateLinks,
  filterMenuRef,
  isFilterMenuOpen,
  onCloseFilterMenu,
  onBrowseTabChange,
  showGridPreviews,
  showListPreviews,
  homeResetKey,
  defaultSortOption,
  sortDirection,
  onNavigationChange,
  searchTerm,
  onActiveListChange,
  restoreActiveList,
  restoreActiveListKey,
  onRestoreActiveList,
}) => {
  const {
    aggregated,
    snapshots,
    blobReplicaInfo,
    browsingAllServers,
    currentSnapshot,
    selectedServer,
    servers,
    privateBlobs,
    privateEntries,
  } = useWorkspace();
  const {
    selected: selectedBlobs,
    toggle: toggleBlob,
    selectMany: selectManyBlobs,
    replace: replaceSelection,
    clear: clearSelection,
  } = useSelection();
  const audio = useAudio();
  const queryClient = useQueryClient();
  const { effectiveRelays } = usePreferredRelays();

  const {
    links: privateLinks,
    serviceConfigured: privateLinkServiceConfigured,
    serviceHost: privateLinkServiceHost,
  } = usePrivateLinks({ enabled: true });
  const privateLinkHost = useMemo(
    () => privateLinkServiceHost.replace(/\/+$/, ""),
    [privateLinkServiceHost],
  );
  const findExistingPrivateLink = useCallback(
    (blob: BlossomBlob): PrivateLinkRecord | null => {
      if (!privateLinkServiceConfigured) return null;
      const blobSha = blob.sha256 ?? null;
      const blobUrl = normalizeMatchUrl(blob.url ?? null);
      for (const record of privateLinks) {
        if (!record || record.status !== "active" || record.isExpired) continue;
        const target = record.target;
        if (!target) continue;
        const targetSha = target.sha256 ?? null;
        const targetUrl = normalizeMatchUrl(target.url ?? null);
        const matchesSha = Boolean(blobSha && targetSha && blobSha === targetSha);
        const matchesUrl = Boolean(blobUrl && targetUrl && blobUrl === targetUrl);
        if (matchesSha || matchesUrl) {
          return record;
        }
      }
      return null;
    },
    [privateLinks, privateLinkServiceConfigured],
  );
  const privateLinkPresence = useMemo(() => {
    if (!privateLinkServiceConfigured) return null;
    const shaSet = new Set<string>();
    const urlSet = new Set<string>();
    privateLinks.forEach(record => {
      if (!record || record.status !== "active" || record.isExpired) return;
      const sha = record.target?.sha256?.toLowerCase();
      if (sha) {
        shaSet.add(sha);
      }
      const url = normalizeMatchUrl(record.target?.url ?? null);
      if (url) {
        urlSet.add(url);
      }
    });
    return { shaSet, urlSet };
  }, [privateLinkServiceConfigured, privateLinks]);
  const { ndk, signer, signEventTemplate } = useNdk();
  const resolvePrivateLink = useCallback(
    (blob: BlossomBlob) => {
      if (!privateLinkServiceConfigured) return null;
      const record = findExistingPrivateLink(blob);
      if (!record) return null;
      const alias = record.alias ?? null;
      const directUrl = alias ? `${privateLinkHost}/${alias}` : (record.target?.url ?? null);
      if (!directUrl) return null;
      return { url: directUrl, alias, expiresAt: record.expiresAt ?? null };
    },
    [findExistingPrivateLink, privateLinkHost, privateLinkServiceConfigured],
  );
  const pubkey = useCurrentPubkey();
  const folderManifest = useFolderManifest();
  const {
    entriesBySha,
    removeEntries,
    upsertEntries,
    refresh: refreshPrivateEntries,
  } = usePrivateLibrary();
  const {
    folders,
    deleteFolder,
    foldersByPath,
    getFolderDisplayName,
    removeBlobFromFolder,
    resolveFolderPath,
    renameFolder,
    getFoldersForBlob,
    setBlobFolderMembership,
  } = useFolderLists();
  const { confirm } = useDialog();
  const [activeList, setActiveList] = useState<ActiveListState | null>(null);
  const playbackUrlCacheRef = useRef(new Map<string, string>());
  const lastPlayRequestRef = useRef<string | undefined>();
  const autoPrivateNavigationRef = useRef<{ previous: ActiveListState | null } | null>(null);
  const [moveState, setMoveState] = useState<MoveDialogState | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  useEffect(() => {
    onActiveListChange?.(activeList);
  }, [activeList, onActiveListChange]);

  useEffect(() => {
    if (restoreActiveListKey == null) return;
    setActiveList(() => (restoreActiveList ? { ...restoreActiveList } : null));
    clearSelection();
    onRestoreActiveList?.();
  }, [restoreActiveListKey, restoreActiveList, clearSelection, onRestoreActiveList]);

  const metadataSource = useMemo(
    () => [...aggregated.blobs, ...privateBlobs],
    [aggregated.blobs, privateBlobs],
  );
  const metadataMap = useAudioMetadataMap(metadataSource);
  const searchTokenCacheRef = useRef(new WeakMap<BlossomBlob, CachedSearchTokens>());

  const searchQuery = useMemo(() => parseSearchQuery(searchTerm), [searchTerm]);
  const isSearching = searchQuery.isActive;
  const resolveSharingDetails = useCallback(
    (blob: BlossomBlob) => {
      const isFolderPlaceholder = Boolean(blob.__bloomFolderPlaceholder);
      const isParentLink = Boolean(blob.__bloomFolderIsParentLink);
      const isFolderLike = isFolderPlaceholder || isListLikeBlob(blob);
      const rawFolderPath = isFolderPlaceholder
        ? (blob.__bloomFolderTargetPath ?? null)
        : (blob.folderPath ?? null);
      const normalizedFolderPath = normalizeFolderPathInput(rawFolderPath ?? undefined);
      const canonicalFolderPath =
        typeof normalizedFolderPath === "string" ? resolveFolderPath(normalizedFolderPath) : null;
      const folderRecord =
        canonicalFolderPath !== null ? (foldersByPath.get(canonicalFolderPath) ?? null) : null;
      const membershipPaths = blob.sha256 ? getFoldersForBlob(blob.sha256) : [];
      const isSharedViaMembership = membershipPaths.some(path => {
        const record = foldersByPath.get(path);
        return record?.visibility === "public";
      });
      const isSharedFolder = Boolean(
        isFolderLike && !isParentLink && folderRecord && folderRecord.visibility === "public",
      );
      const isSharedFile =
        !isFolderLike &&
        (isSharedViaMembership ||
          (canonicalFolderPath !== null && folderRecord?.visibility === "public"));
      const isSharedItem = isSharedFolder || isSharedFile;
      const normalizedBlobUrl = normalizeMatchUrl(blob.url ?? null);
      const hasPrivateLink =
        privateLinkServiceConfigured &&
        Boolean(
          privateLinkPresence &&
            ((blob.sha256 && privateLinkPresence.shaSet.has(blob.sha256.toLowerCase())) ||
              (normalizedBlobUrl && privateLinkPresence.urlSet.has(normalizedBlobUrl))),
        );
      const isPublicBlob = !blob.privateData;
      return {
        isFolderPlaceholder,
        isParentLink,
        isFolderLike,
        isSharedFolder,
        isSharedFile,
        isSharedItem,
        hasPrivateLink,
        isPublicBlob,
      };
    },
    [
      foldersByPath,
      getFoldersForBlob,
      privateLinkPresence,
      privateLinkServiceConfigured,
      resolveFolderPath,
    ],
  );
  const matchesSharingFilter = useCallback(
    (blob: BlossomBlob) => {
      if (blob.sha256 === PRIVATE_PLACEHOLDER_SHA) {
        return true;
      }
      const { isSharedItem, hasPrivateLink } = resolveSharingDetails(blob);
      if (sharingFilter === "shared" && !isSharedItem) {
        return false;
      }
      if (sharingFilter === "not-shared" && isSharedItem) {
        return false;
      }
      if (onlyPrivateLinks && !hasPrivateLink) {
        return false;
      }
      return true;
    },
    [onlyPrivateLinks, resolveSharingDetails, sharingFilter],
  );
  const applyContentFilters = useCallback(
    (source: BlossomBlob[]) => {
      const typeFiltered =
        filterMode === "all" ? source : source.filter(blob => matchesFilter(blob, filterMode));
      if (sharingFilter === "all" && !onlyPrivateLinks) {
        return typeFiltered;
      }
      return typeFiltered.filter(matchesSharingFilter);
    },
    [filterMode, matchesSharingFilter, onlyPrivateLinks, sharingFilter],
  );

  const reinforceFolderAssignments = useCallback(
    (source: readonly BlossomBlob[]): BlossomBlob[] => {
      let changed = false;
      const mapped = source.map(blob => {
        if (!blob || blob.__bloomFolderPlaceholder) {
          return blob;
        }
        const normalizedDirect = normalizeFolderPathInput(blob.folderPath ?? undefined);
        if (typeof normalizedDirect === "string" && normalizedDirect.length > 0) {
          if (blob.folderPath !== normalizedDirect) {
            changed = true;
            return {
              ...blob,
              folderPath: normalizedDirect,
            };
          }
          return blob;
        }
        if (!blob.sha256) {
          return blob;
        }
        const membershipPaths = getFoldersForBlob(blob.sha256);
        if (!membershipPaths || membershipPaths.length === 0) {
          return blob;
        }
        const targetPath = membershipPaths.find(
          path => typeof path === "string" && path.trim().length > 0,
        );
        if (!targetPath) {
          return blob;
        }
        const canonical = resolveFolderPath(targetPath) ?? targetPath;
        const normalizedMembership = normalizeFolderPathInput(canonical);
        if (typeof normalizedMembership !== "string" || normalizedMembership.length === 0) {
          return blob;
        }
        if (blob.folderPath === normalizedMembership) {
          return blob;
        }
        changed = true;
        return {
          ...blob,
          folderPath: normalizedMembership,
        };
      });
      return changed ? mapped : (source as BlossomBlob[]);
    },
    [getFoldersForBlob, resolveFolderPath],
  );

  const signaturesEqual = (prev: SearchTokenSignature, next: SearchTokenSignature) => {
    return (
      prev.name === next.name &&
      prev.label === next.label &&
      prev.type === next.type &&
      prev.folderPath === next.folderPath &&
      prev.serverUrl === next.serverUrl &&
      prev.targetPath === next.targetPath &&
      prev.size === next.size &&
      prev.privateSize === next.privateSize &&
      prev.uploaded === next.uploaded &&
      prev.privateUpdatedAt === next.privateUpdatedAt &&
      prev.privateName === next.privateName &&
      prev.privateFolderPath === next.privateFolderPath &&
      prev.privateType === next.privateType &&
      prev.privateServersRef === next.privateServersRef &&
      prev.privateMetadataRef === next.privateMetadataRef &&
      prev.privateAudioRef === next.privateAudioRef &&
      prev.audioMetadataRef === next.audioMetadataRef
    );
  };

  const buildSearchTokens = (
    blob: BlossomBlob,
    signature: SearchTokenSignature,
    privateMetadata: Record<string, unknown> | null,
    audioMetadata: BlobAudioMetadata | undefined,
  ): CachedSearchTokens => {
    const getPrivateValue = <T = unknown,>(key: string): T | undefined => {
      if (!privateMetadata) return undefined;
      return (privateMetadata as Record<string, unknown>)[key] as T | undefined;
    };
    const privateAudio = (getPrivateValue<Record<string, unknown> | null>("audio") ??
      null) as Record<string, unknown> | null;

    const coerceValue = (value: unknown): string | undefined => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
      return undefined;
    };

    const coerceLower = (value: unknown): string | undefined => {
      const coerced = coerceValue(value);
      return coerced ? coerced.toLowerCase() : undefined;
    };

    const coerceNumeric = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return undefined;
    };

    const textSet = new Set<string>();
    const typeSet = new Set<string>();
    const mimeSet = new Set<string>();
    const serverSet = new Set<string>();
    const folderSet = new Set<string>();

    const addTextCandidate = (value?: string | null) => {
      const normalized = coerceLower(value);
      if (normalized) {
        textSet.add(normalized);
      }
    };

    const addMimeCandidate = (value?: string | null) => {
      const normalized = coerceLower(value);
      if (!normalized) return;
      mimeSet.add(normalized);
      const slashIndex = normalized.indexOf("/");
      if (slashIndex > 0) {
        const category = normalized.slice(0, slashIndex);
        if (category) {
          mimeSet.add(category);
          typeSet.add(category);
        }
      }
    };

    const addTypeCandidate = (value?: string | null) => {
      const extension = extractExtension(value);
      if (!extension) return;
      typeSet.add(extension.toLowerCase());
    };

    const addServerCandidate = (value?: string | null) => {
      if (typeof value !== "string") return;
      const normalized = coerceLower(value);
      if (normalized) {
        serverSet.add(normalized);
      }
      const sanitized = normalizeServerUrl(value);
      if (sanitized) {
        serverSet.add(sanitized.toLowerCase());
      }
      try {
        const parsed = new URL(value);
        serverSet.add(parsed.origin.toLowerCase());
        serverSet.add(parsed.host.toLowerCase());
        serverSet.add(parsed.hostname.toLowerCase());
      } catch {
        // Ignore parse failures.
      }
    };

    const addFolderCandidate = (value?: string | null) => {
      const normalized = normalizeFolderPathInput(value ?? undefined);
      if (typeof normalized === "string") {
        const trimmed = normalized.trim();
        folderSet.add(trimmed ? trimmed.toLowerCase() : "/");
      }
      const lowered = coerceLower(value);
      if (lowered) {
        folderSet.add(lowered);
      }
    };

    addMimeCandidate(blob.type);
    addTypeCandidate(blob.name);
    addTypeCandidate(blob.label);
    addServerCandidate(blob.serverUrl);
    addFolderCandidate(blob.folderPath ?? null);
    addTextCandidate(blob.name);
    addTextCandidate(blob.label);
    addTextCandidate(blob.folderPath ?? undefined);
    addTextCandidate(blob.type);
    addTextCandidate(blob.serverUrl);

    const privateName = getPrivateValue<string | null>("name") ?? undefined;
    const privateType = getPrivateValue<string | null>("type") ?? undefined;
    const privateFolder = getPrivateValue<string | null>("folderPath") ?? undefined;

    addMimeCandidate(privateType);
    addTypeCandidate(privateName);
    addFolderCandidate(privateFolder ?? null);
    addTextCandidate(privateName);
    addTextCandidate(privateFolder);
    addTextCandidate(privateType);

    const privateServers = Array.isArray(
      (blob.privateData as { servers?: string[] } | undefined)?.servers,
    )
      ? ((blob.privateData as { servers?: string[] } | undefined)?.servers as string[])
      : [];
    privateServers.forEach(server => addServerCandidate(server));

    const targetPath = blob.__bloomFolderTargetPath ?? null;
    if (targetPath) {
      addFolderCandidate(targetPath);
      addTextCandidate(targetPath);
    }

    const audioStrings: Partial<Record<keyof BlobAudioMetadata, string>> = {};
    const audioNumbers: Partial<Record<keyof BlobAudioMetadata, number>> = {};

    const assignAudioString = (field: keyof BlobAudioMetadata, fallback?: string | undefined) => {
      const fromPublic = coerceLower(audioMetadata?.[field]);
      const fromPrivate = coerceLower(privateAudio?.[field as string]);
      const value = fromPublic ?? fromPrivate ?? (fallback ? fallback.toLowerCase() : undefined);
      if (value) {
        audioStrings[field] = value;
      }
    };

    const assignAudioNumber = (field: keyof BlobAudioMetadata) => {
      const fromPublic = coerceNumeric(audioMetadata?.[field]);
      if (typeof fromPublic === "number") {
        audioNumbers[field] = fromPublic;
        return;
      }
      const fromPrivate = coerceNumeric(privateAudio?.[field as string]);
      if (typeof fromPrivate === "number") {
        audioNumbers[field] = fromPrivate;
      }
    };

    assignAudioString("artist");
    assignAudioString("album");
    assignAudioString("genre");
    const titleFallback = coerceValue(privateName) ?? coerceValue(blob.name);
    assignAudioString("title", titleFallback);
    assignAudioString("year");

    assignAudioNumber("durationSeconds");
    assignAudioNumber("year");

    Object.values(audioStrings).forEach(value => {
      if (value) {
        textSet.add(value);
      }
    });

    const typeTokens = Array.from(typeSet);
    const mimeTokens = Array.from(mimeSet);
    const serverTokens = Array.from(serverSet);
    const folderTokens = Array.from(folderSet);

    typeTokens.forEach(token => textSet.add(token));
    mimeTokens.forEach(token => textSet.add(token));
    serverTokens.forEach(token => textSet.add(token));
    folderTokens.forEach(token => textSet.add(token));

    const fieldCandidates: Partial<Record<SearchField, string[]>> = {};

    if (audioStrings.artist) {
      fieldCandidates.artist = [audioStrings.artist];
    }
    if (audioStrings.album) {
      fieldCandidates.album = [audioStrings.album];
    }
    if (audioStrings.title) {
      fieldCandidates.title = [audioStrings.title];
    }
    if (audioStrings.genre) {
      fieldCandidates.genre = [audioStrings.genre];
    }
    if (audioStrings.year) {
      fieldCandidates.year = [audioStrings.year];
    }
    if (typeTokens.length > 0) {
      fieldCandidates.type = typeTokens;
    }
    if (mimeTokens.length > 0) {
      fieldCandidates.mime = mimeTokens;
    }
    if (serverTokens.length > 0) {
      fieldCandidates.server = serverTokens;
    }
    if (folderTokens.length > 0) {
      fieldCandidates.folder = folderTokens;
    }

    const resolvedSize = (() => {
      const privateSize = getPrivateValue<number>("size");
      if (typeof blob.size === "number" && Number.isFinite(blob.size)) return blob.size;
      if (typeof privateSize === "number" && Number.isFinite(privateSize)) return privateSize;
      return undefined;
    })();

    const resolvedDuration =
      typeof audioNumbers.durationSeconds === "number" ? audioNumbers.durationSeconds : undefined;
    const resolvedYear =
      typeof audioNumbers.year === "number" && Number.isFinite(audioNumbers.year)
        ? Math.floor(audioNumbers.year)
        : undefined;
    const resolvedUploaded =
      typeof blob.uploaded === "number" && Number.isFinite(blob.uploaded)
        ? blob.uploaded
        : undefined;

    return {
      signature,
      textCandidates: Array.from(textSet),
      fieldCandidates,
      resolvedSize,
      resolvedDuration,
      resolvedYear,
      resolvedUploaded,
    };
  };

  const getSearchTokens = useCallback(
    (blob: BlossomBlob): CachedSearchTokens => {
      const privateMetadata = (blob.privateData?.metadata ?? null) as Record<
        string,
        unknown
      > | null;
      const audioMetadata = metadataMap.get(blob.sha256);

      const safeNumber = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const safeString = (value: unknown): string | null =>
        typeof value === "string" ? value : null;
      const getPrivateValue = <T = unknown,>(key: string): T | undefined => {
        if (!privateMetadata) return undefined;
        return (privateMetadata as Record<string, unknown>)[key] as T | undefined;
      };

      const signature: SearchTokenSignature = {
        name: safeString(blob.name),
        label: safeString(blob.label),
        type: safeString(blob.type),
        folderPath: safeString(blob.folderPath),
        serverUrl: safeString(blob.serverUrl),
        targetPath: safeString(blob.__bloomFolderTargetPath),
        size: safeNumber(blob.size),
        privateSize: safeNumber(getPrivateValue("size")),
        uploaded: safeNumber(blob.uploaded),
        privateUpdatedAt: safeNumber(getPrivateValue("updatedAt")),
        privateName: safeString(getPrivateValue("name")),
        privateFolderPath: safeString(getPrivateValue("folderPath")),
        privateType: safeString(getPrivateValue("type")),
        privateServersRef: Array.isArray(blob.privateData?.servers)
          ? (blob.privateData?.servers as readonly string[])
          : null,
        privateMetadataRef: privateMetadata,
        privateAudioRef: getPrivateValue<Record<string, unknown> | null>("audio") ?? null,
        audioMetadataRef: audioMetadata,
      };

      const cached = searchTokenCacheRef.current.get(blob);
      if (cached && signaturesEqual(cached.signature, signature)) {
        return cached;
      }

      const built = buildSearchTokens(blob, signature, privateMetadata, audioMetadata);
      searchTokenCacheRef.current.set(blob, built);
      return built;
    },
    [metadataMap],
  );

  const matchesSearch = useCallback(
    (blob: BlossomBlob) => {
      if (!searchQuery.isActive) return true;

      const {
        textTerms,
        excludedTextTerms,
        fieldTerms,
        excludedFieldTerms,
        sizeComparisons,
        durationComparisons,
        yearComparisons,
        beforeTimestamps,
        afterTimestamps,
        onRanges,
        includeFlags,
        excludeFlags,
      } = searchQuery;
      const {
        isFolderPlaceholder,
        isParentLink,
        isFolderLike,
        isSharedFolder,
        isSharedFile,
        isSharedItem,
        hasPrivateLink,
        isPublicBlob,
      } = resolveSharingDetails(blob);

      if (isFolderPlaceholder && isParentLink) {
        return false;
      }

      if (isFolderLike) {
        const wantsFolderResults = includeFlags.some(
          flag => flag === "shared" || flag === "shared-folder",
        );
        if (!wantsFolderResults) {
          return false;
        }
      }

      const tokens = getSearchTokens(blob);

      if (sizeComparisons.length > 0) {
        if (typeof tokens.resolvedSize !== "number") {
          return false;
        }
        const satisfiesSizeFilters = sizeComparisons.every(comparison => {
          switch (comparison.operator) {
            case ">":
              return tokens.resolvedSize! > comparison.value;
            case ">=":
              return tokens.resolvedSize! >= comparison.value;
            case "<":
              return tokens.resolvedSize! < comparison.value;
            case "<=":
              return tokens.resolvedSize! <= comparison.value;
            case "=":
            default:
              return tokens.resolvedSize! === comparison.value;
          }
        });
        if (!satisfiesSizeFilters) {
          return false;
        }
      }

      if (durationComparisons.length > 0) {
        if (typeof tokens.resolvedDuration !== "number") {
          return false;
        }
        const matchesDuration = durationComparisons.every(comparison => {
          switch (comparison.operator) {
            case ">":
              return tokens.resolvedDuration! > comparison.value;
            case ">=":
              return tokens.resolvedDuration! >= comparison.value;
            case "<":
              return tokens.resolvedDuration! < comparison.value;
            case "<=":
              return tokens.resolvedDuration! <= comparison.value;
            case "=":
            default:
              return tokens.resolvedDuration! === comparison.value;
          }
        });
        if (!matchesDuration) {
          return false;
        }
      }

      if (yearComparisons.length > 0) {
        if (typeof tokens.resolvedYear !== "number") {
          return false;
        }
        const matchesYear = yearComparisons.every(comparison => {
          switch (comparison.operator) {
            case ">":
              return tokens.resolvedYear! > comparison.value;
            case ">=":
              return tokens.resolvedYear! >= comparison.value;
            case "<":
              return tokens.resolvedYear! < comparison.value;
            case "<=":
              return tokens.resolvedYear! <= comparison.value;
            case "=":
            default:
              return tokens.resolvedYear! === comparison.value;
          }
        });
        if (!matchesYear) {
          return false;
        }
      }

      if (beforeTimestamps.length > 0) {
        if (typeof tokens.resolvedUploaded !== "number") {
          return false;
        }
        const satisfiesBefore = beforeTimestamps.every(
          threshold => tokens.resolvedUploaded! < threshold,
        );
        if (!satisfiesBefore) {
          return false;
        }
      }

      if (afterTimestamps.length > 0) {
        if (typeof tokens.resolvedUploaded !== "number") {
          return false;
        }
        const satisfiesAfter = afterTimestamps.every(
          threshold => tokens.resolvedUploaded! >= threshold,
        );
        if (!satisfiesAfter) {
          return false;
        }
      }

      if (onRanges.length > 0) {
        if (typeof tokens.resolvedUploaded !== "number") {
          return false;
        }
        const matchesAllRanges = onRanges.every(
          range => tokens.resolvedUploaded! >= range.start && tokens.resolvedUploaded! < range.end,
        );
        if (!matchesAllRanges) {
          return false;
        }
      }

      const matchesFlag = (flag: SearchFlag) => {
        switch (flag) {
          case "private":
            return Boolean(blob.privateData);
          case "public":
            return isPublicBlob;
          case "shared":
            return isSharedItem;
          case "shared-folder":
            return isSharedFolder;
          case "shared-file":
            return isSharedFile;
          case "shared-link":
            return !isFolderLike && hasPrivateLink;
          case "audio":
            return isMusicBlob(blob);
          case "image":
            return isImageBlob(blob);
          case "video":
            return isVideoBlob(blob);
          case "document":
            return isDocumentBlob(blob);
          case "pdf":
            return isPdfBlob(blob);
          default:
            return false;
        }
      };

      if (includeFlags.length > 0) {
        const allFlagsMatch = includeFlags.every(flag => matchesFlag(flag));
        if (!allFlagsMatch) {
          return false;
        }
      }

      if (excludeFlags.length > 0) {
        const violatesExcludedFlag = excludeFlags.some(flag => matchesFlag(flag));
        if (violatesExcludedFlag) {
          return false;
        }
      }

      const fieldEntries = Object.entries(fieldTerms) as [SearchField, string[]][];
      for (const [field, values] of fieldEntries) {
        if (!values || values.length === 0) continue;
        const candidates = tokens.fieldCandidates[field] ?? [];
        if (candidates.length === 0) {
          return false;
        }

        const matchedAll = values.every(value =>
          candidates.some(candidate => candidate.includes(value)),
        );
        if (!matchedAll) {
          return false;
        }
      }

      const excludedFieldEntries = Object.entries(excludedFieldTerms) as [SearchField, string[]][];
      for (const [field, values] of excludedFieldEntries) {
        if (!values || values.length === 0) continue;
        const candidates = tokens.fieldCandidates[field] ?? [];
        if (!candidates.length) continue;
        const hasMatch = values.some(value =>
          candidates.some(candidate => candidate.includes(value)),
        );
        if (hasMatch) {
          return false;
        }
      }

      if (textTerms.length === 0) {
        if (excludedTextTerms.length > 0) {
          for (const term of excludedTextTerms) {
            if (tokens.textCandidates.some(candidate => candidate.includes(term))) {
              return false;
            }
          }
        }
        return true;
      }

      for (const term of textTerms) {
        const matched = tokens.textCandidates.some(candidate => candidate.includes(term));
        if (!matched) {
          return false;
        }
      }

      if (excludedTextTerms.length > 0) {
        const violates = excludedTextTerms.some(term =>
          tokens.textCandidates.some(candidate => candidate.includes(term)),
        );
        if (violates) {
          return false;
        }
      }

      return true;
    },
    [getSearchTokens, resolveSharingDetails, searchQuery],
  );

  const normalizedSelectedServer = selectedServer ? normalizeServerUrl(selectedServer) : null;
  const normalizeMaybeServerUrl = (value?: string | null) =>
    value ? normalizeServerUrl(value) : null;
  const serverByUrl = useMemo(
    () => new Map(servers.map(server => [normalizeServerUrl(server.url), server])),
    [servers],
  );

  const hasActiveFilter =
    filterMode !== "all" || sharingFilter !== "all" || onlyPrivateLinks || isSearching;
  const isPrivateRootView = activeList?.type === "private";
  const isPrivateFolderView = activeList?.type === "folder" && activeList.scope === "private";
  const isPrivateView = isPrivateRootView || isPrivateFolderView;
  const privateScopeUrl =
    activeList?.type === "private"
      ? activeList.serverUrl
      : isPrivateFolderView
        ? (activeList.serverUrl ?? null)
        : null;
  const hasPrivateFiles = privateBlobs.length > 0;
  const activeFolder = activeList?.type === "folder" ? activeList : null;
  const activePrivateServer = privateScopeUrl ? serverByUrl.get(privateScopeUrl) : undefined;
  const privateFolderPath = activeFolder?.scope === "private" ? activeFolder.path : "";

  const excludeListedBlobs = useCallback(
    (source: BlossomBlob[]) => source.filter(blob => !entriesBySha.has(blob.sha256)),
    [entriesBySha],
  );

  useEffect(() => {
    onBrowseTabChange(active ? "browse" : "");
  }, [active, onBrowseTabChange]);

  useEffect(() => {
    if (!active) return;
    if (!isFilterMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!filterMenuRef.current || filterMenuRef.current.contains(event.target as Node)) {
        return;
      }
      onCloseFilterMenu();
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!filterMenuRef.current || filterMenuRef.current.contains(event.target as Node)) {
        return;
      }
      onCloseFilterMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseFilterMenu();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, filterMenuRef, isFilterMenuOpen, onCloseFilterMenu]);

  useEffect(() => {
    clearSelection();
  }, [clearSelection, selectedServer, isPrivateView, isSearching]);

  useEffect(() => {
    if (!isPrivateRootView) return;
    if (privateScopeUrl !== normalizedSelectedServer) {
      setActiveList(null);
    }
  }, [isPrivateRootView, privateScopeUrl, normalizedSelectedServer]);

  useEffect(() => {
    if (isPrivateView && !hasPrivateFiles) {
      setActiveList(null);
    }
  }, [hasPrivateFiles, isPrivateView]);

  useEffect(() => {
    if (!homeResetKey) return;
    setActiveList(null);
  }, [homeResetKey]);

  useEffect(() => {
    if (!activeFolder) return;
    if (activeFolder.scope === "aggregated" && selectedServer) {
      setActiveList(null);
      return;
    }
    if (activeFolder.scope === "server") {
      if (!selectedServer) {
        setActiveList(null);
        return;
      }
      if (
        normalizeServerUrl(selectedServer) !==
        (activeFolder.serverUrl ? normalizeServerUrl(activeFolder.serverUrl) : undefined)
      ) {
        setActiveList(null);
      }
    }
  }, [activeFolder, selectedServer]);

  useEffect(
    () => () => {
      playbackUrlCacheRef.current.forEach(url => {
        if (typeof url === "string" && url.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore revoke failures
          }
        }
      });
      playbackUrlCacheRef.current.clear();
    },
    [],
  );

  const privatePlaceholderBlob = useMemo(() => {
    if (!hasPrivateFiles || isPrivateView) return null;
    const newestPrivateUpload = privateBlobs.reduce((max, blob) => {
      const value = typeof blob.uploaded === "number" ? blob.uploaded : 0;
      return value > max ? value : max;
    }, 0);
    return {
      sha256: PRIVATE_PLACEHOLDER_SHA,
      name: PRIVATE_SERVER_NAME,
      serverUrl: selectedServer ?? undefined,
      serverType: "blossom",
      requiresAuth: false,
      type: "application/x-directory",
      uploaded: newestPrivateUpload || Math.floor(Date.now() / 1000),
      url: undefined,
      label: PRIVATE_SERVER_NAME,
    } as BlossomBlob;
  }, [hasPrivateFiles, isPrivateView, privateBlobs, selectedServer]);

  const hasPrivateMatchingFilter = useMemo(() => {
    if (!hasPrivateFiles) return false;
    const filtered = applyContentFilters(privateBlobs);
    if (!isSearching) {
      return filtered.length > 0;
    }
    return filtered.some(matchesSearch);
  }, [applyContentFilters, hasPrivateFiles, isSearching, matchesSearch, privateBlobs]);

  const openPrivateList = useCallback(() => {
    setActiveList({ type: "private", serverUrl: normalizedSelectedServer });
    onSetTab("browse");
    clearSelection();
  }, [clearSelection, normalizedSelectedServer, onSetTab]);

  const openFolderFromInfo = useCallback(
    (info: { scope: FolderScope; path: string; serverUrl?: string | null }) => {
      const normalizedPath = info.path ?? "";
      if (!normalizedPath) {
        if (info.scope === "private") {
          setActiveList({ type: "private", serverUrl: info.serverUrl ?? null });
        } else {
          setActiveList(null);
        }
      } else {
        setActiveList({
          type: "folder",
          scope: info.scope,
          path: normalizedPath,
          serverUrl: info.serverUrl ?? null,
        });
      }
      onSetTab("browse");
      clearSelection();
    },
    [clearSelection, onSetTab],
  );

  const isPlaceholderSha = useCallback((sha: string) => sha === PRIVATE_PLACEHOLDER_SHA, []);

  const isPlaceholderBlob = useCallback(
    (blob: BlossomBlob) => blob.sha256 === PRIVATE_PLACEHOLDER_SHA,
    [],
  );

  const privateSearchMatches = useMemo(() => {
    if (!isSearching) return [] as BlossomBlob[];
    return applyContentFilters(privateBlobs).filter(matchesSearch);
  }, [applyContentFilters, isSearching, matchesSearch, privateBlobs]);

  const aggregatedFilteredBlobs = useMemo(() => {
    const base = applyContentFilters(aggregated.blobs);
    const filtered = reinforceFolderAssignments(excludeListedBlobs(base));
    if (!isSearching) return filtered;
    const matches = filtered.filter(matchesSearch);
    if (privateSearchMatches.length === 0) {
      return matches;
    }
    const merged = matches.slice();
    const seen = new Set(merged.map(blob => blob.sha256));
    privateSearchMatches.forEach(blob => {
      if (seen.has(blob.sha256)) return;
      seen.add(blob.sha256);
      merged.push(blob);
    });
    return reinforceFolderAssignments(merged);
  }, [
    aggregated.blobs,
    applyContentFilters,
    excludeListedBlobs,
    isSearching,
    matchesSearch,
    privateSearchMatches,
    reinforceFolderAssignments,
  ]);

  const aggregatedFolderIndex = useMemo(
    () => buildFolderIndex(aggregatedFilteredBlobs),
    [aggregatedFilteredBlobs],
  );

  const aggregatedFolderPath = activeFolder?.scope === "aggregated" ? activeFolder.path : "";

  const baseAggregatedBlobs = useMemo(() => {
    if (hasActiveFilter) {
      if (!isSearching && privatePlaceholderBlob && hasPrivateMatchingFilter) {
        return [privatePlaceholderBlob, ...aggregatedFilteredBlobs];
      }
      return aggregatedFilteredBlobs;
    }
    const { list } = buildFolderViewFromIndex(aggregatedFolderIndex, aggregatedFilteredBlobs, {
      activePath: aggregatedFolderPath,
      scope: "aggregated",
      resolveFolderName: getFolderDisplayName,
    });
    if (!aggregatedFolderPath && privatePlaceholderBlob && hasPrivateMatchingFilter) {
      return [privatePlaceholderBlob, ...list];
    }
    return list;
  }, [
    aggregatedFilteredBlobs,
    aggregatedFolderIndex,
    aggregatedFolderPath,
    hasActiveFilter,
    hasPrivateMatchingFilter,
    isSearching,
    privatePlaceholderBlob,
    getFolderDisplayName,
  ]);
  const aggregatedParentPathKey = useMemo(() => {
    const target = aggregatedFolderPath ? normalizeFolderPathInput(aggregatedFolderPath) : "";
    return typeof target === "string" ? target : "";
  }, [aggregatedFolderPath]);
  const aggregatedManifestView = useMemo(() => {
    if (!folderManifest.ready || folderManifest.disabled || !browsingAllServers) return null;
    if (hasActiveFilter) return null;
    return folderManifest.getView("aggregated", aggregatedParentPathKey);
  }, [aggregatedParentPathKey, browsingAllServers, folderManifest, hasActiveFilter]);
  const aggregatedInitialLoading = useMemo(
    () => snapshots.some(snapshot => snapshot.isLoading && snapshot.blobs.length === 0),
    [snapshots],
  );
  const visibleAggregatedBlobs = useMemo(() => {
    if (
      folderManifest.ready &&
      !folderManifest.disabled &&
      browsingAllServers &&
      !hasActiveFilter &&
      baseAggregatedBlobs.length === 0 &&
      aggregatedInitialLoading &&
      aggregatedManifestView &&
      aggregatedManifestView.length > 0
    ) {
      return aggregatedManifestView;
    }
    return baseAggregatedBlobs;
  }, [
    aggregatedInitialLoading,
    aggregatedManifestView,
    baseAggregatedBlobs,
    browsingAllServers,
    folderManifest.disabled,
    folderManifest.ready,
    hasActiveFilter,
  ]);

  const privateScopedBlobs = useMemo(() => {
    if (!hasPrivateFiles) return [] as BlossomBlob[];
    if (!privateScopeUrl) return privateBlobs;

    const filtered = privateBlobs.filter(blob => {
      const serversForBlob = blob.privateData?.servers;
      if (serversForBlob && serversForBlob.length) {
        return serversForBlob.some(url => normalizeServerUrl(url) === privateScopeUrl);
      }
      const fallback = normalizeMaybeServerUrl(blob.serverUrl);
      return fallback === privateScopeUrl;
    });

    const targetServer = serverByUrl.get(privateScopeUrl);
    if (!targetServer) {
      return filtered.map(blob => {
        const currentNormalized = normalizeMaybeServerUrl(blob.serverUrl);
        if (currentNormalized === privateScopeUrl) {
          return blob;
        }
        const baseUrl = privateScopeUrl;
        return {
          ...blob,
          serverUrl: baseUrl,
          url: `${baseUrl}/${blob.sha256}`,
        };
      });
    }

    const targetBaseUrl = normalizeServerUrl(targetServer.url);

    return filtered.map(blob => ({
      ...blob,
      serverUrl: targetBaseUrl,
      url: `${targetBaseUrl}/${blob.sha256}`,
      serverType: targetServer.type,
      requiresAuth: Boolean(targetServer.requiresAuth),
      label: targetServer.name ?? blob.label,
    }));
  }, [hasPrivateFiles, privateBlobs, privateScopeUrl, serverByUrl]);

  const privateVisibleBlobs = useMemo(() => {
    const filtered = applyContentFilters(privateScopedBlobs);
    if (!isSearching) return filtered;
    return filtered.filter(matchesSearch);
  }, [applyContentFilters, isSearching, matchesSearch, privateScopedBlobs]);

  const privateFolderIndex = useMemo(
    () => buildFolderIndex(privateVisibleBlobs),
    [privateVisibleBlobs],
  );

  const visiblePrivateBlobs = useMemo(() => {
    if (!isPrivateView || hasActiveFilter) return privateVisibleBlobs;
    const { list } = buildFolderViewFromIndex(privateFolderIndex, privateVisibleBlobs, {
      activePath: privateFolderPath,
      scope: "private",
      serverUrl: privateScopeUrl,
      serverType: activePrivateServer?.type,
      requiresAuth: activePrivateServer ? Boolean(activePrivateServer.requiresAuth) : undefined,
      resolveFolderName: getFolderDisplayName,
    });
    return list;
  }, [
    activePrivateServer,
    isPrivateView,
    hasActiveFilter,
    privateFolderPath,
    privateScopeUrl,
    privateVisibleBlobs,
    privateFolderIndex,
    getFolderDisplayName,
  ]);

  const currentFilteredBlobs = useMemo(() => {
    if (!currentSnapshot) return undefined;
    const base = applyContentFilters(currentSnapshot.blobs);
    const filtered = reinforceFolderAssignments(excludeListedBlobs(base));
    if (!isSearching) return filtered;
    const matches = filtered.filter(matchesSearch);
    if (privateSearchMatches.length === 0) {
      return matches;
    }
    const merged = matches.slice();
    const seen = new Set(merged.map(blob => blob.sha256));
    privateSearchMatches.forEach(blob => {
      if (seen.has(blob.sha256)) return;
      seen.add(blob.sha256);
      merged.push(blob);
    });
    return reinforceFolderAssignments(merged);
  }, [
    applyContentFilters,
    currentSnapshot,
    excludeListedBlobs,
    isSearching,
    matchesSearch,
    privateSearchMatches,
    reinforceFolderAssignments,
  ]);

  const currentFolderIndex = useMemo(
    () => (currentFilteredBlobs ? buildFolderIndex(currentFilteredBlobs) : null),
    [currentFilteredBlobs],
  );

  const currentFolderPath = activeFolder?.scope === "server" ? activeFolder.path : "";

  const baseCurrentVisibleBlobs = useMemo(() => {
    if (!currentFilteredBlobs) return undefined;
    const serverInfo = currentSnapshot?.server;
    if (hasActiveFilter) {
      if (
        !isSearching &&
        !currentFolderPath &&
        privatePlaceholderBlob &&
        hasPrivateMatchingFilter
      ) {
        return [privatePlaceholderBlob, ...currentFilteredBlobs];
      }
      return currentFilteredBlobs;
    }
    const index = currentFolderIndex ?? buildFolderIndex(currentFilteredBlobs);
    const { list } = buildFolderViewFromIndex(index, currentFilteredBlobs, {
      activePath: currentFolderPath,
      scope: "server",
      serverUrl: serverInfo ? normalizeServerUrl(serverInfo.url) : null,
      serverType: serverInfo?.type,
      requiresAuth: serverInfo ? Boolean(serverInfo.requiresAuth) : undefined,
      resolveFolderName: getFolderDisplayName,
    });
    if (!currentFolderPath && privatePlaceholderBlob && hasPrivateMatchingFilter) {
      return [privatePlaceholderBlob, ...list];
    }
    return list;
  }, [
    currentFilteredBlobs,
    currentFolderPath,
    currentSnapshot,
    hasActiveFilter,
    hasPrivateMatchingFilter,
    isSearching,
    privatePlaceholderBlob,
    currentFolderIndex,
    getFolderDisplayName,
  ]);
  const serverParentPathKey = useMemo(() => {
    if (activeFolder?.scope !== "server") return "";
    const normalized = normalizeFolderPathInput(activeFolder.path ?? undefined);
    return typeof normalized === "string" ? normalized : "";
  }, [activeFolder]);
  const serverScopeKey = useMemo(
    () => (normalizedSelectedServer ? `server:${normalizedSelectedServer}` : null),
    [normalizedSelectedServer],
  );
  const privateParentPathKey = useMemo(() => {
    if (activeFolder?.scope !== "private") return "";
    const normalized = normalizeFolderPathInput(activeFolder.path ?? undefined);
    return typeof normalized === "string" ? normalized : "";
  }, [activeFolder]);
  const serverManifestView = useMemo(() => {
    if (!folderManifest.ready || folderManifest.disabled) return null;
    if (!serverScopeKey) return null;
    if (hasActiveFilter) return null;
    return folderManifest.getView(serverScopeKey, serverParentPathKey);
  }, [folderManifest, hasActiveFilter, serverParentPathKey, serverScopeKey]);
  const serverInitialLoading = useMemo(() => {
    if (!serverScopeKey) return false;
    if (!currentSnapshot) return false;
    return currentSnapshot.isLoading && (currentSnapshot.blobs?.length ?? 0) === 0;
  }, [currentSnapshot, serverScopeKey]);
  const currentVisibleBlobs = useMemo(() => {
    if (
      folderManifest.ready &&
      !folderManifest.disabled &&
      serverScopeKey &&
      !hasActiveFilter &&
      serverManifestView &&
      serverManifestView.length > 0 &&
      (!baseCurrentVisibleBlobs || baseCurrentVisibleBlobs.length === 0) &&
      serverInitialLoading
    ) {
      return serverManifestView;
    }
    return baseCurrentVisibleBlobs;
  }, [
    baseCurrentVisibleBlobs,
    folderManifest.disabled,
    folderManifest.ready,
    hasActiveFilter,
    serverInitialLoading,
    serverManifestView,
    serverScopeKey,
  ]);

  const viewMatchesStored = useCallback(
    (scopeKey: string, parentPath: string, items: readonly BlossomBlob[]) => {
      const existing = folderManifest.getView(scopeKey, parentPath);
      if (!existing) return false;
      if (existing.length !== items.length) return false;
      for (let index = 0; index < items.length; index += 1) {
        const left = items[index];
        const right = existing[index];
        if (!left || !right) return false;
        if (left.sha256 !== right.sha256) return false;
        if (Boolean(left.__bloomFolderPlaceholder) !== Boolean(right.__bloomFolderPlaceholder))
          return false;
      }
      return true;
    },
    [folderManifest],
  );

  useEffect(() => {
    if (!folderManifest.ready || folderManifest.disabled) return;
    if (hasActiveFilter) return;

    if (isPrivateView) {
      const scopeKey = `private:${privateScopeUrl ?? "all"}`;
      const items = visiblePrivateBlobs;
      if (viewMatchesStored(scopeKey, privateParentPathKey, items)) return;
      folderManifest.saveView(scopeKey, privateParentPathKey, items);
      return;
    }

    if (serverScopeKey) {
      if (!currentSnapshot) return;
      const isLoading = currentSnapshot.isLoading && (currentSnapshot.blobs?.length ?? 0) === 0;
      if (isLoading) return;
      const items = baseCurrentVisibleBlobs ?? [];
      if (viewMatchesStored(serverScopeKey, serverParentPathKey, items)) return;
      folderManifest.saveView(serverScopeKey, serverParentPathKey, items);
      return;
    }

    const isAggregatedLoading = snapshots.some(
      snapshot => snapshot.isLoading && snapshot.blobs.length === 0,
    );
    if (isAggregatedLoading) return;
    if (viewMatchesStored("aggregated", aggregatedParentPathKey, baseAggregatedBlobs)) return;
    folderManifest.saveView("aggregated", aggregatedParentPathKey, baseAggregatedBlobs);
  }, [
    aggregatedParentPathKey,
    baseAggregatedBlobs,
    baseCurrentVisibleBlobs,
    currentSnapshot,
    folderManifest,
    hasActiveFilter,
    isPrivateView,
    privateParentPathKey,
    privateScopeUrl,
    serverParentPathKey,
    serverScopeKey,
    snapshots,
    viewMatchesStored,
    visiblePrivateBlobs,
  ]);

  const resolveBlobBySha = useCallback(
    (sha: string): BlossomBlob | null => {
      if (!sha) return null;
      const normalized = sha.trim();
      if (!normalized) return null;
      const sources: (readonly BlossomBlob[] | undefined | null)[] = [
        aggregated.blobs,
        currentSnapshot?.blobs,
        currentVisibleBlobs,
        visibleAggregatedBlobs,
        privateBlobs,
        privateVisibleBlobs,
      ];
      for (const source of sources) {
        if (!source) continue;
        const match = source.find(candidate => candidate?.sha256 === normalized);
        if (match) {
          return match;
        }
      }
      return null;
    },
    [
      aggregated.blobs,
      currentSnapshot,
      currentVisibleBlobs,
      visibleAggregatedBlobs,
      privateBlobs,
      privateVisibleBlobs,
    ],
  );

  const queueMetadataSync = useCallback(
    (targets: MetadataSyncTarget[], context?: MetadataSyncContext) => {
      if (!ndk || !signer) return;
      if (!Array.isArray(targets) || targets.length === 0) return;
      const publicTargets = targets.filter(target => target && !target.blob.privateData);
      if (publicTargets.length === 0) return;
      void (async () => {
        let successCount = 0;
        let failureCount = 0;
        for (const target of publicTargets) {
          try {
            const alias = getBlobMetadataName(target.blob) ?? target.blob.name ?? null;
            const extraTags = extractExtraNip94Tags(target.blob.nip94);
            await publishNip94Metadata({
              ndk,
              signer,
              blob: target.blob,
              relays: effectiveRelays,
              alias,
              folderPath: target.folderPath,
              extraTags,
            });
            successCount += 1;
          } catch (error) {
            failureCount += 1;
            console.warn("Failed to sync NIP-94 metadata", target.blob.sha256, error);
          }
        }
        if (failureCount === 0) {
          if (context?.successMessage) {
            showStatusMessage(context.successMessage(successCount), "success", 3000);
          }
        } else {
          const message = context?.errorMessage
            ? context.errorMessage(failureCount)
            : failureCount === 1
              ? "Failed to sync metadata to relays."
              : `Failed to sync metadata for ${failureCount} items.`;
          showStatusMessage(message, "error", 4500);
        }
      })();
    },
    [effectiveRelays, ndk, showStatusMessage, signer],
  );

  useEffect(() => {
    if (!hasPrivateFiles) {
      autoPrivateNavigationRef.current = null;
      return;
    }

    const hasVisibleNonPrivateMatches = isPrivateView
      ? false
      : browsingAllServers
        ? aggregatedFilteredBlobs.length > 0
        : (currentFilteredBlobs?.length ?? 0) > 0;

    if (isSearching && hasPrivateMatchingFilter && !isPrivateView && !hasVisibleNonPrivateMatches) {
      if (!autoPrivateNavigationRef.current) {
        autoPrivateNavigationRef.current = { previous: activeList ?? null };
      }
      openPrivateList();
      return;
    }

    if (autoPrivateNavigationRef.current && (!isSearching || !hasPrivateMatchingFilter)) {
      const previous = autoPrivateNavigationRef.current.previous ?? null;
      autoPrivateNavigationRef.current = null;
      setActiveList(previous);
    }
  }, [
    activeList,
    aggregatedFilteredBlobs,
    browsingAllServers,
    currentFilteredBlobs,
    hasPrivateFiles,
    hasPrivateMatchingFilter,
    isPrivateView,
    isSearching,
    openPrivateList,
  ]);

  const folderPlaceholderInfo = useMemo(() => {
    const map = new Map<string, { scope: FolderScope; path: string; serverUrl?: string | null }>();
    const register = (list?: readonly BlossomBlob[]) => {
      if (!list) return;
      list.forEach(blob => {
        if (blob.__bloomFolderPlaceholder) {
          map.set(blob.sha256, {
            scope: blob.__bloomFolderScope ?? "aggregated",
            path: blob.__bloomFolderTargetPath ?? "",
            serverUrl: blob.serverUrl ?? null,
          });
        }
      });
    };
    register(visibleAggregatedBlobs);
    register(currentVisibleBlobs);
    if (isPrivateView) {
      register(visiblePrivateBlobs);
    }
    return map;
  }, [isPrivateView, visiblePrivateBlobs, visibleAggregatedBlobs, currentVisibleBlobs]);

  const extractFolderInfo = (blob: BlossomBlob) => {
    if (!blob.__bloomFolderPlaceholder) return null;
    return {
      scope: blob.__bloomFolderScope ?? "aggregated",
      path: blob.__bloomFolderTargetPath ?? "",
      serverUrl: blob.serverUrl ?? null,
    } as { scope: FolderScope; path: string; serverUrl?: string | null };
  };

  const formatFolderLabel = useCallback((value: string | null) => {
    if (!value) return "Home";
    const segments = value.split("/").filter(Boolean);
    if (segments.length === 0) return "Home";
    return segments.join(" / ");
  }, []);

  const formatPrivateFolderLabel = useCallback((value: string | null) => {
    if (!value) return "Private";
    const segments = value.split("/").filter(Boolean);
    if (segments.length === 0) return "Private";
    return `Private / ${segments.join(" / ")}`;
  }, []);

  const formatMoveDestinationLabel = useCallback(
    (value: string | null, isPrivate: boolean) =>
      isPrivate ? formatPrivateFolderLabel(value) : formatFolderLabel(value),
    [formatFolderLabel, formatPrivateFolderLabel],
  );

  const moveDestinations = useMemo(() => {
    const paths = new Set<string>();
    folders.forEach(record => {
      const normalized = normalizeFolderPathInput(record.path) ?? null;
      if (!normalized) return;
      const name = deriveNameFromPath(normalized);
      if (isPrivateFolderName(name)) return;
      const canonical = resolveFolderPath(normalized);
      paths.add(canonical);
    });
    return Array.from(paths).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [folders, resolveFolderPath]);

  const privateMoveDestinations = useMemo(() => {
    const paths = new Set<string>();
    privateBlobs.forEach(blob => {
      const normalized = normalizeFolderPathInput(blob.folderPath ?? undefined);
      if (!normalized) return;
      let current: string | null = normalized;
      while (current && !paths.has(current)) {
        paths.add(current);
        current = getParentFolderPath(current);
        if (current === "") {
          current = null;
        }
      }
    });
    return Array.from(paths).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [privateBlobs]);

  const moveDialogOptions = useMemo(() => {
    if (moveState?.isPrivate) {
      const options: Array<{ value: string | null; label: string; disabled?: boolean }> = [
        { value: null, label: "Private" },
        ...privateMoveDestinations.map(path => ({
          value: path,
          label: formatPrivateFolderLabel(path),
        })),
        { value: NEW_FOLDER_OPTION_VALUE, label: "New folder…" },
      ];
      if (moveState.kind === "folder") {
        const currentPath = moveState.path;
        return options.map(option => {
          if (!option.value) return option;
          if (option.value === NEW_FOLDER_OPTION_VALUE) return option;
          if (option.value === currentPath || option.value.startsWith(`${currentPath}/`)) {
            return { ...option, disabled: true };
          }
          return option;
        });
      }
      return options;
    }

    const options: Array<{ value: string | null; label: string; disabled?: boolean }> = [
      { value: null, label: "Home" },
      ...moveDestinations.map(path => ({
        value: path,
        label: formatFolderLabel(path),
      })),
      { value: NEW_FOLDER_OPTION_VALUE, label: "New folder…" },
    ];

    if (moveState?.kind === "folder") {
      const currentPath = moveState.path;
      return options.map(option => {
        if (!option.value) return option;
        if (option.value === NEW_FOLDER_OPTION_VALUE) return option;
        if (option.value === currentPath || option.value.startsWith(`${currentPath}/`)) {
          return { ...option, disabled: true };
        }
        return option;
      });
    }

    return options;
  }, [
    formatFolderLabel,
    formatPrivateFolderLabel,
    moveDestinations,
    moveState,
    privateMoveDestinations,
  ]);

  const blobVariantsBySha = useMemo(() => {
    const map = new Map<string, BlossomBlob[]>();
    const register = (blob: BlossomBlob | null | undefined) => {
      if (!blob?.sha256) return;
      const key = blob.sha256.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        const alreadyPresent = existing.some(entry => {
          if (entry === blob) return true;
          const sameUrl = entry.url && blob.url ? entry.url === blob.url : false;
          const sameServer =
            entry.serverUrl && blob.serverUrl ? entry.serverUrl === blob.serverUrl : false;
          return sameUrl && sameServer;
        });
        if (!alreadyPresent) {
          existing.push(blob);
        }
      } else {
        map.set(key, [blob]);
      }
    };

    aggregated.blobs.forEach(register);
    snapshots.forEach(snapshot => {
      snapshot.blobs.forEach(register);
    });
    privateBlobs.forEach(register);

    return map;
  }, [aggregated.blobs, snapshots, privateBlobs]);

  const collectFolderBlobs = useCallback(
    (scope: FolderScope, normalizedPath: string, serverUrl?: string | null) => {
      const sanitizedPath = normalizedPath ?? "";
      const normalizedServer = serverUrl ? normalizeServerUrl(serverUrl) : null;
      const hasUrl = (value: unknown): value is string =>
        typeof value === "string" && value.trim().length > 0;
      const normalizePath = (value?: string | null) =>
        normalizeFolderPathInput(value ?? undefined) ?? "";
      const deriveServerFromUrl = (value: string, sha: string): string | null => {
        if (!value || !sha) return null;
        const trimmed = value.trim();
        const normalizedSha = sha.toLowerCase();
        try {
          const parsed = new URL(trimmed);
          const strippedPath = parsed.pathname.replace(new RegExp(`${normalizedSha}.*$`, "i"), "");
          const normalizedPath = strippedPath.replace(/\/+$/, "");
          const base = `${parsed.origin}${normalizedPath}`;
          return base.replace(/\/+$/, "");
        } catch {
          const index = trimmed.toLowerCase().indexOf(normalizedSha);
          if (index >= 0) {
            return trimmed.slice(0, index).replace(/\/+$/, "");
          }
        }
        return null;
      };

      const mergeWithFallback = (primary: BlossomBlob, fallback: BlossomBlob): BlossomBlob => {
        if (primary === fallback) return primary;
        const merged: BlossomBlob = { ...primary };
        const applyFallback = <K extends keyof BlossomBlob>(key: K) => {
          const current = merged[key];
          const isMissing =
            current === undefined ||
            current === null ||
            (typeof current === "string" && current.trim().length === 0);
          if (!isMissing) return;
          const fallbackValue = fallback[key];
          if (fallbackValue !== undefined) {
            (merged as BlossomBlob)[key] = fallbackValue as BlossomBlob[K];
          }
        };

        (
          [
            "url",
            "serverUrl",
            "serverType",
            "requiresAuth",
            "size",
            "type",
            "name",
            "label",
            "uploaded",
            "infohash",
            "magnet",
            "nip94",
          ] as (keyof BlossomBlob)[]
        ).forEach(applyFallback);
        return merged;
      };

      const resolveSharableBlob = (blob: BlossomBlob): BlossomBlob => {
        if (!blob.sha256) return blob;
        if (hasUrl(blob.url)) return blob;
        const variants = blobVariantsBySha.get(blob.sha256.toLowerCase());
        if (!variants?.length) return blob;
        const withUrl = variants.filter(candidate => hasUrl(candidate.url));
        if (!withUrl.length) return blob;

        const blobPath = normalizePath(blob.folderPath);
        const matchesPath = (candidate: BlossomBlob) =>
          normalizePath(candidate.folderPath) === (sanitizedPath || blobPath);
        const matchesServer = (candidate: BlossomBlob) =>
          normalizedServer
            ? normalizeMaybeServerUrl(candidate.serverUrl) === normalizedServer
            : true;

        const pickCandidate =
          withUrl.find(
            candidate =>
              matchesServer(candidate) && matchesPath(candidate) && candidate.requiresAuth !== true,
          ) ??
          withUrl.find(candidate => matchesServer(candidate) && candidate.requiresAuth !== true) ??
          withUrl.find(candidate => matchesPath(candidate) && candidate.requiresAuth !== true) ??
          withUrl.find(candidate => matchesServer(candidate)) ??
          withUrl.find(candidate => matchesPath(candidate)) ??
          withUrl.find(candidate => candidate.requiresAuth !== true) ??
          withUrl[0];

        if (!pickCandidate) return blob;
        return mergeWithFallback(blob, pickCandidate);
      };

      const matchesPath = (blob: BlossomBlob) => {
        if (blob.__bloomFolderPlaceholder) return false;
        if (blob.__bloomFolderScope === "private") return false;
        const blobPath = normalizeFolderPathInput(blob.folderPath ?? undefined) ?? "";
        return blobPath === sanitizedPath;
      };
      const matchesServer = (blob: BlossomBlob) => {
        if (!normalizedServer) return true;
        const blobServer = blob.serverUrl ? normalizeServerUrl(blob.serverUrl) : null;
        return blobServer === normalizedServer;
      };

      let source: readonly BlossomBlob[] = aggregated.blobs;
      if (scope === "server") {
        if (
          normalizedServer &&
          currentSnapshot?.server &&
          normalizeMaybeServerUrl(currentSnapshot.server.url) === normalizedServer
        ) {
          source = currentSnapshot.blobs;
        } else if (normalizedServer) {
          source = aggregated.blobs.filter(blob => matchesServer(blob));
        } else if (currentSnapshot?.blobs) {
          source = currentSnapshot.blobs;
        }
      }

      const deduped = new Map<string, BlossomBlob>();
      source.forEach(blob => {
        if (!matchesPath(blob)) return;
        if (!matchesServer(blob)) return;
        if (!blob.sha256) return;
        const key = blob.sha256.toLowerCase();
        const resolved = resolveSharableBlob(blob);
        const existing = deduped.get(key);
        if (!existing) {
          deduped.set(key, resolved);
          return;
        }
        const existingHasUrl = hasUrl(existing.url);
        const resolvedHasUrl = hasUrl(resolved.url);
        const existingPublic = existing.requiresAuth !== true;
        const resolvedPublic = resolved.requiresAuth !== true;
        if (
          (!existingHasUrl && resolvedHasUrl) ||
          (existingHasUrl === resolvedHasUrl && !existingPublic && resolvedPublic)
        ) {
          deduped.set(key, mergeWithFallback(resolved, existing));
        }
      });
      return Array.from(deduped.values()).map(candidate => {
        const blob: BlossomBlob = { ...candidate };
        const sha = typeof blob.sha256 === "string" ? blob.sha256.trim().toLowerCase() : "";
        const directUrl =
          typeof blob.url === "string" && blob.url.trim().length > 0 ? blob.url.trim() : null;
        const explicitServer =
          typeof blob.serverUrl === "string" && blob.serverUrl.trim().length > 0
            ? blob.serverUrl.trim().replace(/\/+$/, "")
            : null;

        let effectiveServer = explicitServer;
        if (!effectiveServer && directUrl && sha.length === 64) {
          const derived = deriveServerFromUrl(directUrl, sha);
          if (derived) {
            effectiveServer = derived;
          }
        }

        if (effectiveServer) {
          blob.serverUrl = effectiveServer;
        }

        if (directUrl) {
          blob.url = directUrl;
        } else if (effectiveServer && sha.length === 64) {
          blob.url = `${effectiveServer}/${sha}`;
        }

        return blob;
      });
    },
    [aggregated.blobs, blobVariantsBySha, currentSnapshot, normalizeMaybeServerUrl],
  );

  const handleShareFolderHint = useCallback(
    (hint: FolderShareHint) => {
      const normalizedPath = normalizeFolderPathInput(hint.path ?? undefined) ?? "";
      if (!normalizedPath) return;
      const blobs = collectFolderBlobs(hint.scope, normalizedPath, hint.serverUrl ?? null);
      const items = blobs.map(blob => {
        if (!privateLinkServiceConfigured) {
          return {
            blob,
            privateLinkAlias: null,
            privateLinkUrl: null,
          };
        }
        const existing = findExistingPrivateLink(blob);
        if (!existing) {
          return {
            blob,
            privateLinkAlias: null,
            privateLinkUrl: null,
          };
        }
        const alias = existing.alias;
        const url = alias ? `${privateLinkHost}/${alias}` : null;
        return {
          blob,
          privateLinkAlias: alias ?? null,
          privateLinkUrl: url,
        };
      });
      onShareFolder({
        path: normalizedPath,
        scope: hint.scope,
        serverUrl: hint.serverUrl ?? null,
        blobs,
        items,
      });
    },
    [
      collectFolderBlobs,
      onShareFolder,
      privateLinkServiceConfigured,
      findExistingPrivateLink,
      privateLinkHost,
    ],
  );

  const handleUnshareFolderHint = useCallback(
    (hint: FolderShareHint) => {
      const normalizedPath = normalizeFolderPathInput(hint.path ?? undefined) ?? "";
      if (!normalizedPath) return;
      const blobs = collectFolderBlobs(hint.scope, normalizedPath, hint.serverUrl ?? null);
      onUnshareFolder({
        path: normalizedPath,
        scope: hint.scope,
        serverUrl: hint.serverUrl ?? null,
        blobs,
      });
    },
    [collectFolderBlobs, onUnshareFolder],
  );

  const isPrivateAggregated = isPrivateView && !privateScopeUrl;

  const privateSnapshot = useMemo(() => {
    if (!isPrivateView || isPrivateAggregated) return null;
    if (currentSnapshot) {
      return {
        ...currentSnapshot,
        blobs: privateVisibleBlobs,
      };
    }
    if (!privateScopeUrl) return null;
    const server = serverByUrl.get(privateScopeUrl);
    if (!server) return null;
    return {
      server,
      blobs: privateVisibleBlobs,
      isLoading: false,
      isError: false,
      error: null,
    };
  }, [
    currentSnapshot,
    isPrivateAggregated,
    isPrivateView,
    privateScopeUrl,
    privateVisibleBlobs,
    serverByUrl,
  ]);

  const privateReplicaInfo = useMemo(() => {
    if (!isPrivateView) return undefined;
    const map = new Map<string, BlobReplicaSummary>();
    privateVisibleBlobs.forEach(blob => {
      const urls = new Map<string, string | undefined>();
      const addServer = (value?: string | null, preferredName?: string | null) => {
        if (!value) return;
        const normalized = normalizeMaybeServerUrl(value);
        if (!normalized) return;
        if (!urls.has(normalized)) {
          urls.set(normalized, preferredName ?? serverByUrl.get(normalized)?.name);
          return;
        }
        if (!urls.get(normalized) && preferredName) {
          urls.set(normalized, preferredName);
        }
      };

      const privateServers = blob.privateData?.servers ?? [];
      privateServers.forEach(url => addServer(url));

      const globalSummary = blobReplicaInfo.get(blob.sha256);
      if (globalSummary) {
        globalSummary.servers.forEach(entry => addServer(entry.url, entry.name));
      }

      addServer(blob.serverUrl);

      if (urls.size === 0 && privateScopeUrl) {
        addServer(privateScopeUrl);
      }
      if (urls.size === 0) return;

      const servers = Array.from(urls.entries()).map(([url, preferredName]) => {
        const server = serverByUrl.get(url);
        const name = preferredName ?? server?.name ?? server?.url ?? url;
        return { url, name };
      });
      map.set(blob.sha256, { count: servers.length, servers });
    });
    return map;
  }, [blobReplicaInfo, isPrivateView, privateVisibleBlobs, privateScopeUrl, serverByUrl]);

  const effectiveBrowsingAllServers = isPrivateView ? isPrivateAggregated : browsingAllServers;
  const effectiveAggregatedBlobs =
    isPrivateView && isPrivateAggregated ? visiblePrivateBlobs : visibleAggregatedBlobs;
  const effectiveCurrentSnapshot = isPrivateView
    ? isPrivateAggregated
      ? undefined
      : (privateSnapshot ?? currentSnapshot)
    : currentSnapshot;
  const effectiveCurrentVisibleBlobs = isPrivateView ? visiblePrivateBlobs : currentVisibleBlobs;
  const effectiveReplicaInfo = isPrivateView ? privateReplicaInfo : blobReplicaInfo;

  const activeServerForPrivate = isPrivateView
    ? (activePrivateServer ?? privateSnapshot?.server)
    : undefined;

  const effectiveSignTemplate = signEventTemplate as SignTemplate | undefined;

  const statusCount = isPrivateView
    ? privateVisibleBlobs.length
    : currentSnapshot
      ? (currentVisibleBlobs?.length ?? 0)
      : visibleAggregatedBlobs.length;
  const statusSize = isPrivateView
    ? privateVisibleBlobs.reduce((acc, blob) => acc + (blob.size || 0), 0)
    : currentSnapshot
      ? (currentVisibleBlobs ?? []).reduce((acc, blob) => acc + (blob.size || 0), 0)
      : visibleAggregatedBlobs.reduce((acc, blob) => acc + (blob.size || 0), 0);

  useEffect(() => {
    onStatusMetricsChange({ count: statusCount, size: statusSize });
  }, [onStatusMetricsChange, statusCount, statusSize]);

  const handleToggleBlob = useCallback(
    (sha: string) => {
      if (isPlaceholderSha(sha)) {
        openPrivateList();
        return;
      }
      const folderTarget = folderPlaceholderInfo.get(sha);
      if (folderTarget) {
        openFolderFromInfo(folderTarget);
        return;
      }
      toggleBlob(sha);
    },
    [folderPlaceholderInfo, isPlaceholderSha, openFolderFromInfo, openPrivateList, toggleBlob],
  );

  const handleSelectManyBlobs = useCallback(
    (shas: string[], value: boolean) => {
      if (shas.some(isPlaceholderSha)) {
        openPrivateList();
        return;
      }
      const folderTarget = shas
        .map(sha => folderPlaceholderInfo.get(sha))
        .find((info): info is { scope: FolderScope; path: string; serverUrl?: string | null } =>
          Boolean(info),
        );
      if (folderTarget) {
        openFolderFromInfo(folderTarget);
        return;
      }
      selectManyBlobs(shas, value);
    },
    [folderPlaceholderInfo, isPlaceholderSha, openFolderFromInfo, openPrivateList, selectManyBlobs],
  );

  const musicQueueSource = useMemo(() => {
    if (isPrivateView) {
      return privateVisibleBlobs;
    }
    if (isSearching) {
      return aggregatedFilteredBlobs;
    }
    return excludeListedBlobs(aggregated.blobs);
  }, [
    aggregated.blobs,
    aggregatedFilteredBlobs,
    excludeListedBlobs,
    isPrivateView,
    isSearching,
    privateVisibleBlobs,
  ]);

  const resolvePlaybackUrl = useCallback(
    async (blob: BlossomBlob) => {
      const cacheKey = `audio:${blob.sha256}`;
      const cached = playbackUrlCacheRef.current.get(cacheKey);
      if (cached) return cached;

      const baseUrl = blob.url;
      if (!baseUrl) {
        throw new Error("Track source unavailable.");
      }

      const effectiveServerType = blob.serverType ?? "blossom";
      const requiresAuth = Boolean(blob.requiresAuth);
      const encryption = blob.privateData?.encryption;

      if (!requiresAuth && !encryption) {
        playbackUrlCacheRef.current.set(cacheKey, baseUrl);
        return baseUrl;
      }

      const headers: Record<string, string> = {};
      if (requiresAuth) {
        if (!signEventTemplate) {
          throw new Error("Connect your signer to play this track.");
        }
        if (effectiveServerType === "nip96") {
          headers.Authorization = await buildNip98AuthHeader(signEventTemplate, {
            url: baseUrl,
            method: "GET",
          });
        } else {
          let resource: URL | null = null;
          try {
            resource = new URL(baseUrl, window.location.href);
          } catch {
            resource = null;
          }
          headers.Authorization = await buildAuthorizationHeader(signEventTemplate, "get", {
            hash: blob.sha256,
            serverUrl: resource ? `${resource.protocol}//${resource.host}` : blob.serverUrl,
            urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            expiresInSeconds: 600,
          });
        }
      }

      const response = await fetch(baseUrl, {
        headers,
        mode: "cors",
      });
      if (!response.ok) {
        throw new Error(`Playback request failed (${response.status})`);
      }

      let audioBlob: Blob;
      if (encryption) {
        if (encryption.algorithm !== "AES-GCM") {
          throw new Error(`Unsupported encryption algorithm: ${encryption.algorithm}`);
        }
        const encryptedBuffer = await response.arrayBuffer();
        const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, {
          algorithm: "AES-GCM",
          key: encryption.key,
          iv: encryption.iv,
          originalName: blob.privateData?.metadata?.name,
          originalType: blob.privateData?.metadata?.type,
          originalSize: blob.privateData?.metadata?.size,
        });
        const mimeType =
          blob.privateData?.metadata?.type ||
          blob.type ||
          response.headers.get("content-type") ||
          "audio/mpeg";
        audioBlob = new Blob([decryptedBuffer], { type: mimeType });
      } else {
        audioBlob = await response.blob();
      }

      const existing = playbackUrlCacheRef.current.get(cacheKey);
      if (existing && existing.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(existing);
        } catch {
          // ignore revoke errors
        }
      }
      const objectUrl = URL.createObjectURL(audioBlob);
      playbackUrlCacheRef.current.set(cacheKey, objectUrl);
      return objectUrl;
    },
    [signEventTemplate],
  );

  const resolveCoverArtUrl = useCallback(
    async (blob: BlossomBlob, coverUrl?: string | null, coverEntry?: PrivateListEntry | null) => {
      if (!coverUrl) return undefined;
      if (coverUrl.startsWith("data:")) return coverUrl;

      const coverSha = coverEntry?.sha256;
      const cacheKey = coverSha ? `cover:${coverSha}` : `cover:${blob.sha256}:${coverUrl}`;
      const cached = playbackUrlCacheRef.current.get(cacheKey);
      if (cached) return cached;

      const effectiveServerType = blob.serverType ?? "blossom";
      const requiresAuth = Boolean(blob.requiresAuth || coverEntry?.encryption);
      const encryption = coverEntry?.encryption;

      const headers: Record<string, string> = {};
      if (requiresAuth && signEventTemplate) {
        if (effectiveServerType === "nip96") {
          headers.Authorization = await buildNip98AuthHeader(signEventTemplate, {
            url: coverUrl,
            method: "GET",
          });
        } else {
          let resource: URL | null = null;
          try {
            resource = new URL(coverUrl, window.location.href);
          } catch {
            resource = null;
          }
          headers.Authorization = await buildAuthorizationHeader(signEventTemplate, "get", {
            hash: coverSha,
            serverUrl: resource ? `${resource.protocol}//${resource.host}` : blob.serverUrl,
            urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            expiresInSeconds: 300,
          });
        }
      } else if (requiresAuth && !signEventTemplate) {
        throw new Error("Connect your signer to view private cover art.");
      }

      const response = await fetch(coverUrl, {
        headers,
        mode: "cors",
      });
      if (!response.ok) {
        throw new Error(`Cover art request failed (${response.status})`);
      }

      let imageBlob: Blob;
      if (encryption) {
        if (encryption.algorithm !== "AES-GCM") {
          throw new Error(`Unsupported encryption algorithm: ${encryption.algorithm}`);
        }
        const encryptedBuffer = await response.arrayBuffer();
        const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, {
          algorithm: "AES-GCM",
          key: encryption.key,
          iv: encryption.iv,
          originalName: coverEntry?.metadata?.name,
          originalType: coverEntry?.metadata?.type,
          originalSize: coverEntry?.metadata?.size,
        });
        const mimeType =
          coverEntry?.metadata?.type || response.headers.get("content-type") || "image/jpeg";
        imageBlob = new Blob([decryptedBuffer], { type: mimeType });
      } else {
        imageBlob = await response.blob();
      }

      const existing = playbackUrlCacheRef.current.get(cacheKey);
      if (existing && existing.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(existing);
        } catch {
          // ignore revoke errors
        }
      }
      const objectUrl = URL.createObjectURL(imageBlob);
      playbackUrlCacheRef.current.set(cacheKey, objectUrl);
      return objectUrl;
    },
    [signEventTemplate],
  );

  const buildTrackForBlob = useCallback(
    async (blob: BlossomBlob) => {
      if (!isMusicBlob(blob)) return null;
      const url = await resolvePlaybackUrl(blob);
      const metadata = metadataMap.get(blob.sha256);
      let coverEntry: PrivateListEntry | null = null;
      const coverUrl = metadata?.coverUrl;
      if (coverUrl) {
        const coverSha = extractSha256FromUrl(coverUrl);
        if (coverSha) {
          coverEntry = entriesBySha.get(coverSha) ?? null;
        }
      }
      const track = createAudioTrack(blob, metadata, url);
      if (!track) return null;
      if (metadata?.coverUrl) {
        try {
          const resolvedCover = await resolveCoverArtUrl(blob, metadata.coverUrl, coverEntry);
          if (resolvedCover) {
            track.coverUrl = resolvedCover;
          }
        } catch (error) {
          console.warn("Cover art unavailable", error);
        }
      }
      return track;
    },
    [entriesBySha, metadataMap, resolveCoverArtUrl, resolvePlaybackUrl],
  );

  const buildQueueForPlayback = useCallback(
    async (focusBlob: BlossomBlob, existingFocusTrack?: Track | null) => {
      const source = musicQueueSource.length ? musicQueueSource : [focusBlob];
      const tracks: Track[] = [];
      const seenKeys = new Set<string>();

      const registerTrack = (track: Track | null | undefined) => {
        if (!track) return;
        const key = track.id ?? track.url;
        if (!key || seenKeys.has(key)) return;
        seenKeys.add(key);
        tracks.push(track);
      };

      if (existingFocusTrack) {
        registerTrack(existingFocusTrack);
      }

      const existingFocusId = existingFocusTrack?.id ?? null;
      for (const item of source) {
        if (existingFocusId && item.sha256 === existingFocusId) continue;
        try {
          const track = await buildTrackForBlob(item);
          registerTrack(track);
        } catch (error) {
          console.warn("Failed to prepare track", error);
        }
      }

      let focusTrack =
        existingFocusTrack ?? tracks.find(track => track.id === focusBlob.sha256) ?? null;
      if (!focusTrack) {
        try {
          focusTrack = await buildTrackForBlob(focusBlob);
          registerTrack(focusTrack);
        } catch (error) {
          console.warn("Unable to prepare selected track", error);
        }
      }

      return { focusTrack, queue: tracks };
    },
    [buildTrackForBlob, musicQueueSource],
  );

  const handleDeleteBlob = useCallback(
    async (blob: BlossomBlob) => {
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        if (blob.__bloomFolderIsParentLink) {
          openFolderFromInfo(folderInfo);
          return;
        }

        if (folderInfo.scope === "private") {
          const normalizedPath = normalizeFolderPathInput(folderInfo.path ?? undefined);
          if (!normalizedPath) {
            showStatusMessage("Cannot delete the Private root.", "info", 3000);
            return;
          }

          const impactedEntries = privateEntries.filter(entry => {
            const entryPath = normalizeFolderPathInput(entry.metadata?.folderPath ?? undefined);
            if (!entryPath) return false;
            return entryPath === normalizedPath || entryPath.startsWith(`${normalizedPath}/`);
          });

          const itemCount = impactedEntries.length;
          const displayName = formatPrivateFolderLabel(normalizedPath);
          const message = itemCount
            ? `Delete folder "${displayName}" and move ${
                itemCount === 1 ? "its item" : `${itemCount} items`
              } to Private?`
            : `Delete folder "${displayName}"?`;
          const confirmed = await confirm({
            title: "Delete folder",
            message,
            confirmLabel: "Delete",
            cancelLabel: "Cancel",
            tone: "danger",
          });
          if (!confirmed) return;

          try {
            if (impactedEntries.length) {
              const nowSeconds = Math.floor(Date.now() / 1000);
              const privateBlobMap = new Map<string, BlossomBlob>();
              privateBlobs.forEach(privateBlob => {
                if (!privateBlob?.sha256) return;
                privateBlobMap.set(privateBlob.sha256, privateBlob);
              });
              const metadataTargets: Array<{
                serverUrl: string | undefined;
                sha256: string;
              }> = [];
              const updates: PrivateListEntry[] = impactedEntries.map(entry => {
                const targetEntry = entriesBySha.get(entry.sha256) ?? entry;
                const privateBlob = privateBlobMap.get(targetEntry.sha256);
                metadataTargets.push({
                  serverUrl: privateBlob?.serverUrl ?? targetEntry.servers?.[0] ?? undefined,
                  sha256: targetEntry.sha256,
                });
                return {
                  sha256: targetEntry.sha256,
                  encryption: targetEntry.encryption,
                  metadata: {
                    ...(targetEntry.metadata ?? {}),
                    folderPath: null,
                  },
                  servers: targetEntry.servers,
                  updatedAt: nowSeconds,
                };
              });
              await upsertEntries(updates);
              metadataTargets.forEach(target => {
                rememberFolderPath(target.serverUrl, target.sha256, null, {
                  updatedAt: nowSeconds * 1000,
                });
              });
              await refreshPrivateEntries();
            }

            if (activeList?.type === "folder" && activeList.scope === "private") {
              const activePath = normalizeFolderPathInput(activeList.path ?? undefined);
              if (
                activePath &&
                (activePath === normalizedPath || activePath.startsWith(`${normalizedPath}/`))
              ) {
                const parentPath = getParentFolderPath(normalizedPath);
                if (parentPath && parentPath.length > 0) {
                  setActiveList({
                    type: "folder",
                    scope: "private",
                    path: parentPath,
                    serverUrl: activeList.serverUrl ?? null,
                  });
                } else {
                  setActiveList({ type: "private", serverUrl: activeList.serverUrl ?? null });
                }
              }
            }

            clearSelection();
            const statusLabel = itemCount
              ? itemCount === 1
                ? "Folder deleted. Item moved to Private."
                : `Folder deleted. ${itemCount} items moved to Private.`
              : "Folder deleted.";
            showStatusMessage(statusLabel, "success", 3000);
          } catch (error) {
            const messageText =
              error instanceof Error ? error.message : "Failed to delete private folder.";
            showStatusMessage(messageText, "error", 4000);
          }
          return;
        }

        const normalizedPath = normalizeFolderPathInput(folderInfo.path ?? undefined);
        if (!normalizedPath) {
          showStatusMessage("Cannot delete the root folder.", "error", 3000);
          return;
        }

        const record = foldersByPath.get(normalizedPath);
        if (!record) {
          showStatusMessage("Folder details unavailable.", "error", 3000);
          return;
        }

        const itemCount = record.shas.length;
        const displayName = getFolderDisplayName(normalizedPath) || record.name || normalizedPath;
        const message = itemCount
          ? `Delete folder "${displayName}" and move ${itemCount === 1 ? "its item" : `${itemCount} items`} to Home?`
          : `Delete folder "${displayName}"?`;
        const confirmed = await confirm({
          title: "Delete folder",
          message,
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          tone: "danger",
        });
        if (!confirmed) return;

        try {
          const deletedRecord = await deleteFolder(normalizedPath);
          const shasToClear = deletedRecord?.shas ?? record.shas;

          if (shasToClear.length) {
            const blobLookup = new Map<string, BlossomBlob>();
            const register = (items?: readonly BlossomBlob[] | null) => {
              if (!items) return;
              items.forEach(item => {
                if (!item || !item.sha256) return;
                if (!blobLookup.has(item.sha256)) {
                  blobLookup.set(item.sha256, item);
                }
              });
            };

            register(aggregated.blobs);
            register(currentSnapshot?.blobs ?? null);
            register(currentVisibleBlobs ?? null);
            register(visibleAggregatedBlobs);
            register(privateBlobs);
            register(privateVisibleBlobs);

            const metadataTargets: MetadataSyncTarget[] = [];

            shasToClear.forEach(sha => {
              const target = blobLookup.get(sha);
              applyFolderUpdate(target?.serverUrl, sha, null, undefined);
              if (target && !target.privateData) {
                metadataTargets.push({ blob: target, folderPath: null });
              }
            });

            if (metadataTargets.length) {
              queueMetadataSync(metadataTargets, {
                successMessage: count =>
                  count === 1
                    ? "Synced metadata for 1 item."
                    : `Synced metadata for ${count} items.`,
                errorMessage: failureCount =>
                  failureCount === 1
                    ? "Failed to sync metadata to relays."
                    : `Failed to sync metadata for ${failureCount} items.`,
              });
            }
          }

          if (
            activeList?.type === "folder" &&
            normalizeFolderPathInput(activeList.path) === normalizedPath
          ) {
            const parentPath = getParentFolderPath(normalizedPath);
            if (parentPath) {
              setActiveList({
                type: "folder",
                scope: folderInfo.scope,
                path: parentPath,
                serverUrl: folderInfo.serverUrl ?? null,
              });
            } else {
              setActiveList(null);
            }
          }

          clearSelection();
          showStatusMessage("Folder deleted. Syncing metadata…", "success", 3000);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to delete folder.";
          showStatusMessage(message, "error", 4000);
        }
        return;
      }
      if (isPlaceholderBlob(blob)) {
        if (!hasPrivateFiles) {
          showStatusMessage("There are no private files to delete.", "info", 2000);
          return;
        }
        const confirmed = await confirm({
          title: "Delete private files",
          message: "Delete all files in your Private list?",
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          tone: "danger",
        });
        if (!confirmed) return;
        const shas = privateEntries.map(entry => entry.sha256);
        try {
          await removeEntries(shas);
          setActiveList(null);
          clearSelection();
          showStatusMessage("Private list deleted", "success", 2000);
        } catch (error) {
          console.warn("Failed to delete private list", error);
          const message = error instanceof Error ? error.message : "Failed to delete private list";
          showStatusMessage(message, "error", 4000);
        }
        return;
      }
      if (!isPrivateView && !currentSnapshot) {
        showStatusMessage("Select a specific server to delete files.", "error", 2000);
        return;
      }
      const targetServer = isPrivateView ? activeServerForPrivate : currentSnapshot?.server;
      if (!targetServer) {
        showStatusMessage("Select a server to manage private files.", "error", 3000);
        return;
      }
      const confirmed = await confirm({
        title: "Delete file",
        message: `Delete ${blob.sha256.slice(0, 10)}… from ${targetServer.name}?`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        tone: "danger",
      });
      if (!confirmed) return;
      const requiresSigner = Boolean(targetServer.requiresAuth);
      if (requiresSigner && !signer) {
        showStatusMessage("Connect your signer to delete from this server.", "error", 2000);
        return;
      }
      try {
        const signTemplateForDelete = requiresSigner
          ? (signEventTemplate as SignTemplate | undefined)
          : undefined;
        await performDelete(
          blob,
          signTemplateForDelete,
          targetServer.type,
          targetServer.url,
          requiresSigner,
        );
        if (entriesBySha.has(blob.sha256)) {
          try {
            await removeEntries([blob.sha256]);
          } catch (error) {
            console.warn("Failed to update private list after delete", error);
          }
        }
        if (pubkey) {
          queryClient.invalidateQueries({
            queryKey: ["server-blobs", targetServer.url, pubkey, targetServer.type],
          });
        }
        if (!isPrivateView && blob.folderPath) {
          try {
            await removeBlobFromFolder(blob.folderPath, blob.sha256);
          } catch (error) {
            console.warn("Failed to update folder list after delete", error);
          }
        }
        selectManyBlobs([blob.sha256], false);
        showStatusMessage("Blob deleted", "success", 2000);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Delete failed";
        showStatusMessage(message, "error", 5000);
      }
    },
    [
      activeList,
      activeServerForPrivate,
      aggregated.blobs,
      clearSelection,
      currentSnapshot,
      currentVisibleBlobs,
      deleteFolder,
      entriesBySha,
      extractFolderInfo,
      foldersByPath,
      formatPrivateFolderLabel,
      getFolderDisplayName,
      getParentFolderPath,
      hasPrivateFiles,
      isPlaceholderBlob,
      isPrivateView,
      openFolderFromInfo,
      privateBlobs,
      privateEntries,
      privateVisibleBlobs,
      upsertEntries,
      pubkey,
      queryClient,
      removeBlobFromFolder,
      removeEntries,
      confirm,
      selectManyBlobs,
      setActiveList,
      showStatusMessage,
      signEventTemplate,
      signer,
      refreshPrivateEntries,
      visibleAggregatedBlobs,
    ],
  );

  const handleCopyUrl = useCallback(
    (blob: BlossomBlob, options?: { url?: string; label?: string }) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        openFolderFromInfo(folderInfo);
        return;
      }
      const linkToCopy = options?.url ?? blob.url;
      if (!linkToCopy) return;
      navigator.clipboard
        .writeText(linkToCopy)
        .then(() => {
          const label = options?.label?.trim();
          showStatusMessage(
            label ? `Copied link from ${label}` : "URL copied to clipboard",
            "success",
            1500,
          );
        })
        .catch(() => undefined);
    },
    [extractFolderInfo, isPlaceholderBlob, openFolderFromInfo, openPrivateList, showStatusMessage],
  );

  const handleShareBlob = useCallback(
    (blob: BlossomBlob, options?: { mode?: ShareMode }) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        if (blob.__bloomFolderIsParentLink || folderInfo.scope === "private") {
          openFolderFromInfo(folderInfo);
          return;
        }
        const normalizedPath = normalizeFolderPathInput(folderInfo.path ?? undefined) ?? "";
        if (!normalizedPath) {
          openFolderFromInfo(folderInfo);
          return;
        }
        const shareHint: FolderShareHint = {
          path: normalizedPath,
          scope: folderInfo.scope === "server" ? "server" : "aggregated",
          serverUrl: folderInfo.serverUrl ?? null,
        };
        handleShareFolderHint(shareHint);
        return;
      }
      if (!blob.url) {
        showStatusMessage("This file does not have a shareable URL.", "error", 3000);
        return;
      }
      if (options?.mode === "private-link" && privateLinkServiceConfigured) {
        const existingLink = findExistingPrivateLink(blob);
        if (existingLink) {
          const linkUrl = `${privateLinkHost}/${existingLink.alias}`;
          const sharePayload: SharePayload = {
            url: linkUrl,
            name: getBlobMetadataName(blob),
            sha256: blob.sha256,
            serverUrl: blob.serverUrl ?? null,
            size: typeof blob.size === "number" ? blob.size : null,
          };
          onRequestShare(sharePayload);
          onSetTab("share");
          return;
        }
      }
      const payload: SharePayload = {
        url: blob.url,
        name: getBlobMetadataName(blob),
        sha256: blob.sha256,
        serverUrl: blob.serverUrl ?? null,
        size: typeof blob.size === "number" ? blob.size : null,
      };
      onRequestShare(payload, options);
      onSetTab(options?.mode === "private-link" ? "share-private" : "share");
    },
    [
      extractFolderInfo,
      handleShareFolderHint,
      isPlaceholderBlob,
      onRequestShare,
      onSetTab,
      openFolderFromInfo,
      openPrivateList,
      showStatusMessage,
      findExistingPrivateLink,
      privateLinkServiceConfigured,
      privateLinkHost,
    ],
  );

  const handlePlayBlob = useCallback(
    (blob: BlossomBlob) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        openFolderFromInfo(folderInfo);
        return;
      }
      if (audio.current?.id === blob.sha256) {
        audio.toggle(audio.current, audio.queue);
        return;
      }
      void (async () => {
        try {
          const focusTrack = await buildTrackForBlob(blob);
          if (!focusTrack) {
            showStatusMessage("Unable to play this track.", "error", 4000);
            return;
          }
          const requestKey = focusTrack.id ?? focusTrack.url;
          lastPlayRequestRef.current = requestKey;
          audio.toggle(focusTrack, [focusTrack]);
          void (async () => {
            try {
              const { queue } = await buildQueueForPlayback(blob, focusTrack);
              if (!queue.length) return;
              const currentKey = requestKey;
              if (!currentKey) return;
              if (lastPlayRequestRef.current !== currentKey) return;
              if (audio.current && audio.current.url !== focusTrack.url) return;
              audio.replaceQueue(queue);
            } catch (error) {
              console.warn("Failed to build playback queue", error);
            }
          })();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Playback failed.";
          showStatusMessage(message, "error", 4000);
        }
      })();
    },
    [
      audio,
      buildQueueForPlayback,
      buildTrackForBlob,
      extractFolderInfo,
      isPlaceholderBlob,
      openFolderFromInfo,
      openPrivateList,
      showStatusMessage,
    ],
  );

  const handleCopyTo = useCallback(
    (blob: BlossomBlob) => {
      const resolveNormalizedServer = (value: string | null | undefined) =>
        (value ?? "").trim().replace(/\/+$/, "").toLowerCase();

      const gatherFolderShas = (
        scope: FolderScope,
        rawPath: string,
        serverUrl?: string | null,
      ): { shas: string[]; missing: number } => {
        const shas = new Set<string>();
        let normalizedPath =
          normalizeFolderPathInput(rawPath ?? undefined) ?? (rawPath ? rawPath.trim() : "");
        if (scope !== "private") {
          const canonical = normalizedPath ? resolveFolderPath(normalizedPath) : null;
          if (!canonical) {
            return { shas: [], missing: 0 };
          }
          normalizedPath = canonical;
          const prefix = `${canonical}/`;
          foldersByPath.forEach(record => {
            const recordPath = normalizeFolderPathInput(record.path) ?? record.path;
            if (!recordPath) return;
            if (recordPath === canonical || recordPath.startsWith(prefix)) {
              record.shas.forEach(sha => {
                if (sha) shas.add(sha);
              });
            }
          });
        } else {
          const targetPath = normalizeFolderPathInput(rawPath) ?? null;
          if (targetPath === null) {
            return { shas: [], missing: 0 };
          }
          const prefix = `${targetPath}/`;
          privateEntries.forEach(entry => {
            const entryPath =
              normalizeFolderPathInput(entry.metadata?.folderPath ?? undefined) ?? null;
            if (!entryPath) return;
            if (entryPath === targetPath || entryPath.startsWith(prefix)) {
              shas.add(entry.sha256);
            }
          });
        }

        if (shas.size === 0) return { shas: [], missing: 0 };

        const targetServerNormalized = resolveNormalizedServer(serverUrl);
        const resolved: string[] = [];
        let missing = 0;
        shas.forEach(sha => {
          const match = resolveBlobBySha(sha);
          if (!match) {
            missing += 1;
            return;
          }
          if (
            scope === "server" &&
            serverUrl &&
            resolveNormalizedServer(match.serverUrl) !== targetServerNormalized
          ) {
            return;
          }
          resolved.push(match.sha256);
        });
        return { shas: resolved, missing };
      };

      const handleFolderSelection = (
        scope: FolderScope,
        path: string,
        serverUrl?: string | null,
      ) => {
        const { shas, missing } = gatherFolderShas(scope, path, serverUrl);
        if (shas.length === 0) {
          showStatusMessage("No files in that folder are available right now.", "info", 3500);
          return;
        }
        if (missing > 0) {
          showStatusMessage(
            `${missing} item${missing === 1 ? "" : "s"} in this folder could not be loaded. Copying the rest.`,
            "warning",
            4000,
          );
        }
        replaceSelection(shas);
        onSetTab("transfer");
      };

      const folderInfo = extractFolderInfo(blob);
      if (blob.__bloomFolderPlaceholder && folderInfo) {
        handleFolderSelection(folderInfo.scope, folderInfo.path ?? "", folderInfo.serverUrl);
        return;
      }

      if (isListLikeBlob(blob)) {
        const scope = folderInfo?.scope ?? "aggregated";
        const path =
          folderInfo?.path ??
          blob.folderPath ??
          (blob.__bloomMetadataName && blob.__bloomMetadataName !== blob.sha256
            ? blob.__bloomMetadataName
            : "");
        handleFolderSelection(scope, path ?? "", folderInfo?.serverUrl ?? blob.serverUrl);
        return;
      }

      if (!blob?.sha256) return;
      if (!selectedBlobs.has(blob.sha256)) {
        replaceSelection([blob.sha256]);
      }
      onSetTab("transfer");
    },
    [
      extractFolderInfo,
      foldersByPath,
      onSetTab,
      privateEntries,
      replaceSelection,
      resolveBlobBySha,
      resolveFolderPath,
      selectedBlobs,
      showStatusMessage,
    ],
  );

  const handleMoveRequest = useCallback(
    (blob: BlossomBlob) => {
      if (blob.__bloomFolderPlaceholder) {
        if (blob.__bloomFolderIsParentLink) {
          return;
        }
        const scope = blob.__bloomFolderScope ?? "aggregated";
        const normalizedPath = normalizeFolderPathInput(blob.__bloomFolderTargetPath ?? undefined);
        if (scope === "private") {
          if (!normalizedPath) {
            showStatusMessage("Unable to determine the folder location.", "error", 4000);
            return;
          }
          const folderName = blob.name?.trim().length
            ? blob.name.trim()
            : (normalizedPath.split("/").pop() ?? normalizedPath);
          const parentPathRaw = getParentFolderPath(normalizedPath);
          const parentPath = parentPathRaw && parentPathRaw.length > 0 ? parentPathRaw : null;
          setMoveError(null);
          setMoveBusy(false);
          setMoveState({
            kind: "folder",
            path: normalizedPath,
            name: folderName,
            currentParent: parentPath,
            scope,
            isPrivate: true,
          });
          return;
        }
        if (!normalizedPath) {
          showStatusMessage("Unable to determine the folder location.", "error", 4000);
          return;
        }
        const canonicalPath = resolveFolderPath(normalizedPath);
        const folderName =
          getFolderDisplayName(canonicalPath) || canonicalPath.split("/").pop() || canonicalPath;
        const parentPathRaw = getParentFolderPath(canonicalPath);
        const parentPath =
          parentPathRaw && parentPathRaw.length > 0 ? resolveFolderPath(parentPathRaw) : null;
        setMoveError(null);
        setMoveBusy(false);
        setMoveState({
          kind: "folder",
          path: canonicalPath,
          name: folderName,
          currentParent: parentPath,
          scope: blob.__bloomFolderScope ?? "aggregated",
          isPrivate: false,
        });
        return;
      }

      if (isListLikeBlob(blob)) {
        const folderInfo = extractFolderInfo(blob);
        const scope = folderInfo?.scope ?? "aggregated";
        const normalizedPath = normalizeFolderPathInput(
          folderInfo?.path ?? blob.folderPath ?? undefined,
        );
        if (scope === "private") {
          if (!normalizedPath) {
            showStatusMessage("This folder cannot be moved.", "error", 4000);
            return;
          }
          const folderName = blob.name?.trim().length
            ? blob.name.trim()
            : (normalizedPath.split("/").pop() ?? normalizedPath);
          const parentPathRaw = getParentFolderPath(normalizedPath);
          const parentPath = parentPathRaw && parentPathRaw.length > 0 ? parentPathRaw : null;
          setMoveError(null);
          setMoveBusy(false);
          setMoveState({
            kind: "folder",
            path: normalizedPath,
            name: folderName,
            currentParent: parentPath,
            scope,
            isPrivate: true,
          });
          return;
        }
        if (!normalizedPath) {
          showStatusMessage("This folder cannot be moved.", "error", 4000);
          return;
        }
        const canonicalPath = resolveFolderPath(normalizedPath);
        const folderName =
          getFolderDisplayName(canonicalPath) || canonicalPath.split("/").pop() || canonicalPath;
        const parentPathRaw = getParentFolderPath(canonicalPath);
        const parentPath =
          parentPathRaw && parentPathRaw.length > 0 ? resolveFolderPath(parentPathRaw) : null;
        setMoveError(null);
        setMoveBusy(false);
        setMoveState({
          kind: "folder",
          path: canonicalPath,
          name: folderName,
          currentParent: parentPath,
          scope,
          isPrivate: false,
        });
        return;
      }

      if (blob.privateData) {
        const entry = entriesBySha.get(blob.sha256);
        const normalizedPath =
          normalizeFolderPathInput(entry?.metadata?.folderPath ?? blob.folderPath ?? undefined) ??
          null;
        if (!entry) {
          showStatusMessage("Unable to locate private file details.", "error", 4000);
          return;
        }
        setMoveError(null);
        setMoveBusy(false);
        setMoveState({ kind: "blob", blob, currentPath: normalizedPath, isPrivate: true });
        return;
      }

      const memberships = getFoldersForBlob(blob.sha256);
      const currentPath = memberships[0] ?? null;
      setMoveError(null);
      setMoveBusy(false);
      setMoveState({ kind: "blob", blob, currentPath, isPrivate: false });
    },
    [
      entriesBySha,
      extractFolderInfo,
      getFolderDisplayName,
      getFoldersForBlob,
      isListLikeBlob,
      resolveFolderPath,
      showStatusMessage,
    ],
  );

  const handleMoveSubmit = useCallback(
    async (destination: MoveDialogDestination) => {
      if (!moveState) return;
      setMoveBusy(true);
      setMoveError(null);

      const canonicalize = (value: string | null) => {
        if (!value) return null;
        if (moveState.isPrivate) {
          return value;
        }
        const resolved = resolveFolderPath(value);
        return resolved ? resolved : null;
      };

      try {
        const resolveDestinationValue = (): string | null => {
          if (destination.kind === "new") {
            const normalized = normalizeFolderPathInput(destination.path);
            if (!normalized) {
              throw new Error("Enter a valid folder path.");
            }
            return normalized;
          }
          return destination.target ?? null;
        };

        const rawDestination = resolveDestinationValue();

        if (moveState.kind === "blob") {
          if (moveState.isPrivate) {
            const targetCanonical = canonicalize(rawDestination);
            const currentCanonical = canonicalize(moveState.currentPath);
            if ((currentCanonical ?? null) === (targetCanonical ?? null)) {
              setMoveState(null);
              return;
            }
            const entry = entriesBySha.get(moveState.blob.sha256);
            if (!entry) {
              throw new Error("Unable to locate private file details.");
            }
            const updatedEntry: PrivateListEntry = {
              sha256: entry.sha256,
              encryption: entry.encryption,
              metadata: {
                ...(entry.metadata ?? {}),
                folderPath: targetCanonical,
              },
              servers: entry.servers,
              updatedAt: Math.floor(Date.now() / 1000),
            };
            await upsertEntries([updatedEntry]);
            const destinationLabel = formatPrivateFolderLabel(targetCanonical);
            showStatusMessage(`Moved to ${destinationLabel}.`, "success", 2500);
            setMoveState(null);
            setMoveError(null);
          } else {
            const targetCanonical = canonicalize(rawDestination);
            const currentCanonical = canonicalize(moveState.currentPath);
            if ((currentCanonical ?? null) === (targetCanonical ?? null)) {
              setMoveState(null);
              return;
            }
            await setBlobFolderMembership(moveState.blob.sha256, targetCanonical);
            const destinationLabel = formatFolderLabel(targetCanonical);
            showStatusMessage(`Moved to ${destinationLabel}. Syncing metadata…`, "success", 3000);
            queueMetadataSync([{ blob: moveState.blob, folderPath: targetCanonical ?? null }], {
              successMessage: () => "Folder metadata synced across relays.",
              errorMessage: failureCount =>
                failureCount === 1
                  ? "Failed to sync metadata to relays."
                  : `Failed to sync metadata for ${failureCount} items.`,
            });
            setMoveState(null);
            setMoveError(null);
          }
        } else {
          const targetCanonical = canonicalize(rawDestination);
          const currentCanonical = moveState.path;
          const currentParentCanonical = canonicalize(moveState.currentParent);

          if ((currentParentCanonical ?? null) === (targetCanonical ?? null)) {
            setMoveState(null);
            return;
          }

          if (
            targetCanonical &&
            (targetCanonical === currentCanonical ||
              targetCanonical.startsWith(`${currentCanonical}/`))
          ) {
            throw new Error("Choose a destination outside this folder.");
          }

          const folderName = currentCanonical.split("/").pop() ?? currentCanonical;
          const nextPath = targetCanonical ? `${targetCanonical}/${folderName}` : folderName;

          if (moveState.isPrivate) {
            const nowSeconds = Math.floor(Date.now() / 1000);
            const updates: PrivateListEntry[] = [];
            privateEntries.forEach(entry => {
              const entryPath = normalizeFolderPathInput(entry.metadata?.folderPath ?? undefined);
              if (!entryPath) return;
              if (entryPath === currentCanonical || entryPath.startsWith(`${currentCanonical}/`)) {
                const suffix = entryPath.slice(currentCanonical.length).replace(/^\/+/, "");
                const updatedPath = suffix ? `${nextPath}/${suffix}` : nextPath;
                updates.push({
                  sha256: entry.sha256,
                  encryption: entry.encryption,
                  metadata: {
                    ...(entry.metadata ?? {}),
                    folderPath: updatedPath,
                  },
                  servers: entry.servers,
                  updatedAt: nowSeconds,
                });
              }
            });

            if (!updates.length) {
              throw new Error("Unable to locate private folder contents.");
            }

            await upsertEntries(updates);

            const destinationLabel = formatPrivateFolderLabel(targetCanonical);
            showStatusMessage(`Folder moved to ${destinationLabel}.`, "success", 2500);

            if (activeList?.type === "folder" && activeList.scope === "private") {
              if (activeList.path === currentCanonical) {
                setActiveList({
                  ...activeList,
                  path: nextPath,
                });
              } else if (activeList.path.startsWith(`${currentCanonical}/`)) {
                const suffix = activeList.path.slice(currentCanonical.length).replace(/^\/+/, "");
                const updatedActivePath = suffix ? `${nextPath}/${suffix}` : nextPath;
                setActiveList({
                  ...activeList,
                  path: updatedActivePath,
                });
              }
            }

            setMoveState(null);
            setMoveError(null);
          } else {
            const impactedRecords = Array.from(foldersByPath.values()).filter(record => {
              if (!currentCanonical) return false;
              return (
                record.path === currentCanonical || record.path.startsWith(`${currentCanonical}/`)
              );
            });
            const metadataTargetMap = new Map<string, MetadataSyncTarget>();
            const computeTargetPath = (recordPath: string) => {
              if (!currentCanonical) return nextPath;
              if (recordPath === currentCanonical) return nextPath;
              if (recordPath.startsWith(`${currentCanonical}/`)) {
                const suffix = recordPath.slice(currentCanonical.length).replace(/^\/+/, "");
                if (!suffix) return nextPath;
                return nextPath ? `${nextPath}/${suffix}` : suffix;
              }
              return nextPath;
            };
            impactedRecords.forEach(record => {
              const targetPathRaw = computeTargetPath(record.path);
              const targetPath = targetPathRaw && targetPathRaw.length > 0 ? targetPathRaw : null;
              record.shas.forEach(sha => {
                if (!sha) return;
                const existing = metadataTargetMap.get(sha);
                if (existing) {
                  existing.folderPath = targetPath;
                  return;
                }
                const blob = resolveBlobBySha(sha);
                if (!blob || blob.privateData) return;
                metadataTargetMap.set(sha, { blob, folderPath: targetPath });
              });
            });
            const metadataTargets = Array.from(metadataTargetMap.values());

            await renameFolder(currentCanonical, nextPath);

            const destinationLabel = formatFolderLabel(targetCanonical);
            showStatusMessage(
              `Folder moved to ${destinationLabel}. Syncing metadata…`,
              "success",
              3000,
            );
            if (metadataTargets.length) {
              queueMetadataSync(metadataTargets, {
                successMessage: count =>
                  count === 1
                    ? "Synced metadata for 1 item."
                    : `Synced metadata for ${count} items.`,
                errorMessage: failureCount =>
                  failureCount === 1
                    ? "Failed to sync metadata to relays."
                    : `Failed to sync metadata for ${failureCount} items.`,
              });
            }

            if (activeList?.type === "folder") {
              const activeCanonical = resolveFolderPath(activeList.path);
              if (activeCanonical === currentCanonical) {
                const resolvedNext = resolveFolderPath(nextPath);
                setActiveList({
                  ...activeList,
                  path: resolvedNext,
                });
              }
            }

            setMoveState(null);
            setMoveError(null);
          }
        }
      } catch (error) {
        setMoveError(error instanceof Error ? error.message : "Unable to move item.");
        return;
      } finally {
        setMoveBusy(false);
      }
    },
    [
      activeList,
      entriesBySha,
      formatFolderLabel,
      formatPrivateFolderLabel,
      moveState,
      privateEntries,
      renameFolder,
      resolveFolderPath,
      setActiveList,
      setBlobFolderMembership,
      showStatusMessage,
      upsertEntries,
    ],
  );

  const closeMoveDialog = useCallback(() => {
    if (moveBusy) return;
    setMoveState(null);
    setMoveError(null);
  }, [moveBusy]);

  const handleRenameBlob = useCallback(
    (blob: BlossomBlob) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        if (folderInfo.scope === "private") {
          const normalizedPath = normalizeFolderPathInput(folderInfo.path ?? undefined);
          if (!normalizedPath) {
            openFolderFromInfo(folderInfo);
            return;
          }
          onRequestFolderRename({
            path: normalizedPath,
            scope: "private",
            serverUrl: folderInfo.serverUrl ?? null,
          });
          return;
        }
        if (folderInfo.path) {
          const normalizedPath = normalizeFolderPathInput(folderInfo.path ?? undefined) ?? "";
          onRequestFolderRename({
            path: normalizedPath,
            scope: folderInfo.scope,
            serverUrl: folderInfo.serverUrl ?? null,
          });
          return;
        }
        return;
      }
      onRequestRename(blob);
    },
    [
      extractFolderInfo,
      isPlaceholderBlob,
      onRequestFolderRename,
      onRequestRename,
      openFolderFromInfo,
      openPrivateList,
    ],
  );

  const handleOpenListBlob = useCallback(
    (blob: BlossomBlob) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        openFolderFromInfo(folderInfo);
      }
    },
    [extractFolderInfo, isPlaceholderBlob, openFolderFromInfo, openPrivateList],
  );

  const navigateHome = useCallback(() => {
    setActiveList(null);
    clearSelection();
  }, [clearSelection]);

  const navigateUp = useCallback(() => {
    setActiveList(prev => {
      if (!prev) return prev;
      if (prev.type === "private") {
        return null;
      }
      if (prev.type === "folder") {
        const parentPath = getParentFolderPath(prev.path);
        if (prev.scope === "private") {
          if (parentPath === null || parentPath === "") {
            return { type: "private", serverUrl: prev.serverUrl ?? null };
          }
          return {
            type: "folder",
            scope: "private",
            path: parentPath,
            serverUrl: prev.serverUrl ?? null,
          };
        }
        if (parentPath === null || parentPath === "") {
          return null;
        }
        return {
          type: "folder",
          scope: prev.scope,
          path: parentPath,
          serverUrl: prev.serverUrl ?? null,
        };
      }
      return prev;
    });
    clearSelection();
  }, [clearSelection, setActiveList]);

  const breadcrumbSegments = useMemo<BrowseNavigationSegment[]>(() => {
    if (isSearching || !activeList) return [];
    const segments: BrowseNavigationSegment[] = [];

    if (activeList.type === "private") {
      segments.push({
        id: `private-root:${activeList.serverUrl ?? "all"}`,
        label: PRIVATE_SERVER_NAME,
        onNavigate: () => {
          openPrivateList();
        },
      });
      return segments;
    }

    if (activeList.type === "folder") {
      if (activeList.scope === "private") {
        segments.push({
          id: `private-root:${activeList.serverUrl ?? "all"}`,
          label: PRIVATE_SERVER_NAME,
          onNavigate: () => {
            openPrivateList();
          },
        });
      }

      const pathSegments = activeList.path ? activeList.path.split("/") : [];
      pathSegments.forEach((segment, index) => {
        const targetPath = pathSegments.slice(0, index + 1).join("/");
        const label = getFolderDisplayName(targetPath) || segment;
        const id = `${activeList.scope}:${targetPath || "__root__"}:${activeList.serverUrl ?? "all"}`;
        const canonicalPath = resolveFolderPath(targetPath);
        const record = canonicalPath ? (foldersByPath.get(canonicalPath) ?? null) : null;
        segments.push({
          id,
          label,
          onNavigate: () => {
            openFolderFromInfo({
              scope: activeList.scope,
              path: targetPath,
              serverUrl: activeList.serverUrl ?? null,
            });
          },
          visibility: record?.visibility ?? null,
        });
      });

      return segments;
    }

    return segments;
  }, [
    activeList,
    foldersByPath,
    getFolderDisplayName,
    isSearching,
    openFolderFromInfo,
    openPrivateList,
  ]);

  const navigationState = useMemo<BrowseNavigationState>(
    () => ({
      segments: breadcrumbSegments,
      canNavigateUp: Boolean(activeList) && !isSearching,
      onNavigateHome: navigateHome,
      onNavigateUp: navigateUp,
    }),
    [activeList, breadcrumbSegments, isSearching, navigateHome, navigateUp],
  );

  useEffect(() => {
    onNavigationChange?.(navigationState);
  }, [navigationState, onNavigationChange]);

  useEffect(() => {
    return () => {
      onNavigationChange?.(null);
    };
  }, [onNavigationChange]);

  const moveDialogInitialValue = moveState
    ? moveState.kind === "folder"
      ? (moveState.currentParent ?? null)
      : (moveState.currentPath ?? null)
    : null;

  const moveDialogCurrentLocation = moveState
    ? moveState.kind === "folder"
      ? formatMoveDestinationLabel(moveState.currentParent, moveState.isPrivate)
      : formatMoveDestinationLabel(moveState.currentPath, moveState.isPrivate)
    : "Home";

  const moveDialogItemLabel = moveState
    ? moveState.kind === "folder"
      ? moveState.name
      : (getBlobMetadataName(moveState.blob) ?? moveState.blob.name ?? moveState.blob.sha256)
    : "";

  const moveDialogItemPath =
    moveState?.kind === "folder"
      ? formatMoveDestinationLabel(moveState.path, moveState.isPrivate)
      : undefined;

  const moveDialogDestinationHint = moveState?.isPrivate
    ? "Private items can only be moved within Private."
    : "Only non-private folders are available as destinations.";

  const moveDialogNewFolderDefault = moveState?.isPrivate ? "Trips" : "Images/Trips";

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading library…
            </div>
          }
        >
          <BrowsePanelLazy
            viewMode={viewMode}
            browsingAllServers={effectiveBrowsingAllServers}
            aggregatedBlobs={effectiveAggregatedBlobs}
            currentSnapshot={effectiveCurrentSnapshot}
            currentVisibleBlobs={effectiveCurrentVisibleBlobs}
            selectedBlobs={selectedBlobs}
            signTemplate={effectiveSignTemplate}
            replicaInfo={effectiveReplicaInfo}
            onToggle={handleToggleBlob}
            onSelectMany={handleSelectManyBlobs}
            onDelete={handleDeleteBlob}
            onCopy={handleCopyUrl}
            onShare={handleShareBlob}
            onRename={handleRenameBlob}
            onMove={handleMoveRequest}
            onCopyTo={handleCopyTo}
            onPlay={handlePlayBlob}
            resolvePrivateLink={resolvePrivateLink}
            currentTrackUrl={audio.current?.url}
            currentTrackStatus={audio.status}
            filterMode={filterMode}
            showGridPreviews={showGridPreviews}
            showListPreviews={showListPreviews}
            onOpenList={handleOpenListBlob}
            defaultSortOption={defaultSortOption}
            sortDirection={sortDirection}
            folderRecords={foldersByPath}
            onShareFolder={handleShareFolderHint}
            onUnshareFolder={handleUnshareFolderHint}
            folderShareBusyPath={folderShareBusyPath}
            privateLinkServiceConfigured={privateLinkServiceConfigured}
          />
        </Suspense>
      </div>
      {moveState ? (
        <MoveDialog
          itemType={moveState.kind === "folder" ? "folder" : "file"}
          itemLabel={moveDialogItemLabel}
          currentLocationLabel={moveDialogCurrentLocation}
          itemPathLabel={moveDialogItemPath}
          options={moveDialogOptions}
          initialValue={moveDialogInitialValue}
          busy={moveBusy}
          error={moveError}
          onSubmit={handleMoveSubmit}
          onCancel={closeMoveDialog}
          createNewOptionValue={NEW_FOLDER_OPTION_VALUE}
          newFolderDefaultPath={moveDialogNewFolderDefault}
          destinationHint={moveDialogDestinationHint}
        />
      ) : null}
    </div>
  );
};

const performDelete = async (
  blob: BlossomBlob,
  signTemplate: SignTemplate | undefined,
  serverType: ManagedServer["type"],
  serverUrl: string,
  requiresSigner: boolean,
) => {
  if (serverType === "nip96") {
    await deleteNip96File(
      serverUrl,
      blob.sha256,
      requiresSigner ? signTemplate : undefined,
      requiresSigner,
    );
    return;
  }
  if (serverType === "satellite") {
    await deleteSatelliteFile(serverUrl, blob.sha256, signTemplate, true);
    return;
  }
  await deleteUserBlob(
    serverUrl,
    blob.sha256,
    requiresSigner ? signTemplate : undefined,
    requiresSigner,
  );
};
