//! Desktop-owned lifecycle for the embedded MCP/HTTP transport.
use shift_integration_server::{BridgeResponse, Server, ServerInfo, ServerOptions};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

#[derive(Clone, Default)]
pub struct IntegrationRuntime {
    server: Arc<Mutex<Option<Server>>>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    closing: Arc<AtomicBool>,
}

impl IntegrationRuntime {
    pub fn force_shutdown(&self) {
        // Synchronous exit cleanup must also handle an in-flight start command.
        self.closing.store(true, Ordering::SeqCst);
        self.server.lock().unwrap().take();
    }

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
        Err("仅主窗口可以管理 MCP 服务".into())
    }
}

#[tauri::command]
pub async fn integration_start(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, IntegrationRuntime>,
) -> Result<ServerInfo, String> {
    require_main(&window)?;
    let _operation = runtime.lifecycle.lock().await;
    if runtime.closing.load(Ordering::SeqCst) {
        return Err("应用正在关闭".into());
    }
    let existing = runtime.info();
    if existing.enabled {
        return Ok(existing);
    }
    let server = Server::start(
        Arc::new(move |request| {
            app.emit_to("main", "integration-request", request)
                .map_err(|error| error.to_string())
        }),
        ServerOptions::default(),
    )
    .await
    .map_err(|error| format!("无法开启 MCP 服务：{error}"))?;
    let mut running = runtime.server.lock().unwrap();
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
) -> Result<ServerInfo, String> {
    require_main(&window)?;
    let _operation = runtime.lifecycle.lock().await;
    let server = runtime.server.lock().unwrap().take();
    if let Some(server) = server {
        server.stop().await;
    }
    Ok(ServerInfo::default())
}

#[tauri::command]
pub fn integration_status(
    window: WebviewWindow,
    runtime: State<'_, IntegrationRuntime>,
) -> Result<ServerInfo, String> {
    require_main(&window)?;
    Ok(runtime.info())
}

#[tauri::command]
pub fn integration_respond(
    window: WebviewWindow,
    runtime: State<'_, IntegrationRuntime>,
    request_id: String,
    response: BridgeResponse,
) -> Result<(), String> {
    require_main(&window)?;
    runtime
        .server
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("MCP 服务已关闭")?
        .respond(&request_id, response)
}
