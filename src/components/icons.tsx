import React from "react";

type IconProps = React.SVGProps<SVGSVGElement> & {
  size?: number;
};

function createIcon(path: React.ReactNode) {
  return ({ size = 20, className = "", ...props }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      {path}
    </svg>
  );
}

export const GridIcon = createIcon(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>
);

export const ListIcon = createIcon(
  <>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
    <circle cx="5" cy="6" r="1.5" fill="currentColor" />
    <circle cx="5" cy="12" r="1.5" fill="currentColor" />
    <circle cx="5" cy="18" r="1.5" fill="currentColor" />
  </>
);

export const FolderIcon = createIcon(
  <>
    <path d="M3.5 7.5v9a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-6l-1.5-2h-6c-.828 0-1.5.672-1.5 1.5Z" />
  </>
);

export const ImageIcon = createIcon(
  <>
    <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
    <circle cx="9" cy="10" r="1.3" />
    <path d="M4.5 17.5 10 12l3 3 3-2.5 3.5 3" />
  </>
);

export const VideoIcon = createIcon(
  <>
    <rect x="3.5" y="6" width="12" height="12" rx="1.5" />
    <path d="M17 9.5 21 8v8l-4-1.5Z" fill="currentColor" stroke="none" />
  </>
);

export const DocumentIcon = createIcon(
  <>
    <path d="M6.5 4h7l4 4v10.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6.5 19V5.5A1.5 1.5 0 0 1 8 4Z" />
    <path d="M13.5 4v4h4" />
    <path d="M9.5 12h5" />
    <path d="M9.5 16h5" />
  </>
);

export type FileKind = "folder" | "image" | "video" | "document";

export const DownloadIcon = createIcon(
  <>
    <path d="M12 4v10" />
    <path d="m7.5 11 4.5 4.5L16.5 11" />
    <path d="M5 19h14" />
  </>
);

export const TrashIcon = createIcon(
  <>
    <path d="M4 7h16" />
    <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
    <path d="M6.5 7v11A2.5 2.5 0 0 0 9 20.5h6a2.5 2.5 0 0 0 2.5-2.5V7" />
    <path d="M10 11.5v5" />
    <path d="M14 11.5v5" />
  </>
);

export const EditIcon = createIcon(
  <>
    <path d="M4 20h3.8a1 1 0 0 0 .7-.29l9.7-9.7a1.5 1.5 0 0 0 0-2.12l-2.38-2.38a1.5 1.5 0 0 0-2.12 0l-9.7 9.7a1 1 0 0 0-.29.7Z" />
    <path d="m13.5 5.5 4 4" />
  </>
);

export const SaveIcon = createIcon(
  <>
    <path d="M5.5 4h9.9a1.5 1.5 0 0 1 1.06.44l2.6 2.6a1.5 1.5 0 0 1 .44 1.06V18.5a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5V5.5A1.5 1.5 0 0 1 5.5 4Z" />
    <path d="M8 4v4.5h6V4" />
    <path d="m9.5 13.5 2.5 2.5 3.5-3.5" />
  </>
);

export const CancelIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="m15 9-6 6" />
    <path d="m9 9 6 6" />
  </>
);

export const CopyIcon = createIcon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M6 15V5a2 2 0 0 1 2-2h10" />
  </>
);

export const BrowseIcon = createIcon(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.35-4.35" />
  </>
);

export const UploadIcon = createIcon(
  <>
    <path d="M12 5v10" />
    <path d="m7.5 9.5 4.5-4.5 4.5 4.5" />
    <path d="M6 19h12" />
  </>
);

export const TransferIcon = createIcon(
  <>
    <path d="M6 8h9" />
    <path d="M12 5l3 3-3 3" />
    <path d="M18 16h-9" />
    <path d="M12 13l-3 3 3 3" />
  </>
);

export const ServersIcon = createIcon(
  <>
    <rect x="4" y="4" width="16" height="6" rx="2" />
    <rect x="4" y="14" width="16" height="6" rx="2" />
    <path d="M8 7h.01" />
    <path d="M8 17h.01" />
  </>
);

export const FileTypeIcon: React.FC<{ kind: FileKind; size?: number; className?: string }> = ({ kind, size = 20, className }) => {
  switch (kind) {
    case "folder":
      return <FolderIcon size={size} className={className} />;
    case "image":
      return <ImageIcon size={size} className={className} />;
    case "video":
      return <VideoIcon size={size} className={className} />;
    default:
      return <DocumentIcon size={size} className={className} />;
  }
};
