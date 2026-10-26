export {};

declare global {
  interface Window {
    edgeShell?: {
      platform: string;
      isElectron: boolean;
      sidecarToken: string;
    };
  }
}
