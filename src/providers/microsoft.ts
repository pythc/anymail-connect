export const microsoftClouds = {
  global: {
    authority: "https://login.microsoftonline.com",
    graph: "https://graph.microsoft.com",
  },
  usgov: {
    authority: "https://login.microsoftonline.us",
    graph: "https://graph.microsoft.us",
  },
  usgovdod: {
    authority: "https://login.microsoftonline.us",
    graph: "https://dod-graph.microsoft.us",
  },
  china: {
    authority: "https://login.chinacloudapi.cn",
    graph: "https://microsoftgraph.chinacloudapi.cn",
  },
} as const;
export type MicrosoftCloud = keyof typeof microsoftClouds;
