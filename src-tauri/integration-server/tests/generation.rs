use reqwest::{Client, Method, RequestBuilder};
use serde_json::{json, Value};
use shift_integration_server::{
    BridgeCancellation, BridgeError, BridgeRequest, BridgeResponse, BridgeSource, Server,
    ServerOptions, Service,
};
use std::{
    io::Write,
    net::{Shutdown, TcpStream},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, task::JoinHandle};

struct Fixture {
    server: Server,
    events: mpsc::UnboundedReceiver<BridgeRequest>,
    cancellations: mpsc::UnboundedReceiver<BridgeCancellation>,
    client: Client,
    service: Service,
}

impl Fixture {
    async fn new(service: Service, ordinary_timeout: Duration, overhead: Duration) -> Self {
        let (sender, events) = mpsc::unbounded_channel();
        let (cancel_sender, cancellations) = mpsc::unbounded_channel();
        let server = Server::start_with_cancellation(
            Arc::new(move |event| sender.send(event).map_err(|error| error.to_string())),
            Arc::new(move |event| cancel_sender.send(event).map_err(|error| error.to_string())),
            ServerOptions {
                service,
                port: 0,
                request_timeout: ordinary_timeout,
                generation_overhead: overhead,
            },
        )
        .await
        .unwrap();
        Self {
            server,
            events,
            cancellations,
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            service,
        }
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let info = self.server.info();
        self.client
            .request(method, format!("{}{path}", info.url))
            .bearer_auth(info.token)
    }

    fn generation(&self, args: Value) -> RequestBuilder {
        let (path, body) = generation_request(self.service, args);
        self.request(Method::POST, path).json(&body)
    }

    async fn event(&mut self) -> BridgeRequest {
        tokio::time::timeout(Duration::from_secs(2), self.events.recv())
            .await
            .expect("renderer request was not emitted")
            .expect("request channel closed")
    }

    async fn cancellation(&mut self) -> BridgeCancellation {
        tokio::time::timeout(Duration::from_secs(2), self.cancellations.recv())
            .await
            .expect("request cancellation was not emitted")
            .expect("cancellation channel closed")
    }

    fn claim(&self, event: &BridgeRequest) -> Result<(), String> {
        self.server
            .claim_request(&event.service_id, &event.request_id)
    }

    fn respond(&self, event: &BridgeRequest, result: Value) {
        self.server
            .respond(
                &event.request_id,
                BridgeResponse {
                    result: Some(result),
                    error: None,
                },
            )
            .unwrap();
    }
}

fn generation_request(service: Service, args: Value) -> (&'static str, Value) {
    match service {
        Service::Http => ("/api/schedules/generate", args),
        Service::Mcp => (
            "/mcp",
            json!({
                "jsonrpc": "2.0", "id": "generate-1", "method": "tools/call",
                "params": {"name": "generate_schedule", "arguments": args}
            }),
        ),
    }
}

fn send(request: RequestBuilder) -> JoinHandle<Result<reqwest::Response, reqwest::Error>> {
    tokio::spawn(async move { request.send().await })
}

fn source(service: Service) -> BridgeSource {
    match service {
        Service::Mcp => BridgeSource::Mcp,
        Service::Http => BridgeSource::Http,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn assert_cancellation(event: &BridgeRequest, cancellation: &BridgeCancellation) {
    assert_eq!(cancellation.request_id, event.request_id);
    assert_eq!(cancellation.service_id, event.service_id);
    assert_eq!(cancellation.source, event.source);
}

async fn success(response: reqwest::Response, service: Service) -> Value {
    assert_eq!(response.status(), 200);
    let body = response.json::<Value>().await.unwrap();
    match service {
        Service::Http => body,
        Service::Mcp => {
            assert_eq!(body["id"], "generate-1");
            assert_ne!(body["result"]["isError"], true);
            serde_json::from_str(body["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
        }
    }
}

#[tokio::test]
async fn generation_routes_forward_trusted_source_and_preserve_result_on_both_services() {
    for service in [Service::Mcp, Service::Http] {
        let mut fixture = Fixture::new(service, Duration::from_secs(2), Duration::ZERO).await;
        let args = json!({"revision": "current", "month": "2026-11", "timeLimitSeconds": 2});
        let pending = send(fixture.generation(args.clone()));
        let event = fixture.event().await;
        assert_eq!(event.method, "generate_schedule");
        assert_eq!(event.args, args);
        assert_eq!(event.source, source(service));
        assert_eq!(event.service_id, fixture.server.info().service_id);
        fixture.claim(&event).unwrap();
        let result = json!({"revision": "generated", "month": "2026-11", "status": "OPTIMAL"});
        fixture.respond(&event, result.clone());
        assert_eq!(
            success(pending.await.unwrap().unwrap(), service).await,
            result
        );
        assert!(fixture.cancellations.try_recv().is_err());
        fixture.server.stop().await;
        assert!(fixture.cancellations.try_recv().is_err());
    }
}

#[tokio::test]
async fn generation_tool_schema_and_defaults_expose_only_supported_inputs() {
    let mut fixture = Fixture::new(
        Service::Mcp,
        Duration::from_secs(2),
        Duration::from_secs(150),
    )
    .await;
    let list = fixture
        .request(Method::POST, "/mcp")
        .json(&json!({"jsonrpc": "2.0", "id": "tools", "method": "tools/list"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let tool = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "generate_schedule")
        .expect("generation tool missing");
    let schema = &tool["inputSchema"];
    assert_eq!(schema["required"], json!(["revision"]));
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["revision"]["type"], "string");
    assert_eq!(schema["properties"]["month"]["type"], "string");
    assert_eq!(schema["properties"]["timeLimitSeconds"]["minimum"], 1);
    assert_eq!(schema["properties"]["timeLimitSeconds"]["maximum"], 60);
    let keys: Vec<_> = schema["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, vec!["month", "revision", "timeLimitSeconds"]);
    assert_eq!(
        ServerOptions::for_service(Service::Mcp).generation_overhead,
        Duration::from_secs(150)
    );
    assert_eq!(
        ServerOptions::for_service(Service::Http).generation_overhead,
        Duration::from_secs(150)
    );

    // Omitting month and limit is valid and receives the default 15s solver + 150s budget.
    let start = now_ms();
    let pending = send(fixture.generation(json!({"revision": "current"})));
    let event = fixture.event().await;
    assert!(event.expires_at >= start + 164_000);
    assert!(event.expires_at <= now_ms() + 166_000);
    fixture.claim(&event).unwrap();
    fixture.respond(&event, json!({"revision": "generated"}));
    success(pending.await.unwrap().unwrap(), Service::Mcp).await;
}

#[tokio::test]
async fn malformed_generation_arguments_are_rejected_before_renderer_work() {
    let invalid = [
        json!(null),
        json!([]),
        json!({}),
        json!({"revision": null}),
        json!({"revision": 1}),
        json!({"revision": ""}),
        json!({"revision": "r", "month": null}),
        json!({"revision": "r", "month": 202610}),
        json!({"revision": "r", "month": "2026-1"}),
        json!({"revision": "r", "month": "2026-13"}),
        json!({"revision": "r", "month": "0000-01"}),
        json!({"revision": "r", "month": "1899-12"}),
        json!({"revision": "r", "month": "2201-01"}),
        json!({"revision": "r", "timeLimitSeconds": null}),
        json!({"revision": "r", "timeLimitSeconds": "15"}),
        json!({"revision": "r", "timeLimitSeconds": false}),
        json!({"revision": "r", "timeLimitSeconds": 0}),
        json!({"revision": "r", "timeLimitSeconds": 61}),
        json!({"revision": "r", "allowPartial": true}),
        json!({"revision": "r", "source": "manual"}),
        json!({"revision": "r", "state": {}}),
    ];
    for service in [Service::Mcp, Service::Http] {
        let mut fixture = Fixture::new(service, Duration::from_secs(2), Duration::ZERO).await;
        for args in &invalid {
            let response = fixture.generation(args.clone()).send().await.unwrap();
            if service == Service::Http {
                assert_eq!(response.status(), 400, "accepted invalid HTTP args: {args}");
            } else {
                assert_eq!(response.status(), 200);
                let body = response.json::<Value>().await.unwrap();
                assert!(
                    body.get("error").is_some() || body["result"]["isError"] == true,
                    "accepted invalid MCP args {args}: {body}"
                );
            }
            assert!(
                fixture.events.try_recv().is_err(),
                "emitted invalid args: {args}"
            );
        }
        assert!(fixture.cancellations.try_recv().is_err());
        fixture.server.stop().await;
    }
}

#[tokio::test]
async fn generation_keeps_authentication_and_protocol_route_isolation() {
    let mut mcp = Fixture::new(Service::Mcp, Duration::from_secs(2), Duration::ZERO).await;
    let mut http = Fixture::new(Service::Http, Duration::from_secs(2), Duration::ZERO).await;
    let args = json!({"revision": "r", "timeLimitSeconds": 1});
    for fixture in [&mcp, &http] {
        let (path, body) = generation_request(fixture.service, args.clone());
        let info = fixture.server.info();
        assert_eq!(
            fixture
                .client
                .post(format!("{}{path}", info.url))
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            fixture
                .request(Method::POST, path)
                .header("Origin", "https://attacker.example")
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            fixture
                .request(Method::POST, path)
                .header("Host", "attacker.example")
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    assert_eq!(
        mcp.request(Method::POST, "/api/schedules/generate")
            .json(&args)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        http.request(Method::POST, "/mcp")
            .json(&generation_request(Service::Mcp, args).1)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    for method in [Method::GET, Method::PUT, Method::DELETE] {
        assert!(!http
            .request(method, "/api/schedules/generate")
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
    }
    assert!(mcp.events.try_recv().is_err());
    assert!(http.events.try_recv().is_err());
    mcp.server.stop().await;
    http.server.stop().await;
}

#[tokio::test]
async fn generation_has_its_own_budget_while_ordinary_requests_still_expire() {
    for service in [Service::Mcp, Service::Http] {
        let mut fixture = Fixture::new(service, Duration::from_millis(60), Duration::ZERO).await;
        let pending = send(fixture.generation(json!({"revision": "r", "timeLimitSeconds": 2})));
        let event = fixture.event().await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            !pending.is_finished(),
            "ordinary timeout cut off generation"
        );
        fixture.claim(&event).unwrap();
        fixture.respond(&event, json!({"revision": "generated"}));
        success(pending.await.unwrap().unwrap(), service).await;

        let read = match service {
            Service::Http => fixture.request(Method::GET, "/api/state"),
            Service::Mcp => fixture.request(Method::POST, "/mcp").json(&json!({
                "jsonrpc":"2.0", "id":"read", "method":"tools/call", "params":{"name":"get_state"}
            })),
        };
        let ordinary = send(read);
        let read_event = fixture.event().await;
        let response = tokio::time::timeout(Duration::from_secs(1), ordinary)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if service == Service::Http {
            assert_eq!(response.status(), 504);
        } else {
            assert_eq!(
                response.json::<Value>().await.unwrap()["result"]["isError"],
                true
            );
        }
        assert!(fixture.claim(&read_event).is_err());
        assert!(fixture.cancellations.try_recv().is_err());
    }
}

#[tokio::test]
async fn commit_claim_is_generation_only_bound_to_service_and_single_use() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(2), Duration::ZERO).await;
    let pending = send(fixture.generation(json!({"revision": "r", "timeLimitSeconds": 2})));
    let event = fixture.event().await;
    assert!(fixture
        .server
        .claim_request("another-service", &event.request_id)
        .is_err());
    assert!(fixture
        .server
        .claim_request(&event.service_id, "missing-request")
        .is_err());
    fixture.claim(&event).unwrap();
    assert!(fixture.claim(&event).is_err());
    fixture.respond(&event, json!({"revision":"generated"}));
    success(pending.await.unwrap().unwrap(), Service::Http).await;
    assert!(fixture.claim(&event).is_err());
    assert!(fixture.cancellations.try_recv().is_err());

    let pending = send(fixture.request(Method::GET, "/api/state"));
    let read = fixture.event().await;
    assert!(fixture.claim(&read).is_err());
    fixture.respond(&read, json!({"revision":"read"}));
    assert_eq!(pending.await.unwrap().unwrap().status(), 200);
}

#[tokio::test]
async fn unclaimed_generation_timeout_emits_one_cancel_and_rejects_late_claim_and_response() {
    for service in [Service::Mcp, Service::Http] {
        let mut fixture = Fixture::new(service, Duration::from_secs(2), Duration::ZERO).await;
        let pending = send(fixture.generation(json!({"revision":"r", "timeLimitSeconds":1})));
        let event = fixture.event().await;
        let cancellation = fixture.cancellation().await;
        assert_cancellation(&event, &cancellation);
        assert!(fixture.claim(&event).is_err());
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
        let response = pending.await.unwrap().unwrap();
        if service == Service::Http {
            assert_eq!(response.status(), 504);
        } else {
            assert_eq!(
                response.json::<Value>().await.unwrap()["result"]["isError"],
                true
            );
        }
        assert!(fixture.cancellations.try_recv().is_err());
        fixture.server.stop().await;
        assert!(fixture.cancellations.try_recv().is_err());
    }
}

#[tokio::test]
async fn claim_checks_monotonic_deadline_even_before_timeout_task_is_scheduled() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(2), Duration::ZERO).await;
    let pending = send(fixture.generation(json!({"revision":"r", "timeLimitSeconds":1})));
    let event = fixture.event().await;
    // Intentionally block this current-thread runtime: the request is still in
    // pending when claim runs, but its authoritative Instant deadline has passed.
    std::thread::sleep(Duration::from_millis(1100));
    assert!(fixture.claim(&event).is_err());
    assert_cancellation(&event, &fixture.cancellation().await);
    assert_eq!(pending.await.unwrap().unwrap().status(), 504);
}

#[tokio::test]
async fn slow_generation_request_bodies_keep_the_ordinary_read_timeout() {
    use std::io::Read;
    for service in [Service::Mcp, Service::Http] {
        let mut fixture =
            Fixture::new(service, Duration::from_millis(80), Duration::from_secs(150)).await;
        let info = fixture.server.info();
        let authority = info.url.strip_prefix("http://").unwrap();
        let mut stream = TcpStream::connect(authority).unwrap();
        let path = match service {
            Service::Mcp => "/mcp",
            Service::Http => "/api/schedules/generate",
        };
        write!(stream, "POST {path} HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{{", info.token).unwrap();
        let response = tokio::task::spawn_blocking(move || {
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut status = [0u8; 12];
            stream.read_exact(&mut status).unwrap();
            String::from_utf8(status.to_vec()).unwrap()
        })
        .await
        .unwrap();
        assert_eq!(response, "HTTP/1.1 504");
        assert!(fixture.events.try_recv().is_err());
        assert!(fixture.cancellations.try_recv().is_err());
        fixture.server.stop().await;
    }
}

#[tokio::test]
async fn accepted_claim_can_reply_after_original_deadline_without_being_cancelled() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_millis(50), Duration::ZERO).await;
    let pending = send(fixture.generation(json!({"revision":"r", "timeLimitSeconds":1})));
    let event = fixture.event().await;
    fixture.claim(&event).unwrap();
    tokio::time::sleep(Duration::from_millis(1150)).await;
    assert!(
        !pending.is_finished(),
        "claimed request lost its commit grace"
    );
    assert!(fixture.cancellations.try_recv().is_err());
    fixture.respond(&event, json!({"revision":"committed"}));
    assert_eq!(
        success(pending.await.unwrap().unwrap(), Service::Http).await["revision"],
        "committed"
    );
    assert!(fixture.cancellations.try_recv().is_err());
}

#[tokio::test]
async fn claimed_request_grace_is_bounded_and_expiry_never_revokes_accepted_commit() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_millis(50), Duration::ZERO).await;
    let pending = send(fixture.generation(json!({"revision":"r", "timeLimitSeconds":1})));
    let event = fixture.event().await;
    fixture.claim(&event).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(8), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 504);
    assert!(fixture.cancellations.try_recv().is_err());
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
async fn responding_with_generation_error_finishes_without_sending_cancellation() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(2), Duration::ZERO).await;
    let pending = send(fixture.generation(json!({"revision":"r", "timeLimitSeconds":2})));
    let event = fixture.event().await;
    fixture
        .server
        .respond(
            &event.request_id,
            BridgeResponse {
                result: None,
                error: Some(BridgeError {
                    status: 409,
                    message: "规则已变化".into(),
                }),
            },
        )
        .unwrap();
    assert_eq!(pending.await.unwrap().unwrap().status(), 409);
    assert!(fixture.claim(&event).is_err());
    assert!(fixture.cancellations.try_recv().is_err());
}

fn raw_generation(fixture: &Fixture) -> TcpStream {
    let info = fixture.server.info();
    let authority = info.url.strip_prefix("http://").unwrap();
    let mut stream = TcpStream::connect(authority).unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let (path, body) = generation_request(
        fixture.service,
        json!({"revision":"r", "timeLimitSeconds":10}),
    );
    let body = body.to_string();
    write!(stream, "POST {path} HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", info.token, body.len(), body).unwrap();
    stream.flush().unwrap();
    stream
}

#[tokio::test]
async fn raw_tcp_disconnect_cancels_unclaimed_generation_and_prevents_late_commit() {
    for service in [Service::Mcp, Service::Http] {
        let mut fixture = Fixture::new(service, Duration::from_secs(2), Duration::ZERO).await;
        let stream = raw_generation(&fixture);
        let event = fixture.event().await;
        stream.shutdown(Shutdown::Both).unwrap();
        drop(stream);
        assert_cancellation(&event, &fixture.cancellation().await);
        assert!(fixture.claim(&event).is_err());
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
        assert!(fixture.cancellations.try_recv().is_err());
    }
}

#[tokio::test]
async fn disconnect_after_claim_does_not_emit_a_false_cancellation() {
    let mut fixture = Fixture::new(Service::Http, Duration::from_secs(2), Duration::ZERO).await;
    let stream = raw_generation(&fixture);
    let event = fixture.event().await;
    fixture.claim(&event).unwrap();
    stream.shutdown(Shutdown::Both).unwrap();
    drop(stream);
    // Stop also drains any connection whose disconnect has not yet been polled.
    fixture.server.stop().await;
    assert!(fixture.cancellations.try_recv().is_err());
}

#[tokio::test]
async fn stopping_one_service_cancels_only_its_unclaimed_generation() {
    for (stopped_service, retained_service) in
        [(Service::Mcp, Service::Http), (Service::Http, Service::Mcp)]
    {
        let mut stopped =
            Fixture::new(stopped_service, Duration::from_secs(2), Duration::ZERO).await;
        let mut retained =
            Fixture::new(retained_service, Duration::from_secs(2), Duration::ZERO).await;
        let stopped_pending =
            send(stopped.generation(json!({"revision":"r", "timeLimitSeconds":10})));
        let retained_pending =
            send(retained.generation(json!({"revision":"r", "timeLimitSeconds":10})));
        let stopped_event = stopped.event().await;
        let retained_event = retained.event().await;
        assert!(stopped
            .server
            .claim_request(&retained_event.service_id, &retained_event.request_id)
            .is_err());
        assert!(retained
            .server
            .claim_request(&stopped_event.service_id, &stopped_event.request_id)
            .is_err());
        stopped.server.stop().await;
        let cancellation =
            tokio::time::timeout(Duration::from_secs(1), stopped.cancellations.recv())
                .await
                .unwrap()
                .unwrap();
        assert_cancellation(&stopped_event, &cancellation);
        assert!(stopped.cancellations.try_recv().is_err());
        assert!(retained.cancellations.try_recv().is_err());
        assert!(!retained_pending.is_finished());
        retained.claim(&retained_event).unwrap();
        retained.respond(&retained_event, json!({"revision":"uninterrupted"}));
        success(retained_pending.await.unwrap().unwrap(), retained_service).await;
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stopped_pending)
                .await
                .is_ok()
        );
        retained.server.stop().await;
        assert!(retained.cancellations.try_recv().is_err());
    }
}
