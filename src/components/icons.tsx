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

export const MusicIcon = createIcon(
  <>
    <path d="M10 17V7.5l8-2V15" />
    <circle cx="10" cy="18.5" r="2.5" />
    <circle cx="18" cy="16.5" r="2.5" />
  </>
);

export const FilterIcon = createIcon(
  <>
    <path d="M4 5h16l-6.5 8v6.5L10.5 21v-8L4 5Z" />
  </>
);

export const PlayIcon = createIcon(
  <>
    <path d="M9 6.5v11l9-5.5Z" fill="currentColor" stroke="none" />
    <path d="M9 6.5v11l9-5.5Z" />
  </>
);

export const PauseIcon = createIcon(
  <>
    <rect x="7.5" y="6" width="3" height="12" rx="1" />
    <rect x="13.5" y="6" width="3" height="12" rx="1" />
  </>
);

export const PreviousIcon = createIcon(
  <>
    <path d="M7 5v14" />
    <path d="M17 5 9 12l8 7Z" />
  </>
);

export const NextIcon = createIcon(
  <>
    <path d="M17 5v14" />
    <path d="M7 5l8 7-8 7Z" />
  </>
);

export const RepeatIcon = createIcon(
  <>
    <path d="M7 4h8a4 4 0 0 1 4 4v1" />
    <path d="m15 5 4 4-4 4" />
    <path d="M17 20H9a4 4 0 0 1-4-4v-1" />
    <path d="m9 19-4-4 4-4" />
  </>
);

export const RepeatOneIcon = createIcon(
  <>
    <path d="M7 4h8a4 4 0 0 1 4 4v1" />
    <path d="m15 5 4 4-4 4" />
    <path d="M17 20H9a4 4 0 0 1-4-4v-1" />
    <path d="m9 19-4-4 4-4" />
    <path d="M12 11v5" />
    <path d="m10.5 12.5 1.5-1.5 1.5 1.5" />
  </>
);

export const StopIcon = createIcon(
  <>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
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

export type FileKind = "folder" | "image" | "video" | "document" | "pdf" | "doc" | "sheet";

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

export const SyncIndicatorIcon = createIcon(
  <>
    <path d="M4 12a8 8 0 0 1 13.66-5.66" />
    <path d="M17.5 3.5H21V7" />
    <path d="M20 12a8 8 0 0 1-13.66 5.66" />
    <path d="m6.5 20.5H3V17" />
  </>
);

export const CopyIcon = createIcon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M6 15V5a2 2 0 0 1 2-2h10" />
  </>
);

export const ShareIcon = createIcon(
  <>
    <circle cx="18" cy="5.5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="18.5" r="2.5" />
    <path d="M8.2 10.9 15 7.3" />
    <path d="M8.2 13.1 15 16.7" />
  </>
);

export const PreviewIcon = createIcon(
  <>
    <path d="M3 12s3.6-6 9-6 9 6 9 6-3.6 6-9 6-9-6-9-6Z" />
    <circle cx="12" cy="12" r="3" />
  </>
);

export const HomeIcon = createIcon(
  <>
    <path d="M4 11.5 12 5l8 6.5" />
    <path d="M7.5 10v9.5A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5V10" />
    <path d="M10.5 21v-5h3v5" />
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
    case "pdf":
      return <PdfIcon size={size} className={className} />;
    case "doc":
      return <DocIcon size={size} className={className} />;
    case "sheet":
      return <SheetIcon size={size} className={className} />;
    default:
      return <DocumentIcon size={size} className={className} />;
  }
};

const PdfIcon: React.FC<IconProps> = ({ size = 20, className = "", ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    role="img"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <path
      d="M30 4H14c-2.2 0-4 1.8-4 4v32c0 2.2 1.8 4 4 4h20c2.2 0 4-1.8 4-4V12L30 4Z"
      fill="white"
      fillOpacity={0.08}
      stroke="white"
      strokeWidth={2}
    />
    <path d="M30 4v8h8" stroke="white" strokeWidth={2} />
    <rect x={10} y={24} width={28} height={12} rx={2} fill="#dc2626" />
    <g fill="white">
      <path d="M15 33v-6h3.2c1.8 0 2.8.9 2.8 2.3 0 1.5-1.1 2.3-2.8 2.3H17v1.4h-2Zm2-3h1.1c.7 0 1.1-.3 1.1-1s-.4-1-1.1-1H17v2Z" />
      <path d="M22 33v-6h3c2.1 0 3.6 1.3 3.6 3s-1.5 3-3.6 3h-3Zm2-2h1c.9 0 1.6-.6 1.6-1.6 0-.9-.7-1.4-1.6-1.4h-1V31Z" />
      <path d="M31 33v-6h5v1.8h-3v.9h2.6V31H33v2h-2Z" />
    </g>
  </svg>
);

const DocIcon: React.FC<IconProps> = ({ size = 20, className = "", ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    role="img"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <path
      d="M30 4H14c-2.2 0-4 1.8-4 4v32c0 2.2 1.8 4 4 4h20c2.2 0 4-1.8 4-4V12L30 4Z"
      fill="white"
      fillOpacity={0.08}
      stroke="white"
      strokeWidth={2}
    />
    <path d="M30 4v8h8" stroke="white" strokeWidth={2} />
    <rect x={10} y={24} width={28} height={12} rx={2} fill="blue" />
    <g fill="white">
      <path d="M15 33v-6h2.8c1.9 0 3.2 1.2 3.2 3s-1.3 3-3.2 3H15Zm2-2h.7c.9 0 1.5-.6 1.5-1.5 0-.9-.6-1.5-1.5-1.5H17v3Z" />
      <path d="M23 33c-1.9 0-3.3-1.3-3.3-3s1.4-3 3.3-3c1.8 0 3.3 1.3 3.3 3s-1.5 3-3.3 3Zm0-2c.9 0 1.4-.6 1.4-1.5s-.5-1.5-1.4-1.5c-.9 0-1.4.6-1.4 1.5s.5 1.5 1.4 1.5Z" />
      <path d="M29.5 33c-1.6 0-3-1.3-3-3s1.4-3 3-3c1 0 1.7.4 2.3 1l-1.2 1c-.3-.3-.6-.5-1.1-.5-.7 0-1.3.6-1.3 1.5s.6 1.5 1.3 1.5c.5 0 .8-.2 1.1-.5l1.2 1c-.6.6-1.3 1-2.3 1Z" />
    </g>
  </svg>
);

const SheetIcon: React.FC<IconProps> = ({ size = 20, className = "", ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    role="img"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <path
      d="M30 4H14c-2.2 0-4 1.8-4 4v32c0 2.2 1.8 4 4 4h20c2.2 0 4-1.8 4-4V12L30 4Z"
      fill="white"
      fillOpacity={0.08}
      stroke="white"
      strokeWidth={2}
    />
    <path d="M30 4v8h8" stroke="white" strokeWidth={2} />
    <rect x={10} y={24} width={28} height={12} rx={2} fill="green" />
    <text
      x={24}
      y={34}
      textAnchor="middle"
      fontFamily="system-ui, sans-serif"
      fontWeight={700}
      fontSize={10}
      fill="white"
    >
      XLS
    </text>
  </svg>
);
