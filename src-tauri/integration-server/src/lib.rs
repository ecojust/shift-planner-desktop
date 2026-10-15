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
};
use uuid::Uuid;

const MAX_BODY_BYTES: usize = 8 * 1024 * 1024 + 65536;
const MAX_PENDING: usize = 64;
const MAX_CONNECTIONS: usize = 128;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub enabled: bool,
    pub url: String,
    pub token: String,
    pub service_id: String,
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

pub struct ServerOptions {
    pub port: u16,
    pub request_timeout: Duration,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            port: 4318,
            request_timeout: Duration::from_secs(15),
        }
    }
}

struct Shared {
    info: ServerInfo,
    active: AtomicBool,
    emit: EmitRequest,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, BridgeError>>>>,
    timeout: Duration,
}

impl Shared {
    fn cancel(&self) {
        self.active.store(false, Ordering::SeqCst);
        for (_, pending) in self.pending.lock().unwrap().drain() {
            let _ = pending.send(Err(failure(503, "MCP 服务已关闭")));
        }
    }

    async fn call(
        self: &Arc<Self>,
        source: BridgeSource,
        method: &str,
        args: Value,
        expires_at: u64,
    ) -> Result<Value, BridgeError> {
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if !self.active.load(Ordering::SeqCst) {
                return Err(failure(503, "MCP 服务已关闭"));
            }
            if pending.len() >= MAX_PENDING {
                return Err(failure(429, "请求过多，请稍后重试"));
            }
            pending.insert(request_id.clone(), sender);
        }
        // Dropping a timed-out/disconnected request removes it, even if the UI never responds.
        let _guard = PendingGuard {
            shared: self.clone(),
            id: request_id.clone(),
        };
        (self.emit)(BridgeRequest {
            request_id,
            source,
            method: method.into(),
            args,
            expires_at,
            service_id: self.info.service_id.clone(),
        })
        .map_err(|_| failure(503, "无法连接应用排班数据"))?;
        match tokio::time::timeout(
            Duration::from_millis(expires_at.saturating_sub(now_ms())),
            receiver,
        )
        .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(failure(503, "MCP 服务已关闭")),
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
        self.shared.pending.lock().unwrap().remove(&self.id);
    }
}

pub struct Server {
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl Server {
    pub async fn start(emit: EmitRequest, options: ServerOptions) -> Result<Self, io::Error> {
        let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, options.port)).await {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && options.port != 0 => {
                TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?
            }
            Err(error) => return Err(error),
        };
        let address = listener.local_addr()?;
        let shared = Arc::new(Shared {
            info: ServerInfo {
                enabled: true,
                url: format!("http://127.0.0.1:{}", address.port()),
                // Two independently generated UUIDs provide 244 random bits.
                token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
                service_id: Uuid::new_v4().to_string(),
            },
            active: AtomicBool::new(true),
            emit,
            pending: Mutex::new(HashMap::new()),
            timeout: options.request_timeout,
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
            return Err("MCP 服务已关闭".into());
        }
        let sender = pending.remove(request_id).ok_or("请求已过期或已完成")?;
        let result = if let Some(error) = response.error {
            Err(error)
        } else {
            Ok(response.result.unwrap_or(Value::Null))
        };
        sender.send(result).map_err(|_| "请求已过期或已取消".into())
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
    let mut response = if request.method() == Method::OPTIONS {
        // Browser preflight carries no Bearer token and never accesses planner data.
        StatusCode::NO_CONTENT.into_response()
    } else if !authorized(headers, &shared.info.token) {
        error_response(failure(401, "访问令牌无效"))
    } else if !shared.active.load(Ordering::SeqCst) {
        error_response(failure(503, "MCP 服务已关闭"))
    } else {
        let expires_at = now_ms().saturating_add(shared.timeout.as_millis() as u64);
        match tokio::time::timeout(shared.timeout, route(shared.clone(), request, expires_at)).await
        {
            Ok(response) => response,
            Err(_) => error_response(failure(504, "请求超时")),
        }
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

async fn route(shared: Arc<Shared>, request: Request, expires_at: u64) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    if path == "/mcp"
        && request
            .headers()
            .get("mcp-protocol-version")
            .is_some_and(|version| !version.to_str().ok().is_some_and(supported_protocol))
    {
        return error_response(failure(400, "Unsupported MCP protocol version"));
    }
    if path == "/api/state" && method == Method::GET {
        return dispatch_http(&shared, "get_state", json!({}), expires_at).await;
    }
    if path == "/api/validate" && method == Method::GET {
        return dispatch_http(&shared, "validate_schedule", json!({}), expires_at).await;
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
        || (path == "/api/assignments" && method == Method::POST))
    {
        return error_response(failure(404, "Not found"));
    }
    let bytes = match to_bytes(request.into_body(), MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return error_response(failure(413, "请求超过大小限制或无法读取")),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) if path == "/mcp" => return invalid_rpc(-32700, "Parse error"),
        Err(_) => return error_response(failure(400, "无效 JSON")),
    };
    if path == "/mcp" {
        return mcp(shared, body, expires_at).await;
    }
    if !body.is_object() {
        return error_response(failure(400, "请求必须为对象"));
    }
    dispatch_http(
        &shared,
        if path == "/api/state" {
            "replace_state"
        } else {
            "set_assignment"
        },
        body,
        expires_at,
    )
    .await
}

async fn dispatch_http(
    shared: &Arc<Shared>,
    method: &str,
    args: Value,
    expires_at: u64,
) -> Response {
    match shared
        .call(BridgeSource::Http, method, args, expires_at)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => error_response(error),
    }
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

async fn mcp(shared: Arc<Shared>, body: Value, expires_at: u64) -> Response {
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
            json!({"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "shift-schedule-expert", "version": env!("CARGO_PKG_VERSION")}, "instructions": "Read get_state before writing. All writes require its current revision. Changes are saved directly in the open application. MCP and HTTP share the write permissions in desktop Setting; by default only members may be changed. Disallowed writes return MCP tool errors or HTTP 403. Read-only fields must remain unchanged."})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": tool_definitions()}),
        "tools/call" => {
            let Some(name) = body["params"]["name"].as_str() else {
                return rpc_error(id, -32602, "Missing tool name");
            };
            if !matches!(
                name,
                "get_state" | "replace_state" | "set_assignment" | "validate_schedule"
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
            match shared.call(BridgeSource::Mcp, name, args, expires_at).await {
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
        {"name": "set_assignment", "description": "Set one employee/date assignment. shiftId:off means rest; remove:true deletes. Locked assignments require unlock:true. Requires permission to modify assignments for MCP in desktop Setting; by default only members are allowed, so this tool returns a tool error until assignment changes are enabled.", "inputSchema": {"type": "object", "properties": {"revision": revision, "employeeId": {"type": "string"}, "date": {"type": "string"}, "shiftId": {"type": "string"}, "locked": {"type": "boolean"}, "remove": {"type": "boolean"}, "unlock": {"type": "boolean"}}, "required": ["revision", "employeeId", "date"], "additionalProperties": false}}
    ])
}
