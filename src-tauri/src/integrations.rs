//! Desktop-owned lifecycle for the embedded MCP/HTTP transport.
use shift_integration_server::{BridgeResponse, Server, ServerInfo, ServerOptions, Service};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

#[derive(Clone, Default)]
pub struct IntegrationRuntime {
    mcp: Arc<ServiceRuntime>,
    http: Arc<ServiceRuntime>,
    closing: Arc<AtomicBool>,
}

#[derive(Default)]
struct ServiceRuntime {
    server: Mutex<Option<Server>>,
    lifecycle: tokio::sync::Mutex<()>,
}

impl IntegrationRuntime {
    pub fn force_shutdown(&self) {
        // Synchronous exit cleanup must also handle an in-flight start command.
        self.closing.store(true, Ordering::SeqCst);
        self.mcp.server.lock().unwrap().take();
        self.http.server.lock().unwrap().take();
    }

    fn service(&self, service: Service) -> &ServiceRuntime {
        match service {
            Service::Mcp => &self.mcp,
            Service::Http => &self.http,
        }
    }
}

impl ServiceRuntime {
    fn info(&self) -> ServerInfo {
        self.server
            .lock()
            .unwrap()
            .as_ref()
            .map(Server::info)
            .unwrap_or_default()
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("仅主窗口可以管理 MCP / HTTP 服务".into())
    }
}

#[tauri::command]
pub async fn integration_start(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, IntegrationRuntime>,
    service: Service,
) -> Result<ServerInfo, String> {
    require_main(&window)?;
    let selected = runtime.service(service);
    let _operation = selected.lifecycle.lock().await;
    if runtime.closing.load(Ordering::SeqCst) {
        return Err("应用正在关闭".into());
    }
    let existing = selected.info();
    if existing.enabled {
        return Ok(existing);
    }
    let cancellation_app = app.clone();
    let server = Server::start_with_cancellation(
        Arc::new(move |request| {
            // Preserve the route-owned source alongside the untrusted client arguments.
            app.emit_to("main", "integration-request", request)
                .map_err(|error| error.to_string())
        }),
        Arc::new(move |cancellation| {
            cancellation_app
                .emit_to("main", "integration-cancelled", cancellation)
                .map_err(|error| error.to_string())
        }),
        ServerOptions::for_service(service),
    )
    .await
    .map_err(|error| format!("无法开启 {} 服务：{error}", service.label()))?;
    let mut running = selected.server.lock().unwrap();
    if runtime.closing.load(Ordering::SeqCst) {
        return Err("应用正在关闭".into());
    }
    let info = server.info();
    *running = Some(server);
    Ok(info)
}

#[tauri::command]
pub async fn integration_stop(
    window: WebviewWindow,
    runtime: State<'_, IntegrationRuntime>,
    service: Service,
) -> Result<ServerInfo, String> {
    require_main(&window)?;
    let selected = runtime.service(service);
    let _operation = selected.lifecycle.lock().await;
    let server = selected.server.lock().unwrap().take();
    if let Some(server) = server {
        server.stop().await;
    }
    Ok(ServerInfo::default())
}

#[tauri::command]
pub fn integration_status(
    window: WebviewWindow,
    runtime: State<'_, IntegrationRuntime>,
    service: Service,
) -> Result<ServerInfo, String> {
    require_main(&window)?;
    Ok(runtime.service(service).info())
}

#[tauri::command]
pub fn integration_respond(
    window: WebviewWindow,
    runtime: State<'_, IntegrationRuntime>,
    service: Service,
    request_id: String,
    response: BridgeResponse,
) -> Result<(), String> {
    require_main(&window)?;
    runtime
        .service(service)
        .server
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("服务已关闭")?
        .respond(&request_id, response)
}

#[tauri::command]
pub fn integration_claim_request(
    window: WebviewWindow,
    runtime: State<'_, IntegrationRuntime>,
    service: Service,
    service_id: String,
    request_id: String,
) -> Result<(), String> {
    require_main(&window)?;
    runtime
        .service(service)
        .server
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("服务已关闭")?
        .claim_request(&service_id, &request_id)
}
