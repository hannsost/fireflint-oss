//! Foundation: Asset (F1.6) — Rust port of the TS reference module.
//!
//! Owns blobs (content-addressed, deduplicated), assets with immutable
//! versions, renditions, classification, domain links, legal holds,
//! collections and purge (see `modules/foundation/asset`). Isolated crate.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;

pub type Id = String;
pub type IsoDateTime = String;

// --- Errors ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AssetError {
    #[error("asset '{0}' not found")]
    AssetNotFound(String),
    #[error("blob '{0}' not found")]
    BlobNotFound(String),
    #[error("collection '{0}' not found")]
    CollectionNotFound(String),
    #[error("deleted asset cannot be versioned")]
    AssetDeleted,
    #[error("asset has active legal holds")]
    LegalHoldActive,
    #[error("asset must be logically deleted before purge")]
    AssetNotDeleted,
}

// --- Enums -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChecksumAlgorithm {
    Sha256,
    Reference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanState {
    Pending,
    Clean,
    Infected,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidentiality {
    Public,
    Internal,
    Confidential,
    Restricted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetType {
    Document,
    Image,
    Video,
    Audio,
    Archive,
    Data,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetState {
    Draft,
    Active,
    Quarantined,
    Archived,
    Deleted,
}

// --- Value types -----------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct AssetContext {
    pub organization_id: Id,
    pub correlation_id: String,
    pub principal_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobObject {
    pub id: Id,
    pub organization_id: Id,
    pub checksum: String,
    pub checksum_algorithm: ChecksumAlgorithm,
    pub size: usize,
    pub media_type: String,
    pub storage_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption_key_ref: Option<String>,
    pub scan_state: ScanState,
    pub created_at: IsoDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetClassification {
    pub category: String,
    pub confidentiality: Confidentiality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personal_data: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub special_category_data: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub records_class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainLink {
    pub domain: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub id: Id,
    pub relation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSource {
    pub system: String,
    pub external_id: String,
    pub imported_at: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoritative: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetVersion {
    pub id: Id,
    pub asset_id: Id,
    pub version: u64,
    pub blob_id: Id,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_principal_id: Option<Id>,
    pub created_at: IsoDateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendition {
    pub id: Id,
    pub asset_version_id: Id,
    pub kind: String,
    pub blob_id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u32>,
    pub created_at: IsoDateTime,
}

#[derive(Debug, Clone, Default)]
pub struct RenditionInput {
    pub asset_version_id: Id,
    pub kind: String,
    pub blob_id: Id,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_seconds: Option<u32>,
    pub bitrate: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: Id,
    pub organization_id: Id,
    #[serde(rename = "type")]
    pub kind: AssetType,
    pub state: AssetState,
    pub classification: AssetClassification,
    pub current_version_id: Id,
    pub links: Vec<DomainLink>,
    pub sources: Vec<AssetSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_policy_ref: Option<Id>,
    pub legal_hold_refs: Vec<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_policy_ref: Option<Id>,
    pub created_at: IsoDateTime,
    pub updated_at: IsoDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCollection {
    pub id: Id,
    pub organization_id: Id,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_collection_id: Option<Id>,
    pub asset_ids: Vec<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classification: Option<AssetClassification>,
}

#[derive(Debug, Clone, Default)]
pub struct CollectionInput {
    pub name: String,
    pub parent_collection_id: Option<Id>,
    pub classification: Option<AssetClassification>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeResult {
    pub asset_id: Id,
    pub purged_version_ids: Vec<Id>,
    pub purged_blob_ids: Vec<Id>,
}

#[derive(Debug, Clone, Default)]
pub struct UploadInput {
    pub filename: String,
    pub media_type: String,
    pub content: Vec<u8>,
    pub encryption_key_ref: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AssetCreateInput {
    pub kind: Option<AssetType>,
    pub classification: AssetClassification,
    pub upload: UploadInput,
    pub title: Option<String>,
    pub description: Option<String>,
    pub links: Option<Vec<DomainLink>>,
    pub sources: Option<Vec<AssetSource>>,
    pub retention_policy_ref: Option<Id>,
    pub access_policy_ref: Option<Id>,
}

impl Default for AssetClassification {
    fn default() -> Self {
        AssetClassification {
            category: String::new(),
            confidentiality: Confidentiality::Internal,
            personal_data: None,
            special_category_data: None,
            records_class: None,
        }
    }
}

// --- Helpers ---------------------------------------------------------------

fn now() -> IsoDateTime {
    Utc::now().to_rfc3339()
}

fn checksum(content: &[u8]) -> String {
    let mut hash: u32 = 2166136261;
    for b in content {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("{hash:x}")
}

// --- In-memory reference implementation ------------------------------------

#[derive(Default)]
struct Inner {
    blobs: Vec<BlobObject>,
    contents: Vec<(Id, Vec<u8>)>,
    assets: Vec<Asset>,
    versions: Vec<AssetVersion>,
    renditions: Vec<Rendition>,
    collections: Vec<AssetCollection>,
    sequence: u64,
}

impl Inner {
    fn next(&mut self, prefix: &str) -> String {
        self.sequence += 1;
        format!("{prefix}-{}", self.sequence)
    }
    fn asset_idx(&self, org: &str, id: &str) -> Result<usize, AssetError> {
        self.assets
            .iter()
            .position(|a| a.id == id && a.organization_id == org)
            .ok_or_else(|| AssetError::AssetNotFound(id.to_string()))
    }
    fn blob_idx(&self, org: &str, id: &str) -> Result<usize, AssetError> {
        self.blobs
            .iter()
            .position(|b| b.id == id && b.organization_id == org)
            .ok_or_else(|| AssetError::BlobNotFound(id.to_string()))
    }
    fn collection_idx(&self, org: &str, id: &str) -> Result<usize, AssetError> {
        self.collections
            .iter()
            .position(|c| c.id == id && c.organization_id == org)
            .ok_or_else(|| AssetError::CollectionNotFound(id.to_string()))
    }
}

#[derive(Default)]
pub struct ReferenceAssetStore {
    inner: RefCell<Inner>,
}

impl ReferenceAssetStore {
    pub fn new() -> Self {
        Self::default()
    }
}

// --- Blobs -----------------------------------------------------------------

pub trait BlobProvider {
    fn blob_put(&self, ctx: &AssetContext, input: UploadInput) -> Result<BlobObject, AssetError>;
    fn blob_get(&self, ctx: &AssetContext, blob_id: &str)
        -> Result<Option<BlobObject>, AssetError>;
    fn blob_content(
        &self,
        ctx: &AssetContext,
        blob_id: &str,
    ) -> Result<Option<Vec<u8>>, AssetError>;
    fn blob_mark_scan_state(
        &self,
        ctx: &AssetContext,
        blob_id: &str,
        state: ScanState,
    ) -> Result<BlobObject, AssetError>;
}

impl BlobProvider for ReferenceAssetStore {
    fn blob_put(&self, ctx: &AssetContext, input: UploadInput) -> Result<BlobObject, AssetError> {
        let sum = checksum(&input.content);
        let mut inner = self.inner.borrow_mut();
        if let Some(existing) = inner
            .blobs
            .iter()
            .find(|b| b.organization_id == ctx.organization_id && b.checksum == sum)
        {
            return Ok(existing.clone());
        }
        let blob = BlobObject {
            id: inner.next("blob"),
            organization_id: ctx.organization_id.clone(),
            checksum: sum.clone(),
            checksum_algorithm: ChecksumAlgorithm::Reference,
            size: input.content.len(),
            media_type: input.media_type,
            storage_key: format!("reference://{}/{}", ctx.organization_id, sum),
            encryption_key_ref: input.encryption_key_ref,
            scan_state: ScanState::Pending,
            created_at: now(),
        };
        inner.contents.push((blob.id.clone(), input.content));
        inner.blobs.push(blob.clone());
        Ok(blob)
    }

    fn blob_get(
        &self,
        ctx: &AssetContext,
        blob_id: &str,
    ) -> Result<Option<BlobObject>, AssetError> {
        let inner = self.inner.borrow();
        Ok(inner
            .blobs
            .iter()
            .find(|b| b.id == blob_id && b.organization_id == ctx.organization_id)
            .cloned())
    }

    fn blob_content(
        &self,
        ctx: &AssetContext,
        blob_id: &str,
    ) -> Result<Option<Vec<u8>>, AssetError> {
        let inner = self.inner.borrow();
        inner.blob_idx(&ctx.organization_id, blob_id)?;
        Ok(inner
            .contents
            .iter()
            .find(|(id, _)| id == blob_id)
            .map(|(_, c)| c.clone()))
    }

    fn blob_mark_scan_state(
        &self,
        ctx: &AssetContext,
        blob_id: &str,
        state: ScanState,
    ) -> Result<BlobObject, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let bidx = inner.blob_idx(&ctx.organization_id, blob_id)?;
        inner.blobs[bidx].scan_state = state;
        let asset_ids: Vec<Id> = inner
            .versions
            .iter()
            .filter(|v| v.blob_id == blob_id)
            .map(|v| v.asset_id.clone())
            .collect();
        for asset_id in asset_ids {
            if let Some(pos) = inner.assets.iter().position(|a| a.id == asset_id) {
                if state == ScanState::Infected {
                    inner.assets[pos].state = AssetState::Quarantined;
                } else if state == ScanState::Clean && inner.assets[pos].state == AssetState::Draft
                {
                    inner.assets[pos].state = AssetState::Active;
                }
            }
        }
        Ok(inner.blobs[bidx].clone())
    }
}

// --- Assets ----------------------------------------------------------------

pub trait AssetProvider {
    fn asset_create(
        &self,
        ctx: &AssetContext,
        input: AssetCreateInput,
    ) -> Result<Asset, AssetError>;
    fn asset_get(&self, ctx: &AssetContext, asset_id: &str) -> Result<Option<Asset>, AssetError>;
    fn asset_add_version(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
        upload: UploadInput,
        title: Option<String>,
        description: Option<String>,
    ) -> Result<AssetVersion, AssetError>;
    fn asset_versions(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
    ) -> Result<Vec<AssetVersion>, AssetError>;
    fn asset_link(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
        link: DomainLink,
    ) -> Result<Asset, AssetError>;
    fn asset_archive(&self, ctx: &AssetContext, asset_id: &str) -> Result<Asset, AssetError>;
    fn asset_delete(&self, ctx: &AssetContext, asset_id: &str) -> Result<Asset, AssetError>;
    fn asset_usages(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
    ) -> Result<Vec<DomainLink>, AssetError>;
}

impl AssetProvider for ReferenceAssetStore {
    fn asset_create(
        &self,
        ctx: &AssetContext,
        input: AssetCreateInput,
    ) -> Result<Asset, AssetError> {
        let blob = self.blob_put(ctx, input.upload.clone())?;
        let mut inner = self.inner.borrow_mut();
        let ts = now();
        let asset_id = inner.next("asset");
        let version = AssetVersion {
            id: inner.next("version"),
            asset_id: asset_id.clone(),
            version: 1,
            blob_id: blob.id,
            filename: input.upload.filename,
            title: input.title,
            description: input.description,
            metadata: None,
            created_by_principal_id: ctx.principal_id.clone(),
            created_at: ts.clone(),
        };
        let asset = Asset {
            id: asset_id,
            organization_id: ctx.organization_id.clone(),
            kind: input.kind.unwrap_or(AssetType::Other),
            state: AssetState::Draft,
            classification: input.classification,
            current_version_id: version.id.clone(),
            links: input.links.unwrap_or_default(),
            sources: input.sources.unwrap_or_default(),
            retention_policy_ref: input.retention_policy_ref,
            legal_hold_refs: Vec::new(),
            access_policy_ref: input.access_policy_ref,
            created_at: ts.clone(),
            updated_at: ts,
        };
        inner.versions.push(version);
        inner.assets.push(asset.clone());
        Ok(asset)
    }

    fn asset_get(&self, ctx: &AssetContext, asset_id: &str) -> Result<Option<Asset>, AssetError> {
        let inner = self.inner.borrow();
        Ok(inner
            .assets
            .iter()
            .find(|a| a.id == asset_id && a.organization_id == ctx.organization_id)
            .cloned())
    }

    fn asset_add_version(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
        upload: UploadInput,
        title: Option<String>,
        description: Option<String>,
    ) -> Result<AssetVersion, AssetError> {
        {
            let inner = self.inner.borrow();
            let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
            if inner.assets[idx].state == AssetState::Deleted {
                return Err(AssetError::AssetDeleted);
            }
        }
        let blob = self.blob_put(ctx, upload.clone())?;
        let mut inner = self.inner.borrow_mut();
        let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
        let current = inner
            .versions
            .iter()
            .filter(|v| v.asset_id == asset_id)
            .map(|v| v.version)
            .max()
            .unwrap_or(0);
        let ts = now();
        let version = AssetVersion {
            id: inner.next("version"),
            asset_id: asset_id.to_string(),
            version: current + 1,
            blob_id: blob.id,
            filename: upload.filename,
            title,
            description,
            metadata: None,
            created_by_principal_id: ctx.principal_id.clone(),
            created_at: ts.clone(),
        };
        inner.assets[idx].current_version_id = version.id.clone();
        inner.assets[idx].state = AssetState::Draft;
        inner.assets[idx].updated_at = ts;
        inner.versions.push(version.clone());
        Ok(version)
    }

    fn asset_versions(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
    ) -> Result<Vec<AssetVersion>, AssetError> {
        let inner = self.inner.borrow();
        inner.asset_idx(&ctx.organization_id, asset_id)?;
        let mut versions: Vec<AssetVersion> = inner
            .versions
            .iter()
            .filter(|v| v.asset_id == asset_id)
            .cloned()
            .collect();
        versions.sort_by_key(|v| v.version);
        Ok(versions)
    }

    fn asset_link(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
        link: DomainLink,
    ) -> Result<Asset, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
        if !inner.assets[idx].links.contains(&link) {
            inner.assets[idx].links.push(link);
        }
        Ok(inner.assets[idx].clone())
    }

    fn asset_archive(&self, ctx: &AssetContext, asset_id: &str) -> Result<Asset, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
        inner.assets[idx].state = AssetState::Archived;
        inner.assets[idx].updated_at = now();
        Ok(inner.assets[idx].clone())
    }

    fn asset_delete(&self, ctx: &AssetContext, asset_id: &str) -> Result<Asset, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
        if !inner.assets[idx].legal_hold_refs.is_empty() {
            return Err(AssetError::LegalHoldActive);
        }
        inner.assets[idx].state = AssetState::Deleted;
        inner.assets[idx].updated_at = now();
        Ok(inner.assets[idx].clone())
    }

    fn asset_usages(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
    ) -> Result<Vec<DomainLink>, AssetError> {
        let inner = self.inner.borrow();
        let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
        Ok(inner.assets[idx].links.clone())
    }
}

// --- Renditions ------------------------------------------------------------

pub trait RenditionProvider {
    fn rendition_create(
        &self,
        ctx: &AssetContext,
        input: RenditionInput,
    ) -> Result<Rendition, AssetError>;
    fn rendition_list(
        &self,
        ctx: &AssetContext,
        asset_version_id: &str,
    ) -> Result<Vec<Rendition>, AssetError>;
}

impl RenditionProvider for ReferenceAssetStore {
    fn rendition_create(
        &self,
        ctx: &AssetContext,
        input: RenditionInput,
    ) -> Result<Rendition, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let asset_id = inner
            .versions
            .iter()
            .find(|v| v.id == input.asset_version_id)
            .map(|v| v.asset_id.clone())
            .ok_or_else(|| AssetError::AssetNotFound("version".to_string()))?;
        inner.asset_idx(&ctx.organization_id, &asset_id)?;
        inner.blob_idx(&ctx.organization_id, &input.blob_id)?;
        let rendition = Rendition {
            id: inner.next("rendition"),
            asset_version_id: input.asset_version_id,
            kind: input.kind,
            blob_id: input.blob_id,
            width: input.width,
            height: input.height,
            duration_seconds: input.duration_seconds,
            bitrate: input.bitrate,
            created_at: now(),
        };
        inner.renditions.push(rendition.clone());
        Ok(rendition)
    }

    fn rendition_list(
        &self,
        _ctx: &AssetContext,
        asset_version_id: &str,
    ) -> Result<Vec<Rendition>, AssetError> {
        let inner = self.inner.borrow();
        Ok(inner
            .renditions
            .iter()
            .filter(|r| r.asset_version_id == asset_version_id)
            .cloned()
            .collect())
    }
}

// --- Legal holds + dedup ---------------------------------------------------

pub trait HoldProvider {
    fn hold_add_legal_hold(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
        legal_hold_ref: &str,
    ) -> Result<Asset, AssetError>;
    fn hold_release_legal_hold(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
        legal_hold_ref: &str,
    ) -> Result<Asset, AssetError>;
}

impl HoldProvider for ReferenceAssetStore {
    fn hold_add_legal_hold(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
        legal_hold_ref: &str,
    ) -> Result<Asset, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
        if !inner.assets[idx]
            .legal_hold_refs
            .iter()
            .any(|r| r == legal_hold_ref)
        {
            inner.assets[idx]
                .legal_hold_refs
                .push(legal_hold_ref.to_string());
        }
        Ok(inner.assets[idx].clone())
    }

    fn hold_release_legal_hold(
        &self,
        ctx: &AssetContext,
        asset_id: &str,
        legal_hold_ref: &str,
    ) -> Result<Asset, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
        inner.assets[idx]
            .legal_hold_refs
            .retain(|r| r != legal_hold_ref);
        Ok(inner.assets[idx].clone())
    }
}

pub trait DeduplicationProvider {
    fn dedup_find_by_checksum(
        &self,
        ctx: &AssetContext,
        checksum: &str,
    ) -> Result<Option<BlobObject>, AssetError>;
}

impl DeduplicationProvider for ReferenceAssetStore {
    fn dedup_find_by_checksum(
        &self,
        ctx: &AssetContext,
        checksum: &str,
    ) -> Result<Option<BlobObject>, AssetError> {
        let inner = self.inner.borrow();
        Ok(inner
            .blobs
            .iter()
            .find(|b| b.organization_id == ctx.organization_id && b.checksum == checksum)
            .cloned())
    }
}

// --- Collections -----------------------------------------------------------

pub trait CollectionProvider {
    fn collection_create(
        &self,
        ctx: &AssetContext,
        input: CollectionInput,
    ) -> Result<AssetCollection, AssetError>;
    fn collection_add(
        &self,
        ctx: &AssetContext,
        collection_id: &str,
        asset_id: &str,
    ) -> Result<AssetCollection, AssetError>;
    fn collection_remove(
        &self,
        ctx: &AssetContext,
        collection_id: &str,
        asset_id: &str,
    ) -> Result<AssetCollection, AssetError>;
    fn collection_list_assets(
        &self,
        ctx: &AssetContext,
        collection_id: &str,
    ) -> Result<Vec<Asset>, AssetError>;
}

impl CollectionProvider for ReferenceAssetStore {
    fn collection_create(
        &self,
        ctx: &AssetContext,
        input: CollectionInput,
    ) -> Result<AssetCollection, AssetError> {
        let mut inner = self.inner.borrow_mut();
        if let Some(parent) = &input.parent_collection_id {
            inner.collection_idx(&ctx.organization_id, parent)?;
        }
        let collection = AssetCollection {
            id: inner.next("collection"),
            organization_id: ctx.organization_id.clone(),
            name: input.name,
            parent_collection_id: input.parent_collection_id,
            asset_ids: Vec::new(),
            classification: input.classification,
        };
        inner.collections.push(collection.clone());
        Ok(collection)
    }

    fn collection_add(
        &self,
        ctx: &AssetContext,
        collection_id: &str,
        asset_id: &str,
    ) -> Result<AssetCollection, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let cidx = inner.collection_idx(&ctx.organization_id, collection_id)?;
        inner.asset_idx(&ctx.organization_id, asset_id)?;
        if !inner.collections[cidx]
            .asset_ids
            .iter()
            .any(|id| id == asset_id)
        {
            inner.collections[cidx].asset_ids.push(asset_id.to_string());
        }
        Ok(inner.collections[cidx].clone())
    }

    fn collection_remove(
        &self,
        ctx: &AssetContext,
        collection_id: &str,
        asset_id: &str,
    ) -> Result<AssetCollection, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let cidx = inner.collection_idx(&ctx.organization_id, collection_id)?;
        inner.collections[cidx]
            .asset_ids
            .retain(|id| id != asset_id);
        Ok(inner.collections[cidx].clone())
    }

    fn collection_list_assets(
        &self,
        ctx: &AssetContext,
        collection_id: &str,
    ) -> Result<Vec<Asset>, AssetError> {
        let inner = self.inner.borrow();
        let cidx = inner.collection_idx(&ctx.organization_id, collection_id)?;
        let ids = inner.collections[cidx].asset_ids.clone();
        let mut out = Vec::new();
        for id in ids {
            let idx = inner.asset_idx(&ctx.organization_id, &id)?;
            out.push(inner.assets[idx].clone());
        }
        Ok(out)
    }
}

// --- Purge -----------------------------------------------------------------

pub trait PurgeProvider {
    fn purge(&self, ctx: &AssetContext, asset_id: &str) -> Result<PurgeResult, AssetError>;
}

impl PurgeProvider for ReferenceAssetStore {
    fn purge(&self, ctx: &AssetContext, asset_id: &str) -> Result<PurgeResult, AssetError> {
        let mut inner = self.inner.borrow_mut();
        let idx = inner.asset_idx(&ctx.organization_id, asset_id)?;
        if !inner.assets[idx].legal_hold_refs.is_empty() {
            return Err(AssetError::LegalHoldActive);
        }
        if inner.assets[idx].state != AssetState::Deleted {
            return Err(AssetError::AssetNotDeleted);
        }

        let version_ids: Vec<Id> = inner
            .versions
            .iter()
            .filter(|v| v.asset_id == asset_id)
            .map(|v| v.id.clone())
            .collect();
        let mut blob_ids: Vec<Id> = inner
            .versions
            .iter()
            .filter(|v| v.asset_id == asset_id)
            .map(|v| v.blob_id.clone())
            .collect();

        inner.versions.retain(|v| v.asset_id != asset_id);

        // Drop renditions of purged versions, collecting their blobs too.
        let mut kept = Vec::new();
        for r in std::mem::take(&mut inner.renditions) {
            if version_ids.contains(&r.asset_version_id) {
                if !blob_ids.contains(&r.blob_id) {
                    blob_ids.push(r.blob_id.clone());
                }
            } else {
                kept.push(r);
            }
        }
        inner.renditions = kept;

        let mut purged_blob_ids = Vec::new();
        for blob_id in &blob_ids {
            let still_referenced = inner.versions.iter().any(|v| &v.blob_id == blob_id)
                || inner.renditions.iter().any(|r| &r.blob_id == blob_id);
            if !still_referenced {
                inner.blobs.retain(|b| &b.id != blob_id);
                inner.contents.retain(|(id, _)| id != blob_id);
                purged_blob_ids.push(blob_id.clone());
            }
        }

        for c in inner.collections.iter_mut() {
            c.asset_ids.retain(|id| id != asset_id);
        }
        inner.assets.retain(|a| a.id != asset_id);

        Ok(PurgeResult {
            asset_id: asset_id.to_string(),
            purged_version_ids: version_ids,
            purged_blob_ids,
        })
    }
}

/// Reference context, mirrors `referenceAssetContext()`.
pub fn reference_asset_context() -> AssetContext {
    AssetContext {
        organization_id: "tenant-1".to_string(),
        correlation_id: "asset-reference".to_string(),
        principal_id: Some("principal-1".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload(filename: &str, text: &str, media_type: &str) -> UploadInput {
        UploadInput {
            filename: filename.into(),
            media_type: media_type.into(),
            content: text.as_bytes().to_vec(),
            encryption_key_ref: None,
        }
    }

    fn classification() -> AssetClassification {
        AssetClassification {
            category: "business-document".into(),
            confidentiality: Confidentiality::Confidential,
            personal_data: Some(true),
            special_category_data: None,
            records_class: None,
        }
    }

    fn create_input(kind: AssetType, up: UploadInput) -> AssetCreateInput {
        AssetCreateInput {
            kind: Some(kind),
            classification: classification(),
            upload: up,
            ..Default::default()
        }
    }

    #[test]
    fn creates_asset_with_immutable_first_version() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(
                    AssetType::Document,
                    upload("contract.txt", "v1", "text/plain"),
                ),
            )
            .unwrap();
        let versions = store.asset_versions(&ctx, &asset.id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version, 1);
    }

    #[test]
    fn same_content_is_deduplicated() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let first = store
            .blob_put(&ctx, upload("a.txt", "same", "text/plain"))
            .unwrap();
        let second = store
            .blob_put(&ctx, upload("b.txt", "same", "text/plain"))
            .unwrap();
        assert_eq!(second.id, first.id);
    }

    #[test]
    fn new_version_advances_without_replacing_history() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(
                    AssetType::Document,
                    upload("contract.txt", "v1", "text/plain"),
                ),
            )
            .unwrap();
        let second = store
            .asset_add_version(
                &ctx,
                &asset.id,
                upload("contract.txt", "v2", "text/plain"),
                None,
                None,
            )
            .unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(store.asset_versions(&ctx, &asset.id).unwrap().len(), 2);
    }

    #[test]
    fn malware_state_quarantines_asset() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(
                    AssetType::Archive,
                    upload("upload.zip", "binary", "application/zip"),
                ),
            )
            .unwrap();
        let version = store.asset_versions(&ctx, &asset.id).unwrap()[0].clone();
        store
            .blob_mark_scan_state(&ctx, &version.blob_id, ScanState::Infected)
            .unwrap();
        assert_eq!(
            store.asset_get(&ctx, &asset.id).unwrap().unwrap().state,
            AssetState::Quarantined
        );
    }

    #[test]
    fn clean_scan_activates_draft_asset() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(AssetType::Image, upload("image.jpg", "image", "image/jpeg")),
            )
            .unwrap();
        let version = store.asset_versions(&ctx, &asset.id).unwrap()[0].clone();
        store
            .blob_mark_scan_state(&ctx, &version.blob_id, ScanState::Clean)
            .unwrap();
        assert_eq!(
            store.asset_get(&ctx, &asset.id).unwrap().unwrap().state,
            AssetState::Active
        );
    }

    #[test]
    fn rendition_belongs_to_version() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(
                    AssetType::Image,
                    upload("image.jpg", "original", "image/jpeg"),
                ),
            )
            .unwrap();
        let version = store.asset_versions(&ctx, &asset.id).unwrap()[0].clone();
        let thumb = store
            .blob_put(&ctx, upload("thumb.jpg", "thumb", "image/jpeg"))
            .unwrap();
        let rendition = store
            .rendition_create(
                &ctx,
                RenditionInput {
                    asset_version_id: version.id.clone(),
                    kind: "thumbnail".into(),
                    blob_id: thumb.id,
                    width: Some(320),
                    height: Some(180),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(rendition.asset_version_id, version.id);
    }

    #[test]
    fn domain_links_connect_asset() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(
                    AssetType::Document,
                    upload("invoice.txt", "invoice", "text/plain"),
                ),
            )
            .unwrap();
        let linked = store
            .asset_link(
                &ctx,
                &asset.id,
                DomainLink {
                    domain: "edi".into(),
                    kind: "message".into(),
                    id: "edi-message-1".into(),
                    relation: "raw_payload".into(),
                },
            )
            .unwrap();
        assert_eq!(linked.links[0].domain, "edi");
    }

    #[test]
    fn legal_hold_blocks_deletion_until_released() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(
                    AssetType::Document,
                    upload("evidence.txt", "evidence", "text/plain"),
                ),
            )
            .unwrap();
        store
            .hold_add_legal_hold(&ctx, &asset.id, "hold-1")
            .unwrap();
        let err = store.asset_delete(&ctx, &asset.id).unwrap_err();
        assert!(matches!(err, AssetError::LegalHoldActive));
        store
            .hold_release_legal_hold(&ctx, &asset.id, "hold-1")
            .unwrap();
        assert_eq!(
            store.asset_delete(&ctx, &asset.id).unwrap().state,
            AssetState::Deleted
        );
    }

    #[test]
    fn asset_records_external_provenance() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let mut input = create_input(
            AssetType::Document,
            upload("invoice.pdf", "invoice", "application/pdf"),
        );
        input.sources = Some(vec![AssetSource {
            system: "edi".into(),
            external_id: "message-100".into(),
            imported_at: "2026-06-19T12:00:00.000Z".into(),
            source_url: Some("as2://partner/message-100".into()),
            authoritative: Some(true),
        }]);
        let asset = store.asset_create(&ctx, input).unwrap();
        assert_eq!(asset.sources[0].system, "edi");
    }

    #[test]
    fn collection_groups_assets() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(AssetType::Image, upload("hotel.jpg", "image", "image/jpeg")),
            )
            .unwrap();
        let collection = store
            .collection_create(
                &ctx,
                CollectionInput {
                    name: "Hotel Berlin".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .collection_add(&ctx, &collection.id, &asset.id)
            .unwrap();
        assert_eq!(
            store.collection_list_assets(&ctx, &collection.id).unwrap()[0].id,
            asset.id
        );
    }

    #[test]
    fn usage_query_returns_backlinks() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let mut input = create_input(
            AssetType::Document,
            upload("application.pdf", "application", "application/pdf"),
        );
        input.links = Some(vec![
            DomainLink {
                domain: "forms".into(),
                kind: "submission".into(),
                id: "submission-1".into(),
                relation: "attachment".into(),
            },
            DomainLink {
                domain: "work".into(),
                kind: "case".into(),
                id: "case-1".into(),
                relation: "evidence".into(),
            },
        ]);
        let asset = store.asset_create(&ctx, input).unwrap();
        assert_eq!(store.asset_usages(&ctx, &asset.id).unwrap().len(), 2);
    }

    #[test]
    fn purge_requires_delete_and_removes_unshared_blobs() {
        let store = ReferenceAssetStore::new();
        let ctx = reference_asset_context();
        let asset = store
            .asset_create(
                &ctx,
                create_input(
                    AssetType::Document,
                    upload("temporary.txt", "temporary", "text/plain"),
                ),
            )
            .unwrap();
        let err = store.purge(&ctx, &asset.id).unwrap_err();
        assert!(matches!(err, AssetError::AssetNotDeleted));
        store.asset_delete(&ctx, &asset.id).unwrap();
        let result = store.purge(&ctx, &asset.id).unwrap();
        assert_eq!(result.purged_version_ids.len(), 1);
        assert!(store.asset_get(&ctx, &asset.id).unwrap().is_none());
    }
}
