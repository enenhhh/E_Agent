/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E_AGENT_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
