mod protocol;
mod store;
mod ws;

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::{info, warn};
use tracing_subscriber::filter::LevelFilter;

use crate::protocol::now_ms;
use crate::store::Store;
use crate::ws::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    network: IpAddr,
    prefix: u8,
}

impl Cidr {
    pub fn parse(value: &str) -> Result<Self, String> {
        let (network, prefix) = value
            .trim()
            .split_once('/')
            .ok_or_else(|| format!("missing prefix length in {value:?}"))?;
        let network: IpAddr = network
            .parse()
            .map_err(|_| format!("invalid address in {value:?}"))?;
        let prefix: u8 = prefix
            .parse()
            .map_err(|_| format!("invalid prefix length in {value:?}"))?;
        let max = match network {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        if prefix > max {
            return Err(format!("prefix length {prefix} exceeds {max}"));
        }
        Ok(Self { network, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.network, ip) {
            (IpAddr::V4(network), IpAddr::V4(ip)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - self.prefix as u32)
                };
                (u32::from(network) & mask) == (u32::from(ip) & mask)
            }
            (IpAddr::V6(network), IpAddr::V6(ip)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - self.prefix as u32)
                };
                (u128::from(network) & mask) == (u128::from(ip) & mask)
            }
            _ => false,
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("BATON_SECRET is required and must be at least 32 characters")]
    Secret,
    #[error("BATON_DB must be an absolute path")]
    DbNotAbsolute,
    #[error("BATON_DB parent directory is not usable: {0}")]
    DbParent(String),
    #[error("BATON_BIND is invalid: {0}")]
    Bind(String),
    #[error("TRUSTED_PROXY_CIDRS is invalid: {0}")]
    ProxyCidr(String),
    #[error("BATON_LOG is invalid: {0}")]
    Log(String),
}

pub struct Config {
    secret: Arc<str>,
    db_path: PathBuf,
    bind: SocketAddr,
    trusted_proxies: Vec<Cidr>,
    log_level: LevelFilter,
}

impl Config {
    fn from_env() -> Result<Self, ConfigError> {
        let secret = std::env::var("BATON_SECRET").map_err(|_| ConfigError::Secret)?;
        if secret.chars().count() < 32 {
            return Err(ConfigError::Secret);
        }
        let db_path = PathBuf::from(
            std::env::var("BATON_DB").unwrap_or_else(|_| "/data/baton.db".to_owned()),
        );
        if !db_path.is_absolute() {
            return Err(ConfigError::DbNotAbsolute);
        }
        validate_db_parent(&db_path)?;

        let bind = std::env::var("BATON_BIND")
            .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
            .parse::<SocketAddr>()
            .map_err(|error| ConfigError::Bind(error.to_string()))?;

        let trusted_proxies = std::env::var("TRUSTED_PROXY_CIDRS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(Cidr::parse)
            .collect::<Result<Vec<_>, _>>()
            .map_err(ConfigError::ProxyCidr)?;

        let log_level =
            parse_log_level(&std::env::var("BATON_LOG").unwrap_or_else(|_| "info".to_owned()))
                .ok_or_else(|| {
                    ConfigError::Log("expected error, warn, info or debug".to_owned())
                })?;

        Ok(Self {
            secret: Arc::from(secret),
            db_path,
            bind,
            trusted_proxies,
            log_level,
        })
    }
}

fn validate_db_parent(db_path: &Path) -> Result<(), ConfigError> {
    let parent = db_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| ConfigError::DbParent("path has no parent".to_owned()))?;
    if !parent.is_dir() {
        return Err(ConfigError::DbParent(format!(
            "{} is not a directory",
            parent.display()
        )));
    }
    let probe = parent.join(format!(
        ".baton-write-check-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(error) => Err(ConfigError::DbParent(format!(
            "{} is not writable: {error}",
            parent.display()
        ))),
    }
}

fn parse_log_level(value: &str) -> Option<LevelFilter> {
    match value.trim().to_ascii_lowercase().as_str() {
        "error" => Some(LevelFilter::ERROR),
        "warn" => Some(LevelFilter::WARN),
        "info" => Some(LevelFilter::INFO),
        "debug" => Some(LevelFilter::DEBUG),
        _ => None,
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("baton-server: {error}");
        std::process::exit(1);
    }
}

#[tokio::main]
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    tracing_subscriber::fmt()
        .with_max_level(config.log_level)
        .init();

    let store = Arc::new(Store::open(&config.db_path)?);
    let removed = store.delete_expired(now_ms()).await?;
    if removed > 0 {
        info!(removed, "removed expired tasks at startup");
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let state = Arc::new(AppState::new(
        store.clone(),
        config.secret.clone(),
        config.trusted_proxies.clone(),
        shutdown_rx.clone(),
    ));
    let mut cleanup = tokio::spawn(cleanup_loop(store, shutdown_rx));

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/healthz", get(healthz))
        .with_state(state.clone());

    let listener = TcpListener::bind(config.bind).await?;
    info!(
        bind = %config.bind,
        db = %config.db_path.display(),
        "baton server listening"
    );

    let signal_state = state.clone();
    let shutdown = async move {
        wait_for_signal().await;
        info!("shutdown requested");
        let _ = shutdown_tx.send(true);
        signal_state.close_all_connections();
    };

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await?;

    if tokio::time::timeout(Duration::from_secs(5), &mut cleanup)
        .await
        .is_err()
    {
        cleanup.abort();
    }
    info!("baton server stopped");
    Ok(())
}

async fn healthz(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.ping().await {
        Ok(()) => (StatusCode::OK, "ok"),
        Err(error) => {
            warn!(error = %error, "health check failed");
            (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        }
    }
}

async fn cleanup_loop(store: Arc<Store>, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = interval.tick() => {
                match store.delete_expired(now_ms()).await {
                    Ok(0) => {}
                    Ok(removed) => info!(removed, "removed expired tasks"),
                    Err(error) => warn!(error = %error, "expired task cleanup failed"),
                }
            }
        }
    }
}

async fn wait_for_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            warn!(error = %error, "cannot listen for ctrl-c");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => warn!(error = %error, "cannot listen for SIGTERM"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    #[test]
    fn cidr_matching_for_ipv4_and_ipv6() {
        let cidr = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(cidr.contains(ip("10.1.2.3")));
        assert!(!cidr.contains(ip("11.1.2.3")));
        assert!(Cidr::parse("0.0.0.0/0")
            .unwrap()
            .contains(ip("203.0.113.4")));
        assert!(Cidr::parse("192.0.2.1/32")
            .unwrap()
            .contains(ip("192.0.2.1")));
        assert!(!Cidr::parse("192.0.2.1/32")
            .unwrap()
            .contains(ip("192.0.2.2")));
        let v6 = Cidr::parse("2001:db8::/32").unwrap();
        assert!(v6.contains(ip("2001:db8::1")));
        assert!(!v6.contains(ip("2001:db9::1")));
        assert!(!v6.contains(ip("10.0.0.1")));
    }

    #[test]
    fn invalid_cidrs_are_rejected() {
        for value in [
            "10.0.0.0",
            "10.0.0.0/33",
            "2001:db8::/129",
            "nope",
            "10.0.0.0/x",
        ] {
            assert!(Cidr::parse(value).is_err(), "{value} should fail");
        }
    }

    #[test]
    fn log_levels_are_restricted() {
        assert_eq!(parse_log_level("error"), Some(LevelFilter::ERROR));
        assert_eq!(parse_log_level("WARN"), Some(LevelFilter::WARN));
        assert_eq!(parse_log_level("info"), Some(LevelFilter::INFO));
        assert_eq!(parse_log_level("debug"), Some(LevelFilter::DEBUG));
        assert_eq!(parse_log_level("trace"), None);
        assert_eq!(parse_log_level("bogus"), None);
    }

    #[test]
    fn db_parent_must_be_absolute_and_writable() {
        let relative = PathBuf::from("baton.db");
        assert!(!relative.is_absolute());
        let temp = std::env::temp_dir().join(format!(
            "baton-config-test-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(validate_db_parent(&temp).is_ok());
    }
}
