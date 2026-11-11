//! Blob storage seam for media assets (v2 content depth).
//!
//! A minimal put/get/delete port so the request path stays storage-agnostic.
//! The default [`LocalBlobStore`] writes under a directory; an S3-compatible
//! backend can implement the same trait later (and route per data-residency).

use anyhow::{Context, Result};
use std::path::PathBuf;

pub trait BlobStore: Send + Sync {
    fn put(&self, key: &str, bytes: &[u8]) -> Result<()>;
    fn get(&self, key: &str) -> Result<Vec<u8>>;
    fn delete(&self, key: &str) -> Result<()>;
}

/// Filesystem-backed store rooted at a directory. Keys may contain '/'.
pub struct LocalBlobStore {
    root: PathBuf,
}

impl LocalBlobStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Resolve a key to a path, rejecting traversal. Keys are server-generated,
    /// but stay defensive.
    fn path_for(&self, key: &str) -> Result<PathBuf> {
        if key
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
        {
            anyhow::bail!("invalid storage key");
        }
        Ok(self.root.join(key))
    }
}

impl BlobStore for LocalBlobStore {
    fn put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let path = self.path_for(key)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("create blob dir")?;
        }
        std::fs::write(&path, bytes).context("write blob")?;
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Vec<u8>> {
        let path = self.path_for(key)?;
        std::fs::read(&path).context("read blob")
    }

    fn delete(&self, key: &str) -> Result<()> {
        let path = self.path_for(key)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).context("delete blob"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("fireflint-blobtest-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn put_get_delete_roundtrip() {
        let store = LocalBlobStore::new(temp_root());
        let key = "org-a/asset-1";
        store.put(key, b"hello").unwrap();
        assert_eq!(store.get(key).unwrap(), b"hello");
        store.delete(key).unwrap();
        assert!(store.get(key).is_err());
        // Deleting a missing key is a no-op.
        store.delete(key).unwrap();
    }

    #[test]
    fn rejects_path_traversal() {
        let store = LocalBlobStore::new(temp_root());
        assert!(store.put("../escape", b"x").is_err());
        assert!(store.get("a/../../etc/passwd").is_err());
    }
}
