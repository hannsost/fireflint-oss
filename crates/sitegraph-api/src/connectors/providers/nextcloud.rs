//! A bounded, explicitly shared metadata projection; never download or share files.
use super::*;
use roxmltree::{Document, Node, ParsingOptions};
use std::collections::BTreeMap;

const DAV: &str = "DAV:";
const OC: &str = "http://owncloud.org/ns";
pub(super) const PROPFIND: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>
<d:displayname/><d:getlastmodified/><d:getetag/><d:getcontenttype/>
<d:resourcetype/><d:getcontentlength/><oc:fileid/>
</d:prop></d:propfind>"#;

pub(in crate::connectors) fn valid_username(s: &str) -> bool {
    !s.trim().is_empty()
        && s.len() <= 240
        && s != "."
        && s != ".."
        && !s.contains(['/', '\\', ':', '%', '?', '#'])
        && !s.chars().any(char::is_control)
}
pub(in crate::connectors) fn validate_folder(value: Option<&str>) -> Result<(), ProviderError> {
    let valid = value.is_some_and(|v| {
        v.starts_with('/')
            && v.len() <= 1024
            && !v.contains(['\\', '%', '?', '#'])
            && !v.chars().any(char::is_control)
            && v[1..]
                .split('/')
                .all(|s| !s.trim().is_empty() && s != "." && s != "..")
    });
    if !valid {
        return Err(ProviderError::input("Einen konkreten Ordner wie /Team/Kunden ohne abschließenden Schrägstrich, URL-Kodierung oder Punktsegmente angeben."));
    }
    Ok(())
}

pub(super) async fn fetch(
    config: &ConnectorConfig,
    credentials: &ConnectorCredentials,
    base: &Url,
    start: Option<String>,
    transport: &Transport,
) -> Result<Batch, ProviderError> {
    validate_folder(config.folder_path.as_deref())?;
    if start.is_some() || !config.share_metadata || config.object_type != "files" {
        return Err(ProviderError::input("Nextcloud benötigt eine bestätigte Ordnerfreigabe und unterstützt keinen Seitencursor."));
    }
    let username = credentials
        .username
        .as_deref()
        .filter(|v| valid_username(v))
        .ok_or_else(ProviderError::protocol)?;
    let mut url = base
        .join("remote.php/dav/files/")
        .map_err(|_| ProviderError::protocol())?;
    url.path_segments_mut()
        .map_err(|_| ProviderError::protocol())?
        .pop_if_empty()
        .push(username)
        .extend(config.folder_path.as_deref().unwrap()[1..].split('/'))
        .push("");
    let reply = transport
        .send_raw(config, credentials, url.clone(), None)
        .await?;
    parse(base, &url, &reply.bytes)
}
fn single<'a, 'i>(node: Node<'a, 'i>, ns: &str, key: &str) -> Result<Node<'a, 'i>, ProviderError> {
    let mut matches = node.children().filter(|n| n.has_tag_name((ns, key)));
    let result = matches.next().ok_or_else(ProviderError::protocol)?;
    if matches.next().is_some() {
        return Err(ProviderError::protocol());
    }
    Ok(result)
}
fn text_value<'a>(node: Node<'a, '_>) -> Result<&'a str, ProviderError> {
    if node.children().any(|n| n.is_element()) {
        return Err(ProviderError::protocol());
    }
    let value = node.text().unwrap_or("").trim();
    if value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(ProviderError::protocol());
    }
    Ok(value)
}
fn status(node: Node<'_, '_>) -> Result<u16, ProviderError> {
    let value = text_value(single(node, DAV, "status")?)?;
    let mut parts = value.split_whitespace();
    if !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
        return Err(ProviderError::protocol());
    }
    parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(ProviderError::protocol)
}
fn decoded_path(url: &Url) -> Result<String, ProviderError> {
    // Decode individual segments so encoded separators cannot change scope.
    url.path()
        .split('/')
        .map(|part| {
            let decoded = percent_encoding::percent_decode_str(part)
                .decode_utf8()
                .map_err(|_| ProviderError::protocol())?;
            if decoded.contains(['/', '\\', '%'])
                || decoded.chars().any(char::is_control)
                || decoded == "."
                || decoded == ".."
            {
                return Err(ProviderError::protocol());
            }
            Ok(decoded.into_owned())
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.join("/"))
}
fn parse(base: &Url, requested: &Url, bytes: &[u8]) -> Result<Batch, ProviderError> {
    let xml = std::str::from_utf8(bytes).map_err(|_| ProviderError::protocol())?;
    // roxmltree rejects nonempty DTD by default; explicitly reject empty DTD too.
    if xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        return Err(ProviderError::protocol());
    }
    let doc = Document::parse_with_options(
        xml,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: 20_000,
            ..Default::default()
        },
    )
    .map_err(|_| ProviderError::protocol())?;
    let root = doc.root_element();
    if !root.has_tag_name((DAV, "multistatus")) {
        return Err(ProviderError::protocol());
    }
    let prefix = decoded_path(requested)?;
    use sha2::{Digest, Sha256};
    let instance = hex::encode(Sha256::digest(base.as_str().as_bytes()));
    let mut rows = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_paths = HashSet::new();
    let mut has_self = false;
    for (index, response) in root.children().filter(Node::is_element).enumerate() {
        if index >= 1001 || !response.has_tag_name((DAV, "response")) {
            return Err(ProviderError::protocol());
        }
        let href = text_value(single(response, DAV, "href")?)?;
        if href.contains('\\') || href.chars().any(char::is_whitespace) {
            return Err(ProviderError::protocol());
        }
        let target = requested
            .join(href)
            .map_err(|_| ProviderError::protocol())?;
        if !(href.starts_with('/') || href.starts_with("https://"))
            || target.origin() != requested.origin()
            || !target.username().is_empty()
            || target.password().is_some()
            || target.query().is_some()
            || target.fragment().is_some()
        {
            return Err(ProviderError::protocol());
        }
        let path = decoded_path(&target)?;
        let is_self = path.trim_end_matches('/') == prefix.trim_end_matches('/');
        let child = if is_self {
            ""
        } else {
            path.strip_prefix(&prefix)
                .ok_or_else(ProviderError::protocol)?
                .trim_end_matches('/')
        };
        if (!is_self && (child.is_empty() || child.contains('/')))
            || !seen_paths.insert(path.clone())
        {
            return Err(ProviderError::protocol());
        }
        if response.children().any(|n| n.has_tag_name((DAV, "status"))) {
            return Err(ProviderError::protocol());
        }
        let mut props = BTreeMap::new();
        for propstat in response
            .children()
            .filter(|n| n.has_tag_name((DAV, "propstat")))
        {
            match status(propstat)? {
                200 => {
                    for p in single(propstat, DAV, "prop")?
                        .children()
                        .filter(Node::is_element)
                    {
                        let key = (p.tag_name().namespace().unwrap_or(""), p.tag_name().name());
                        if props.insert(key, p).is_some() {
                            return Err(ProviderError::protocol());
                        }
                    }
                }
                404 => {} // An unsupported optional property is not a failed resource.
                _ => return Err(ProviderError::protocol()),
            }
        }
        let resource = props
            .get(&(DAV, "resourcetype"))
            .ok_or_else(ProviderError::protocol)?;
        let collection = resource
            .children()
            .any(|n| n.has_tag_name((DAV, "collection")));
        if resource
            .children()
            .filter(Node::is_element)
            .any(|n| !n.has_tag_name((DAV, "collection")))
        {
            return Err(ProviderError::protocol());
        }
        if is_self {
            if !collection {
                return Err(ProviderError::protocol());
            }
            has_self = true;
            continue;
        }
        if collection {
            continue;
        }
        if path.ends_with('/') {
            return Err(ProviderError::protocol());
        }
        let get = |ns, key| {
            props
                .get(&(ns, key))
                .copied()
                .ok_or_else(ProviderError::protocol)
                .and_then(text_value)
        };
        let id = get(OC, "fileid")?;
        let numeric_id = id.parse::<u64>().map_err(|_| ProviderError::protocol())?;
        if numeric_id == 0 || numeric_id.to_string() != id || !seen_ids.insert(id.to_owned()) {
            return Err(ProviderError::protocol());
        }
        let name = match props.get(&(DAV, "displayname")) {
            Some(n) => text_value(*n)?,
            None => child,
        };
        if name.is_empty() || name.len() > 240 {
            return Err(ProviderError::protocol());
        }
        let length = get(DAV, "getcontentlength")?
            .parse::<u64>()
            .map_err(|_| ProviderError::protocol())?;
        if length > 9_007_199_254_740_991 {
            return Err(ProviderError::protocol());
        }
        let modified = chrono::DateTime::parse_from_rfc2822(get(DAV, "getlastmodified")?)
            .map_err(|_| ProviderError::protocol())?
            .to_rfc3339();
        let etag = get(DAV, "getetag")?;
        if etag.is_empty() {
            return Err(ProviderError::protocol());
        }
        let original = base
            .join(&format!("index.php/f/{id}"))
            .map_err(|_| ProviderError::protocol())?;
        let mut data = json!({"name":name,"url":original.as_str(),"file_id":id,"size_bytes":length,
            "source_modified_at":modified,"etag":etag});
        if let Some(mime) = props.get(&(DAV, "getcontenttype")) {
            data["mime_type"] = json!(text_value(*mime)?);
        }
        rows.push(ImportRow {
            kind: "external_document".into(),
            external_id: format!("files:{instance}:{id}"),
            name: name.into(),
            data,
            expected_revision: None,
        });
        if rows.len() > 100 {
            return Err(ProviderError::input("Der Ordner enthält mehr als 100 direkte Dateien. Einen kleineren Ordner anbinden; es wurde nichts übernommen."));
        }
    }
    if !has_self {
        return Err(ProviderError::protocol());
    }
    rows.sort_by(|a, b| a.external_id.cmp(&b.external_id));
    Ok(Batch {
        rows,
        next_cursor: None,
    })
}
