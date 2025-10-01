/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRIVATE_LINK_SERVICE_HOST?: string;
  readonly VITE_PRIVATE_LINK_SERVICE_PUBKEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
