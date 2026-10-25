/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Address of the realtime server, e.g. `wss://canvas.example.com`. Set at build time. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
