use reqwest::{Client, RequestBuilder};
use serde_json::{json, Value};
use shift_integration_server::{
    BridgeError, BridgeRequest, BridgeResponse, BridgeSource, Server, ServerOptions,
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
    async fn new(timeout: Duration) -> Self {
        let (sender, events) = mpsc::unbounded_channel();
        let server = Server::start(
            Arc::new(move |event| sender.send(event).map_err(|error| error.to_string())),
            ServerOptions {
                port: 0,
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
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
    let message = "Setting 未允许修改排班";
    for source in [BridgeSource::Http, BridgeSource::Mcp] {
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
    }
    fixture.server.stop().await;
}

#[tokio::test]
async fn authentication_and_dns_rebinding_checks_precede_data_access() {
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
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
    let mut fixture = Fixture::new(Duration::from_millis(80)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(30)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(10)).await;
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
    let mut fixture = Fixture::new(Duration::from_secs(5)).await;
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
