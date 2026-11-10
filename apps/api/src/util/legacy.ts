export const LEGACY = {
  envPrefix: "KILNDB_",
  localDataDirName: ".kilndb",
  pointerDirName: ".kilndb",
  mariadbRootUser: "kilndb_root",
  sessionCookie: "kilndb_session",
  appAuthIssuer: "kilndb-app-auth",
  functionLogIdHeader: "x-kilndb-function-log-id",
} as const;
