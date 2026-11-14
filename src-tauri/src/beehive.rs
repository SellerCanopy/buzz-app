//! Beehive access for the desktop app. Two narrow commands: one signs the
//! sign-in event with the person's Buzz key, the other forwards one request to
//! the build's Beehive address. Neither exposes a general signer or an
//! arbitrary request, and the key never reaches the page.
use crate::identity::{EventTemplate, IdentityHost};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{sync::OnceLock, time::Duration};
use url::Url;

/// Read once at build time, like the other `BUZZ_BUILD_*` values. Empty or
/// unset means Beehive is off.
const BEEHIVE_URL: Option<&str> = option_env!("BUZZ_BUILD_BEEHIVE_URL");

const SERVICE: &str = "/kiln.engine.v1.EngineService/";
const TOKEN_PATH: &str = "/auth/token";
const MAX_REQUEST: usize = 16 * 1024 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;

/// What the page receives when a command fails. `code` follows the Connect
/// error codes, plus `unavailable` for a failure before Beehive answered.
#[derive(Debug, Serialize)]
pub(crate) struct Failure {
    code: String,
    message: String,
    status: u16,
}

impl Failure {
    fn unavailable(message: &str) -> Self {
        Self {
            code: "unavailable".into(),
            message: message.into(),
            status: 0,
        }
    }
}

type Result<T> = std::result::Result<T, Failure>;

/// The Beehive origin from a build value: https, or http on localhost in a
/// debug build, with no path, query, fragment or credentials.
fn parse_base(value: Option<&str>, debug: bool) -> Result<Url> {
    let text = value.map(str::trim).filter(|text| !text.is_empty());
    let text = text.ok_or_else(|| Failure::unavailable("Beehive is not set up in this build"))?;
    let invalid = || Failure::unavailable("The Beehive address is invalid");
    let url = Url::parse(text).map_err(|_| invalid())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    let secure = url.scheme() == "https" || (debug && local && url.scheme() == "http");
    let bare = url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    if secure && bare {
        Ok(url)
    } else {
        Err(invalid())
    }
}

fn base() -> Result<Url> {
    parse_base(BEEHIVE_URL, cfg!(debug_assertions))
}

/// A path the page may call: the token trade, or one engine method by name.
fn allowed_path(path: &str) -> bool {
    path == TOKEN_PATH
        || path
            .strip_prefix(SERVICE)
            .is_some_and(|name| !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// The NIP-98 event that proves who is asking for a token.
fn authorization_template(url: &Url, created_at: u64, nonce: String) -> EventTemplate {
    EventTemplate {
        kind: 27235,
        created_at,
        content: String::new(),
        tags: vec![
            vec!["u".into(), url.as_str().to_owned()],
            vec!["method".into(), "POST".into()],
            vec!["nonce".into(), nonce],
        ],
    }
}

/// Sign the event that trades for a Beehive token. Returns the base64 of the
/// signed event; the page adds the `Nostr ` scheme.
#[tauri::command]
pub(crate) async fn beehive_authorization(host: tauri::State<'_, IdentityHost>) -> Result<String> {
    // The server compares against `<origin>/auth/token`, with no trailing slash
    // after the origin and no extra path.
    let origin = base()?.origin().ascii_serialization();
    let url = Url::parse(&format!("{origin}{TOKEN_PATH}"))
        .map_err(|_| Failure::unavailable("The Beehive address is invalid"))?;
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Failure::unavailable("System clock is unavailable"))?
        .as_secs();
    let signed = host
        .sign(authorization_template(
            &url,
            created_at,
            uuid::Uuid::new_v4().to_string(),
        ))
        .await
        .map_err(|message| Failure::unavailable(&message))?;
    Ok(STANDARD.encode(
        serde_json::to_vec(&signed)
            .map_err(|_| Failure::unavailable("Could not encode the sign-in event"))?,
    ))
}

fn client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
        })
        .as_ref()
        .map_err(|_| Failure::unavailable("Beehive network client is unavailable"))
}

/// A bearer token or `Nostr` event is one printable header token, never a line.
fn header_safe(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
}

/// Which header a request carries: the signed event for the token trade, a
/// bearer token for every engine method.
fn authorization(path: &str, bearer: Option<&str>, signed: Option<&str>) -> Result<Option<String>> {
    let refused = || Failure {
        code: "invalid_argument".into(),
        message: "The request is not allowed".into(),
        status: 0,
    };
    match (path == TOKEN_PATH, bearer, signed) {
        (true, None, Some(value)) if value.starts_with("Nostr ") && header_safe(value) => {
            Ok(Some(value.to_owned()))
        }
        (false, Some(token), None) if header_safe(token) && !token.contains(' ') => {
            Ok(Some(format!("Bearer {token}")))
        }
        (false, None, None) => Ok(None),
        _ => Err(refused()),
    }
}

/// Turn a failed reply into the page's error: the engine's own code and message
/// when it sent them, `unavailable` for anything else, such as a proxy page.
fn failure(status: u16, text: &str) -> Failure {
    let parsed = serde_json::from_str::<serde_json::Value>(text).ok();
    let field = |name: &str| {
        parsed
            .as_ref()
            .and_then(|value| value.get(name))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    match field("code") {
        Some(code) => Failure {
            code,
            message: field("message").unwrap_or_default(),
            status,
        },
        None => Failure {
            code: "unavailable".into(),
            message: "Beehive did not answer".into(),
            status,
        },
    }
}

/// POST one request to Beehive and return the reply body.
#[tauri::command]
pub(crate) async fn beehive_request(
    path: String,
    body: String,
    bearer: Option<String>,
    authorization: Option<String>,
) -> Result<String> {
    if !allowed_path(&path) || body.len() > MAX_REQUEST {
        return Err(Failure {
            code: "invalid_argument".into(),
            message: "The request is not allowed".into(),
            status: 0,
        });
    }
    let header = self::authorization(&path, bearer.as_deref(), authorization.as_deref())?;
    let url = base()?
        .join(&path)
        .map_err(|_| Failure::unavailable("The Beehive address is invalid"))?;
    let mut request = client()?
        .post(url)
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1")
        .body(body);
    if let Some(header) = header {
        request = request.header("authorization", header);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| Failure::unavailable("Beehive is not reachable"))?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Failure::unavailable("Beehive stopped answering"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(Failure::unavailable("Beehive's answer was too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if status.is_success() {
        Ok(text)
    } else {
        Err(failure(status.as_u16(), &text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_takes_https_and_drops_nothing_it_needs() {
        let url = parse_base(Some("https://hive.example.org"), false).unwrap();
        assert_eq!(url.as_str(), "https://hive.example.org/");
    }

    #[test]
    fn base_rejects_http_outside_a_debug_build() {
        assert!(parse_base(Some("http://localhost:3100"), false).is_err());
        assert!(parse_base(Some("http://hive.example.org"), true).is_err());
        assert!(parse_base(Some("http://localhost:3100"), true).is_ok());
        assert!(parse_base(Some("http://127.0.0.1:3100"), true).is_ok());
    }

    #[test]
    fn base_rejects_a_path_query_or_credentials_and_an_empty_value() {
        for value in [
            "https://hive.example.org/api",
            "https://hive.example.org/?a=1",
            "https://hive.example.org/#x",
            "https://user:pw@hive.example.org",
            "not a url",
            "",
        ] {
            assert!(parse_base(Some(value), true).is_err(), "{value}");
        }
        assert!(parse_base(None, true).is_err());
    }

    #[test]
    fn only_the_token_trade_and_named_engine_methods_are_allowed() {
        assert!(allowed_path("/auth/token"));
        assert!(allowed_path("/kiln.engine.v1.EngineService/ListCards"));
        for path in [
            "",
            "/",
            "/healthz",
            "/auth/token/",
            "/auth/tokenx",
            "/kiln.engine.v1.EngineService/",
            "/kiln.engine.v1.EngineService/../auth/token",
            "/kiln.engine.v1.EngineService/ListCards?x=1",
            "/kiln.engine.v1.EngineService/List/Cards",
            "//hive.example.org/x",
        ] {
            assert!(!allowed_path(path), "{path}");
        }
    }

    #[test]
    fn the_signed_event_is_a_post_to_the_token_url_with_a_nonce() {
        let url = Url::parse("https://hive.example.org/auth/token").unwrap();
        let event = authorization_template(&url, 1_700_000_000, "n1".into());
        assert_eq!(event.kind, 27235);
        assert_eq!(event.created_at, 1_700_000_000);
        assert!(event.content.is_empty());
        assert!(event.tags.contains(&vec![
            "u".into(),
            "https://hive.example.org/auth/token".into()
        ]));
        assert!(event.tags.contains(&vec!["method".into(), "POST".into()]));
        assert!(event.tags.contains(&vec!["nonce".into(), "n1".into()]));
    }

    #[test]
    fn the_header_matches_the_path() {
        let token = "/auth/token";
        let method = "/kiln.engine.v1.EngineService/ListCards";
        assert_eq!(
            authorization(token, None, Some("Nostr abc"))
                .unwrap()
                .as_deref(),
            Some("Nostr abc")
        );
        assert_eq!(
            authorization(method, Some("tok"), None).unwrap().as_deref(),
            Some("Bearer tok")
        );
        assert!(authorization(method, None, None).unwrap().is_none());
        // A signed event on a method, a bearer on the token trade, or both: refused.
        assert!(authorization(method, None, Some("Nostr abc")).is_err());
        assert!(authorization(token, Some("tok"), None).is_err());
        assert!(authorization(token, None, Some("Basic abc")).is_err());
        assert!(authorization(method, Some("a\r\nb"), None).is_err());
        assert!(authorization(method, Some("a b"), None).is_err());
    }

    #[test]
    fn a_failed_reply_keeps_the_engine_code_or_becomes_unavailable() {
        let known = failure(401, r#"{"code":"unauthenticated","message":"expired"}"#);
        assert_eq!(
            (known.code.as_str(), known.message.as_str(), known.status),
            ("unauthenticated", "expired", 401)
        );
        let proxy = failure(502, "<html>Bad Gateway</html>");
        assert_eq!((proxy.code.as_str(), proxy.status), ("unavailable", 502));
    }
}
