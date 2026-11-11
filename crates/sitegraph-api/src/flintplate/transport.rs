use crate::{outbound, ApiError, ApiResult};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_TYPE,
};
use sitegraph_db::hub::MenuSourceAccess;
use std::time::Duration;

const SNAPSHOT_PATH: &str = "/device/v1/fireflint/snapshot";
const MAX_BYTES: usize = 500 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(super) struct Transport {
    #[cfg(test)]
    mock_origin: Option<String>,
}

fn failure() -> ApiError {
    ApiError::BadRequest("Der Menü-Snapshot konnte nicht sicher abgerufen werden. Bitte Quelladresse, Lesezugang und Erreichbarkeit prüfen.".into())
}

fn json_headers(headers: &HeaderMap) -> bool {
    let mut types = headers.get_all(CONTENT_TYPE).iter();
    let Some(value) = types.next().and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if types.next().is_some() {
        return false;
    }
    let mut parts = value.split(';').map(str::trim);
    if !parts
        .next()
        .is_some_and(|s| s.eq_ignore_ascii_case("application/json"))
    {
        return false;
    }
    let mut charset_seen = false;
    for parameter in parts {
        let Some((key, value)) = parameter.split_once('=') else {
            return false;
        };
        if !key.trim().eq_ignore_ascii_case("charset") || charset_seen {
            return false;
        }
        let value = value.trim();
        if !value.eq_ignore_ascii_case("utf-8") && !value.eq_ignore_ascii_case("\"utf-8\"") {
            return false;
        }
        charset_seen = true;
    }
    headers.get_all(CONTENT_ENCODING).iter().all(|value| {
        value
            .to_str()
            .is_ok_and(|v| v.trim().eq_ignore_ascii_case("identity"))
    })
}

impl Transport {
    #[cfg(test)]
    pub(super) fn fixture(origin: String) -> Self {
        Self {
            mock_origin: Some(origin),
        }
    }

    async fn target(&self, origin: &str) -> ApiResult<outbound::Target> {
        #[cfg(test)]
        if let Some(mock) = &self.mock_origin {
            let mut url = reqwest::Url::parse(mock).map_err(|_| failure())?;
            url.set_path(SNAPSHOT_PATH);
            url.set_query(None);
            url.set_fragment(None);
            return outbound::connector_mock_target(url)
                .await
                .map_err(|_| failure());
        }
        let origin = outbound::connector_origin(origin).map_err(|_| failure())?;
        outbound::connector_target(&format!("{origin}{SNAPSHOT_PATH}"))
            .await
            .map_err(|_| failure())
    }

    pub(super) async fn fetch(&self, source: &MenuSourceAccess) -> ApiResult<String> {
        self.fetch_with_timeout(source, FETCH_TIMEOUT).await
    }

    async fn fetch_with_timeout(
        &self,
        source: &MenuSourceAccess,
        timeout: Duration,
    ) -> ApiResult<String> {
        // Covers DNS, connection establishment, response headers and every chunk.
        tokio::time::timeout(timeout, self.request(source, timeout))
            .await
            .map_err(|_| failure())?
    }

    async fn request(&self, source: &MenuSourceAccess, timeout: Duration) -> ApiResult<String> {
        let target = self.target(&source.base_url).await?;
        let client = target
            .raw_single_request_client(timeout)
            .map_err(|_| failure())?;
        let mut key = HeaderValue::from_str(&source.api_key).map_err(|_| failure())?;
        key.set_sensitive(true);
        let mut response = client
            .get(target.url)
            .header("X-FlintPlate-Key", key)
            .header(ACCEPT, "application/json")
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| failure())?;
        if response.status() != reqwest::StatusCode::OK
            || !json_headers(response.headers())
            || response
                .content_length()
                .is_some_and(|size| size > MAX_BYTES as u64)
        {
            return Err(failure());
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
            if chunk.len() > MAX_BYTES - data.len() {
                return Err(failure());
            }
            data.extend_from_slice(&chunk);
        }
        // Do not parse/re-serialize here: the strict menu decoder must receive
        // duplicate keys and the exact bytes used later for the apply receipt.
        String::from_utf8(data).map_err(|_| failure())
    }
}

#[cfg(test)]
mod tests;
