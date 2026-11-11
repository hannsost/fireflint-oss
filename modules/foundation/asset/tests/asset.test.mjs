import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceAssetStore, referenceAssetContext } from "../dist/index.js";

const context = referenceAssetContext();
const upload = (filename, text, mediaType = "text/plain") => ({
  filename,
  mediaType,
  content: new TextEncoder().encode(text),
});
const classification = {
  category: "business-document",
  confidentiality: "confidential",
  personalData: true,
};

test("creates asset with immutable first version", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "document",
    classification,
    upload: upload("contract.txt", "v1"),
  });
  const versions = await store.asset.versions(context, asset.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);
});

test("same content is deduplicated at blob layer", async () => {
  const store = new ReferenceAssetStore();
  const first = await store.blob.put(context, upload("a.txt", "same"));
  const second = await store.blob.put(context, upload("b.txt", "same"));
  assert.equal(second.id, first.id);
});

test("new version advances current version without replacing history", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "document",
    classification,
    upload: upload("contract.txt", "v1"),
  });
  const second = await store.asset.addVersion(
    context,
    asset.id,
    upload("contract.txt", "v2"),
  );
  assert.equal(second.version, 2);
  assert.equal((await store.asset.versions(context, asset.id)).length, 2);
});

test("malware state quarantines related asset", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "archive",
    classification,
    upload: upload("upload.zip", "binary", "application/zip"),
  });
  const version = (await store.asset.versions(context, asset.id))[0];
  await store.blob.markScanState(context, version.blobId, "infected");
  assert.equal((await store.asset.get(context, asset.id))?.state, "quarantined");
});

test("clean scan activates draft asset", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "image",
    classification,
    upload: upload("image.jpg", "image", "image/jpeg"),
  });
  const version = (await store.asset.versions(context, asset.id))[0];
  await store.blob.markScanState(context, version.blobId, "clean");
  assert.equal((await store.asset.get(context, asset.id))?.state, "active");
});

test("rendition belongs to a concrete asset version", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "image",
    classification,
    upload: upload("image.jpg", "original", "image/jpeg"),
  });
  const version = (await store.asset.versions(context, asset.id))[0];
  const thumbnailBlob = await store.blob.put(
    context,
    upload("thumb.jpg", "thumb", "image/jpeg"),
  );
  const rendition = await store.rendition.create(context, {
    assetVersionId: version.id,
    kind: "thumbnail",
    blobId: thumbnailBlob.id,
    width: 320,
    height: 180,
  });
  assert.equal(rendition.assetVersionId, version.id);
});

test("domain links connect one asset to forms, EDI or commerce", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "document",
    classification,
    upload: upload("invoice.txt", "invoice"),
  });
  const linked = await store.asset.link(context, asset.id, {
    domain: "edi",
    type: "message",
    id: "edi-message-1",
    relation: "raw_payload",
  });
  assert.equal(linked.links[0].domain, "edi");
});

test("legal hold blocks deletion until released", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "document",
    classification,
    upload: upload("evidence.txt", "evidence"),
  });
  await store.hold.addLegalHold(context, asset.id, "hold-1");
  await assert.rejects(
    store.asset.delete(context, asset.id),
    (error) => error?.code === "LEGAL_HOLD_ACTIVE",
  );
  await store.hold.releaseLegalHold(context, asset.id, "hold-1");
  assert.equal((await store.asset.delete(context, asset.id)).state, "deleted");
});

test("asset records external provenance without importing provider secrets", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "document",
    classification,
    upload: upload("invoice.pdf", "invoice", "application/pdf"),
    sources: [{
      system: "edi",
      externalId: "message-100",
      importedAt: "2026-06-19T12:00:00.000Z",
      sourceUrl: "as2://partner/message-100",
      authoritative: true,
    }],
  });
  assert.equal(asset.sources[0].system, "edi");
  assert.equal("credential" in asset.sources[0], false);
});

test("collection groups assets without changing their domain ownership", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "image",
    classification,
    upload: upload("hotel.jpg", "image", "image/jpeg"),
  });
  const collection = await store.collection.create(context, {
    name: "Hotel Berlin",
  });
  await store.collection.add(context, collection.id, asset.id);
  assert.equal(
    (await store.collection.listAssets(context, collection.id))[0].id,
    asset.id,
  );
});

test("usage query returns all domain backlinks", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "document",
    classification,
    upload: upload("application.pdf", "application", "application/pdf"),
    links: [
      { domain: "forms", type: "submission", id: "submission-1", relation: "attachment" },
      { domain: "work", type: "case", id: "case-1", relation: "evidence" },
    ],
  });
  assert.equal((await store.asset.usages(context, asset.id)).length, 2);
});

test("purge requires logical delete and removes unshared blobs", async () => {
  const store = new ReferenceAssetStore();
  const asset = await store.asset.create(context, {
    type: "document",
    classification,
    upload: upload("temporary.txt", "temporary"),
  });
  await assert.rejects(
    store.purge.purge(context, asset.id),
    (error) => error?.code === "ASSET_NOT_DELETED",
  );
  await store.asset.delete(context, asset.id);
  const result = await store.purge.purge(context, asset.id);
  assert.equal(result.purgedVersionIds.length, 1);
  assert.equal(await store.asset.get(context, asset.id), null);
});
