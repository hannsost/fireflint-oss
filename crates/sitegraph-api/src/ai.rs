//! AI content workflows (v3): pluggable provider connectors + a graph executor.
//!
//! A workflow is a node/edge graph (built visually or by the chat copilot).
//! Node kinds: `trigger`, `agent`, `condition`, `loop`, `parallel`, `join`,
//! `memory`, `output`. The executor walks the graph (Kahn-style, branch-aware),
//! calls AI providers for agent/loop nodes, lets `memory` nodes store/recall/
//! forget facts (run-scoped or persistent), and an `output` node writes a
//! content draft (optional approval = publishing it later). Every node's result
//! is recorded in the run trace for observability.
//!
//! Cross-cutting controls: per-node `max_tokens`, a workflow-level token budget,
//! and a reusable system preprompt at both connector and workflow level.
//!
//! Providers are pluggable: `anthropic` (native Messages API), `openai_compatible`
//! (any OpenAI-compatible Chat Completions endpoint — OpenAI, Mistral, OpenRouter,
//! Groq, Together, vLLM, LM Studio, Ollama, … selected via `base_url` + `model`)
//! and `mock` (deterministic, key-free — makes the whole engine testable offline).

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use sitegraph_db::Db;
use uuid::Uuid;

const ANTHROPIC_VERSION: &str = "2023-06-01";
pub(crate) const DEFAULT_ANTHROPIC_BASE: &str = "https://api.anthropic.com";
/// Default for `openai_compatible` when no base URL is configured.
pub(crate) const DEFAULT_OPENAI_COMPATIBLE_BASE: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS: u64 = 1024;
const MAX_ROUNDS: usize = 200;

// --- Provider seam ---------------------------------------------------------

/// Output of one LLM call: the text plus token usage for budgeting.
struct Gen {
    text: String,
    input_tokens: u64,
    output_tokens: u64,
}

enum Provider {
    Anthropic {
        key: String,
        base: String,
    },
    /// OpenAI-compatible `POST {base}/chat/completions`. The key is optional
    /// because local runtimes (Ollama, LM Studio, vLLM) often need none.
    OpenAiCompatible {
        key: Option<String>,
        base: String,
    },
    Mock,
}

impl Provider {
    /// Build a runtime provider from a stored connector row.
    fn from_connector(
        provider: &str,
        key: Option<String>,
        base: Option<String>,
    ) -> Result<Provider, String> {
        let key = key.filter(|k| !k.is_empty());
        match provider {
            "mock" => Ok(Provider::Mock),
            "anthropic" => Ok(Provider::Anthropic {
                key: key.ok_or("anthropic connector has no API key")?,
                base: base.unwrap_or_else(|| DEFAULT_ANTHROPIC_BASE.into()),
            }),
            "openai_compatible" => Ok(Provider::OpenAiCompatible {
                key,
                base: base.unwrap_or_else(|| DEFAULT_OPENAI_COMPATIBLE_BASE.into()),
            }),
            _ => Err("Unsupported provider".into()),
        }
    }
}

/// Convert Anthropic-style (system + messages) input to an OpenAI-compatible
/// Chat Completions request body.
pub(crate) fn openai_chat_body(
    model: &str,
    system: Option<&str>,
    messages: &[Value],
    max_tokens: u64,
) -> Value {
    let mut all = Vec::with_capacity(messages.len() + 1);
    if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
        all.push(json!({ "role": "system", "content": sys }));
    }
    all.extend(messages.iter().cloned());
    json!({ "model": model, "max_tokens": max_tokens, "messages": all })
}

/// Extract text and usage from an OpenAI-compatible Chat Completions response.
pub(crate) fn openai_chat_output(v: &Value) -> (String, u64, u64) {
    let text = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    (
        text,
        v["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
        v["usage"]["completion_tokens"].as_u64().unwrap_or(0),
    )
}

/// A resolved connector: the provider plus its reusable defaults.
struct ConnectorCtx {
    provider: Provider,
    preprompt: Option<String>,
    default_model: Option<String>,
}

fn est_tokens(s: &str) -> u64 {
    (s.chars().count() as u64).div_ceil(4)
}

impl Provider {
    async fn generate(
        &self,
        model: &str,
        system: Option<&str>,
        prompt: &str,
        max_tokens: u64,
    ) -> Result<Gen, String> {
        self.generate_messages(
            model,
            system,
            &[json!({ "role": "user", "content": prompt })],
            max_tokens,
        )
        .await
    }

    async fn generate_messages(
        &self,
        model: &str,
        system: Option<&str>,
        messages: &[Value],
        max_tokens: u64,
    ) -> Result<Gen, String> {
        match self {
            Provider::OpenAiCompatible { key, base } => {
                let body = openai_chat_body(model, system, messages, max_tokens);
                // Same SSRF protections as for Anthropic: operator-approved host,
                // validated + pinned DNS answers, no credential-forwarding redirects.
                let target = crate::outbound::ai_target(base).await?;
                let client = target.client(Duration::from_secs(60))?;
                let url = format!(
                    "{}/chat/completions",
                    target.url.as_str().trim_end_matches('/')
                );
                let mut req = client
                    .post(url)
                    .header("content-type", "application/json")
                    .json(&body)
                    .timeout(Duration::from_secs(60));
                if let Some(key) = key {
                    let mut auth = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
                        .map_err(|_| "invalid provider API key")?;
                    auth.set_sensitive(true);
                    req = req.header(reqwest::header::AUTHORIZATION, auth);
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|_| "provider request failed".to_string())?;
                if !resp.status().is_success() {
                    let code = resp.status();
                    return Err(format!("provider error {code}"));
                }
                let v = bounded_provider_json(resp).await?;
                let (text, input_tokens, output_tokens) = openai_chat_output(&v);
                Ok(Gen {
                    text,
                    input_tokens,
                    output_tokens,
                })
            }
            Provider::Mock => {
                let prompt = messages
                    .last()
                    .and_then(|m| m["content"].as_str())
                    .unwrap_or("");
                let text = format!("[mock:{model}] {prompt}");
                Ok(Gen {
                    input_tokens: est_tokens(system.unwrap_or("")) + est_tokens(prompt),
                    output_tokens: est_tokens(&text),
                    text,
                })
            }
            Provider::Anthropic { key, base } => {
                let mut body = json!({
                    "model": model,
                    "max_tokens": max_tokens,
                    "messages": messages,
                });
                if let Some(sys) = system {
                    body["system"] = json!(sys);
                }
                // Check stored URLs again at use time and pin the validated
                // DNS answers. Redirects cannot forward provider credentials.
                let target = crate::outbound::ai_target(base).await?;
                let client = target.client(Duration::from_secs(60))?;
                let url = format!("{}/v1/messages", target.url.as_str().trim_end_matches('/'));
                let mut api_key = reqwest::header::HeaderValue::from_str(key)
                    .map_err(|_| "invalid provider API key")?;
                api_key.set_sensitive(true);
                let resp = client
                    .post(url)
                    .header("x-api-key", api_key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .header("content-type", "application/json")
                    .json(&body)
                    .timeout(Duration::from_secs(60))
                    .send()
                    .await
                    .map_err(|_| "provider request failed".to_string())?;
                if !resp.status().is_success() {
                    let code = resp.status();
                    // A provider/proxy error body could echo credentials.
                    return Err(format!("provider error {code}"));
                }
                let v = bounded_provider_json(resp).await?;
                let text = v["content"][0]["text"].as_str().unwrap_or("").to_string();
                Ok(Gen {
                    input_tokens: v["usage"]["input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: v["usage"]["output_tokens"].as_u64().unwrap_or(0),
                    text,
                })
            }
        }
    }
}

#[derive(Deserialize, utoipa::ToSchema)]
pub(crate) struct ChatMessage {
    pub role: String,
    pub content: String,
}

pub(crate) fn validate_chat(messages: &[ChatMessage]) -> Result<(), String> {
    if messages.is_empty() || messages.len() > 79 || messages.len().is_multiple_of(2) {
        return Err(
            "Chat needs alternating user/assistant messages ending in a user message".into(),
        );
    }
    let mut size = 0;
    for (index, message) in messages.iter().enumerate() {
        let expected = if index.is_multiple_of(2) {
            "user"
        } else {
            "assistant"
        };
        if message.role != expected
            || message.content.trim().is_empty()
            || message.content.len() > 16000
        {
            return Err("Invalid chat message or message too long".into());
        }
        size += message.content.len();
    }
    if size > 200000 {
        return Err("Chat is too long; start a new chat".into());
    }
    Ok(())
}

/// Chat is advisory: no tools, implicit database context, or content writes.
pub(crate) async fn chat(
    db: &Db,
    org: Uuid,
    id: Uuid,
    messages: &[ChatMessage],
) -> Result<Value, String> {
    let (provider, key, base, preprompt, model) = db
        .ai_connector_runtime(org, id)
        .await
        .map_err(|_| "Could not load connector")?
        .ok_or("Connector not found in this organization")?;
    let provider = Provider::from_connector(&provider, key, base)?;
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.into());
    let system = format!("Du bist der FireFlint-Assistent für redaktionelle Inhalte. Du hast keinen Zugriff auf Firmendaten oder Werkzeuge. Du berätst und formulierst Vorschläge. Behaupte niemals, etwas gespeichert oder veröffentlicht zu haben. Kennzeichne Unsicherheit. Antworte in der Sprache der Frage.\n{}", preprompt.unwrap_or_default());
    let messages: Vec<Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let output = provider
        .generate_messages(&model, Some(&system), &messages, 2048)
        .await?;
    if output.text.trim().is_empty() || output.text.len() > 16000 {
        return Err("Provider returned an invalid answer".into());
    }
    Ok(
        json!({ "message": { "role": "assistant", "content": output.text }, "model": model, "usage": { "input_tokens": output.input_tokens, "output_tokens": output.output_tokens } }),
    )
}

async fn bounded_provider_json(mut response: reqwest::Response) -> Result<Value, String> {
    const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("provider response is too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "could not read provider response")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("provider response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid provider JSON".into())
}

// --- Graph types -----------------------------------------------------------

#[derive(Deserialize, Clone)]
struct Node {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    data: Map<String, Value>,
}

#[derive(Deserialize, Clone)]
struct Edge {
    source: String,
    target: String,
    #[serde(default)]
    branch: Option<String>,
}

/// Workflow-wide controls carried alongside the graph.
#[derive(Deserialize, Default)]
struct Settings {
    /// Hard cap on total tokens (input+output) across the whole run.
    #[serde(default)]
    token_budget: Option<u64>,
    /// System preprompt prepended to every agent in this workflow.
    #[serde(default)]
    preprompt: Option<String>,
}

#[derive(Deserialize, Default)]
struct Graph {
    #[serde(default)]
    nodes: Vec<Node>,
    #[serde(default)]
    edges: Vec<Edge>,
    #[serde(default)]
    settings: Settings,
}

fn ds(data: &Map<String, Value>, key: &str) -> Option<String> {
    data.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Replace `{{input}}` and `{{<nodeId>}}` placeholders from the context.
fn interpolate(template: &str, ctx: &HashMap<String, String>) -> String {
    let mut out = template.to_string();
    for (k, v) in ctx {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}

/// Merge connector + workflow + node preprompts into one system string.
fn compose_system(
    connector_pre: Option<&str>,
    wf_pre: Option<&str>,
    node_sys: Option<&str>,
) -> Option<String> {
    let mut parts = Vec::new();
    for s in [connector_pre, wf_pre, node_sys].into_iter().flatten() {
        let t = s.trim();
        if !t.is_empty() {
            parts.push(t.to_string());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

// --- Executor --------------------------------------------------------------

/// Run a workflow graph. Returns (status, trace, error). `status` is
/// "succeeded" or "failed"; `trace` is a JSON array of per-node records.
pub async fn run_workflow(
    db: &Db,
    org_id: Uuid,
    workflow_id: Uuid,
    graph_value: &Value,
    input: &str,
) -> (String, Value, Option<String>) {
    let graph: Graph = match serde_json::from_value(graph_value.clone()) {
        Ok(g) => g,
        Err(e) => {
            return (
                "failed".into(),
                json!([]),
                Some(format!("invalid graph: {e}")),
            )
        }
    };
    let wf_pre = graph.settings.preprompt.clone();
    let budget = graph.settings.token_budget;

    let nodes: HashMap<String, Node> = graph
        .nodes
        .iter()
        .cloned()
        .map(|n| (n.id.clone(), n))
        .collect();
    let mut out_edges: HashMap<String, Vec<Edge>> = HashMap::new();
    let mut in_count: HashMap<String, usize> = HashMap::new();
    for n in &graph.nodes {
        in_count.entry(n.id.clone()).or_insert(0);
    }
    for e in &graph.edges {
        out_edges
            .entry(e.source.clone())
            .or_default()
            .push(e.clone());
        *in_count.entry(e.target.clone()).or_insert(0) += 1;
    }

    let mut ctx: HashMap<String, String> = HashMap::new();
    ctx.insert("input".into(), input.to_string());
    let mut run_mem: HashMap<String, String> = HashMap::new();
    let mut trace: Vec<Value> = Vec::new();
    let mut connector_cache: HashMap<String, ConnectorCtx> = HashMap::new();
    let mut tokens_used: u64 = 0;

    let mut remaining = in_count.clone();
    let mut incoming_taken: HashMap<String, bool> = HashMap::new();
    let mut done: HashSet<String> = HashSet::new();
    // Ready queue: nodes whose incoming edges are all resolved.
    let mut ready: Vec<String> = graph
        .nodes
        .iter()
        .filter(|n| in_count.get(&n.id).copied().unwrap_or(0) == 0)
        .map(|n| n.id.clone())
        .collect();
    for r in &ready {
        incoming_taken.insert(r.clone(), true); // entry points are active
    }

    let mut rounds = 0;
    while let Some(node_id) = ready.pop() {
        rounds += 1;
        if rounds > MAX_ROUNDS {
            return (
                "failed".into(),
                json!(trace),
                Some("workflow exceeded step limit".into()),
            );
        }
        if done.contains(&node_id) {
            continue;
        }
        done.insert(node_id.clone());

        let node = match nodes.get(&node_id) {
            Some(n) => n.clone(),
            None => continue,
        };
        let active = incoming_taken.get(&node_id).copied().unwrap_or(false);

        // Branch chosen by this node (for conditions); None => all out-edges taken.
        let mut chosen_branch: Option<String> = None;

        if active {
            match node.kind.as_str() {
                "trigger" => {
                    ctx.insert(node.id.clone(), input.to_string());
                    trace.push(json!({ "node": node.id, "type": "trigger", "status": "ok",
                        "input": trace_excerpt(input), "output": trace_excerpt(input) }));
                }
                "agent" | "loop" => {
                    let is_loop = node.kind == "loop";
                    let connector_id = ds(&node.data, "connector_id");
                    let cc = match connector_ctx(
                        db,
                        org_id,
                        connector_id.as_deref(),
                        &mut connector_cache,
                    )
                    .await
                    {
                        Ok(c) => c,
                        Err(e) => {
                            trace.push(json!({ "node": node.id, "type": node.kind, "status": "error",
                                "input": trace_excerpt(&ds(&node.data, "prompt").unwrap_or_default()),
                                "error": trace_excerpt(&e) }));
                            return ("failed".into(), json!(trace), Some(e));
                        }
                    };
                    let model = ds(&node.data, "model")
                        .filter(|m| !m.is_empty())
                        .or_else(|| cc.default_model.clone())
                        .unwrap_or_else(|| DEFAULT_MODEL.into());
                    let system = compose_system(
                        cc.preprompt.as_deref(),
                        wf_pre.as_deref(),
                        ds(&node.data, "system").as_deref(),
                    );
                    let max_tokens = node
                        .data
                        .get("max_tokens")
                        .and_then(|v| v.as_u64())
                        .filter(|n| *n > 0)
                        .unwrap_or(DEFAULT_MAX_TOKENS);
                    let prompt_tpl = ds(&node.data, "prompt").unwrap_or_default();

                    let iterations = if is_loop {
                        node.data
                            .get("iterations")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(1)
                            .clamp(1, 20) as usize
                    } else {
                        1
                    };

                    let mut collected: Vec<String> = Vec::new();
                    let mut prompts: Vec<String> = Vec::new();
                    let mut step_in = 0u64;
                    let mut step_out = 0u64;
                    let mut failed: Option<String> = None;
                    for i in 0..iterations {
                        let mut iter_ctx = ctx.clone();
                        iter_ctx.insert("index".into(), i.to_string());
                        let prompt = interpolate(&prompt_tpl, &iter_ctx);
                        prompts.push(prompt.clone());
                        match cc
                            .provider
                            .generate(&model, system.as_deref(), &prompt, max_tokens)
                            .await
                        {
                            Ok(g) => {
                                step_in += g.input_tokens;
                                step_out += g.output_tokens;
                                collected.push(g.text);
                            }
                            Err(e) => {
                                failed = Some(format!("{} '{}' failed: {e}", node.kind, node.id));
                                break;
                            }
                        }
                    }
                    if let Some(e) = failed {
                        trace.push(json!({ "node": node.id, "type": node.kind, "status": "error",
                            "input": trace_excerpt(&prompts.join("\n---\n")), "error": trace_excerpt(&e) }));
                        return ("failed".into(), json!(trace), Some(e));
                    }
                    tokens_used += step_in + step_out;
                    let text = collected.join("\n---\n");
                    ctx.insert(node.id.clone(), text.clone());
                    trace.push(json!({
                        "node": node.id, "type": node.kind, "model": model, "status": "ok",
                        "input": trace_excerpt(&prompts.join("\n---\n")),
                        "output": trace_excerpt(&text),
                        "tokens": { "input": step_in, "output": step_out },
                    }));
                    if let Some(b) = budget {
                        if tokens_used > b {
                            trace.push(json!({ "type": "budget", "status": "error", "tokens_total": tokens_used, "token_budget": b }));
                            return (
                                "failed".into(),
                                json!(trace),
                                Some(format!("token budget exceeded: used {tokens_used} of {b}")),
                            );
                        }
                    }
                }
                "condition" => {
                    let needle = ds(&node.data, "contains").unwrap_or_default();
                    let src = ds(&node.data, "input").unwrap_or_else(|| "input".into());
                    let haystack = ctx.get(&src).cloned().unwrap_or_default();
                    let matched = !needle.is_empty() && haystack.contains(&needle);
                    chosen_branch = Some(if matched {
                        "true".into()
                    } else {
                        "false".into()
                    });
                    ctx.insert(node.id.clone(), haystack.clone());
                    trace.push(
                        json!({ "node": node.id, "type": "condition", "status": "ok",
                        "input": trace_excerpt(&haystack), "output": trace_excerpt(&haystack),
                        "branch": chosen_branch }),
                    );
                }
                "parallel" => {
                    ctx.insert(
                        node.id.clone(),
                        ctx.get("input").cloned().unwrap_or_default(),
                    );
                    let value = ctx.get("input").cloned().unwrap_or_default();
                    trace.push(json!({ "node": node.id, "type": "parallel", "status": "ok",
                        "input": trace_excerpt(&value), "output": trace_excerpt(&value) }));
                }
                "join" => {
                    let parts: Vec<String> = graph
                        .edges
                        .iter()
                        .filter(|e| e.target == node.id)
                        .filter_map(|e| ctx.get(&e.source).cloned())
                        .collect();
                    let merged = parts.join("\n\n");
                    ctx.insert(node.id.clone(), merged.clone());
                    trace.push(json!({ "node": node.id, "type": "join", "status": "ok",
                        "input": trace_excerpt(&merged), "output": trace_excerpt(&merged) }));
                }
                "memory" => {
                    match run_memory(db, org_id, workflow_id, &node, &graph, &ctx, &mut run_mem)
                        .await
                    {
                        Ok((value, record)) => {
                            ctx.insert(node.id.clone(), value);
                            trace.push(record);
                        }
                        Err(e) => {
                            trace.push(json!({ "node": node.id, "type": "memory", "status": "error",
                                "input": trace_excerpt(&upstream_value(&graph, &node.id, &ctx).unwrap_or_default()),
                                "error": trace_excerpt(&e) }));
                            return ("failed".into(), json!(trace), Some(e));
                        }
                    }
                }
                "output" => {
                    let type_key = ds(&node.data, "content_type").unwrap_or_default();
                    let src = ds(&node.data, "input");
                    let text = src
                        .and_then(|s| ctx.get(&s).cloned())
                        .or_else(|| upstream_value(&graph, &node.id, &ctx))
                        .unwrap_or_default();
                    match build_draft(
                        db,
                        org_id,
                        &type_key,
                        &text,
                        ds(&node.data, "mode").as_deref(),
                    )
                    .await
                    {
                        Ok(cid) => trace
                            .push(json!({ "node": node.id, "type": "output", "status": "ok",
                            "input": trace_excerpt(&text), "output": cid, "content_id": cid })),
                        Err(e) => {
                            trace.push(
                                json!({ "node": node.id, "type": "output", "status": "error",
                                "input": trace_excerpt(&text), "error": trace_excerpt(&e) }),
                            );
                            return ("failed".into(), json!(trace), Some(e));
                        }
                    }
                }
                other => {
                    let value = upstream_value(&graph, &node.id, &ctx).unwrap_or_default();
                    trace.push(json!({ "node": node.id, "type": other, "status": "skipped",
                        "input": trace_excerpt(&value), "output": trace_excerpt(&value),
                        "reason": "unknown node type" }));
                }
            }
        } else {
            trace.push(json!({ "node": node.id, "type": node.kind, "status": "skipped" }));
        }

        // Resolve out-edges: decrement targets, mark taken where applicable.
        if let Some(outs) = out_edges.get(&node_id) {
            for e in outs {
                let taken = active
                    && match &chosen_branch {
                        Some(b) => e.branch.as_deref() == Some(b.as_str()),
                        None => true,
                    };
                if taken {
                    incoming_taken.insert(e.target.clone(), true);
                }
                let rem = remaining.entry(e.target.clone()).or_insert(0);
                if *rem > 0 {
                    *rem -= 1;
                }
                if remaining.get(&e.target).copied().unwrap_or(0) == 0 && !done.contains(&e.target)
                {
                    ready.push(e.target.clone());
                }
            }
        }
    }

    trace.push(json!({ "type": "summary", "status": "ok", "tokens_total": tokens_used, "token_budget": budget }));
    ("succeeded".into(), json!(trace), None)
}

const TRACE_MAX_CHARS: usize = 280;

/// Keep trace payloads useful for debugging without persisting secrets or
/// unbounded user/provider data. This is applied before the trace is stored.
fn trace_excerpt(s: &str) -> String {
    let mut out = s.to_string();
    let keys = [
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "authorization",
        "password",
        "secret",
        "token",
    ];
    for key in keys {
        let lower = out.to_ascii_lowercase();
        let mut from = 0;
        while let Some(found) = lower[from..].find(key) {
            let start = from + found;
            let boundary = start == 0
                || (!lower.as_bytes()[start - 1].is_ascii_alphanumeric()
                    && lower.as_bytes()[start - 1] != b'_');
            if !boundary {
                from = start + key.len();
                continue;
            }
            let after = start + key.len();
            let Some(separator) = out[after..].find([':', '=']) else {
                from = after;
                continue;
            };
            let mut value_start = after + separator + 1;
            let bytes = out.as_bytes();
            while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
                value_start += 1;
            }
            let quote = matches!(bytes.get(value_start), Some(b'"') | Some(b'\''));
            let mut value_end = value_start;
            if quote {
                let quote_byte = bytes[value_start];
                value_end += 1;
                while value_end < bytes.len() && bytes[value_end] != quote_byte {
                    value_end += 1;
                }
            } else {
                while value_end < bytes.len()
                    && !bytes[value_end].is_ascii_whitespace()
                    && !matches!(bytes[value_end], b',' | b'}' | b']' | b'&')
                {
                    value_end += 1;
                }
            }
            out.replace_range(value_start..value_end, "[REDACTED]");
            break;
        }
    }
    out.chars().take(TRACE_MAX_CHARS).collect()
}

/// Execute a `memory` node. Returns (node output value, trace record).
async fn run_memory(
    db: &Db,
    org_id: Uuid,
    workflow_id: Uuid,
    node: &Node,
    graph: &Graph,
    ctx: &HashMap<String, String>,
    run_mem: &mut HashMap<String, String>,
) -> Result<(String, Value), String> {
    let mode = ds(&node.data, "mode").unwrap_or_else(|| "store".into());
    let scope = ds(&node.data, "scope").unwrap_or_else(|| "run".into());
    let persistent = scope == "persistent";
    let key = ds(&node.data, "key").unwrap_or_default();
    if key.is_empty() {
        return Err(format!("memory node '{}' needs a key", node.id));
    }

    let value = match mode.as_str() {
        "store" => {
            let val = ds(&node.data, "value")
                .filter(|s| !s.is_empty())
                .or_else(|| ds(&node.data, "input").and_then(|s| ctx.get(&s).cloned()))
                .or_else(|| upstream_value(graph, &node.id, ctx))
                .unwrap_or_default();
            if persistent {
                db.ai_memory_store(org_id, workflow_id, &key, &val)
                    .await
                    .map_err(|e| format!("memory store failed: {e}"))?;
            } else {
                run_mem.insert(key.clone(), val.clone());
            }
            val
        }
        "recall" => {
            if persistent {
                db.ai_memory_recall(org_id, workflow_id, &key)
                    .await
                    .map_err(|e| format!("memory recall failed: {e}"))?
                    .unwrap_or_default()
            } else {
                run_mem.get(&key).cloned().unwrap_or_default()
            }
        }
        "forget" => {
            if persistent {
                db.ai_memory_forget(org_id, workflow_id, &key)
                    .await
                    .map_err(|e| format!("memory forget failed: {e}"))?;
            } else {
                run_mem.remove(&key);
            }
            String::new()
        }
        other => return Err(format!("unknown memory mode '{other}'")),
    };

    let record = json!({
        "node": node.id, "type": "memory", "status": "ok",
        "mode": mode, "scope": scope, "key": trace_excerpt(&key),
        "input": trace_excerpt(&value), "output": trace_excerpt(&value),
    });
    Ok((value, record))
}

// --- Copilot: chat -> workflow graph ---------------------------------------

/// The fixed FireFlint workflow grammar. This is the single source of truth the
/// copilot uses; it maps 1:1 onto the executor above. Mirrored (for humans) in
/// `docs/ai-workflow-syntax.md`.
const COPILOT_SYSTEM: &str = r#"You design content workflows for the FireFlint AI engine.
Reply with ONLY one JSON object, no prose, no markdown fences:
{"nodes":[{"id":"<unique>","type":"<kind>","data":{...}}],"edges":[{"source":"<id>","target":"<id>","branch":null}],"settings":{"token_budget":null,"preprompt":null}}

NODE KINDS and their exact data fields (use only these):
- trigger  data:{}  — the single entry point. Its output is the run input text.
- agent    data:{connector_id?:string|null, model?:string, system?:string, prompt:string, max_tokens?:int}
           Calls the LLM once. connector_id null => mock provider. model defaults to the connector's
           default or claude-sonnet-4-6. Output = the model text.
- loop     data:{connector_id?:string|null, model?:string, prompt:string, iterations:int 1..20, max_tokens?:int}
           Repeats the prompt N times; {{index}} is the 0-based counter; outputs joined with "\n---\n".
- condition data:{input:string, contains:string}
           Reads the output of node `input` (or "input" for the run input); if it contains
           `contains`, the "true" out-edge is taken, else the "false" out-edge. Pass-through output.
- parallel data:{}  — fan-out: give it several out-edges to run branches independently.
- join     data:{}  — fan-in: output = all incoming node outputs concatenated with "\n\n".
- memory   data:{mode:"store"|"recall"|"forget", scope:"run"|"persistent", key:string, value?:string, input?:string}
           store saves a value (explicit `value`, else node `input`'s output) under `key`; recall outputs the
           stored value; forget deletes it. scope "run" lives only for this run; "persistent" survives runs.
- output   data:{content_type:string, mode?:"draft"|"publish", input?:string}
           Writes a content draft of type `content_type` (a content-type KEY). Reads node `input`
           (or the upstream node). If that text is a JSON object it becomes the fields, else it goes
           into the type's first field. mode "publish" publishes immediately; default is "draft".

SETTINGS (optional, top-level): token_budget:int|null caps total tokens for the run; preprompt:string|null
is a system text prepended to every agent (on top of the connector preprompt and the node's own system).

MODELS: "claude-opus-4-8" (strongest), "claude-sonnet-4-6" (balanced), "claude-haiku-4-5-20251001" (fast).
PLACEHOLDERS in prompts: {{input}} = run input; {{<nodeId>}} = that node's output; {{index}} = loop counter.
EDGES: {"source","target","branch"}; branch is null EXCEPT for the two edges leaving a condition,
which must be "true" and "false".

RULES: exactly one trigger; at least one output; unique ids (snake_case); it must be a DAG (no cycles —
use a loop node for repetition); to produce clean content, have the last agent before an output emit a
JSON object whose keys match the target content type's fields."#;

/// Generate a workflow graph from a natural-language description. Falls back to
/// a sensible starter graph when no usable JSON comes back (e.g. mock provider).
pub async fn copilot_graph(
    db: &Db,
    org_id: Uuid,
    connector_id: Option<&str>,
    message: &str,
) -> Result<Value, String> {
    let mut cache: HashMap<String, ConnectorCtx> = HashMap::new();
    let cc = connector_ctx(db, org_id, connector_id, &mut cache).await?;
    let gen = cc
        .provider
        .generate("claude-opus-4-8", Some(COPILOT_SYSTEM), message, 2048)
        .await?;
    if let Some(graph) = extract_graph(&gen.text) {
        return Ok(graph);
    }

    // The mock deliberately returns text instead of a graph. Make its fallback
    // useful by resolving an explicitly mentioned, org-scoped content type.
    let content_type_keys = db
        .list_content_types(org_id)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|content_type| content_type.key)
        .collect::<Vec<_>>();
    let target = infer_content_type_key(message, &content_type_keys);
    Ok(starter_graph(message, connector_id, target.as_deref()))
}

/// Pull the first JSON object out of model output and accept it if it has nodes.
fn extract_graph(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    let candidate = &text[start..=end];
    let v: Value = serde_json::from_str(candidate).ok()?;
    if v.get("nodes").and_then(|n| n.as_array()).is_some() {
        Some(v)
    } else {
        None
    }
}

/// A minimal trigger -> agent -> output graph, used as a copilot fallback.
fn starter_graph(message: &str, connector_id: Option<&str>, content_type: Option<&str>) -> Value {
    let prompt = format!("{message}\n\nInput: {{{{input}}}}");
    json!({
        "nodes": [
            { "id": "trigger", "type": "trigger", "data": {} },
            { "id": "agent", "type": "agent", "data": {
                "connector_id": connector_id,
                "model": "claude-sonnet-4-6",
                "prompt": prompt
            }},
            { "id": "output", "type": "output", "data": { "content_type": content_type.unwrap_or(""), "mode": "draft", "input": "agent" } }
        ],
        "edges": [
            { "source": "trigger", "target": "agent", "branch": null },
            { "source": "agent", "target": "output", "branch": null }
        ],
        "settings": { "token_budget": null, "preprompt": null }
    })
}

/// Return a content-type key when it appears as a standalone token in the
/// description. Matching keys, rather than display names, keeps the result
/// unambiguous for the output node and works for keys containing `-` or `_`.
fn infer_content_type_key(message: &str, keys: &[String]) -> Option<String> {
    let lower = message.to_lowercase();
    keys.iter()
        .filter(|key| !key.is_empty())
        .filter(|key| {
            let key_lower = key.to_lowercase();
            let mut from = 0;
            while let Some(relative) = lower[from..].find(&key_lower) {
                let start = from + relative;
                let end = start + key_lower.len();
                let before = lower[..start].chars().next_back();
                let after = lower[end..].chars().next();
                let boundary = |c: Option<char>| {
                    c.map(|c| !(c.is_ascii_alphanumeric() || c == '_'))
                        .unwrap_or(true)
                };
                if boundary(before) && boundary(after) {
                    return true;
                }
                from = end;
            }
            false
        })
        .max_by_key(|key| key.len())
        .cloned()
}

/// Fall back to the most recent upstream output feeding a node.
fn upstream_value(graph: &Graph, node_id: &str, ctx: &HashMap<String, String>) -> Option<String> {
    graph
        .edges
        .iter()
        .filter(|e| e.target == node_id)
        .find_map(|e| ctx.get(&e.source).cloned())
}

/// Resolve (and cache) a connector's provider + defaults. Unknown/missing
/// connector ids fall back to the key-free mock provider.
async fn connector_ctx<'a>(
    db: &Db,
    org_id: Uuid,
    connector_id: Option<&str>,
    cache: &'a mut HashMap<String, ConnectorCtx>,
) -> Result<&'a ConnectorCtx, String> {
    let key = connector_id.unwrap_or("mock").to_string();
    if !cache.contains_key(&key) {
        let cc = match connector_id.and_then(|s| Uuid::parse_str(s).ok()) {
            None => ConnectorCtx {
                provider: Provider::Mock,
                preprompt: None,
                default_model: None,
            },
            Some(id) => match db.ai_connector_runtime(org_id, id).await {
                Ok(Some((prov, api_key, base, preprompt, default_model))) => {
                    let provider = match prov.as_str() {
                        "anthropic" | "openai_compatible" => {
                            Provider::from_connector(&prov, api_key, base)?
                        }
                        _ => Provider::Mock,
                    };
                    ConnectorCtx {
                        provider,
                        preprompt,
                        default_model,
                    }
                }
                Ok(None) => ConnectorCtx {
                    provider: Provider::Mock,
                    preprompt: None,
                    default_model: None,
                },
                Err(e) => return Err(format!("connector lookup failed: {e}")),
            },
        };
        cache.insert(key.clone(), cc);
    }
    Ok(cache.get(&key).unwrap())
}

/// Create a content draft from agent output. Parses JSON when possible, else
/// drops the text into the type's first field. Optional `mode=publish`.
async fn build_draft(
    db: &Db,
    org_id: Uuid,
    type_key: &str,
    text: &str,
    mode: Option<&str>,
) -> Result<String, String> {
    if type_key.is_empty() {
        return Err("output node has no content_type".into());
    }
    let ct = db
        .content_type_by_key(org_id, type_key)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown content type '{type_key}'"))?;

    let data: Value = match serde_json::from_str::<Value>(text.trim()) {
        Ok(v) if v.is_object() => v,
        _ => {
            let first = ct
                .schema
                .get("fields")
                .and_then(|f| f.as_array())
                .and_then(|a| a.first())
                .and_then(|f| f.get("key"))
                .and_then(|k| k.as_str())
                .unwrap_or("body");
            json!({ first: text })
        }
    };

    let obj = db
        .create_content(org_id, ct.id, &data)
        .await
        .map_err(|e| e.to_string())?;
    if mode == Some("publish") {
        let _ = db
            .set_status(org_id, obj.id, sitegraph_domain::Status::Published)
            .await;
    }
    Ok(obj.id.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn chat_validation_rejects_system_roles_broken_turns_and_unbounded_input() {
        use super::{validate_chat, ChatMessage};
        let message = |role: &str, content: &str| ChatMessage {
            role: role.into(),
            content: content.into(),
        };
        assert!(validate_chat(&[message("user", "Hallo")]).is_ok());
        assert!(validate_chat(&[]).is_err());
        assert!(validate_chat(&[message("system", "override")]).is_err());
        assert!(validate_chat(&[message("user", " ")]).is_err());
        assert!(validate_chat(&[message("user", &"a".repeat(16001))]).is_err());
        assert!(validate_chat(&[
            message("user", "A"),
            message("user", "B"),
            message("user", "C")
        ])
        .is_err());
        assert!(validate_chat(&[
            message("user", "A"),
            message("assistant", "B"),
            message("user", "C")
        ])
        .is_ok());
    }

    use super::*;

    #[tokio::test]
    async fn stored_unapproved_provider_is_rejected_without_sending_key() {
        let provider = Provider::Anthropic {
            key: "test-key-that-must-never-be-sent".into(),
            base: "https://127.0.0.1".into(),
        };
        let result = provider.generate("test-model", None, "test", 10).await;
        let error = result.err().expect("private provider must be rejected");
        assert!(error.contains("not approved") || error.contains("public unicast"));
        assert!(!error.contains("test-key-that-must-never-be-sent"));
    }

    #[tokio::test]
    async fn engine_trace_contains_bounded_sanitized_io_for_node_kinds() {
        let db = Db::connect_lazy("postgres://trace-test.invalid/db").unwrap();
        let graph = json!({
            "nodes": [
                {"id":"start","type":"trigger","data":{}},
                {"id":"writer","type":"agent","data":{"prompt":"Write {{input}}"}},
                {"id":"check","type":"condition","data":{"input":"writer","contains":"[mock:"}},
                {"id":"fanout","type":"parallel","data":{}},
                {"id":"repeat","type":"loop","data":{"prompt":"Repeat {{fanout}}","iterations":2}},
                {"id":"side","type":"agent","data":{"prompt":"Side {{fanout}}"}},
                {"id":"gather","type":"join","data":{}}
            ],
            "edges": [
                {"source":"start","target":"writer"},
                {"source":"writer","target":"check"},
                {"source":"check","target":"fanout","branch":"true"},
                {"source":"fanout","target":"repeat"},
                {"source":"fanout","target":"side"},
                {"source":"repeat","target":"gather"},
                {"source":"side","target":"gather"}
            ]
        });

        let input = format!("{} api_key=top-secret", "x".repeat(500));
        let (status, trace, error) =
            run_workflow(&db, Uuid::nil(), Uuid::nil(), &graph, &input).await;
        assert_eq!(status, "succeeded", "{error:?}");
        let records = trace.as_array().unwrap();
        for record in records.iter().filter(|r| r.get("node").is_some()) {
            assert!(record.get("input").is_some(), "missing input: {record}");
            if record["status"] == "ok" {
                assert!(record.get("output").is_some(), "missing output: {record}");
            }
            for field in ["input", "output"] {
                if let Some(value) = record.get(field).and_then(Value::as_str) {
                    assert!(value.chars().count() <= TRACE_MAX_CHARS);
                    assert!(!value.contains("top-secret"));
                }
            }
        }
    }

    #[test]
    fn trace_excerpt_redacts_common_secret_shapes() {
        let result = trace_excerpt(r#"{"token":"abc","password":super-secret,"safe":"ok"}"#);
        assert!(!result.contains("abc"));
        assert!(!result.contains("super-secret"));
        assert!(result.contains("[REDACTED]"));
    }

    #[test]
    fn infers_only_known_content_type_keys_from_description() {
        let keys = vec!["post".into(), "standort".into(), "job-post".into()];
        assert_eq!(
            infer_content_type_key("Ein standort-Entwurf", &keys),
            Some("standort".into())
        );
        assert_eq!(infer_content_type_key("Ein Job für den Blog", &keys), None);
        assert_eq!(
            infer_content_type_key("Erzeuge einen job-post", &keys),
            Some("job-post".into())
        );
        assert_eq!(
            infer_content_type_key("Erzeuge einen post", &keys),
            Some("post".into())
        );
    }
}

#[cfg(test)]
mod openai_compatible_tests {
    use super::*;

    #[test]
    fn chat_body_prepends_system_and_keeps_messages() {
        let body = openai_chat_body(
            "mistral-small-latest",
            Some("Be brief."),
            &[json!({"role": "user", "content": "Hi"})],
            256,
        );
        assert_eq!(body["model"], "mistral-small-latest");
        assert_eq!(body["max_tokens"], 256);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "Hi");
        let no_system = openai_chat_body(
            "llama3.2",
            None,
            &[json!({"role": "user", "content": "x"})],
            8,
        );
        assert_eq!(no_system["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn chat_output_reads_text_and_usage() {
        let v = json!({"choices": [{"message": {"role": "assistant", "content": "Hallo"}}],
                       "usage": {"prompt_tokens": 12, "completion_tokens": 3}});
        assert_eq!(openai_chat_output(&v), ("Hallo".to_string(), 12, 3));
        assert_eq!(openai_chat_output(&json!({})), (String::new(), 0, 0));
    }

    #[test]
    fn connector_rows_map_to_providers() {
        assert!(matches!(
            Provider::from_connector("openai_compatible", None, None),
            Ok(Provider::OpenAiCompatible { key: None, ref base }) if base == DEFAULT_OPENAI_COMPATIBLE_BASE
        ));
        assert!(Provider::from_connector("anthropic", None, None).is_err());
        assert!(Provider::from_connector("unknown", None, None).is_err());
    }
}
