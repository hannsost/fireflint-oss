export type Id = string;
export type IsoDateTime = string;

export interface AssetContext {
  organizationId: Id;
  correlationId: string;
  principalId?: Id;
}

export interface BlobObject {
  id: Id;
  organizationId: Id;
  checksum: string;
  checksumAlgorithm: "sha256" | "reference";
  size: number;
  mediaType: string;
  storageKey: string;
  encryptionKeyRef?: string;
  scanState: "pending" | "clean" | "infected" | "failed";
  createdAt: IsoDateTime;
}

export interface AssetClassification {
  category: string;
  confidentiality: "public" | "internal" | "confidential" | "restricted";
  personalData?: boolean;
  specialCategoryData?: boolean;
  recordsClass?: string;
}

export interface DomainLink {
  domain: string;
  type: string;
  id: Id;
  relation: string;
}

export interface AssetSource {
  system: string;
  externalId: string;
  importedAt: IsoDateTime;
  sourceUrl?: string;
  authoritative?: boolean;
}

export interface AssetVersion {
  id: Id;
  assetId: Id;
  version: number;
  blobId: Id;
  filename: string;
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdByPrincipalId?: Id;
  createdAt: IsoDateTime;
}

export interface Rendition {
  id: Id;
  assetVersionId: Id;
  kind: string;
  blobId: Id;
  width?: number;
  height?: number;
  durationSeconds?: number;
  bitrate?: number;
  createdAt: IsoDateTime;
}

export interface Asset {
  id: Id;
  organizationId: Id;
  type: "document" | "image" | "video" | "audio" | "archive" | "data" | "other";
  state: "draft" | "active" | "quarantined" | "archived" | "deleted";
  classification: AssetClassification;
  currentVersionId: Id;
  links: DomainLink[];
  sources: AssetSource[];
  retentionPolicyRef?: Id;
  legalHoldRefs: Id[];
  accessPolicyRef?: Id;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface AssetCollection {
  id: Id;
  organizationId: Id;
  name: string;
  parentCollectionId?: Id;
  assetIds: Id[];
  classification?: AssetClassification;
}

export interface PurgeResult {
  assetId: Id;
  purgedVersionIds: Id[];
  purgedBlobIds: Id[];
}

export interface UploadInput {
  filename: string;
  mediaType: string;
  content: Uint8Array;
  encryptionKeyRef?: string;
}

export interface AssetCreateInput {
  type: Asset["type"];
  classification: AssetClassification;
  upload: UploadInput;
  title?: string;
  description?: string;
  links?: DomainLink[];
  sources?: AssetSource[];
  retentionPolicyRef?: Id;
  accessPolicyRef?: Id;
}

export interface BlobProvider {
  put(context: AssetContext, input: UploadInput): Promise<BlobObject>;
  get(context: AssetContext, blobId: Id): Promise<BlobObject | null>;
  content(context: AssetContext, blobId: Id): Promise<Uint8Array | null>;
  markScanState(
    context: AssetContext,
    blobId: Id,
    state: BlobObject["scanState"],
  ): Promise<BlobObject>;
}

export interface AssetProvider {
  create(context: AssetContext, input: AssetCreateInput): Promise<Asset>;
  get(context: AssetContext, assetId: Id): Promise<Asset | null>;
  addVersion(
    context: AssetContext,
    assetId: Id,
    input: UploadInput & { title?: string; description?: string },
  ): Promise<AssetVersion>;
  versions(context: AssetContext, assetId: Id): Promise<AssetVersion[]>;
  link(context: AssetContext, assetId: Id, link: DomainLink): Promise<Asset>;
  archive(context: AssetContext, assetId: Id): Promise<Asset>;
  delete(context: AssetContext, assetId: Id): Promise<Asset>;
  usages(context: AssetContext, assetId: Id): Promise<DomainLink[]>;
}

export interface RenditionProvider {
  create(
    context: AssetContext,
    input: Omit<Rendition, "id" | "createdAt">,
  ): Promise<Rendition>;
  list(context: AssetContext, assetVersionId: Id): Promise<Rendition[]>;
}

export interface HoldProvider {
  addLegalHold(context: AssetContext, assetId: Id, legalHoldRef: Id): Promise<Asset>;
  releaseLegalHold(context: AssetContext, assetId: Id, legalHoldRef: Id): Promise<Asset>;
}

export interface DeduplicationProvider {
  findByChecksum(context: AssetContext, checksum: string): Promise<BlobObject | null>;
}

export interface CollectionProvider {
  create(
    context: AssetContext,
    input: Omit<AssetCollection, "id" | "organizationId" | "assetIds">,
  ): Promise<AssetCollection>;
  add(context: AssetContext, collectionId: Id, assetId: Id): Promise<AssetCollection>;
  remove(context: AssetContext, collectionId: Id, assetId: Id): Promise<AssetCollection>;
  listAssets(context: AssetContext, collectionId: Id): Promise<Asset[]>;
}

export interface PurgeProvider {
  purge(context: AssetContext, assetId: Id): Promise<PurgeResult>;
}
