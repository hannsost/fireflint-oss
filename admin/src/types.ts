// Mirrors the SiteGraph API JSON shapes (see /openapi.json).

export type Role = "owner" | "editor" | "viewer";
export type Status = "draft" | "published";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Membership {
  org_id: string;
  org_name: string;
  role: Role;
}

export interface OrgMember {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface FieldDef {
  key: string;
  label: string;
  type: string; // text | richtext | select | date | number | media | relation-ref
  required: boolean;
  ref_type?: string | null; // target content type key for relation-ref
}

export interface ContentType {
  id: string;
  org_id: string;
  key: string;
  name: string;
  schema: { fields?: FieldDef[] };
}

export interface ContentObject {
  id: string;
  org_id: string;
  content_type_id: string;
  revision: number;
  publication: ContentPublication | null;
  has_unpublished_changes: boolean;
  status: Status;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ContentPublication {
  data: Record<string, unknown>;
  assignments: ChannelAssignment[];
  revision: number;
  published_at: string;
}

export interface Website {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  domain?: string | null;
  created_at: string;
}

export interface ChannelAssignment {
  website_id: string;
  overrides?: Record<string, unknown> | null;
}

export interface ContentVersion {
  id: string;
  content_object_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface ApiToken {
  id: string;
  name: string;
  website_id: string | null;
}

export interface Webhook {
  id: string;
  org_id: string;
  url: string;
  active: boolean;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  response_status?: number | null;
  last_error?: string | null;
  created_at: string;
  delivered_at?: string | null;
}

export interface OrgOverview {
  content_total: number;
  content_published: number;
  content_types: number;
  websites: number;
  assets: number;
  members: number;
}

export interface Schedule {
  schedule_revision: number;
  revision: number;
  publish_revision: number | null;
  publish_conflict: boolean;
  publish_at?: string | null;
  unpublish_at?: string | null;
}

export interface Asset {
  id: string;
  org_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  created_at: string;
  url: string;
}

export interface AuditEntry {
  id: string;
  user_id?: string | null;
  user_email?: string | null;
  action: string;
  target_type: string;
  target_id?: string | null;
  meta?: Record<string, unknown> | null;
  created_at: string;
}

// --- AI workflows (v3) ---

export interface AiConnector {
  id: string;
  org_id: string;
  name: string;
  provider: string; // "anthropic" | "openai_compatible" | "mock"
  active: boolean;
  has_key: boolean;
  preprompt?: string | null;
  default_model?: string | null;
  created_at: string;
}

// A workflow graph node. `type` is the engine kind; `data` holds config plus a
// `__pos` hint used to restore the canvas layout (ignored by the engine).
export interface WorkflowNode {
  id: string;
  type: string; // trigger | agent | condition | loop | parallel | join | output
  data: Record<string, unknown> & { __pos?: { x: number; y: number } };
}

export interface WorkflowEdge {
  source: string;
  target: string;
  branch?: string | null; // for condition outputs: "true" | "false"
}

export interface WorkflowSettings {
  token_budget?: number | null;
  preprompt?: string | null;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings?: WorkflowSettings;
}

export interface AiWorkflow {
  id: string;
  org_id: string;
  name: string;
  graph: WorkflowGraph;
  created_at: string;
  updated_at: string;
}

export interface AiRun {
  id: string;
  workflow_id: string;
  status: "running" | "succeeded" | "failed";
  trace: Array<Record<string, unknown>>;
  error?: string | null;
  created_at: string;
  finished_at?: string | null;
}

// --- Data residency / storage (control-plane read view) ---

export type StorageStatus =
  | "pending"
  | "provisioning"
  | "ready"
  | "migrating"
  | "degraded"
  | "restoring"
  | "deleting";

export type IsolationTopology =
  | "shared_row"
  | "schema_per_tenant"
  | "database_per_tenant"
  | "cluster_per_tenant"
  | "external";

export interface StorageTarget {
  id: string;
  topology: IsolationTopology;
  region: string;
  status: StorageStatus;
  organization_id?: string | null;
  schema_version?: string | null;
  endpoint_ref: string;
  revision: number;
}

// Selector keys are camelCase (serde rename_all on the wire type).
export interface BindingSelector {
  organizationId?: string | null;
  domain?: string | null;
  dataCategory?: string | null;
  minimumClassification?: string | null;
  region?: string | null;
}

export interface StorageBinding {
  id: string;
  target_id: string;
  priority: number;
  fallback: boolean;
  selector: BindingSelector;
  active_from?: string | null;
  active_until?: string | null;
  revision: number;
}

// --- Cluster view (read-only BFF) ---

export interface OperatorHealth {
  name: string;
  ready: string;
  healthy: boolean;
  present: boolean;
}

export interface PodView {
  name: string;
  phase: string;
  ready: string;
  restarts: number;
  reason?: string | null;
}

export interface WorkloadView {
  name: string;
  kind: string;
  ready: string;
  image?: string | null;
}

export interface VolumeView {
  name: string;
  phase: string;
  capacity?: string | null;
  storage_class?: string | null;
}

export interface ClusterOverview {
  namespace: string;
  operator: OperatorHealth;
  pods: PodView[];
  workloads: WorkloadView[];
  volumes: VolumeView[];
}
