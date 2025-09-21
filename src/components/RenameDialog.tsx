import React, { useEffect, useRef } from "react";
import type { BlossomBlob } from "../lib/blossomClient";

export type EditDialogAudioFields = {
  title: string;
  artist: string;
  album: string;
  trackNumber: string;
  trackTotal: string;
  durationSeconds: string;
  genre: string;
  year: string;
};

export type EditDialogProps = {
  blob: BlossomBlob;
  alias: string;
  busy?: boolean;
  error?: string | null;
  isMusic: boolean;
  onAliasChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  audioFields?: EditDialogAudioFields;
  onAudioFieldChange?: (field: keyof EditDialogAudioFields, value: string) => void;
};

export const EditDialog: React.FC<EditDialogProps> = ({
  blob,
  alias,
  busy = false,
  error,
  isMusic,
  onAliasChange,
  onSubmit,
  onCancel,
  audioFields,
  onAudioFieldChange,
}) => {
  const aliasInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const target = isMusic ? titleInputRef.current : aliasInputRef.current;
    if (target) {
      target.focus();
      if (!isMusic) target.select();
    }
  }, [isMusic]);

  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  const renderMusicFields = () => {
    if (!isMusic) return null;
    const fields = audioFields ?? {
      title: "",
      artist: "",
      album: "",
      trackNumber: "",
      trackTotal: "",
      durationSeconds: "",
      genre: "",
      year: "",
    };

    const handleAudioChange = (field: keyof EditDialogAudioFields) => (event: React.ChangeEvent<HTMLInputElement>) => {
      onAudioFieldChange?.(field, event.target.value);
    };

    return (
      <div className="mt-4 space-y-4">
        <p className="text-sm text-slate-400">
          Update the track metadata for <span className="font-mono text-slate-200">{blob.sha256.slice(0, 12)}…</span>. Title is required.
        </p>
        <label className="block text-sm text-slate-300">
          Title
          <input
            ref={titleInputRef}
            type="text"
            value={fields.title}
            onChange={handleAudioChange("title")}
            disabled={busy}
            className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
            placeholder="Track title"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm text-slate-300">
            Artist
            <input
              type="text"
              value={fields.artist}
              onChange={handleAudioChange("artist")}
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              placeholder="Primary artist"
            />
          </label>
          <label className="block text-sm text-slate-300">
            Album
            <input
              type="text"
              value={fields.album}
              onChange={handleAudioChange("album")}
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              placeholder="Album name"
            />
          </label>
          <label className="block text-sm text-slate-300">
            Track number
            <input
              type="number"
              min={1}
              value={fields.trackNumber}
              onChange={handleAudioChange("trackNumber")}
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              placeholder="e.g. 3"
            />
          </label>
          <label className="block text-sm text-slate-300">
            Total tracks
            <input
              type="number"
              min={1}
              value={fields.trackTotal}
              onChange={handleAudioChange("trackTotal")}
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              placeholder="e.g. 10"
            />
          </label>
          <label className="block text-sm text-slate-300">
            Duration (seconds)
            <input
              type="number"
              min={1}
              value={fields.durationSeconds}
              onChange={handleAudioChange("durationSeconds")}
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              placeholder="e.g. 215"
            />
          </label>
          <label className="block text-sm text-slate-300">
            Genre
            <input
              type="text"
              value={fields.genre}
              onChange={handleAudioChange("genre")}
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              placeholder="e.g. Electronic"
            />
          </label>
          <label className="block text-sm text-slate-300">
            Year
            <input
              type="number"
              min={0}
              value={fields.year}
              onChange={handleAudioChange("year")}
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              placeholder="e.g. 2024"
            />
          </label>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-300">
          <div className="font-medium text-slate-100">Display name</div>
          <div className="mt-1 font-mono text-emerald-300">{alias}</div>
          <p className="mt-2 text-xs text-slate-400">
            The display name is automatically derived as <span className="font-semibold">Artist – Title</span> when an artist is provided.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" onKeyDown={handleKeyDown}>
      <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-100">Edit file details</h2>
        {!isMusic && (
          <p className="mt-2 text-sm text-slate-400">
            Provide a new display name for <span className="font-mono text-slate-200">{blob.sha256.slice(0, 12)}…</span>. Leave the field empty to clear the
            alias.
          </p>
        )}

        {isMusic ? (
          renderMusicFields()
        ) : (
          <label className="mt-4 block text-sm text-slate-300">
            Display name
            <input
              ref={aliasInputRef}
              type="text"
              value={alias}
              onChange={event => onAliasChange(event.target.value)}
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              placeholder="Enter a display name"
            />
          </label>
        )}
        {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
        <div className="mt-6 flex justify-end gap-3">
          <button
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-600"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-500 disabled:opacity-50"
            onClick={onSubmit}
            disabled={busy}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
};
