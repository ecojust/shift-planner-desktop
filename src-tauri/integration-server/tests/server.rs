use reqwest::{Client, RequestBuilder};
use serde_json::{json, Value};
use shift_integration_server::{
    BridgeError, BridgeRequest, BridgeResponse, BridgeSource, Server, ServerOptions, Service,
};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpListener, sync::mpsc, task::JoinHandle};

struct Fixture {
    server: Server,
    events: mpsc::UnboundedReceiver<BridgeRequest>,
    client: Client,
}

impl Fixture {
    async fn new(service: Service, timeout: Duration) -> Self {
        Self::on_port(service, 0, timeout).await
    }

    async fn on_port(service: Service, port: u16, timeout: Duration) -> Self {
        let (sender, events) = mpsc::unbounded_channel();
        let server = Server::start(
            Arc::new(move |event| sender.send(event).map_err(|error| error.to_string())),
            ServerOptions {
                service,
                port,
                request_timeout: timeout,
            },
        )
        .await
        .unwrap();
        Self {
            server,
            events,
            client: Client::builder().no_proxy().build().unwrap(),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> RequestBuilder {
        let info = self.server.info();
        self.client
            .request(method, format!("{}{path}", info.url))
            .bearer_auth(info.token)
    }

    fn read_request(&self, service: Service) -> RequestBuilder {
        self.read_request_with_token(service, &self.server.info().token)
    }

    fn read_request_with_token(&self, service: Service, token: &str) -> RequestBuilder {
        let url = self.server.info().url;
        match service {
            Service::Http => self.client.get(format!("{url}/api/state")),
            Service::Mcp => self.client.post(format!("{url}/mcp")).json(&json!({
                "jsonrpc": "2.0", "id": "read", "method": "tools/call",
                "params": {"name": "get_state"}
            })),
        }
        .bearer_auth(token)
    }

    async fn event(&mut self) -> BridgeRequest {
        tokio::time::timeout(Duration::from_secs(2), self.events.recv())
            .await
            .unwrap()
            .unwrap()
    }

    fn respond(&self, id: &str, value: Value) {
        self.server
            .respond(
                id,
                BridgeResponse {
                    result: Some(value),
                    error: None,
                },
            )
            .unwrap();
    }
}

fn send(request: RequestBuilder) -> JoinHandle<Result<reqwest::Response, reqwest::Error>> {
    tokio::spawn(async move { request.send().await })
}

#[tokio::test]
async fn http_forwards_current_data_reads_writes_and_validation() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(5)).await;
    for (verb, path, method, args) in [
        (reqwest::Method::GET, "/api/state", "get_state", json!({})),
        (
            reqwest::Method::PUT,
            "/api/state",
            "replace_state",
            json!({"revision": "r1", "state": {"employees": []}}),
        ),
        (
            reqwest::Method::POST,
            "/api/assignments",
            "set_assignment",
            json!({"revision": "r2", "employeeId": "alice", "date": "2026-10-15", "shiftId": "off"}),
        ),
        (
            reqwest::Method::GET,
            "/api/validate",
            "validate_schedule",
            json!({}),
        ),
    ] {
        let pending = send(fixture.request(verb, path).json(&args));
        let event = fixture.event().await;
        assert_eq!(event.source, BridgeSource::Http);
        assert_eq!(serde_json::to_value(&event).unwrap()["source"], "http");
        assert_eq!(event.method, method);
        assert_eq!(event.args, args);
        assert_eq!(event.service_id, fixture.server.info().service_id);
        assert!(
            event.expires_at
                > SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
        );
        let result = json!({"revision": "updated", "operation": method});
        fixture.respond(&event.request_id, result.clone());
        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.json::<Value>().await.unwrap(), result);
    }
    fixture.server.stop().await;
}

#[tokio::test]
async fn http_source_cannot_be_forged_through_body_query_or_headers() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(5)).await;
    for (verb, path, method) in [
        (reqwest::Method::PUT, "/api/state", "replace_state"),
        (reqwest::Method::POST, "/api/assignments", "set_assignment"),
    ] {
        let args = json!({
            "revision": "r1", "source": "mcp", "args": {"source": "mcp"},
            "state": {"employees": []}, "employeeId": "alice",
            "date": "2026-10-15", "shiftId": "off"
        });
        let pending = send(
            fixture
                .request(verb, &format!("{path}?source=mcp"))
                .header("source", "mcp")
                .header("x-integration-source", "mcp")
                .json(&args),
        );
        let event = fixture.event().await;
        assert_eq!(event.source, BridgeSource::Http);
        assert_eq!(event.method, method);
        assert_eq!(event.args, args);
        let serialized = serde_json::to_value(&event).unwrap();
        assert_eq!(serialized["source"], "http");
        assert_eq!(serialized["args"]["source"], "mcp");
        fixture.respond(&event.request_id, json!({"revision": "r2"}));
        assert_eq!(pending.await.unwrap().unwrap().status(), 200);
    }
    fixture.server.stop().await;
}

#[tokio::test]
async fn mcp_source_cannot_be_forged_through_arguments_envelope_query_or_headers() {
    let mut fixture = Fixture::new(Service::Mcp, Duration::from_secs(5)).await;
    for method in [
        "get_state",
        "validate_schedule",
        "replace_state",
        "set_assignment",
    ] {
        let args = json!({"revision": "r1", "source": "http", "args": {"source": "http"}});
        let pending = send(
            fixture
                .request(reqwest::Method::POST, "/mcp?source=http")
                .header("source", "http")
                .header("x-integration-source", "http")
                .json(&json!({
                    "jsonrpc": "2.0", "id": method, "method": "tools/call", "source": "http",
                    "params": {"name": method, "source": "http", "arguments": args}
                })),
        );
        let event = fixture.event().await;
        assert_eq!(event.source, BridgeSource::Mcp);
        assert_eq!(event.method, method);
        assert_eq!(event.args, args);
        let serialized = serde_json::to_value(&event).unwrap();
        assert_eq!(serialized["source"], "mcp");
        assert_eq!(serialized["args"]["source"], "http");
        fixture.respond(&event.request_id, json!({"revision": "r2"}));
        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.json::<Value>().await.unwrap()["id"], method);
    }
    fixture.server.stop().await;
}

#[tokio::test]
async fn permission_denials_return_http_403_and_mcp_tool_errors() {
    let message = "Setting 未允许修改排班";
    for (service, source) in [
        (Service::Http, BridgeSource::Http),
        (Service::Mcp, BridgeSource::Mcp),
    ] {
        let mut fixture = Fixture::new(service, Duration::from_secs(5)).await;
        let args = json!({"revision": "r1", "employeeId": "alice", "date": "2026-10-15", "shiftId": "off"});
        let request = match source {
            BridgeSource::Http => fixture
                .request(reqwest::Method::POST, "/api/assignments")
                .json(&args),
            BridgeSource::Mcp => fixture.request(reqwest::Method::POST, "/mcp").json(&json!({
                "jsonrpc": "2.0", "id": "denied", "method": "tools/call",
                "params": {"name": "set_assignment", "arguments": args}
            })),
        };
        let pending = send(request);
        let event = fixture.event().await;
        assert_eq!(event.source, source);
        fixture
            .server
            .respond(
                &event.request_id,
                BridgeResponse {
                    result: None,
                    error: Some(BridgeError {
                        status: 403,
                        message: message.into(),
                    }),
                },
            )
            .unwrap();
        let response = pending.await.unwrap().unwrap();
        match source {
            BridgeSource::Http => {
                assert_eq!(response.status(), 403);
                assert_eq!(response.json::<Value>().await.unwrap()["error"], message);
            }
            BridgeSource::Mcp => {
                assert_eq!(response.status(), 200);
                let body = response.json::<Value>().await.unwrap();
                assert_eq!(body["id"], "denied");
                assert_eq!(body["result"]["isError"], true);
                assert_eq!(body["result"]["content"][0]["text"], message);
                assert!(body.get("error").is_none());
            }
        }
        fixture.server.stop().await;
    }
}

#[tokio::test]
async fn authentication_and_dns_rebinding_checks_precede_data_access() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(5)).await;
    let url = format!("{}/api/state", fixture.server.info().url);
    assert_eq!(fixture.client.get(&url).send().await.unwrap().status(), 401);
    assert_eq!(
        fixture
            .client
            .get(&url)
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        fixture
            .request(reqwest::Method::GET, "/api/state")
            .header("Host", "attacker.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        fixture
            .request(reqwest::Method::GET, "/api/state")
            .header("Host", "127.0.0.1:1")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        fixture
            .request(reqwest::Method::GET, "/api/state")
            .header("Origin", "https://attacker.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        fixture
            .request(reqwest::Method::GET, "/api/state")
            .header("Origin", "null")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let response = fixture
        .client
        .request(reqwest::Method::OPTIONS, &url)
        .header("Origin", "tauri://localhost")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "tauri://localhost"
    );
    assert!(fixture.events.try_recv().is_err());
}

#[tokio::test]
async fn mcp_initialization_tools_notifications_and_errors_are_protocol_compatible() {
    let mut fixture = Fixture::new(Service::Mcp, Duration::from_secs(5)).await;
    let init = fixture.request(reqwest::Method::POST, "/mcp").json(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})).send().await.unwrap().json::<Value>().await.unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["capabilities"], json!({"tools": {}}));
    let list = fixture
        .request(reqwest::Method::POST, "/mcp")
        .json(&json!({"jsonrpc": "2.0", "id": "tools", "method": "tools/list"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 4);
    assert_eq!(list["id"], "tools");
    assert_eq!(
        list["result"]["tools"][2]["inputSchema"]["required"],
        json!(["revision", "state"])
    );
    let notification = fixture.request(reqwest::Method::POST, "/mcp").json(&json!({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "replace_state", "arguments": {}}})).send().await.unwrap();
    assert_eq!(notification.status(), 202);
    assert!(fixture.events.try_recv().is_err());
    for (request, code) in [
        (
            json!({"jsonrpc": "2.0", "id": 2, "method": "unknown"}),
            -32601,
        ),
        (
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "unknown"}}),
            -32602,
        ),
        (
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "get_state", "arguments": []}}),
            -32602,
        ),
        (json!([]), -32600),
    ] {
        let response = fixture
            .request(reqwest::Method::POST, "/mcp")
            .json(&request)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], code);
    }
    let malformed = fixture
        .request(reqwest::Method::POST, "/mcp")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), 400);
    assert_eq!(
        malformed.json::<Value>().await.unwrap()["error"]["code"],
        -32700
    );
    let unsupported = fixture
        .request(reqwest::Method::POST, "/mcp")
        .header("MCP-Protocol-Version", "2099-01-01")
        .json(&json!({"jsonrpc": "2.0", "id": 10, "method": "ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unsupported.status(), 400);
    assert_eq!(
        fixture
            .request(reqwest::Method::GET, "/mcp")
            .send()
            .await
            .unwrap()
            .status(),
        405
    );
    assert_eq!(
        fixture
            .request(reqwest::Method::DELETE, "/mcp")
            .send()
            .await
            .unwrap()
            .status(),
        405
    );
}

#[tokio::test]
async fn mcp_tools_return_data_and_business_errors_without_losing_rpc_id() {
    let mut fixture = Fixture::new(Service::Mcp, Duration::from_secs(5)).await;
    let pending = send(fixture.request(reqwest::Method::POST, "/mcp").json(&json!({"jsonrpc": "2.0", "id": "read", "method": "tools/call", "params": {"name": "get_state"}})));
    let event = fixture.event().await;
    assert_eq!(event.source, BridgeSource::Mcp);
    assert_eq!(serde_json::to_value(&event).unwrap()["source"], "mcp");
    assert_eq!(event.method, "get_state");
    fixture.respond(
        &event.request_id,
        json!({"revision": "r1", "state": {"employees": []}}),
    );
    let response = pending
        .await
        .unwrap()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(response["id"], "read");
    assert_eq!(
        serde_json::from_str::<Value>(response["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap()["revision"],
        "r1"
    );
    let pending = send(fixture.request(reqwest::Method::POST, "/mcp").json(&json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "set_assignment", "arguments": {"revision": "old"}}})));
    let event = fixture.event().await;
    fixture
        .server
        .respond(
            &event.request_id,
            BridgeResponse {
                result: None,
                error: Some(BridgeError {
                    status: 409,
                    message: "版本冲突".into(),
                }),
            },
        )
        .unwrap();
    let response = pending
        .await
        .unwrap()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(response["id"], 9);
    assert_eq!(response["result"]["isError"], true);
    assert_eq!(response["result"]["content"][0]["text"], "版本冲突");
}

#[tokio::test]
async fn http_preserves_conflicts_and_rejects_duplicate_responses() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(5)).await;
    let pending = send(
        fixture
            .request(reqwest::Method::PUT, "/api/state")
            .json(&json!({"revision": "old"})),
    );
    let event = fixture.event().await;
    fixture
        .server
        .respond(
            &event.request_id,
            BridgeResponse {
                result: None,
                error: Some(BridgeError {
                    status: 409,
                    message: "版本冲突".into(),
                }),
            },
        )
        .unwrap();
    let response = pending.await.unwrap().unwrap();
    assert_eq!(response.status(), 409);
    assert_eq!(response.json::<Value>().await.unwrap()["error"], "版本冲突");
    assert!(fixture
        .server
        .respond(
            &event.request_id,
            BridgeResponse {
                result: Some(json!({})),
                error: None
            }
        )
        .is_err());
}

#[tokio::test]
async fn timed_out_requests_are_removed_and_late_responses_rejected() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_millis(80)).await;
    let pending = send(fixture.request(reqwest::Method::GET, "/api/state"));
    let event = fixture.event().await;
    assert_eq!(pending.await.unwrap().unwrap().status(), 504);
    assert!(fixture
        .server
        .respond(
            &event.request_id,
            BridgeResponse {
                result: Some(json!({})),
                error: None
            }
        )
        .is_err());
    // The timeout frees pending capacity; subsequent requests still reach the renderer.
    let pending = send(fixture.request(reqwest::Method::GET, "/api/state"));
    let event = fixture.event().await;
    fixture.respond(&event.request_id, json!({"revision": "fresh"}));
    assert_eq!(pending.await.unwrap().unwrap().status(), 200);
}

#[tokio::test]
async fn shutdown_closes_listener_and_pending_connections_and_rotates_credentials() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(30)).await;
    let original = fixture.server.info();
    let pending = send(fixture.request(reqwest::Method::GET, "/api/state"));
    fixture.event().await;
    tokio::time::timeout(Duration::from_secs(1), fixture.server.stop())
        .await
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .is_ok());
    assert!(fixture
        .client
        .get(format!("{}/api/state", original.url))
        .send()
        .await
        .is_err());
    let port = original.url.rsplit(':').next().unwrap().parse().unwrap();
    let replacement = Server::start(
        Arc::new(|_| Ok(())),
        ServerOptions {
            service: Service::Http,
            port,
            request_timeout: Duration::from_secs(1),
        },
    )
    .await
    .unwrap();
    assert_eq!(replacement.info().url, original.url);
    assert_ne!(replacement.info().token, original.token);
    assert_ne!(replacement.info().service_id, original.service_id);
    assert_eq!(
        fixture
            .client
            .get(format!("{}/api/state", replacement.info().url))
            .bearer_auth(original.token)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    replacement.stop().await;
}

#[tokio::test]
async fn occupied_port_falls_back_to_a_real_free_loopback_port() {
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = occupied.local_addr().unwrap().port();
    let server = Server::start(
        Arc::new(|_| Ok(())),
        ServerOptions {
            service: Service::Http,
            port,
            request_timeout: Duration::from_secs(1),
        },
    )
    .await
    .unwrap();
    assert_ne!(server.info().url, format!("http://127.0.0.1:{port}"));
    assert!(server.info().url.starts_with("http://127.0.0.1:"));
    server.stop().await;
}

#[tokio::test]
async fn pending_request_limit_rejects_excess_without_emitting_work() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(10)).await;
    let mut requests = Vec::new();
    let mut events = Vec::new();
    for _ in 0..64 {
        requests.push(send(fixture.request(reqwest::Method::GET, "/api/state")));
        events.push(fixture.event().await);
    }
    assert_eq!(
        fixture
            .request(reqwest::Method::GET, "/api/state")
            .send()
            .await
            .unwrap()
            .status(),
        429
    );
    assert!(fixture.events.try_recv().is_err());
    for event in events {
        fixture.respond(&event.request_id, json!({}));
    }
    for request in requests {
        assert_eq!(request.await.unwrap().unwrap().status(), 200);
    }
}

#[tokio::test]
async fn oversized_and_invalid_http_payloads_never_reach_renderer() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(5)).await;
    assert_eq!(
        fixture
            .request(reqwest::Method::PUT, "/api/state")
            .body("x".repeat(9 * 1024 * 1024))
            .send()
            .await
            .unwrap()
            .status(),
        413
    );
    assert_eq!(
        fixture
            .request(reqwest::Method::PUT, "/api/state")
            .body("{")
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        fixture
            .request(reqwest::Method::PUT, "/api/state")
            .json(&json!([]))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert!(fixture.events.try_recv().is_err());
}

#[tokio::test]
async fn unavailable_renderer_returns_service_unavailable() {
    let server = Server::start(
        Arc::new(|_| Err("closed".into())),
        ServerOptions {
            service: Service::Http,
            port: 0,
            request_timeout: Duration::from_secs(1),
        },
    )
    .await
    .unwrap();
    let info = server.info();
    let response = Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{}/api/state", info.url))
        .bearer_auth(info.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    server.stop().await;
}

#[test]
fn service_selection_has_independent_default_ports_and_lowercase_serialization() {
    assert_eq!(ServerOptions::default().service, Service::Mcp);
    for (service, name, port) in [(Service::Mcp, "mcp", 4318), (Service::Http, "http", 4319)] {
        let options = ServerOptions::for_service(service);
        assert_eq!(options.service, service);
        assert_eq!(options.port, port);
        assert_eq!(serde_json::to_value(service).unwrap(), name);
        assert_eq!(
            serde_json::from_value::<Service>(json!(name)).unwrap(),
            service
        );
    }
    assert!(serde_json::from_value::<Service>(json!("other")).is_err());
}

#[tokio::test]
async fn simultaneous_services_have_independent_addresses_credentials_and_pending_requests() {
    let mut mcp = Fixture::new(Service::Mcp, Duration::from_secs(5)).await;
    let mut http = Fixture::new(Service::Http, Duration::from_secs(5)).await;
    let mcp_info = mcp.server.info();
    let http_info = http.server.info();
    assert_ne!(mcp_info.url, http_info.url);
    assert_ne!(mcp_info.token, http_info.token);
    assert_ne!(mcp_info.service_id, http_info.service_id);

    let mcp_pending = send(mcp.read_request(Service::Mcp));
    let http_pending = send(http.read_request(Service::Http));
    let mcp_event = mcp.event().await;
    let http_event = http.event().await;
    assert_eq!(mcp_event.source, BridgeSource::Mcp);
    assert_eq!(http_event.source, BridgeSource::Http);
    assert_eq!(mcp_event.service_id, mcp_info.service_id);
    assert_eq!(http_event.service_id, http_info.service_id);
    assert_ne!(mcp_event.request_id, http_event.request_id);

    // A renderer response routed to the wrong service must not consume either request.
    for (server, foreign_request_id) in [
        (&mcp.server, &http_event.request_id),
        (&http.server, &mcp_event.request_id),
    ] {
        assert!(server
            .respond(
                foreign_request_id,
                BridgeResponse {
                    result: Some(json!({"revision": "wrong-service"})),
                    error: None,
                }
            )
            .is_err());
    }
    mcp.respond(&mcp_event.request_id, json!({"revision": "mcp-result"}));
    http.respond(&http_event.request_id, json!({"revision": "http-result"}));
    let mcp_response = mcp_pending.await.unwrap().unwrap();
    let http_response = http_pending.await.unwrap().unwrap();
    assert_eq!(mcp_response.status(), 200);
    assert_eq!(http_response.status(), 200);
    let mcp_body = mcp_response.json::<Value>().await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(mcp_body["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap()["revision"],
        "mcp-result"
    );
    assert_eq!(
        http_response.json::<Value>().await.unwrap()["revision"],
        "http-result"
    );
    mcp.server.stop().await;
    http.server.stop().await;
}

#[tokio::test]
async fn services_reject_the_other_protocol_routes_without_emitting_work() {
    let mut mcp = Fixture::new(Service::Mcp, Duration::from_secs(5)).await;
    let mut http = Fixture::new(Service::Http, Duration::from_secs(5)).await;
    for (method, path) in [
        (reqwest::Method::GET, "/api/state"),
        (reqwest::Method::PUT, "/api/state"),
        (reqwest::Method::GET, "/api/validate"),
        (reqwest::Method::POST, "/api/assignments"),
    ] {
        let response = mcp
            .request(method, path)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404, "MCP server exposed {path}");
    }
    for method in [
        reqwest::Method::POST,
        reqwest::Method::GET,
        reqwest::Method::DELETE,
    ] {
        let response = http.request(method, "/mcp")
            .header("MCP-Protocol-Version", "unsupported")
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_state"}}))
            .send().await.unwrap();
        assert_eq!(response.status(), 404, "HTTP server exposed /mcp");
    }
    assert!(mcp.events.try_recv().is_err());
    assert!(http.events.try_recv().is_err());
    mcp.server.stop().await;
    http.server.stop().await;
}

#[tokio::test]
async fn service_tokens_cannot_authenticate_to_the_other_service() {
    let mut mcp = Fixture::new(Service::Mcp, Duration::from_secs(5)).await;
    let mut http = Fixture::new(Service::Http, Duration::from_secs(5)).await;
    for (fixture, service, foreign_token) in [
        (&mcp, Service::Mcp, http.server.info().token),
        (&http, Service::Http, mcp.server.info().token),
    ] {
        let response = fixture
            .read_request_with_token(service, &foreign_token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
    }
    assert!(mcp.events.try_recv().is_err());
    assert!(http.events.try_recv().is_err());
    mcp.server.stop().await;
    http.server.stop().await;
}

#[tokio::test]
async fn stopping_and_restarting_either_service_preserves_the_others_pending_request_and_credentials(
) {
    for (stopped_service, retained_service) in
        [(Service::Mcp, Service::Http), (Service::Http, Service::Mcp)]
    {
        let mut stopped = Fixture::new(stopped_service, Duration::from_secs(30)).await;
        let mut retained = Fixture::new(retained_service, Duration::from_secs(30)).await;
        let original = stopped.server.info();
        let retained_info = retained.server.info();
        let stopped_pending = send(stopped.read_request(stopped_service));
        let retained_pending = send(retained.read_request(retained_service));
        let stopped_event = stopped.event().await;
        let retained_event = retained.event().await;

        tokio::time::timeout(Duration::from_secs(1), stopped.server.stop())
            .await
            .unwrap();
        // Disabling only this service closes its pending connection promptly.
        let stopped_result = tokio::time::timeout(Duration::from_secs(1), stopped_pending)
            .await
            .unwrap()
            .unwrap();
        if let Ok(response) = stopped_result {
            if stopped_service == Service::Mcp && response.status() == 200 {
                assert_eq!(
                    response.json::<Value>().await.unwrap()["result"]["isError"],
                    true
                );
            } else {
                assert_eq!(response.status(), 503);
            }
        }
        assert!(stopped
            .client
            .get(format!("{}/api/state", original.url))
            .send()
            .await
            .is_err());
        assert!(!retained_pending.is_finished());

        let port = original.url.rsplit(':').next().unwrap().parse().unwrap();
        let mut replacement = Fixture::on_port(stopped_service, port, Duration::from_secs(5)).await;
        let replacement_info = replacement.server.info();
        assert_eq!(replacement_info.url, original.url);
        assert_ne!(replacement_info.token, original.token);
        assert_ne!(replacement_info.service_id, original.service_id);
        assert_eq!(
            replacement
                .read_request_with_token(stopped_service, &original.token)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert!(replacement.events.try_recv().is_err());
        assert!(replacement
            .server
            .respond(
                &stopped_event.request_id,
                BridgeResponse {
                    result: Some(json!({"revision": "stale"})),
                    error: None,
                }
            )
            .is_err());

        let current_retained_info = retained.server.info();
        assert!(current_retained_info.enabled);
        assert_eq!(current_retained_info.url, retained_info.url);
        assert_eq!(current_retained_info.token, retained_info.token);
        assert_eq!(current_retained_info.service_id, retained_info.service_id);
        retained.respond(
            &retained_event.request_id,
            json!({"revision": "uninterrupted"}),
        );
        assert_eq!(retained_pending.await.unwrap().unwrap().status(), 200);

        // Restarted service accepts only its new request IDs and remains operational.
        let new_pending = send(replacement.read_request(stopped_service));
        let new_event = replacement.event().await;
        assert_eq!(new_event.service_id, replacement_info.service_id);
        assert_ne!(new_event.request_id, stopped_event.request_id);
        replacement.respond(&new_event.request_id, json!({"revision": "restarted"}));
        assert_eq!(new_pending.await.unwrap().unwrap().status(), 200);
        replacement.server.stop().await;
        retained.server.stop().await;
    }
}
