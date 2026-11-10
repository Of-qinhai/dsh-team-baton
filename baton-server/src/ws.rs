use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use crate::protocol::{
    error_response, now_ms, ok_response, parse_request, ErrorCode, Request, RequestKind, RoomView,
    MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, STATE_CHANGED_EVENT,
};
use crate::store::{Store, StoreError};
use crate::Cidr;

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const OUTBOUND_CAPACITY: usize = 8;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const ROOM_RATE_LIMIT: u32 = 10;
const TASK_RATE_LIMIT: u32 = 20;
const AUTH_FAILURE_LIMIT: u32 = 10;

pub struct AppState {
    pub store: Arc<Store>,
    registry: Arc<Registry>,
    secret: Arc<str>,
    limits: Arc<RateLimiter>,
    trusted_proxies: Arc<Vec<Cidr>>,
    shutdown: watch::Receiver<bool>,
}

impl AppState {
    pub fn new(
        store: Arc<Store>,
        secret: Arc<str>,
        trusted_proxies: Vec<Cidr>,
        shutdown: watch::Receiver<bool>,
    ) -> Self {
        Self {
            store,
            registry: Arc::new(Registry::default()),
            secret,
            limits: Arc::new(RateLimiter::default()),
            trusted_proxies: Arc::new(trusted_proxies),
            shutdown,
        }
    }

    pub fn close_all_connections(&self) {
        self.registry.close_all();
    }

    fn notify_users(&self, users: &[String]) {
        let mut seen = HashSet::new();
        for user in users {
            if !seen.insert(user.as_str()) {
                continue;
            }
            if let Some(handle) = self.registry.handle(user) {
                let _ = handle
                    .tx
                    .try_send(Outbound::Text(STATE_CHANGED_EVENT.to_owned()));
            }
        }
    }
}

#[derive(Debug)]
enum Outbound {
    Text(String),
}

#[derive(Clone)]
struct ConnHandle {
    generation: u64,
    tx: mpsc::Sender<Outbound>,
    close: watch::Sender<bool>,
}

#[derive(Default)]
struct Registry {
    inner: Mutex<HashMap<String, ConnHandle>>,
    next_generation: AtomicU64,
}

impl Registry {
    fn next_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ConnHandle>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn replace(&self, user_id: String, handle: ConnHandle) -> Option<ConnHandle> {
        self.lock().insert(user_id, handle)
    }

    fn handle(&self, user_id: &str) -> Option<ConnHandle> {
        self.lock().get(user_id).cloned()
    }

    fn is_online(&self, user_id: &str) -> bool {
        self.lock().contains_key(user_id)
    }

    fn remove_if_generation(&self, user_id: &str, generation: u64) -> bool {
        let mut map = self.lock();
        if map.get(user_id).map(|handle| handle.generation) == Some(generation) {
            map.remove(user_id);
            true
        } else {
            false
        }
    }

    fn close_all(&self) {
        for handle in self.lock().values() {
            let _ = handle.close.send(true);
        }
    }
}

#[derive(Default)]
struct RateLimiter {
    windows: Mutex<HashMap<String, Window>>,
}

struct Window {
    started: Instant,
    count: u32,
}

impl RateLimiter {
    fn allow(&self, key: String, limit: u32) -> bool {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let window = windows.entry(key).or_insert(Window {
            started: now,
            count: 0,
        });
        if now.duration_since(window.started) >= RATE_WINDOW {
            *window = Window {
                started: now,
                count: 0,
            };
        }
        if window.count >= limit {
            false
        } else {
            window.count += 1;
            true
        }
    }

    fn auth_blocked(&self, ip: IpAddr) -> bool {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = format!("auth:{ip}");
        let now = Instant::now();
        match windows.get_mut(&key) {
            Some(window) => {
                if now.duration_since(window.started) >= RATE_WINDOW {
                    windows.remove(&key);
                    false
                } else {
                    window.count >= AUTH_FAILURE_LIMIT
                }
            }
            None => false,
        }
    }

    fn record_auth_failure(&self, ip: IpAddr) {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = format!("auth:{ip}");
        let now = Instant::now();
        let window = windows.entry(key).or_insert(Window {
            started: now,
            count: 0,
        });
        if now.duration_since(window.started) >= RATE_WINDOW {
            *window = Window {
                started: now,
                count: 0,
            };
        }
        window.count += 1;
    }
}

#[derive(Clone)]
struct Identity {
    user_id: String,
    display_name: String,
    generation: u64,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let client_ip = match client_ip(peer.ip(), &headers, state.trusted_proxies.as_slice()) {
        Ok(ip) => ip,
        Err(reason) => {
            warn!(peer = %peer.ip(), reason, "rejecting websocket connection");
            return (StatusCode::BAD_REQUEST, "invalid client address").into_response();
        }
    };
    ws.max_message_size(MAX_REQUEST_BYTES)
        .max_frame_size(MAX_REQUEST_BYTES)
        .on_upgrade(move |socket| connection(socket, state, client_ip))
}

fn client_ip(
    peer: IpAddr,
    headers: &HeaderMap,
    trusted_proxies: &[Cidr],
) -> Result<IpAddr, &'static str> {
    if !trusted_proxies.iter().any(|cidr| cidr.contains(peer)) {
        return Ok(peer);
    }
    let mut values = headers.get_all("x-forwarded-for").iter();
    let first = values
        .next()
        .ok_or("trusted proxy omitted x-forwarded-for")?;
    if values.next().is_some() {
        return Err("multiple x-forwarded-for headers");
    }
    let value = first
        .to_str()
        .map_err(|_| "invalid x-forwarded-for encoding")?
        .trim();
    if value.is_empty() || value.contains(',') {
        return Err("x-forwarded-for must contain exactly one address");
    }
    value
        .parse::<IpAddr>()
        .map_err(|_| "invalid x-forwarded-for address")
}

async fn connection(socket: WebSocket, state: Arc<AppState>, client_ip: IpAddr) {
    let (sink, mut stream) = socket.split();
    let (tx, rx) = mpsc::channel::<Outbound>(OUTBOUND_CAPACITY);
    let (close_tx, mut close_rx) = watch::channel(false);
    let generation = state.registry.next_generation();
    let mut writer = tokio::spawn(writer_loop(sink, rx, close_rx.clone(), close_tx.clone()));
    let mut shutdown_rx = state.shutdown.clone();
    let auth_deadline = tokio::time::Instant::now() + AUTH_TIMEOUT;
    let mut last_activity = tokio::time::Instant::now();
    let mut authed: Option<Identity> = None;

    loop {
        let wait = if authed.is_some() {
            IDLE_TIMEOUT.saturating_sub(last_activity.elapsed())
        } else {
            auth_deadline.saturating_duration_since(tokio::time::Instant::now())
        };
        tokio::select! {
            _ = tokio::time::sleep(wait) => {
                debug!(client = %client_ip, "closing idle websocket");
                break;
            }
            changed = close_rx.changed() => {
                let _ = changed;
                break;
            }
            changed = shutdown_rx.changed() => {
                let _ = changed;
                break;
            }
            item = stream.next() => {
                match item {
                    Some(Ok(Message::Text(text))) => {
                        let request = match parse_request(&text) {
                            Ok(request) => request,
                            Err(error) => {
                                debug!(client = %client_ip, code = error.code.as_str(), "bad request");
                                let queue_failed = send_error(&tx, error.id.as_deref(), error.code);
                                if queue_failed || error.code == ErrorCode::ProtocolMismatch {
                                    break;
                                }
                                continue;
                            }
                        };
                        last_activity = tokio::time::Instant::now();
                        let close = handle_request(
                            &state,
                            &mut authed,
                            request,
                            generation,
                            &tx,
                            &close_tx,
                            client_ip,
                        )
                        .await;
                        if close {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Binary(_))) => {
                        if send_error(&tx, None, ErrorCode::InvalidRequest) {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    let _ = close_tx.send(true);
    if let Some(identity) = authed {
        if state
            .registry
            .remove_if_generation(&identity.user_id, identity.generation)
        {
            match state.store.peer_users(&identity.user_id).await {
                Ok(reply) => state.notify_users(&reply.peers),
                Err(error) => warn!(
                    user_id = %identity.user_id,
                    error = %error,
                    "cannot determine peers for offline notification"
                ),
            }
        }
    }
    if tokio::time::timeout(CLOSE_TIMEOUT, &mut writer)
        .await
        .is_err()
    {
        writer.abort();
    }
}

async fn writer_loop(
    mut sink: SplitSink<WebSocket, Message>,
    mut rx: mpsc::Receiver<Outbound>,
    mut close_rx: watch::Receiver<bool>,
    close_tx: watch::Sender<bool>,
) {
    loop {
        tokio::select! {
            biased;
            changed = close_rx.changed() => {
                let _ = changed;
                while let Ok(message) = rx.try_recv() {
                    if !write_outbound(&mut sink, message).await {
                        let _ = close_tx.send(true);
                        return;
                    }
                }
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    sink.send(Message::Close(None)),
                )
                .await;
                return;
            }
            message = rx.recv() => {
                match message {
                    Some(message) => {
                        if !write_outbound(&mut sink, message).await {
                            let _ = close_tx.send(true);
                            return;
                        }
                    }
                    None => {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(1),
                            sink.send(Message::Close(None)),
                        )
                        .await;
                        return;
                    }
                }
            }
        }
    }
}

async fn write_outbound(sink: &mut SplitSink<WebSocket, Message>, message: Outbound) -> bool {
    let Outbound::Text(text) = message;
    matches!(
        tokio::time::timeout(WRITE_TIMEOUT, sink.send(Message::Text(text))).await,
        Ok(Ok(()))
    )
}

#[allow(clippy::too_many_arguments)]
async fn handle_request(
    state: &Arc<AppState>,
    authed: &mut Option<Identity>,
    request: Request,
    generation: u64,
    tx: &mpsc::Sender<Outbound>,
    close_tx: &watch::Sender<bool>,
    client_ip: IpAddr,
) -> bool {
    let Request { id, kind } = request;
    match kind {
        RequestKind::Hello {
            secret,
            user_id,
            display_name,
            ..
        } => {
            if authed.is_some() {
                let _ = send_error(tx, Some(&id), ErrorCode::InvalidRequest);
                return true;
            }
            return handle_hello(
                state,
                authed,
                &id,
                &secret,
                user_id,
                display_name,
                generation,
                tx,
                close_tx,
                client_ip,
            )
            .await;
        }
        _ if authed.is_none() => {
            return send_error(tx, Some(&id), ErrorCode::InvalidRequest);
        }
        _ => {}
    }

    let identity = authed.as_ref().expect("checked authenticated").clone();
    match kind {
        RequestKind::Sync => match state.store.sync(&identity.user_id, now_ms()).await {
            Ok(mut reply) => {
                fill_online(&state.registry, &mut reply.rooms);
                send_data(tx, &id, json!({"rooms": reply.rooms, "tasks": reply.tasks}))
            }
            Err(error) => respond_store_error(&id, tx, error),
        },
        RequestKind::RoomCreate { name } => {
            if !state
                .limits
                .allow(format!("room:{}", identity.user_id), ROOM_RATE_LIMIT)
            {
                return send_error(tx, Some(&id), ErrorCode::RateLimited);
            }
            match state
                .store
                .create_room(&identity.user_id, &identity.display_name, &name, now_ms())
                .await
            {
                Ok(mut reply) => {
                    fill_online(&state.registry, std::slice::from_mut(&mut reply.room));
                    let close = send_data(tx, &id, json!({"code": reply.code, "room": reply.room}));
                    state.notify_users(&reply.notify);
                    close
                }
                Err(error) => respond_store_error(&id, tx, error),
            }
        }
        RequestKind::RoomJoin { code } => {
            if !state
                .limits
                .allow(format!("room:{}", identity.user_id), ROOM_RATE_LIMIT)
            {
                return send_error(tx, Some(&id), ErrorCode::RateLimited);
            }
            match state
                .store
                .join_room(&identity.user_id, &identity.display_name, &code, now_ms())
                .await
            {
                Ok(reply) => {
                    debug!(request_id = %id, code = %reply.code, created = reply.created, "room joined");
                    let close = send_data(tx, &id, json!({"code": reply.code}));
                    state.notify_users(&reply.notify);
                    close
                }
                Err(error) => respond_store_error(&id, tx, error),
            }
        }
        RequestKind::RoomLeave { code } => {
            if !state
                .limits
                .allow(format!("room:{}", identity.user_id), ROOM_RATE_LIMIT)
            {
                return send_error(tx, Some(&id), ErrorCode::RateLimited);
            }
            match state.store.leave_room(&identity.user_id, &code).await {
                Ok(reply) => {
                    let close = send_data(tx, &id, json!({"code": reply.code}));
                    state.notify_users(&reply.notify);
                    close
                }
                Err(error) => respond_store_error(&id, tx, error),
            }
        }
        RequestKind::RoomDisband { code } => {
            if !state
                .limits
                .allow(format!("room:{}", identity.user_id), ROOM_RATE_LIMIT)
            {
                return send_error(tx, Some(&id), ErrorCode::RateLimited);
            }
            match state.store.disband_room(&identity.user_id, &code).await {
                Ok(reply) => {
                    let close = send_data(tx, &id, json!({"code": reply.code}));
                    state.notify_users(&reply.notify);
                    close
                }
                Err(error) => respond_store_error(&id, tx, error),
            }
        }
        RequestKind::TaskSend {
            task_id,
            room,
            to,
            env,
            title,
            brief,
        } => {
            if !state
                .limits
                .allow(format!("task:{}", identity.user_id), TASK_RATE_LIMIT)
            {
                return send_error(tx, Some(&id), ErrorCode::RateLimited);
            }
            match state
                .store
                .send_task(
                    &identity.user_id,
                    &task_id,
                    &room,
                    &to,
                    &env,
                    &title,
                    &brief,
                    now_ms(),
                )
                .await
            {
                Ok(reply) => {
                    debug!(request_id = %id, task_id = %reply.task.task_id, created = reply.created, "task sent");
                    let close = send_data(tx, &id, json!({"task": reply.task}));
                    state.notify_users(&reply.notify);
                    close
                }
                Err(error) => respond_store_error(&id, tx, error),
            }
        }
        RequestKind::TaskGet { task_id } => {
            match state
                .store
                .get_task(&identity.user_id, &task_id, now_ms())
                .await
            {
                Ok(reply) => send_data(tx, &id, json!({"task": reply.task, "brief": reply.brief})),
                Err(error) => respond_store_error(&id, tx, error),
            }
        }
        RequestKind::TaskRespond { task_id, decision } => {
            match state
                .store
                .respond_task(&identity.user_id, &task_id, decision.as_str(), now_ms)
                .await
            {
                Ok(reply) => {
                    let close = send_data(tx, &id, json!({"task": reply.task}));
                    state.notify_users(&reply.notify);
                    close
                }
                Err(error) => respond_store_error(&id, tx, error),
            }
        }
        RequestKind::Ping => send_data(tx, &id, json!({})),
        RequestKind::Hello { .. } => unreachable!("hello handled above"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_hello(
    state: &Arc<AppState>,
    authed: &mut Option<Identity>,
    request_id: &str,
    secret: &str,
    user_id: String,
    display_name: String,
    generation: u64,
    tx: &mpsc::Sender<Outbound>,
    close_tx: &watch::Sender<bool>,
    client_ip: IpAddr,
) -> bool {
    if state.limits.auth_blocked(client_ip) {
        let _ = send_error(tx, Some(request_id), ErrorCode::RateLimited);
        warn!(request_id, client = %client_ip, "authentication rate limited");
        return true;
    }
    if !secret_matches(&state.secret, secret) {
        state.limits.record_auth_failure(client_ip);
        let _ = send_error(tx, Some(request_id), ErrorCode::AuthFailed);
        warn!(request_id, client = %client_ip, "authentication failed");
        return true;
    }

    match state.store.hello(&user_id, &display_name).await {
        Ok(reply) => {
            let handle = ConnHandle {
                generation,
                tx: tx.clone(),
                close: close_tx.clone(),
            };
            if let Some(old) = state.registry.replace(user_id.clone(), handle) {
                let _ = old.close.send(true);
            }
            *authed = Some(Identity {
                user_id: user_id.clone(),
                display_name,
                generation,
            });
            let close = send_data(tx, request_id, json!({}));
            state.notify_users(&reply.peers);
            info!(
                request_id,
                user_id = %user_id,
                name_changed = reply.name_changed,
                client = %client_ip,
                "connection authenticated"
            );
            close
        }
        Err(error) => {
            warn!(request_id, error = %error, "hello store operation failed");
            let _ = send_error(tx, Some(request_id), ErrorCode::Internal);
            true
        }
    }
}

fn secret_matches(expected: &str, candidate: &str) -> bool {
    let expected = expected.as_bytes();
    let candidate = candidate.as_bytes();
    if expected.len() != candidate.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in expected.iter().zip(candidate) {
        difference |= left ^ right;
    }
    difference == 0
}

fn fill_online(registry: &Registry, rooms: &mut [RoomView]) {
    for room in rooms {
        for member in &mut room.members {
            member.online = registry.is_online(&member.user_id);
        }
    }
}

fn respond_store_error(request_id: &str, tx: &mpsc::Sender<Outbound>, error: StoreError) -> bool {
    let code = store_error_code(&error);
    match code {
        ErrorCode::Internal => warn!(
            request_id,
            code = code.as_str(),
            error = %error,
            "store operation failed"
        ),
        _ => debug!(
            request_id,
            code = code.as_str(),
            error = %error,
            "store operation rejected"
        ),
    }
    let close = matches!(error, StoreError::Unavailable);
    send_error(tx, Some(request_id), code) || close
}

fn store_error_code(error: &StoreError) -> ErrorCode {
    match error {
        StoreError::Invalid => ErrorCode::InvalidRequest,
        StoreError::Forbidden => ErrorCode::Forbidden,
        StoreError::NotFound => ErrorCode::NotFound,
        StoreError::Conflict => ErrorCode::Conflict,
        StoreError::CapacityExceeded => ErrorCode::CapacityExceeded,
        StoreError::UnsupportedSchema(_) | StoreError::Internal(_) | StoreError::Unavailable => {
            ErrorCode::Internal
        }
    }
}

fn send_data(tx: &mpsc::Sender<Outbound>, id: &str, data: Value) -> bool {
    let value = ok_response(id, data);
    enqueue_value(tx, &value, Some(id))
}

fn send_error(tx: &mpsc::Sender<Outbound>, id: Option<&str>, code: ErrorCode) -> bool {
    let value = error_response(id, code);
    enqueue_value(tx, &value, id)
}

fn enqueue_value(tx: &mpsc::Sender<Outbound>, value: &Value, fallback_id: Option<&str>) -> bool {
    match serde_json::to_string(value) {
        Ok(text) if text.len() <= MAX_RESPONSE_BYTES => tx.try_send(Outbound::Text(text)).is_err(),
        Ok(_) | Err(_) => {
            let fallback = error_response(fallback_id, ErrorCode::Internal);
            match serde_json::to_string(&fallback) {
                Ok(text) => tx.try_send(Outbound::Text(text)).is_err(),
                Err(_) => true,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use axum::routing::get;
    use axum::Router;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::Value;
    use std::path::Path;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::tungstenite::Message as WsMessage;
    use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

    const UUID_A: &str = "00000000-0000-0000-0000-00000000000a";
    const UUID_B: &str = "00000000-0000-0000-0000-00000000000b";
    const UUID_T: &str = "00000000-0000-0000-0000-0000000000aa";

    type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

    async fn call(client: &mut Client, id: &str, ty: &str, data: Value) -> Value {
        let request = json!({"id": id, "type": ty, "data": data});
        client
            .send(WsMessage::Text(request.to_string()))
            .await
            .unwrap();
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), client.next())
                .await
                .expect("response timeout")
                .expect("socket closed")
                .expect("websocket error");
            let WsMessage::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).unwrap();
            if value.get("id").and_then(Value::as_str) == Some(id) {
                return value;
            }
            assert_eq!(value["type"], "state.changed");
        }
    }

    async fn expect_state_changed(client: &mut Client) {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), client.next())
                .await
                .expect("notification timeout")
                .expect("socket closed")
                .expect("websocket error");
            let WsMessage::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["type"] == "state.changed" {
                return;
            }
            panic!("unexpected message while waiting for state.changed: {value}");
        }
    }

    async fn start_server() -> (
        SocketAddr,
        Arc<AppState>,
        watch::Sender<bool>,
        tokio::task::JoinHandle<()>,
    ) {
        let store = Arc::new(Store::open(Path::new(":memory:")).unwrap());
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let state = Arc::new(AppState::new(
            store,
            Arc::from("0123456789abcdef0123456789abcdef"),
            Vec::new(),
            shutdown_rx,
        ));
        let app = Router::new()
            .route("/ws", get(ws_handler))
            .with_state(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (addr, state, shutdown_tx, server)
    }

    #[tokio::test]
    async fn two_clients_complete_room_and_task_flow() {
        let (addr, _state, _shutdown, server) = start_server().await;
        let url = format!("ws://{addr}/ws");
        let (mut a, _) = connect_async(&url).await.unwrap();
        let (mut b, _) = connect_async(&url).await.unwrap();

        let hello_a = call(
            &mut a,
            "a-hello",
            "hello",
            json!({"protocolVersion": 1, "secret": "0123456789abcdef0123456789abcdef", "userId": UUID_A, "displayName": "A"}),
        )
        .await;
        assert_eq!(hello_a["type"], "ok");
        let hello_b = call(
            &mut b,
            "b-hello",
            "hello",
            json!({"protocolVersion": 1, "secret": "0123456789abcdef0123456789abcdef", "userId": UUID_B, "displayName": "B"}),
        )
        .await;
        assert_eq!(hello_b["type"], "ok");

        let created = call(&mut a, "create", "room.create", json!({"name": "Team"})).await;
        assert_eq!(created["type"], "ok");
        let code = created["data"]["code"].as_str().unwrap().to_owned();
        assert_eq!(created["data"]["room"]["members"][0]["online"], true);

        let joined = call(
            &mut b,
            "join",
            "room.join",
            json!({"code": code.to_lowercase()}),
        )
        .await;
        assert_eq!(joined["type"], "ok");
        assert_eq!(joined["data"]["code"], code);

        let sync_b = call(&mut b, "sync-b", "sync", json!({})).await;
        assert_eq!(sync_b["type"], "ok");
        assert_eq!(sync_b["data"]["rooms"][0]["code"], code);
        assert_eq!(
            sync_b["data"]["rooms"][0]["members"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let sent = call(
            &mut a,
            "send",
            "task.send",
            json!({"taskId": UUID_T, "room": code, "to": UUID_B, "env": "frontend", "title": "Build", "brief": "do it"}),
        )
        .await;
        assert_eq!(sent["type"], "ok");
        assert_eq!(sent["data"]["task"]["status"], "pending");
        assert_eq!(sent["data"]["task"]["from"]["userId"], UUID_A);
        expect_state_changed(&mut a).await;
        expect_state_changed(&mut b).await;

        let duplicate = call(
            &mut a,
            "send-again",
            "task.send",
            json!({"taskId": UUID_T, "room": code, "to": UUID_B, "env": "frontend", "title": "Build", "brief": "do it"}),
        )
        .await;
        assert_eq!(duplicate["data"]["task"]["taskId"], UUID_T);
        assert_eq!(duplicate["data"]["task"]["status"], "pending");

        let got = call(&mut b, "get", "task.get", json!({"taskId": UUID_T})).await;
        assert_eq!(got["type"], "ok");
        assert_eq!(got["data"]["brief"], "do it");

        let accepted = call(
            &mut b,
            "respond",
            "task.respond",
            json!({"taskId": UUID_T, "decision": "accepted"}),
        )
        .await;
        assert_eq!(accepted["type"], "ok");
        assert_eq!(accepted["data"]["task"]["status"], "accepted");
        expect_state_changed(&mut a).await;
        expect_state_changed(&mut b).await;

        let sync_a = call(&mut a, "sync-a", "sync", json!({})).await;
        assert_eq!(sync_a["type"], "ok");
        assert_eq!(sync_a["data"]["tasks"][0]["status"], "accepted");
        assert!(sync_a["data"]["tasks"][0].get("brief").is_none());

        a.close(None).await.unwrap();
        b.close(None).await.unwrap();
        let _ = _shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    }

    #[tokio::test]
    async fn wrong_secret_is_auth_failed_and_closes() {
        let (addr, _state, _shutdown, server) = start_server().await;
        let url = format!("ws://{addr}/ws");
        let (mut a, _) = connect_async(&url).await.unwrap();
        let response = call(
            &mut a,
            "hello",
            "hello",
            json!({"protocolVersion": 1, "secret": "wrong-secret", "userId": UUID_A, "displayName": "A"}),
        )
        .await;
        assert_eq!(response["type"], "error");
        assert_eq!(response["code"], "auth_failed");
        let message = tokio::time::timeout(Duration::from_secs(5), a.next())
            .await
            .expect("close timeout");
        assert!(message.is_none() || message.unwrap().unwrap().is_close());
        let _ = _shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    }

    #[tokio::test]
    async fn full_outbound_queue_drops_updates_but_reports_response_failure() {
        let (tx, _rx) = mpsc::channel::<Outbound>(8);
        for _ in 0..8 {
            tx.try_send(Outbound::Text("{}".to_owned()))
                .expect("prefill");
        }
        // A response that cannot be queued must be reported so the caller closes the connection.
        assert!(enqueue_value(
            &tx,
            &json!({"id":"r","type":"ok","data":{}}),
            Some("r")
        ));
        // A dropped update is the acceptable case: sync will repair it.
        assert!(tx
            .try_send(Outbound::Text(STATE_CHANGED_EVENT.to_owned()))
            .is_err());
    }

    #[tokio::test]
    async fn protocol_mismatch_is_reported_and_closes() {
        let (addr, _state, _shutdown, server) = start_server().await;
        let url = format!("ws://{addr}/ws");
        let (mut a, _) = connect_async(&url).await.unwrap();
        let response = call(
            &mut a,
            "hello",
            "hello",
            json!({"protocolVersion": 2, "secret": "0123456789abcdef0123456789abcdef", "userId": UUID_A, "displayName": "A"}),
        )
        .await;
        assert_eq!(response["type"], "error");
        assert_eq!(response["code"], "protocol_mismatch");
        let message = tokio::time::timeout(Duration::from_secs(5), a.next())
            .await
            .expect("close timeout");
        assert!(message.is_none() || message.unwrap().unwrap().is_close());
        let _ = _shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    }

    #[test]
    fn rate_limiter_counts_per_key_and_window() {
        let limiter = RateLimiter::default();
        for _ in 0..10 {
            assert!(limiter.allow("room:u".into(), 10));
        }
        assert!(!limiter.allow("room:u".into(), 10));
        assert!(limiter.allow("room:v".into(), 10));
    }

    #[test]
    fn auth_failures_are_limited_per_ip() {
        let limiter = RateLimiter::default();
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        let other: IpAddr = "203.0.113.10".parse().unwrap();
        for _ in 0..AUTH_FAILURE_LIMIT {
            assert!(!limiter.auth_blocked(ip));
            limiter.record_auth_failure(ip);
        }
        assert!(limiter.auth_blocked(ip));
        assert!(!limiter.auth_blocked(other));
    }

    #[test]
    fn trusted_proxy_rules_are_enforced() {
        let trusted = [Cidr::parse("10.0.0.0/8").unwrap()];
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());
        let proxy: IpAddr = "10.1.2.3".parse().unwrap();
        let forwarded: IpAddr = "203.0.113.9".parse().unwrap();
        assert_eq!(client_ip(proxy, &headers, &trusted).unwrap(), forwarded);
        let untrusted: IpAddr = "192.0.2.1".parse().unwrap();
        assert_eq!(client_ip(untrusted, &headers, &trusted).unwrap(), untrusted);

        headers.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2".parse().unwrap());
        assert!(client_ip(proxy, &headers, &trusted).is_err());
        assert!(client_ip(proxy, &HeaderMap::new(), &trusted).is_err());
    }

    #[test]
    fn secret_comparison_is_exact() {
        assert!(secret_matches("0123456789abcdef", "0123456789abcdef"));
        assert!(!secret_matches("0123456789abcdef", "0123456789abcdeF"));
        assert!(!secret_matches("0123456789abcdef", "short"));
    }

    #[test]
    fn protocol_error_event_shape_is_fixed() {
        let value = error_response(Some("r"), ErrorCode::Internal);
        assert_eq!(value["message"], "internal error");
        let event: Value = serde_json::from_str(STATE_CHANGED_EVENT).unwrap();
        assert_eq!(event["type"], "state.changed");
    }
}
