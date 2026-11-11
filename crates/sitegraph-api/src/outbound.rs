//! Outbound HTTP targets are resolved, checked and pinned for each attempt.
//! No environment proxies or redirects may bypass the checked destination.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use reqwest::{Client, Url};

const MAX_URL_BYTES: usize = 2048;
const DNS_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) fn allow_private_webhooks() -> bool {
    private_webhooks_enabled(
        std::env::var("APP_ENV").ok().as_deref(),
        std::env::var("WEBHOOK_ALLOW_PRIVATE").ok().as_deref(),
    )
}

fn private_webhooks_enabled(environment: Option<&str>, setting: Option<&str>) -> bool {
    environment == Some("development") && setting == Some("true")
}

/// Conservative public-unicast policy, including cloud metadata, mapped IPv4,
/// shared address space, documentation and IPv6 transition/reserved ranges.
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && (s[1] & 0xf000) == 0)
        }
    }
}

fn parse_target(value: &str) -> Result<Url, String> {
    if value.len() > MAX_URL_BYTES || value.chars().any(char::is_control) {
        return Err("url is too long or contains control characters".into());
    }
    let url = Url::parse(value).map_err(|_| "invalid url")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("url must be http(s)".into());
    }
    if url.host_str().is_none() || url.port_or_known_default() == Some(0) {
        return Err("url must have a host and a valid port".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("url must not contain credentials or a fragment".into());
    }
    Ok(url)
}

pub(crate) struct Target {
    pub(crate) url: Url,
    addresses: Vec<SocketAddr>,
}

impl Target {
    fn with_addresses(
        url: Url,
        addresses: Vec<SocketAddr>,
        allow_private: bool,
    ) -> Result<Self, String> {
        if addresses.is_empty() {
            return Err("host does not resolve".into());
        }
        if !allow_private && addresses.iter().any(|a| !is_public_ip(a.ip())) {
            return Err("target must resolve only to public unicast addresses".into());
        }
        Ok(Self { url, addresses })
    }

    fn client_builder(&self, timeout: Duration) -> Result<reqwest::ClientBuilder, String> {
        Ok(Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(timeout)
            .resolve_to_addrs(
                self.url.host_str().ok_or("url has no host")?,
                &self.addresses,
            ))
    }

    pub(crate) fn client(&self, timeout: Duration) -> Result<Client, String> {
        self.client_builder(timeout)?
            .build()
            .map_err(|_| "could not create outbound client".into())
    }

    /// A single request, preserving response bytes even if compression features
    /// are enabled elsewhere in the workspace later.
    pub(crate) fn raw_single_request_client(&self, timeout: Duration) -> Result<Client, String> {
        self.client_builder(timeout)?
            .retry(reqwest::retry::never())
            .no_gzip()
            .no_brotli()
            .no_zstd()
            .no_deflate()
            .build()
            .map_err(|_| "could not create outbound client".into())
    }
}

async fn resolve_target(url: Url, allow_private: bool) -> Result<Target, String> {
    let host = url.host_str().ok_or("url has no host")?;
    // url::Url preserves brackets around IPv6 literals; lookup_host does not.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = url.port_or_known_default().ok_or("url has no port")?;
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        if !allow_private && host.trim_end_matches('.').eq_ignore_ascii_case("localhost") {
            return Err("target must resolve only to public unicast addresses".into());
        }
        tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host, port)))
            .await
            .map_err(|_| "target DNS lookup timed out")?
            .map_err(|_| "host does not resolve")?
            .collect()
    };
    Target::with_addresses(url, addresses, allow_private)
}

/// Integration credentials never use the development webhook private-target bypass.
pub(crate) async fn connector_target(value: &str) -> Result<Target, String> {
    let url = parse_target(value)?;
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
        return Err("connector requires HTTPS on port 443".into());
    }
    resolve_target(url, false).await
}

/// Validate and canonicalize an origin without DNS or any network access.
/// Raw syntax checks precede URL normalization so dot paths and backslashes
/// cannot disappear during parsing. DNS is checked separately on every fetch.
pub(crate) fn connector_origin(value: &str) -> Result<String, String> {
    let invalid = || "source requires a public HTTPS origin on port 443".to_owned();
    if value.len() > MAX_URL_BYTES
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value.contains(['\\', '%', '?', '#', '@'])
    {
        return Err(invalid());
    }
    let (scheme, authority) = value.split_once("://").ok_or_else(invalid)?;
    if !scheme.eq_ignore_ascii_case("https")
        || authority.is_empty()
        || authority
            .strip_suffix('/')
            .unwrap_or(authority)
            .ends_with(':')
        || authority
            .strip_suffix('/')
            .unwrap_or(authority)
            .contains('/')
    {
        return Err(invalid());
    }
    let url = parse_target(value).map_err(|_| invalid())?;
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) || url.path() != "/" {
        return Err(invalid());
    }
    let host = url.host_str().ok_or_else(invalid)?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.trim_end_matches('.').eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| !is_public_ip(ip))
    {
        return Err(invalid());
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
pub(crate) async fn connector_mock_target(url: Url) -> Result<Target, String> {
    if url.host_str() != Some("127.0.0.1") {
        return Err("mock must be loopback".into());
    }
    resolve_target(url, true).await
}

pub(crate) async fn webhook_target(value: &str) -> Result<Target, String> {
    resolve_target(parse_target(value)?, allow_private_webhooks()).await
}

/// Proxy hosts are approved by the operator, never by a connector's author.
/// HTTPS on 443 is required even for approved proxies; path prefixes are allowed.
///
/// Built-in approved hosts: the official Anthropic and OpenAI APIs. Any other
/// OpenAI-compatible endpoint (Mistral, OpenRouter, Groq, a company gateway, …)
/// must be listed in `AI_ALLOWED_PROVIDER_HOSTS`. Self-hosted runtimes on a
/// private network or loopback (Ollama, LM Studio, vLLM) additionally require
/// `AI_ALLOW_PRIVATE_PROVIDERS=true`, which also permits plain HTTP and custom
/// ports for those explicitly approved hosts.
#[cfg(test)]
fn parse_ai_base(value: &str, additional_hosts: &str) -> Result<Url, String> {
    parse_ai_base_with(value, additional_hosts, false)
}

fn parse_ai_base_with(
    value: &str,
    additional_hosts: &str,
    allow_private: bool,
) -> Result<Url, String> {
    let url = parse_target(value)?;
    if url.query().is_some() {
        return Err("AI base_url must not contain a query".into());
    }
    if !allow_private && (url.scheme() != "https" || url.port_or_known_default() != Some(443)) {
        return Err("AI base_url must use HTTPS on port 443 without a query".into());
    }
    let host = url.host_str().ok_or("url has no host")?;
    let approved = host == "api.anthropic.com"
        || host == "api.openai.com"
        || additional_hosts.split(',').any(|entry| {
            let entry = entry.trim();
            !entry.is_empty() && entry.eq_ignore_ascii_case(host)
        });
    if !approved {
        return Err("AI provider host is not approved by the operator".into());
    }
    Ok(url)
}

pub(crate) fn allow_private_ai_providers() -> bool {
    std::env::var("AI_ALLOW_PRIVATE_PROVIDERS")
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false)
}

pub(crate) async fn ai_target(value: &str) -> Result<Target, String> {
    let hosts = std::env::var("AI_ALLOWED_PROVIDER_HOSTS").unwrap_or_default();
    let allow_private = allow_private_ai_providers();
    resolve_target(
        parse_ai_base_with(value, &hosts, allow_private)?,
        allow_private,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_and_compatible_hosts_follow_the_operator_allowlist() {
        assert!(parse_ai_base("https://api.openai.com/v1", "").is_ok());
        assert!(parse_ai_base("https://api.mistral.ai/v1", "").is_err());
        assert!(parse_ai_base("https://api.mistral.ai/v1", "api.mistral.ai").is_ok());
        assert!(parse_ai_base("https://openrouter.ai/api/v1", "openrouter.ai").is_ok());
        // Local runtimes need both the allowlist entry and the private opt-in.
        assert!(parse_ai_base("http://localhost:11434/v1", "localhost").is_err());
        assert!(parse_ai_base_with("http://localhost:11434/v1", "localhost", true).is_ok());
        assert!(parse_ai_base_with("http://localhost:11434/v1", "", true).is_err());
        assert!(parse_ai_base_with("http://localhost:11434/v1?x=1", "localhost", true).is_err());
    }

    #[test]
    fn source_origin_is_canonical_and_never_needs_dns() {
        for value in [
            "https://menu.example.test",
            "HTTPS://Menu.Example.Test:443/",
        ] {
            assert_eq!(
                connector_origin(value).unwrap(),
                "https://menu.example.test"
            );
        }
        assert_eq!(
            connector_origin("https://93.184.216.34/").unwrap(),
            "https://93.184.216.34"
        );
        assert_eq!(
            connector_origin("https://[2606:4700:4700::1111]:443/").unwrap(),
            "https://[2606:4700:4700::1111]"
        );
        for value in [
            "http://menu.example.test",
            "https://menu.example.test:8443",
            "https://menu.example.test:",
            "https://user:secret@menu.example.test",
            "https://@menu.example.test",
            "https://menu.example.test/?key=secret",
            "https://menu.example.test/#secret",
            "https://menu.example.test/path",
            "https://menu.example.test/.",
            "https://menu.example.test/path/..",
            "https://menu.example.test/%2e",
            "https://menu%2eexample.test",
            "https://menu.example.test\\private",
            " https://menu.example.test",
            "https://menu.example.test\t",
            "https:///menu.example.test",
            "https://127.0.0.1",
            "https://2130706433",
            "https://0x7f000001",
            "https://0177.0.0.1",
            "https://169.254.169.254",
            "https://10.0.0.1",
            "https://100.64.0.1",
            "https://localhost",
            "https://LOCALHOST./",
            "https://[::1]",
            "https://[::ffff:127.0.0.1]",
            "https://[2001:db8::1]",
            "https://192.0.2.1",
            "https://example.test//",
        ] {
            assert!(connector_origin(value).is_err(), "{value}");
        }
        assert!(connector_origin(&format!("https://{}.test", "a".repeat(MAX_URL_BYTES))).is_err());
    }

    #[test]
    fn public_address_policy_rejects_metadata_and_transition_ranges() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "100.100.100.200",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "64:ff9b::7f00:1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "3fff::1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(is_public_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn private_override_requires_explicit_development() {
        assert!(private_webhooks_enabled(Some("development"), Some("true")));
        for environment in [None, Some("production"), Some("test"), Some("Development")] {
            assert!(!private_webhooks_enabled(environment, Some("true")));
        }
        assert!(!private_webhooks_enabled(Some("development"), None));
    }

    #[test]
    fn rejects_mixed_dns_and_rechecks_new_answers() {
        let url = parse_target("https://hooks.example.com/events").unwrap();
        let public = "1.1.1.1:443".parse().unwrap();
        let private = "127.0.0.1:443".parse().unwrap();
        assert!(Target::with_addresses(url.clone(), vec![public], false).is_ok());
        assert!(Target::with_addresses(url.clone(), vec![public, private], false).is_err());
        assert!(Target::with_addresses(url.clone(), vec![private], false).is_err());
        assert!(Target::with_addresses(url, vec![], false).is_err());
    }

    #[tokio::test]
    async fn normalized_private_literals_cannot_bypass_address_checks() {
        for value in [
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0177.0.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "http://localhost./",
        ] {
            assert!(
                resolve_target(parse_target(value).unwrap(), false)
                    .await
                    .is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_ambiguous_urls_and_unapproved_ai_hosts() {
        for value in [
            "file:///etc/passwd",
            "https://user:pass@example.com",
            "https://example.com/#fragment",
            "http://example.com:0",
        ] {
            assert!(parse_target(value).is_err(), "{value}");
        }
        assert!(parse_target(&format!(
            "https://example.com/{}",
            "a".repeat(MAX_URL_BYTES)
        ))
        .is_err());
        for value in [
            "http://api.anthropic.com",
            "https://api.anthropic.com:8443",
            "https://api.anthropic.com.attacker.test",
            "https://api.anthropic.com/?key=secret",
            "https://127.0.0.1",
        ] {
            assert!(parse_ai_base(value, "").is_err(), "{value}");
        }
        assert!(parse_ai_base("https://api.anthropic.com", "").is_ok());
        assert!(parse_ai_base("https://proxy.example.com/prefix", "proxy.example.com").is_ok());
        assert!(parse_ai_base("https://other.proxy.example.com", "proxy.example.com").is_err());
    }

    #[tokio::test]
    async fn pinned_destination_is_used_and_redirect_never_reached() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let target = Target::with_addresses(
            parse_target(&format!(
                "http://unresolvable.example.invalid:{}/hook",
                address.port()
            ))
            .unwrap(),
            vec![address],
            true,
        )
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.contains("unresolvable.example.invalid"));
            assert!(request.contains("test-signature"));
            let response = format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", address.port());
            stream.write_all(response.as_bytes()).await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(150), listener.accept())
                    .await
                    .is_err()
            );
        });
        let response = target
            .client(Duration::from_secs(2))
            .unwrap()
            .post(target.url)
            .header("x-fireflint-signature", "test-signature")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        server.await.unwrap();
    }
}
