//! Loopback HTTP/MCP transport embedded in the desktop application.
//! The renderer owns validation, revisions, persistence and the current planner data.
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io,
    net::Ipv4Addr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, watch, Semaphore},
    task::{JoinHandle, JoinSet},
    time::Instant,
};
use uuid::Uuid;

const MAX_BODY_BYTES: usize = 8 * 1024 * 1024 + 65536;
const MAX_PENDING: usize = 64;
const MAX_CONNECTIONS: usize = 128;
const COMMIT_RESPONSE_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub enabled: bool,
    pub url: String,
    pub token: String,
    pub service_id: String,
}

/// Each service owns a separate listener, credentials and pending-request queue.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Service {
    #[default]
    Mcp,
    Http,
}

impl Service {
    pub fn label(self) -> &'static str {
        match self {
            Self::Mcp => "MCP",
            Self::Http => "HTTP",
        }
    }

    fn supports_path(self, path: &str) -> bool {
        match self {
            Self::Mcp => path == "/mcp",
            Self::Http => matches!(
                path,
                "/api/state" | "/api/assignments" | "/api/validate" | "/api/schedules/generate"
            ),
        }
    }
}

/// Set by the transport route, never taken from client arguments or headers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BridgeSource {
    Mcp,
    Http,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub request_id: String,
    pub source: BridgeSource,
    pub method: String,
    pub args: Value,
    pub expires_at: u64,
    pub service_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCancellation {
    pub request_id: String,
    pub source: BridgeSource,
    pub service_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BridgeError {
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct BridgeResponse {
    pub result: Option<Value>,
    pub error: Option<BridgeError>,
}

pub type EmitRequest = Arc<dyn Fn(BridgeRequest) -> Result<(), String> + Send + Sync>;
pub type EmitCancellation = Arc<dyn Fn(BridgeCancellation) -> Result<(), String> + Send + Sync>;

pub struct ServerOptions {
    pub service: Service,
    pub port: u16,
    pub request_timeout: Duration,
    /// Startup, native watchdog and response overhead beyond the solver budget.
    pub generation_overhead: Duration,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self::for_service(Service::Mcp)
    }
}

impl ServerOptions {
    pub fn for_service(service: Service) -> Self {
        Self {
            service,
            port: match service {
                Service::Mcp => 4318,
                Service::Http => 4319,
            },
            request_timeout: Duration::from_secs(15),
            generation_overhead: Duration::from_secs(150),
        }
    }
}

struct Shared {
    service: Service,
    info: ServerInfo,
    active: AtomicBool,
    emit: EmitRequest,
    emit_cancellation: EmitCancellation,
    pending: Mutex<HashMap<String, PendingRequest>>,
    timeout: Duration,
    generation_overhead: Duration,
}

struct PendingRequest {
    sender: oneshot::Sender<Result<Value, BridgeError>>,
    deadline: Instant,
    source: BridgeSource,
    generation: bool,
    claimed: bool,
}

#[derive(Clone, Copy)]
struct RequestTiming {
    started: Instant,
    started_ms: u64,
}

impl RequestTiming {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            started_ms: now_ms(),
        }
    }

    fn deadline(self, duration: Duration) -> RequestDeadline {
        RequestDeadline {
            instant: self.started + duration,
            expires_at: self.started_ms.saturating_add(duration.as_millis() as u64),
        }
    }
}

#[derive(Clone, Copy)]
struct RequestDeadline {
    instant: Instant,
    expires_at: u64,
}

impl Shared {
    fn notify_cancelled(&self, request_id: String, pending: &PendingRequest) {
        if pending.generation && !pending.claimed {
            let _ = (self.emit_cancellation)(BridgeCancellation {
                request_id,
                source: pending.source,
                service_id: self.info.service_id.clone(),
            });
        }
    }

    fn cancel(&self) {
        let cancelled: Vec<_> = {
            let mut pending = self.pending.lock().unwrap();
            self.active.store(false, Ordering::SeqCst);
            pending.drain().collect()
        };
        for (id, pending) in cancelled {
            self.notify_cancelled(id, &pending);
            let _ = pending.sender.send(Err(failure(503, "服务已关闭")));
        }
    }

    async fn call(
        self: &Arc<Self>,
        source: BridgeSource,
        method: &str,
        args: Value,
        deadline: RequestDeadline,
    ) -> Result<Value, BridgeError> {
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if !self.active.load(Ordering::SeqCst) {
                return Err(failure(503, "服务已关闭"));
            }
            if pending.len() >= MAX_PENDING {
                return Err(failure(429, "请求过多，请稍后重试"));
            }
            if Instant::now() >= deadline.instant {
                return Err(failure(504, "请求已过期"));
            }
            pending.insert(
                request_id.clone(),
                PendingRequest {
                    sender,
                    deadline: deadline.instant,
                    source,
                    generation: method == "generate_schedule",
                    claimed: false,
                },
            );
        }
        // Dropping a timed-out/disconnected request removes it, even if the UI never responds.
        let _guard = PendingGuard {
            shared: self.clone(),
            id: request_id.clone(),
        };
        (self.emit)(BridgeRequest {
            request_id: request_id.clone(),
            source,
            method: method.into(),
            args,
            expires_at: deadline.expires_at,
            service_id: self.info.service_id.clone(),
        })
        .map_err(|_| failure(503, "无法连接应用排班数据"))?;
        let mut receiver = receiver;
        let mut response = tokio::time::timeout_at(deadline.instant, &mut receiver).await;
        if response.is_err() {
            // A successful claim is the commit acceptance point. Give its
            // synchronous save a bounded chance to report its final outcome.
            let claimed = self
                .pending
                .lock()
                .unwrap()
                .get(&request_id)
                .is_some_and(|item| item.claimed);
            if claimed {
                response = tokio::time::timeout_at(
                    deadline.instant + COMMIT_RESPONSE_GRACE,
                    &mut receiver,
                )
                .await;
            }
        }
        match response {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(failure(503, "服务已关闭")),
            Err(_) => Err(failure(504, "应用响应超时，请确认排班窗口已打开")),
        }
    }
}

struct PendingGuard {
    shared: Arc<Shared>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        let pending = self.shared.pending.lock().unwrap().remove(&self.id);
        if let Some(pending) = pending {
            self.shared.notify_cancelled(self.id.clone(), &pending);
        }
    }
}

pub struct Server {
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl Server {
    pub async fn start(emit: EmitRequest, options: ServerOptions) -> Result<Self, io::Error> {
        Self::start_with_cancellation(emit, Arc::new(|_| Ok(())), options).await
    }

    pub async fn start_with_cancellation(
        emit: EmitRequest,
        emit_cancellation: EmitCancellation,
        options: ServerOptions,
    ) -> Result<Self, io::Error> {
        let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, options.port)).await {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && options.port != 0 => {
                TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?
            }
            Err(error) => return Err(error),
        };
        let address = listener.local_addr()?;
        let shared = Arc::new(Shared {
            service: options.service,
            info: ServerInfo {
                enabled: true,
                url: format!("http://127.0.0.1:{}", address.port()),
                // Two independently generated UUIDs provide 244 random bits.
                token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
                service_id: Uuid::new_v4().to_string(),
            },
            active: AtomicBool::new(true),
            emit,
            emit_cancellation,
            pending: Mutex::new(HashMap::new()),
            timeout: options.request_timeout,
            generation_overhead: options.generation_overhead,
        });
        let router = Router::new()
            .fallback(any(handle))
            .with_state(shared.clone());
        let (shutdown, mut stopping) = watch::channel(false);
        let running = shared.clone();
        let task = tokio::spawn(async move {
            let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = stopping.changed() => break,
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                        let service = TowerToHyperService::new(router.clone());
                        connections.spawn(async move {
                            let _permit = permit;
                            let mut builder = hyper::server::conn::http1::Builder::new();
                            builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10));
                            let _ = builder.serve_connection(TokioIo::new(stream), service).await;
                        });
                    }
                }
            }
            // Explicitly close the listener AND all keep-alive connections on disable.
            drop(listener);
            running.cancel();
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        Ok(Self {
            shared,
            shutdown,
            task: Some(task),
        })
    }

    pub fn info(&self) -> ServerInfo {
        let mut info = self.shared.info.clone();
        info.enabled = self.shared.active.load(Ordering::SeqCst);
        info
    }

    pub fn respond(&self, request_id: &str, response: BridgeResponse) -> Result<(), String> {
        let mut pending = self.shared.pending.lock().unwrap();
        if !self.shared.active.load(Ordering::SeqCst) {
            return Err("服务已关闭".into());
        }
        let pending_request = pending.remove(request_id).ok_or("请求已过期或已完成")?;
        drop(pending);
        let response_deadline = pending_request.deadline
            + if pending_request.claimed {
                COMMIT_RESPONSE_GRACE
            } else {
                Duration::ZERO
            };
        if Instant::now() >= response_deadline {
            self.shared
                .notify_cancelled(request_id.into(), &pending_request);
            let _ = pending_request.sender.send(Err(failure(504, "请求已过期")));
            return Err("请求已过期".into());
        }
        let result = if let Some(error) = response.error {
            Err(error)
        } else {
            Ok(response.result.unwrap_or(Value::Null))
        };
        pending_request
            .sender
            .send(result)
            .map_err(|_| "请求已过期或已取消".into())
    }

    /// Linearization point for a renderer-owned synchronous generated-schedule
    /// commit. Cancellation before this claim prevents accepting that commit.
    pub fn claim_request(&self, service_id: &str, request_id: &str) -> Result<(), String> {
        let mut pending = self.shared.pending.lock().unwrap();
        if !self.shared.active.load(Ordering::SeqCst) || self.shared.info.service_id != service_id {
            return Err("服务已关闭或连接已失效".into());
        }
        let request = pending.get_mut(request_id).ok_or("请求已过期或已取消")?;
        if request.sender.is_closed() || Instant::now() >= request.deadline {
            return Err("请求已过期或已取消".into());
        }
        if !request.generation || request.claimed {
            return Err("请求不可提交或已接受提交".into());
        }
        request.claimed = true;
        Ok(())
    }

    pub async fn stop(mut self) {
        self.shared.cancel();
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shared.cancel();
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn failure(status: u16, message: &str) -> BridgeError {
    BridgeError {
        status,
        message: message.into(),
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

fn error_response(error: BridgeError) -> Response {
    let status = StatusCode::from_u16(error.status)
        .ok()
        .filter(|status| status.is_client_error() || status.is_server_error())
        .unwrap_or(StatusCode::BAD_REQUEST);
    json_response(status, json!({"error": error.message}))
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    let Some(provided) = headers.get(header::AUTHORIZATION) else {
        return false;
    };
    let bytes = provided.as_bytes();
    if bytes.len() != expected.len() {
        return false;
    }
    bytes
        .iter()
        .zip(expected.as_bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn allowed_host(value: &str, port: u16) -> bool {
    value == format!("127.0.0.1:{port}") || value == format!("localhost:{port}")
}

fn allowed_origin(value: &str, port: u16) -> bool {
    matches!(
        value,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || value
        .strip_prefix("http://")
        .is_some_and(|host| allowed_host(host, port))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn handle(State(shared): State<Arc<Shared>>, request: Request) -> Response {
    let port = shared.info.url.rsplit(':').next().unwrap().parse().unwrap();
    let headers = request.headers();
    if !headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|host| allowed_host(host, port))
    {
        return error_response(failure(403, "Host forbidden"));
    }
    let origin = headers.get(header::ORIGIN).cloned();
    if origin.as_ref().is_some_and(|v| {
        !v.to_str()
            .ok()
            .is_some_and(|origin| allowed_origin(origin, port))
    }) {
        return error_response(failure(403, "Origin forbidden"));
    }
    let mut response = if !shared.service.supports_path(request.uri().path()) {
        // Route isolation also applies to unauthenticated requests and preflight:
        // credentials for this listener never expose the other protocol.
        error_response(failure(404, "Not found"))
    } else if request.method() == Method::OPTIONS {
        // Browser preflight carries no Bearer token and never accesses planner data.
        StatusCode::NO_CONTENT.into_response()
    } else if !authorized(headers, &shared.info.token) {
        error_response(failure(401, "访问令牌无效"))
    } else if !shared.active.load(Ordering::SeqCst) {
        error_response(failure(503, "服务已关闭"))
    } else {
        route(shared.clone(), request, RequestTiming::new()).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, PUT, POST, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Authorization, Content-Type, MCP-Protocol-Version"),
        );
    }
    response
}

async fn route(shared: Arc<Shared>, request: Request, timing: RequestTiming) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    if !shared.service.supports_path(&path) {
        return error_response(failure(404, "Not found"));
    }
    if path == "/mcp"
        && request
            .headers()
            .get("mcp-protocol-version")
            .is_some_and(|version| !version.to_str().ok().is_some_and(supported_protocol))
    {
        return error_response(failure(400, "Unsupported MCP protocol version"));
    }
    if path == "/api/state" && method == Method::GET {
        return dispatch_http(&shared, "get_state", json!({}), timing).await;
    }
    if path == "/api/validate" && method == Method::GET {
        return dispatch_http(&shared, "validate_schedule", json!({}), timing).await;
    }
    if path == "/mcp" && method != Method::POST {
        let mut response = error_response(failure(405, "Stateless MCP: use POST"));
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("POST"));
        return response;
    }
    if !((path == "/mcp" && method == Method::POST)
        || (path == "/api/state" && method == Method::PUT)
        || (path == "/api/assignments" && method == Method::POST)
        || (path == "/api/schedules/generate" && method == Method::POST))
    {
        return error_response(failure(404, "Not found"));
    }
    // Even long generation requests must deliver their body within the normal
    // request budget. Only a parsed, valid generate call gets extra solve time.
    let bytes = match tokio::time::timeout_at(
        timing.deadline(shared.timeout).instant,
        to_bytes(request.into_body(), MAX_BODY_BYTES),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return error_response(failure(413, "请求超过大小限制或无法读取")),
        Err(_) => return error_response(failure(504, "请求正文读取超时")),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) if path == "/mcp" => return invalid_rpc(-32700, "Parse error"),
        Err(_) => return error_response(failure(400, "无效 JSON")),
    };
    if path == "/mcp" {
        return mcp(shared, body, timing).await;
    }
    if !body.is_object() {
        return error_response(failure(400, "请求必须为对象"));
    }
    dispatch_http(
        &shared,
        if path == "/api/state" {
            "replace_state"
        } else if path == "/api/schedules/generate" {
            "generate_schedule"
        } else {
            "set_assignment"
        },
        body,
        timing,
    )
    .await
}

async fn dispatch_http(
    shared: &Arc<Shared>,
    method: &str,
    args: Value,
    timing: RequestTiming,
) -> Response {
    let duration = match request_duration(shared, method, &args) {
        Ok(duration) => duration,
        Err(error) => return error_response(error),
    };
    match shared
        .call(BridgeSource::Http, method, args, timing.deadline(duration))
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => error_response(error),
    }
}

fn request_duration(shared: &Shared, method: &str, args: &Value) -> Result<Duration, BridgeError> {
    if method != "generate_schedule" {
        return Ok(shared.timeout);
    }
    let args = args
        .as_object()
        .ok_or_else(|| failure(400, "参数必须为对象"))?;
    if args
        .keys()
        .any(|key| !matches!(key.as_str(), "revision" | "month" | "timeLimitSeconds"))
    {
        return Err(failure(
            400,
            "生成排班仅接受 revision、month、timeLimitSeconds；不允许缺员选项",
        ));
    }
    if !args
        .get("revision")
        .and_then(Value::as_str)
        .is_some_and(|revision| !revision.is_empty())
    {
        return Err(failure(400, "缺少有效 revision，请先读取当前排班数据"));
    }
    if let Some(month) = args.get("month") {
        let valid = month.as_str().is_some_and(|month| {
            month.len() == 7
                && month.as_bytes()[4] == b'-'
                && month.as_bytes()[..4].iter().all(u8::is_ascii_digit)
                && month.as_bytes()[5..].iter().all(u8::is_ascii_digit)
                && month[..4]
                    .parse::<u16>()
                    .is_ok_and(|year| (1900..=2200).contains(&year))
                && month[5..]
                    .parse::<u8>()
                    .is_ok_and(|month| (1..=12).contains(&month))
        });
        if !valid {
            return Err(failure(400, "月份须为 YYYY-MM，年份范围为 1900–2200"));
        }
    }
    let seconds = match args.get("timeLimitSeconds") {
        None => 15.0,
        Some(value) => value
            .as_f64()
            .filter(|seconds| seconds.is_finite() && (1.0..=60.0).contains(seconds))
            .ok_or_else(|| failure(400, "timeLimitSeconds 须为 1–60 秒的数字"))?,
    };
    Ok(Duration::from_secs_f64(seconds) + shared.generation_overhead)
}

fn rpc_error(id: Value, code: i32, message: &str) -> Response {
    Json(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}))
        .into_response()
}

fn invalid_rpc(code: i32, message: &str) -> Response {
    let mut response = rpc_error(Value::Null, code, message);
    *response.status_mut() = StatusCode::BAD_REQUEST;
    response
}

fn supported_protocol(version: &str) -> bool {
    matches!(
        version,
        "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25"
    )
}

async fn mcp(shared: Arc<Shared>, body: Value, timing: RequestTiming) -> Response {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    if !body.is_object()
        || body.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !body.get("method").is_some_and(Value::is_string)
        || body
            .get("id")
            .is_some_and(|id| !(id.is_string() || id.is_number() || id.is_null()))
        || body.get("params").is_some_and(|params| !params.is_object())
    {
        return invalid_rpc(-32600, "Invalid Request");
    }
    if body.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let result = match body["method"].as_str().unwrap() {
        "initialize" => {
            let version = body["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = if supported_protocol(version) {
                version
            } else {
                "2025-03-26"
            };
            json!({"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "shift-schedule-expert", "version": env!("CARGO_PKG_VERSION")}, "instructions": "Read get_state before writing. All writes and generate_schedule require its current revision. Changes are saved directly in the open application. MCP and HTTP share the write permissions in desktop Setting; by default only members may be changed. Generating requires assignment write permission and uses the built-in solver with complete coverage, preserving locked assignments and other months. Allow at least timeLimitSeconds + 155 seconds for generation, including startup and response delivery. Disallowed writes return MCP tool errors or HTTP 403. Read-only fields must remain unchanged."})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": tool_definitions()}),
        "tools/call" => {
            let Some(name) = body["params"]["name"].as_str() else {
                return rpc_error(id, -32602, "Missing tool name");
            };
            if !matches!(
                name,
                "get_state"
                    | "replace_state"
                    | "set_assignment"
                    | "validate_schedule"
                    | "generate_schedule"
            ) {
                return rpc_error(id, -32602, "Unknown tool");
            }
            let args = body["params"]
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if !args.is_object() {
                return rpc_error(id, -32602, "Tool arguments must be an object");
            }
            let duration = match request_duration(&shared, name, &args) {
                Ok(duration) => duration,
                Err(error) => return rpc_error(id, -32602, &error.message),
            };
            match shared
                .call(BridgeSource::Mcp, name, args, timing.deadline(duration))
                .await
            {
                Ok(result) => json!({"content": [{"type": "text", "text": result.to_string()}]}),
                Err(error) => {
                    json!({"isError": true, "content": [{"type": "text", "text": error.message}]})
                }
            }
        }
        _ => return rpc_error(id, -32601, "Method not found"),
    };
    Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
}

fn tool_definitions() -> Value {
    let revision = json!({"type": "string", "description": "Current revision returned by get_state. Stale writes are rejected."});
    json!([
        {"name": "get_state", "description": "Read all members, shifts, rules, assignments and the current revision.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}},
        {"name": "validate_schedule", "description": "Check current schedule for rule violations without changing it.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}},
        {"name": "replace_state", "description": "Replace the complete planner document. Read first and preserve unchanged fields. All data is validated before saving. Only types allowed for MCP in desktop Setting may change; by default only members are allowed. Changes to a forbidden type return a tool error.", "inputSchema": {"type": "object", "properties": {"revision": revision, "state": {"type": "object", "additionalProperties": true}}, "required": ["revision", "state"], "additionalProperties": false}},
        {"name": "set_assignment", "description": "Set one employee/date assignment. shiftId:off means rest; remove:true deletes. Locked assignments require unlock:true. Requires permission to modify assignments for MCP in desktop Setting; by default only members are allowed, so this tool returns a tool error until assignment changes are enabled.", "inputSchema": {"type": "object", "properties": {"revision": revision, "employeeId": {"type": "string"}, "date": {"type": "string"}, "shiftId": {"type": "string"}, "locked": {"type": "boolean"}, "remove": {"type": "boolean"}, "unlock": {"type": "boolean"}}, "required": ["revision", "employeeId", "date"], "additionalProperties": false}},
        {"name": "generate_schedule", "description": "Generate and save a complete monthly schedule using the built-in solver and current configuration. Requires assignment write permission and the latest revision. Preserves locked assignments and all other months; month defaults to the application's active month. No partial coverage option. A completed solve with no valid feasible result returns success:false, saved:false and diagnostic issues without changing data. Transport, permission and lifecycle failures return tool errors. Allow timeLimitSeconds + 155 seconds for startup, solving and response delivery.", "inputSchema": {"type": "object", "properties": {"revision": revision, "month": {"type": "string", "pattern": "^(19[0-9]{2}|20[0-9]{2}|21[0-9]{2}|2200)-(0[1-9]|1[0-2])$", "description": "Optional YYYY-MM from 1900-01 through 2200-12; defaults to the active month."}, "timeLimitSeconds": {"type": "number", "minimum": 1, "maximum": 60, "default": 15, "description": "Solver time budget; startup is budgeted separately."}}, "required": ["revision"], "additionalProperties": false}}
    ])
}
