export interface InstanceLease {
  dataDir: string;
  removeDirOnStop: boolean;
}

export interface MetadataLease {
  dataDir: string;
  released: boolean;
}

export const harnessState: {
  instance: InstanceLease | null;
  metadata: MetadataLease | null;
} = {
  instance: null,
  metadata: null,
};
