use super::*;
use sitegraph_domain::flintplate::decode_snapshot;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const GOLDEN: &str =
    include_str!("../../../../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json");
const SYNTHETIC_KEY: &str = "synthetic-flintplate-read-key";

#[test]
fn fixture_injection_requires_control_and_the_exact_confirmed_origin() {
    use crate::flintplate::{e1_fixture::Control, fetch_transport};
    let origin = "https://e1-fixture.example.test";
    let control = Control::new("http://127.0.0.1:29999".into());
    assert!(fetch_transport(origin, None).mock_origin.is_none());
    assert_eq!(
        fetch_transport(origin, Some(&control))
            .mock_origin
            .as_deref(),
        Some("http://127.0.0.1:29999")
    );
    for other in [
        "https://e1-fixture.example.test/",
        "https://e1-fixture.example.test:443",
        "https://E1-fixture.example.test",
        "https://other.example.test",
        "http://127.0.0.1:29999",
    ] {
        assert!(fetch_transport(other, Some(&control)).mock_origin.is_none());
    }
}

fn source() -> MenuSourceAccess {
    MenuSourceAccess {
        base_url: "https://menu.example.test".into(),
        api_key: SYNTHETIC_KEY.into(),
    }
}

fn venue() -> Uuid {
    let value: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    value["venue_id"].as_str().unwrap().parse().unwrap()
}

fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

async fn mock(response: Vec<u8>, delay: Duration) -> (Transport, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let transport = Transport {
        mock_origin: Some(format!("http://{address}")),
    };
    let server = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut buffer = [0; 2048];
            let count = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buffer))
                .await
                .unwrap()
                .unwrap();
            assert_ne!(count, 0);
            request.extend_from_slice(&buffer[..count]);
            assert!(request.len() <= 8192);
            if request.windows(4).any(|v| v == b"\r\n\r\n") {
                break;
            }
        }
        tokio::time::sleep(delay).await;
        // Early response rejection can close the socket while the fixture sends.
        let _ = stream.write_all(&response).await;
        drop(stream);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "unexpected second request"
        );
        String::from_utf8(request).unwrap()
    });
    (transport, server)
}

fn success(result: ApiResult<String>) -> String {
    result.unwrap_or_else(|_| panic!("snapshot fetch must succeed"))
}

fn fixed_failure(error: ApiError) {
    let ApiError::BadRequest(message) = error else {
        panic!("expected fixed transport failure");
    };
    let ApiError::BadRequest(expected) = failure() else {
        unreachable!()
    };
    assert_eq!(message, expected);
    assert!(!message.contains(SYNTHETIC_KEY));
    assert!(!message.contains("upstream-private-detail"));
    assert!(!message.contains("127.0.0.1"));
}

#[tokio::test]
async fn fixed_get_uses_only_sensitive_key_header_and_preserves_raw_snapshot() {
    let raw = format!(" \n{GOLDEN}\n\t");
    let (transport, server) = mock(
        response(
            "200 OK",
            "Content-Type: application/json; charset=utf-8\r\n",
            raw.as_bytes(),
        ),
        Duration::ZERO,
    )
    .await;
    let fetched = success(transport.fetch(&source()).await);
    assert_eq!(fetched, raw);
    assert!(decode_snapshot(&fetched, venue()).is_ok());
    let request = server.await.unwrap();
    assert_eq!(
        request.lines().next(),
        Some("GET /device/v1/fireflint/snapshot HTTP/1.1")
    );
    let headers = request.to_ascii_lowercase();
    assert!(headers.contains(&format!("x-flintplate-key: {SYNTHETIC_KEY}\r\n")));
    assert!(headers.contains("accept: application/json\r\n"));
    assert!(headers.contains("accept-encoding: identity\r\n"));
    assert!(!headers.contains("authorization:"));
    assert!(!headers.contains("cookie:"));
    assert_eq!(request.matches(SYNTHETIC_KEY).count(), 1);
}

#[tokio::test]
async fn duplicate_json_is_not_silently_normalized_by_transport() {
    let raw = "{\"items\":[],\"items\":[]}";
    let (transport, server) = mock(
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            raw.as_bytes(),
        ),
        Duration::ZERO,
    )
    .await;
    let fetched = success(transport.fetch(&source()).await);
    assert_eq!(fetched, raw);
    let error = decode_snapshot(&fetched, venue()).unwrap_err();
    assert!(error.contains("doppelte Schlüssel"));
    server.await.unwrap();
}

#[tokio::test]
async fn upstream_status_and_headers_never_leak_and_requests_are_not_retried() {
    let body = format!("{SYNTHETIC_KEY}: upstream-private-detail");
    for status in [
        "201 Created",
        "204 No Content",
        "206 Partial Content",
        "301 Moved Permanently",
        "302 Found",
        "307 Temporary Redirect",
        "401 Unauthorized",
        "403 Forbidden",
        "429 Too Many Requests",
        "500 Internal Server Error",
    ] {
        let headers = format!("Content-Type: application/json\r\nLocation: http://127.0.0.1/private?key={SYNTHETIC_KEY}\r\nX-Private: upstream-private-detail\r\n");
        let (transport, server) =
            mock(response(status, &headers, body.as_bytes()), Duration::ZERO).await;
        fixed_failure(transport.fetch(&source()).await.unwrap_err());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn redirect_does_not_transmit_credentials_to_destination() {
    let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let headers = format!(
        "Content-Type: application/json\r\nLocation: http://{}/leak\r\n",
        destination.local_addr().unwrap()
    );
    let (transport, server) = mock(response("302 Found", &headers, b""), Duration::ZERO).await;
    fixed_failure(transport.fetch(&source()).await.unwrap_err());
    server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), destination.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn only_uncompressed_json_utf8_is_accepted() {
    for headers in [
        "",
        "Content-Type: text/html\r\n",
        "Content-Type: application/problem+json\r\n",
        "Content-Type: application/json; charset=iso-8859-1\r\n",
        "Content-Type: application/json; charset=utf-8; charset=utf-8\r\n",
        "Content-Type: application/json\r\nContent-Type: text/html\r\n",
        "Content-Type: application/json\r\nContent-Encoding: gzip\r\n",
        "Content-Type: application/json\r\nContent-Encoding: br\r\n",
    ] {
        let (transport, server) = mock(
            response("200 OK", headers, GOLDEN.as_bytes()),
            Duration::ZERO,
        )
        .await;
        fixed_failure(transport.fetch(&source()).await.unwrap_err());
        server.await.unwrap();
    }
    let (transport, server) = mock(
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            &[0xff, 0xfe],
        ),
        Duration::ZERO,
    )
    .await;
    fixed_failure(transport.fetch(&source()).await.unwrap_err());
    server.await.unwrap();
    let (transport, server) = mock(
        response(
            "200 OK",
            "Content-Type: APPLICATION/JSON; Charset=\"UTF-8\"\r\nContent-Encoding: identity\r\n",
            GOLDEN.as_bytes(),
        ),
        Duration::ZERO,
    )
    .await;
    assert_eq!(success(transport.fetch(&source()).await), GOLDEN);
    server.await.unwrap();
}

#[tokio::test]
async fn declared_size_limit_accepts_exact_cap_and_rejects_one_more_byte() {
    let padded = format!("{GOLDEN}{}", " ".repeat(MAX_BYTES - GOLDEN.len()));
    let (transport, server) = mock(
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            padded.as_bytes(),
        ),
        Duration::ZERO,
    )
    .await;
    let fetched = success(transport.fetch(&source()).await);
    assert_eq!(fetched, padded);
    assert!(decode_snapshot(&fetched, venue()).is_ok());
    server.await.unwrap();
    // Oversized declaration must fail without waiting for the promised body.
    let oversized = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_BYTES + 1);
    let (transport, server) = mock(oversized.into_bytes(), Duration::ZERO).await;
    fixed_failure(transport.fetch(&source()).await.unwrap_err());
    server.await.unwrap();
}

#[tokio::test]
async fn chunked_responses_cannot_bypass_streaming_size_limit() {
    for size in [MAX_BYTES, MAX_BYTES + 1] {
        let mut bytes = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        for chunk in vec![b' '; size].chunks(16 * 1024) {
            bytes.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            bytes.extend_from_slice(chunk);
            bytes.extend_from_slice(b"\r\n");
        }
        bytes.extend_from_slice(b"0\r\n\r\n");
        let (transport, server) = mock(bytes, Duration::ZERO).await;
        let result = transport.fetch(&source()).await;
        if size == MAX_BYTES {
            assert_eq!(success(result).len(), MAX_BYTES);
        } else {
            fixed_failure(result.unwrap_err());
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn truncated_and_delayed_responses_fail_without_retry_or_details() {
    let (transport, server) = mock(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{}"
            .to_vec(),
        Duration::ZERO,
    )
    .await;
    fixed_failure(transport.fetch(&source()).await.unwrap_err());
    server.await.unwrap();
    let (transport, server) = mock(
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            GOLDEN.as_bytes(),
        ),
        Duration::from_millis(200),
    )
    .await;
    fixed_failure(
        transport
            .fetch_with_timeout(&source(), Duration::from_millis(50))
            .await
            .unwrap_err(),
    );
    server.await.unwrap();
}

#[tokio::test]
async fn production_transport_rejects_loopback_without_any_request() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = MenuSourceAccess {
        base_url: format!("https://{}", listener.local_addr().unwrap()),
        api_key: SYNTHETIC_KEY.into(),
    };
    fixed_failure(Transport::default().fetch(&source).await.unwrap_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

/// Explicit opt-in against an already running, isolated source application.
/// FIREFLINT_E1_TEST_FIXTURE names a JSON file containing origin, api_key_file
/// (a file name next to the JSON, synthetic credential only), venue_id and
/// expected_item_count. This seam exists only in the test binary.
#[tokio::test]
#[ignore = "requires a separately managed isolated FlintPlate fixture and synthetic credential"]
async fn real_source_fixture_snapshot() {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Fixture {
        origin: String,
        api_key_file: String,
        venue_id: Uuid,
        expected_item_count: usize,
    }
    let path = std::path::PathBuf::from(
        std::env::var("FIREFLINT_E1_TEST_FIXTURE").expect("explicit fixture JSON path required"),
    );
    assert!(path.is_absolute(), "fixture JSON path must be absolute");
    let data = std::fs::read(&path).expect("fixture JSON must be readable");
    let fixture: Fixture =
        serde_json::from_slice(&data).expect("fixture JSON must match the documented schema");
    let origin = reqwest::Url::parse(&fixture.origin).expect("fixture origin must be a URL");
    assert!(
        origin.scheme() == "http"
            && origin.host_str() == Some("127.0.0.1")
            && origin.path() == "/"
            && origin.query().is_none()
            && origin.fragment().is_none()
            && origin.username().is_empty()
            && origin.password().is_none(),
        "fixture must use a bare HTTP loopback origin"
    );
    let key_path = std::path::Path::new(&fixture.api_key_file);
    assert!(
        key_path.components().count() == 1
            && matches!(
                key_path.components().next(),
                Some(std::path::Component::Normal(_))
            ),
        "synthetic key must be a file beside the fixture JSON"
    );
    assert!(
        !fixture.api_key_file.starts_with('.'),
        "hidden configuration files are not fixture keys"
    );
    let key = std::fs::read_to_string(path.parent().unwrap().join(key_path))
        .expect("synthetic fixture key file must be readable");
    let key = key.trim_end_matches(['\r', '\n']);
    assert!(
        (1..=4096).contains(&key.len()) && key.bytes().all(|b| (0x21..=0x7e).contains(&b)),
        "synthetic key must use visible ASCII"
    );
    let source = MenuSourceAccess {
        base_url: "https://isolated-fixture.example.test".into(),
        api_key: key.into(),
    };
    let transport = Transport {
        mock_origin: Some(fixture.origin),
    };
    let raw = success(transport.fetch(&source).await);
    let decoded = decode_snapshot(&raw, fixture.venue_id)
        .expect("source fixture must produce a valid snapshot for the expected venue");
    assert_eq!(
        decoded["items"].as_array().unwrap().len(),
        fixture.expected_item_count
    );
}
