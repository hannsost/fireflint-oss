import type {
  Asset,
  AssetCollection,
  AssetContext,
  AssetProvider,
  AssetVersion,
  BlobObject,
  BlobProvider,
  DeduplicationProvider,
  HoldProvider,
  CollectionProvider,
  PurgeProvider,
  PurgeResult,
  Rendition,
  RenditionProvider,
} from "./contracts.js";
import { AssetError } from "./errors.js";

export class ReferenceAssetStore {
  readonly blobs = new Map<string, BlobObject>();
  readonly contents = new Map<string, Uint8Array>();
  readonly assets = new Map<string, Asset>();
  readonly versionItems: AssetVersion[] = [];
  readonly renditions: Rendition[] = [];
  readonly collections = new Map<string, AssetCollection>();
  #sequence = 0;

  readonly blob: BlobProvider = {
    put: async (context, input) => {
      const checksum = this.checksum(input.content);
      const existing = [...this.blobs.values()].find(
        (item) =>
          item.organizationId === context.organizationId &&
          item.checksum === checksum,
      );
      if (existing) return structuredClone(existing);
      const value: BlobObject = {
        id: this.next("blob"),
        organizationId: context.organizationId,
        checksum,
        checksumAlgorithm: "reference",
        size: input.content.byteLength,
        mediaType: input.mediaType,
        storageKey: `reference://${context.organizationId}/${checksum}`,
        encryptionKeyRef: input.encryptionKeyRef,
        scanState: "pending",
        createdAt: new Date().toISOString(),
      };
      this.blobs.set(value.id, value);
      this.contents.set(value.id, new Uint8Array(input.content));
      return structuredClone(value);
    },
    get: async (context, blobId) => {
      const value = this.blobs.get(blobId);
      return value?.organizationId === context.organizationId
        ? structuredClone(value)
        : null;
    },
    content: async (context, blobId) => {
      this.requireBlob(context, blobId);
      const value = this.contents.get(blobId);
      return value ? new Uint8Array(value) : null;
    },
    markScanState: async (context, blobId, state) => {
      const value = this.requireBlob(context, blobId);
      value.scanState = state;
      for (const version of this.versionItems.filter((item) => item.blobId === blobId)) {
        const asset = this.assets.get(version.assetId);
        if (asset && state === "infected") asset.state = "quarantined";
        if (asset && state === "clean" && asset.state === "draft") asset.state = "active";
      }
      return structuredClone(value);
    },
  };

  readonly asset: AssetProvider = {
    create: async (context, input) => {
      const blob = await this.blob.put(context, input.upload);
      const now = new Date().toISOString();
      const assetId = this.next("asset");
      const version: AssetVersion = {
        id: this.next("version"),
        assetId,
        version: 1,
        blobId: blob.id,
        filename: input.upload.filename,
        title: input.title,
        description: input.description,
        createdByPrincipalId: context.principalId,
        createdAt: now,
      };
      const value: Asset = {
        id: assetId,
        organizationId: context.organizationId,
        type: input.type,
        state: "draft",
        classification: structuredClone(input.classification),
        currentVersionId: version.id,
        links: structuredClone(input.links ?? []),
        sources: structuredClone(input.sources ?? []),
        retentionPolicyRef: input.retentionPolicyRef,
        legalHoldRefs: [],
        accessPolicyRef: input.accessPolicyRef,
        createdAt: now,
        updatedAt: now,
      };
      this.versionItems.push(version);
      this.assets.set(value.id, value);
      return structuredClone(value);
    },
    get: async (context, assetId) => {
      const value = this.assets.get(assetId);
      return value?.organizationId === context.organizationId
        ? structuredClone(value)
        : null;
    },
    addVersion: async (context, assetId, input) => {
      const asset = this.requireAsset(context, assetId);
      if (asset.state === "deleted") {
        throw new AssetError("ASSET_DELETED", "Deleted asset cannot be versioned");
      }
      const blob = await this.blob.put(context, input);
      const currentNumber = Math.max(
        ...this.versionItems
          .filter((item) => item.assetId === assetId)
          .map((item) => item.version),
      );
      const version: AssetVersion = {
        id: this.next("version"),
        assetId,
        version: currentNumber + 1,
        blobId: blob.id,
        filename: input.filename,
        title: input.title,
        description: input.description,
        createdByPrincipalId: context.principalId,
        createdAt: new Date().toISOString(),
      };
      this.versionItems.push(version);
      asset.currentVersionId = version.id;
      asset.state = "draft";
      asset.updatedAt = version.createdAt;
      return structuredClone(version);
    },
    versions: async (context, assetId) => {
      this.requireAsset(context, assetId);
      return this.versionItems
        .filter((item) => item.assetId === assetId)
        .sort((left, right) => left.version - right.version)
        .map((item) => structuredClone(item));
    },
    link: async (context, assetId, link) => {
      const asset = this.requireAsset(context, assetId);
      if (!asset.links.some((item) =>
        item.domain === link.domain &&
        item.type === link.type &&
        item.id === link.id &&
        item.relation === link.relation
      )) asset.links.push(structuredClone(link));
      return structuredClone(asset);
    },
    archive: async (context, assetId) => {
      const asset = this.requireAsset(context, assetId);
      asset.state = "archived";
      asset.updatedAt = new Date().toISOString();
      return structuredClone(asset);
    },
    delete: async (context, assetId) => {
      const asset = this.requireAsset(context, assetId);
      if (asset.legalHoldRefs.length > 0) {
        throw new AssetError("LEGAL_HOLD_ACTIVE", "Asset has active legal holds");
      }
      asset.state = "deleted";
      asset.updatedAt = new Date().toISOString();
      return structuredClone(asset);
    },
    usages: async (context, assetId) => {
      const asset = this.requireAsset(context, assetId);
      return structuredClone(asset.links);
    },
  };

  readonly rendition: RenditionProvider = {
    create: async (context, input) => {
      const version = this.versionItems.find(
        (item) => item.id === input.assetVersionId,
      );
      if (!version) throw new AssetError("ASSET_NOT_FOUND", "Asset version not found");
      this.requireAsset(context, version.assetId);
      this.requireBlob(context, input.blobId);
      const value: Rendition = {
        ...structuredClone(input),
        id: this.next("rendition"),
        createdAt: new Date().toISOString(),
      };
      this.renditions.push(value);
      return structuredClone(value);
    },
    list: async (_context, assetVersionId) =>
      this.renditions
        .filter((item) => item.assetVersionId === assetVersionId)
        .map((item) => structuredClone(item)),
  };

  readonly hold: HoldProvider = {
    addLegalHold: async (context, assetId, legalHoldRef) => {
      const asset = this.requireAsset(context, assetId);
      if (!asset.legalHoldRefs.includes(legalHoldRef)) {
        asset.legalHoldRefs.push(legalHoldRef);
      }
      return structuredClone(asset);
    },
    releaseLegalHold: async (context, assetId, legalHoldRef) => {
      const asset = this.requireAsset(context, assetId);
      asset.legalHoldRefs = asset.legalHoldRefs.filter(
        (item) => item !== legalHoldRef,
      );
      return structuredClone(asset);
    },
  };

  readonly deduplication: DeduplicationProvider = {
    findByChecksum: async (context, checksum) => {
      const value = [...this.blobs.values()].find(
        (item) =>
          item.organizationId === context.organizationId &&
          item.checksum === checksum,
      );
      return value ? structuredClone(value) : null;
    },
  };
  readonly collection: CollectionProvider = {
    create: async (context, input) => {
      if (input.parentCollectionId) {
        this.requireCollection(context, input.parentCollectionId);
      }
      const value: AssetCollection = {
        ...structuredClone(input),
        id: this.next("collection"),
        organizationId: context.organizationId,
        assetIds: [],
      };
      this.collections.set(value.id, value);
      return structuredClone(value);
    },
    add: async (context, collectionId, assetId) => {
      const collection = this.requireCollection(context, collectionId);
      this.requireAsset(context, assetId);
      if (!collection.assetIds.includes(assetId)) collection.assetIds.push(assetId);
      return structuredClone(collection);
    },
    remove: async (context, collectionId, assetId) => {
      const collection = this.requireCollection(context, collectionId);
      collection.assetIds = collection.assetIds.filter((id) => id !== assetId);
      return structuredClone(collection);
    },
    listAssets: async (context, collectionId) => {
      const collection = this.requireCollection(context, collectionId);
      return collection.assetIds.map((id) =>
        structuredClone(this.requireAsset(context, id)),
      );
    },
  };
  readonly purge: PurgeProvider = {
    purge: async (context, assetId) => {
      const asset = this.requireAsset(context, assetId);
      if (asset.legalHoldRefs.length > 0) {
        throw new AssetError("LEGAL_HOLD_ACTIVE", "Asset has active legal holds");
      }
      if (asset.state !== "deleted") {
        throw new AssetError(
          "ASSET_NOT_DELETED",
          "Asset must be logically deleted before purge",
        );
      }
      const versions = this.versionItems.filter((item) => item.assetId === assetId);
      const versionIds = new Set(versions.map((item) => item.id));
      const blobIds = new Set(versions.map((item) => item.blobId));
      for (let index = this.versionItems.length - 1; index >= 0; index -= 1) {
        if (this.versionItems[index].assetId === assetId) {
          this.versionItems.splice(index, 1);
        }
      }
      for (let index = this.renditions.length - 1; index >= 0; index -= 1) {
        if (versionIds.has(this.renditions[index].assetVersionId)) {
          blobIds.add(this.renditions[index].blobId);
          this.renditions.splice(index, 1);
        }
      }
      const purgedBlobIds: string[] = [];
      for (const blobId of blobIds) {
        const stillReferenced =
          this.versionItems.some((item) => item.blobId === blobId) ||
          this.renditions.some((item) => item.blobId === blobId);
        if (!stillReferenced) {
          this.blobs.delete(blobId);
          this.contents.delete(blobId);
          purgedBlobIds.push(blobId);
        }
      }
      for (const collection of this.collections.values()) {
        collection.assetIds = collection.assetIds.filter((id) => id !== assetId);
      }
      this.assets.delete(assetId);
      const result: PurgeResult = {
        assetId,
        purgedVersionIds: [...versionIds],
        purgedBlobIds,
      };
      return result;
    },
  };

  private requireAsset(context: AssetContext, id: string): Asset {
    const value = this.assets.get(id);
    if (!value || value.organizationId !== context.organizationId) {
      throw new AssetError("ASSET_NOT_FOUND", `Asset '${id}' not found`);
    }
    return value;
  }

  private requireBlob(context: AssetContext, id: string): BlobObject {
    const value = this.blobs.get(id);
    if (!value || value.organizationId !== context.organizationId) {
      throw new AssetError("BLOB_NOT_FOUND", `Blob '${id}' not found`);
    }
    return value;
  }

  private requireCollection(
    context: AssetContext,
    id: string,
  ): AssetCollection {
    const value = this.collections.get(id);
    if (!value || value.organizationId !== context.organizationId) {
      throw new AssetError(
        "COLLECTION_NOT_FOUND",
        `Collection '${id}' not found`,
      );
    }
    return value;
  }

  private checksum(content: Uint8Array): string {
    let hash = 2166136261;
    for (const byte of content) hash = Math.imul(hash ^ byte, 16777619);
    return (hash >>> 0).toString(16);
  }

  private next(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}

export const referenceAssetContext = (): AssetContext => ({
  organizationId: "tenant-1",
  correlationId: "asset-reference",
  principalId: "principal-1",
});
