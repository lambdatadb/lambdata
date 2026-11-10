export type SetAsideKind = "quarantine" | "kept";

export interface SetAsideTable {
  name: string;
  rowCount: number | null;
  sizeBytes: number | null;
  nameFreeInDatabase: boolean;
}

export interface SetAsideSchema {
  schema: string;
  kind: SetAsideKind;
  createdAt: number | null;
  sizeBytes: number | null;
  tables: SetAsideTable[];
}

export interface SetAsideListResponse {
  schemas: SetAsideSchema[];
}

export interface MoveBackSetAsideTableRequest {
  table: string;
  as?: string;
}

export interface MoveBackSetAsideTableResponse {
  table: string;
  movedTo: string;
  schemaRemoved: boolean;
}
