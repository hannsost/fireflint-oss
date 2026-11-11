import type {
  ConsentRecord,
  ExportBundle,
  FormDefinition,
  FormsContext,
  FormsEvent,
  IntegrationResult,
  NotificationMessage,
  RetentionPolicy,
  SignatureRecord,
  Submission,
  SubmissionInput,
  SubmissionQuery,
  SubmissionValue,
  UploadedFile,
  ValidationIssue,
  WorkflowDefinition,
  WorkflowTask,
} from "../contracts.js";
import { FormsEngine } from "../engine.js";
import { FormsError } from "../errors.js";
import { formsEventTypes } from "../events.js";
import type {
  FormsCapability,
  FormsModule,
  FormsProfile,
  FormsProviders,
} from "../module.js";
import { b2cFormsProfile } from "../profiles.js";
import {
  defaultReferenceFormsFixtures,
  type ReferenceFormsFixtures,
} from "./fixtures.js";

const referenceCapabilities: FormsCapability[] = [
  "forms",
  "multi-step",
  "drafts",
  "file-uploads",
  "spam-protection",
  "consents",
  "signatures",
  "workflows",
  "tasks",
  "notifications",
  "retention",
  "exports",
  "crm",
  "erp",
  "ats",
  "dms",
  "case-management",
  "formal-applications",
  "xfall",
];

export interface ReferenceForms {
  engine: FormsEngine;
  sandbox: ReferenceFormsSandbox;
}

export interface PublicFormResult {
  submission: Submission;
  confirmation: NotificationMessage;
}

export interface BusinessReviewResult {
  submission: Submission;
  task: WorkflowTask;
  integration: IntegrationResult;
}

export interface GovernmentApplicationResult {
  submission: Submission;
  task: WorkflowTask;
  exportBundle: ExportBundle;
  integration: IntegrationResult;
}

export class ReferenceFormsSandbox {
  readonly events: FormsEvent[] = [];
  readonly providers: FormsProviders;

  readonly #forms = new Map<string, FormDefinition>();
  readonly #workflows = new Map<string, WorkflowDefinition>();
  readonly #policies = new Map<string, RetentionPolicy>();
  readonly #files = new Map<string, UploadedFile>();
  readonly #signatures = new Map<string, SignatureRecord>();
  readonly #submissions = new Map<string, Submission>();
  readonly #tasks = new Map<string, WorkflowTask>();
  readonly #notifications = new Map<string, NotificationMessage>();
  readonly #idempotentSubmissions = new Map<string, string>();
  #sequence = 0;

  constructor(
    readonly profile: FormsProfile,
    fixtures: ReferenceFormsFixtures = defaultReferenceFormsFixtures,
  ) {
    for (const form of fixtures.forms) this.#forms.set(form.id, structuredClone(form));
    for (const workflow of fixtures.workflows) {
      this.#workflows.set(workflow.key, structuredClone(workflow));
    }
    for (const policy of fixtures.retentionPolicies) {
      this.#policies.set(policy.key, structuredClone(policy));
    }
    this.providers = this.createProviders();
  }

  async submitPublicForm(
    context: FormsContext,
    input: SubmissionInput,
  ): Promise<PublicFormResult> {
    const submission = await this.createAndSubmit(context, input);
    const recipient = input.submitterEmail ?? String(input.data.email ?? "");
    const confirmation = await this.providers.notifications.send(context, {
      submissionId: submission.id,
      channel: "email",
      templateKey: "submission-confirmation",
      recipient,
    });
    return { submission, confirmation };
  }

  async submitBusinessRegistration(
    context: FormsContext,
    input: SubmissionInput,
  ): Promise<BusinessReviewResult> {
    this.requireOrganization(context);
    let submission = await this.createAndSubmit(context, input);
    submission = await this.providers.workflows.transition(
      { ...context, actor: { ...context.actor, roles: ["reviewer"] } },
      submission.id,
      "start_review",
    );
    const task = await this.providers.tasks.create(context, {
      submissionId: submission.id,
      key: "verify-company",
      title: "Unternehmen und Nachweise prüfen",
      assigneeRole: "reviewer",
    });
    const integration = await this.providers.integrations.push(
      context,
      "crm",
      submission,
    );
    return { submission, task, integration };
  }

  async submitGovernmentApplication(
    context: FormsContext,
    input: SubmissionInput,
  ): Promise<GovernmentApplicationResult> {
    if (!context.actor?.userId) {
      throw new FormsError(
        "AUTHENTICATION_REQUIRED",
        "Formal applications require an authenticated actor",
      );
    }
    let submission = await this.createAndSubmit(context, input);
    submission = await this.providers.workflows.transition(
      { ...context, actor: { ...context.actor, roles: ["case-worker"] } },
      submission.id,
      "open_case",
    );
    const task = await this.providers.tasks.create(context, {
      submissionId: submission.id,
      key: "formal-review",
      title: "Formale Prüfung durchführen",
      assigneeRole: "case-worker",
    });
    const exportBundle = await this.providers.exports.create(
      context,
      submission.id,
      "xfall",
    );
    const integration = await this.providers.integrations.push(
      context,
      "case_management",
      submission,
    );
    return { submission, task, exportBundle, integration };
  }

  private async createAndSubmit(
    context: FormsContext,
    input: SubmissionInput,
  ): Promise<Submission> {
    this.requireIdempotency(context);
    const existingId = this.#idempotentSubmissions.get(context.idempotencyKey!);
    if (existingId) return structuredClone(this.requireSubmission(existingId));

    const form = this.requireForm(input.formId);
    const spam = await this.providers.spam.assess(context, form, input.data);
    if (!spam.accepted) {
      throw new FormsError("SPAM_REJECTED", "Submission was rejected as spam", {
        reasons: spam.reasons,
      });
    }
    const validation = await this.providers.validation.validate(
      context,
      form,
      input.data,
    );
    if (!validation.valid) {
      throw new FormsError("VALIDATION_FAILED", "Submission is invalid", {
        issues: validation.issues,
      });
    }
    this.assertConsentAndSignature(form, input);
    let submission = await this.providers.submissions.createDraft(context, {
      ...input,
      data: validation.normalizedData ?? input.data,
    });
    submission = await this.providers.submissions.submit(context, submission.id);
    this.#idempotentSubmissions.set(context.idempotencyKey!, submission.id);
    return submission;
  }

  private createProviders(): FormsProviders {
    return {
      definitions: {
        get: async (context, ref) => {
          const form = [...this.#forms.values()].find(
            (item) =>
              item.organizationId === context.organizationId &&
              (item.id === ref.formId || item.key === ref.key),
          );
          return form ? structuredClone(form) : null;
        },
        list: async (context, query = {}) => ({
          items: [...this.#forms.values()]
            .filter((form) => form.organizationId === context.organizationId)
            .filter((form) => !query.keys || query.keys.includes(form.key))
            .filter((form) => !query.status || form.status === query.status)
            .slice(0, query.limit ?? 50)
            .map((form) => structuredClone(form)),
        }),
      },
      validation: {
        validate: async (_context, form, data) => {
          const issues: ValidationIssue[] = [];
          const normalizedData = { ...data };
          for (const field of form.fields) {
            const value = data[field.key];
            const missing =
              value === undefined ||
              value === null ||
              value === "" ||
              (Array.isArray(value) && value.length === 0);
            if (field.required && missing) {
              issues.push({
                field: field.key,
                code: "required",
                message: `${field.label} is required`,
              });
              continue;
            }
            if (field.type === "email" && typeof value === "string") {
              normalizedData[field.key] = value.trim().toLowerCase();
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
                issues.push({
                  field: field.key,
                  code: "email",
                  message: `${field.label} must be a valid email`,
                });
              }
            }
            if (field.type === "number" && typeof value !== "number" && !missing) {
              issues.push({
                field: field.key,
                code: "number",
                message: `${field.label} must be a number`,
              });
            }
          }
          return { valid: issues.length === 0, issues, normalizedData };
        },
      },
      files: {
        upload: async (context, input) => {
          if (input.size > 10 * 1024 * 1024) {
            throw new FormsError("FILE_REJECTED", "File exceeds reference limit");
          }
          const file: UploadedFile = {
            id: this.nextId("file"),
            filename: input.filename,
            mimeType: input.mimeType,
            size: input.size,
            scanState: "clean",
          };
          this.#files.set(file.id, file);
          await this.emit(context, formsEventTypes.fileUploaded, file);
          return structuredClone(file);
        },
        get: async (_context, fileId) => {
          const file = this.#files.get(fileId);
          return file ? structuredClone(file) : null;
        },
        delete: async (_context, fileId) => {
          this.#files.delete(fileId);
        },
      },
      spam: {
        assess: async (_context, _form, data) => {
          const text = Object.values(data).join(" ").toLowerCase();
          const rejected = text.includes("buy followers") || text.includes("casino spam");
          return {
            accepted: !rejected,
            score: rejected ? 0.99 : 0.01,
            reasons: rejected ? ["Reference spam phrase detected"] : [],
          };
        },
      },
      consents: {
        record: async (context, submissionId, consent) => {
          const submission = this.requireSubmission(submissionId);
          const record: ConsentRecord = {
            ...consent,
            id: this.nextId("consent"),
            acceptedAt: consent.accepted ? new Date().toISOString() : undefined,
          };
          submission.consents.push(record);
          await this.emit(context, formsEventTypes.consentRecorded, record);
          return structuredClone(record);
        },
      },
      signatures: {
        create: async (context, input) => {
          const signature: SignatureRecord = {
            ...input,
            id: this.nextId("signature"),
            signedAt: new Date().toISOString(),
          };
          this.#signatures.set(signature.id, signature);
          await this.emit(context, formsEventTypes.signatureCreated, signature);
          return structuredClone(signature);
        },
        verify: async (_context, signatureId) => ({
          valid: this.#signatures.has(signatureId),
          reasons: this.#signatures.has(signatureId)
            ? []
            : ["Signature does not exist"],
        }),
      },
      submissions: {
        createDraft: async (context, input) => this.createDraft(context, input),
        get: async (_context, submissionId) => {
          const submission = this.#submissions.get(submissionId);
          return submission ? structuredClone(submission) : null;
        },
        list: async (context, query = {}) => this.listSubmissions(context, query),
        updateDraft: async (context, submissionId, data) =>
          this.updateDraft(context, submissionId, data),
        submit: async (context, submissionId) =>
          this.transition(context, submissionId, "submit"),
        withdraw: async (context, submissionId, reason) =>
          this.withdraw(context, submissionId, reason),
      },
      workflows: {
        getDefinition: async (_context, key) => {
          const workflow = this.#workflows.get(key);
          return workflow ? structuredClone(workflow) : null;
        },
        evaluate: async (context, submission, transitionKey) =>
          this.evaluateTransition(context, submission, transitionKey),
        transition: async (context, submissionId, transitionKey) =>
          this.transition(context, submissionId, transitionKey),
      },
      tasks: {
        create: async (context, input) => {
          this.requireSubmission(input.submissionId);
          const task: WorkflowTask = {
            ...input,
            id: this.nextId("task"),
            state: "open",
          };
          this.#tasks.set(task.id, task);
          await this.emit(context, formsEventTypes.taskCreated, task);
          return structuredClone(task);
        },
        list: async (_context, submissionId) =>
          [...this.#tasks.values()]
            .filter((task) => task.submissionId === submissionId)
            .map((task) => structuredClone(task)),
        complete: async (context, taskId) => {
          const task = this.#tasks.get(taskId);
          if (!task) throw new FormsError("SUBMISSION_NOT_FOUND", "Task not found");
          task.state = "completed";
          task.completedAt = new Date().toISOString();
          await this.emit(context, formsEventTypes.taskCompleted, task);
          return structuredClone(task);
        },
      },
      notifications: {
        send: async (context, input) => {
          const notification: NotificationMessage = {
            ...input,
            id: this.nextId("notification"),
            state: "sent",
          };
          this.#notifications.set(notification.id, notification);
          await this.emit(context, formsEventTypes.notificationSent, notification);
          return structuredClone(notification);
        },
      },
      retention: {
        getPolicy: async (_context, key) => {
          const policy = this.#policies.get(key);
          return policy ? structuredClone(policy) : null;
        },
        calculate: async (_context, policy, submission) => {
          const days = policy.stateOverrides?.[submission.state] ?? policy.retainForDays;
          return new Date(
            new Date(submission.createdAt).getTime() + days * 86_400_000,
          ).toISOString();
        },
        apply: async (context, submissionId) => {
          const submission = this.requireSubmission(submissionId);
          const form = this.requireForm(submission.formId);
          const policy = form.retentionPolicyKey
            ? this.#policies.get(form.retentionPolicyKey)
            : undefined;
          if (!policy) {
            throw new FormsError(
              "RETENTION_POLICY_NOT_FOUND",
              "Retention policy not found",
            );
          }
          let result: "deleted" | "anonymized" | "review_required";
          if (policy.action === "delete") {
            this.#submissions.delete(submissionId);
            result = "deleted";
          } else if (policy.action === "anonymize") {
            submission.data = {};
            submission.submitter = undefined;
            result = "anonymized";
          } else {
            result = "review_required";
          }
          await this.emit(context, formsEventTypes.retentionApplied, {
            submissionId,
            result,
          });
          return result;
        },
      },
      exports: {
        create: async (context, submissionId, format) => {
          this.requireSubmission(submissionId);
          const bundle: ExportBundle = {
            submissionId,
            format,
            downloadUrl: `https://reference.invalid/forms/${submissionId}.${format}`,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          };
          await this.emit(context, formsEventTypes.exportCreated, bundle);
          return bundle;
        },
      },
      integrations: {
        push: async (context, target, submission) => {
          const result: IntegrationResult = {
            system: target,
            externalId: `${target.toUpperCase()}-${submission.referenceNumber}`,
            status: "accepted",
          };
          await this.emit(context, formsEventTypes.integrationPushed, {
            submissionId: submission.id,
            ...result,
          });
          return result;
        },
      },
      events: {
        publish: async (event) => {
          this.events.push(structuredClone(event));
        },
      },
    };
  }

  private async createDraft(
    context: FormsContext,
    input: SubmissionInput,
  ): Promise<Submission> {
    const form = this.requireForm(input.formId);
    const now = new Date().toISOString();
    const files = (input.fileIds ?? []).map((id) => {
      const file = this.#files.get(id);
      if (!file || file.scanState !== "clean") {
        throw new FormsError("FILE_REJECTED", `File '${id}' is unavailable`);
      }
      return structuredClone(file);
    });
    const signatures = (input.signatureIds ?? []).map((id) => {
      const signature = this.#signatures.get(id);
      if (!signature) {
        throw new FormsError("SIGNATURE_REQUIRED", `Signature '${id}' is unavailable`);
      }
      return structuredClone(signature);
    });
    const consents: ConsentRecord[] = (input.consents ?? []).map((item) => ({
      ...item,
      id: this.nextId("consent"),
      acceptedAt: item.accepted ? now : undefined,
    }));
    const submission: Submission = {
      id: this.nextId("submission"),
      organizationId: context.organizationId,
      channelId: context.channelId,
      formId: form.id,
      formVersion: form.version,
      referenceNumber: `REF-${String(this.#sequence).padStart(6, "0")}`,
      state: "draft",
      data: structuredClone(input.data),
      files,
      consents,
      signatures,
      submitter: {
        userId: context.actor?.userId,
        email: input.submitterEmail,
        customerOrganizationId: context.actor?.customerOrganizationId,
      },
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };
    if (form.retentionPolicyKey) {
      const policy = this.#policies.get(form.retentionPolicyKey);
      if (policy) {
        submission.retentionUntil = await this.providers.retention.calculate(
          context,
          policy,
          submission,
        );
      }
    }
    this.#submissions.set(submission.id, submission);
    await this.emit(context, formsEventTypes.draftCreated, submission);
    return structuredClone(submission);
  }

  private listSubmissions(
    context: FormsContext,
    query: SubmissionQuery,
  ): Submission[] {
    return [...this.#submissions.values()]
      .filter((item) => item.organizationId === context.organizationId)
      .filter((item) => !query.formId || item.formId === query.formId)
      .filter((item) => !query.state || item.state === query.state)
      .filter(
        (item) =>
          !query.submitterEmail || item.submitter?.email === query.submitterEmail,
      )
      .filter(
        (item) =>
          !query.customerOrganizationId ||
          item.submitter?.customerOrganizationId === query.customerOrganizationId,
      )
      .filter((item) => !query.assignedTo || item.assignedTo === query.assignedTo)
      .map((item) => structuredClone(item));
  }

  private async updateDraft(
    context: FormsContext,
    submissionId: string,
    data: Record<string, SubmissionValue>,
  ): Promise<Submission> {
    const submission = this.requireSubmission(submissionId);
    if (submission.state !== "draft" && submission.state !== "waiting_for_information") {
      throw new FormsError(
        "SUBMISSION_NOT_EDITABLE",
        `Submission '${submissionId}' is not editable`,
      );
    }
    submission.data = structuredClone(data);
    submission.updatedAt = new Date().toISOString();
    await this.emit(context, formsEventTypes.draftUpdated, submission);
    return structuredClone(submission);
  }

  private async withdraw(
    context: FormsContext,
    submissionId: string,
    reason?: string,
  ): Promise<Submission> {
    const submission = this.requireSubmission(submissionId);
    if (["completed", "rejected", "withdrawn"].includes(submission.state)) {
      throw new FormsError(
        "TRANSITION_NOT_ALLOWED",
        `Submission '${submissionId}' cannot be withdrawn`,
      );
    }
    submission.state = "withdrawn";
    submission.updatedAt = new Date().toISOString();
    submission.metadata = { ...submission.metadata, withdrawalReason: reason };
    await this.emit(context, formsEventTypes.withdrawn, submission);
    return structuredClone(submission);
  }

  private evaluateTransition(
    context: FormsContext,
    submission: Submission,
    transitionKey: string,
  ): { allowed: boolean; issues: ValidationIssue[] } {
    const form = this.requireForm(submission.formId);
    const workflow = form.workflowKey
      ? this.#workflows.get(form.workflowKey)
      : undefined;
    if (!workflow) {
      throw new FormsError("WORKFLOW_NOT_FOUND", "Workflow not found");
    }
    const transition = workflow.transitions.find((item) => item.key === transitionKey);
    if (!transition || !transition.from.includes(submission.state)) {
      return {
        allowed: false,
        issues: [{ code: "state", message: "Transition is not valid from current state" }],
      };
    }
    const roles = context.actor?.roles ?? [];
    if (
      transition.allowedRoles?.length &&
      !transition.allowedRoles.some((role) => roles.includes(role))
    ) {
      return {
        allowed: false,
        issues: [{ code: "role", message: "Actor lacks required role" }],
      };
    }
    return { allowed: true, issues: [] };
  }

  private async transition(
    context: FormsContext,
    submissionId: string,
    transitionKey: string,
  ): Promise<Submission> {
    const submission = this.requireSubmission(submissionId);
    const form = this.requireForm(submission.formId);
    const workflow = form.workflowKey
      ? this.#workflows.get(form.workflowKey)
      : undefined;
    if (!workflow) throw new FormsError("WORKFLOW_NOT_FOUND", "Workflow not found");
    const transition = workflow.transitions.find((item) => item.key === transitionKey);
    const decision = this.evaluateTransition(context, submission, transitionKey);
    if (!transition || !decision.allowed) {
      throw new FormsError(
        "TRANSITION_NOT_ALLOWED",
        `Transition '${transitionKey}' is not allowed`,
        { issues: decision.issues },
      );
    }
    submission.state = transition.to;
    submission.updatedAt = new Date().toISOString();
    if (transition.to === "submitted") submission.submittedAt = submission.updatedAt;
    await this.emit(
      context,
      transition.to === "submitted"
        ? formsEventTypes.submitted
        : formsEventTypes.stateChanged,
      submission,
    );
    return structuredClone(submission);
  }

  private assertConsentAndSignature(
    form: FormDefinition,
    input: SubmissionInput,
  ): void {
    const consentKeys = form.fields
      .filter((field) => field.type === "consent" && field.required)
      .map((field) => field.key);
    for (const key of consentKeys) {
      if (!input.consents?.some((item) => item.key === key && item.accepted)) {
        throw new FormsError("CONSENT_REQUIRED", `Consent '${key}' is required`);
      }
    }
    const signatureRequired = form.fields.some(
      (field) => field.type === "signature" && field.required,
    );
    if (signatureRequired && !input.signatureIds?.length) {
      throw new FormsError("SIGNATURE_REQUIRED", "A signature is required");
    }
  }

  private requireForm(formId: string): FormDefinition {
    const form = this.#forms.get(formId);
    if (!form) throw new FormsError("FORM_NOT_FOUND", `Form '${formId}' not found`);
    if (form.status !== "published") {
      throw new FormsError("FORM_NOT_PUBLISHED", `Form '${formId}' is not published`);
    }
    return form;
  }

  private requireSubmission(submissionId: string): Submission {
    const submission = this.#submissions.get(submissionId);
    if (!submission) {
      throw new FormsError(
        "SUBMISSION_NOT_FOUND",
        `Submission '${submissionId}' not found`,
      );
    }
    return submission;
  }

  private requireIdempotency(context: FormsContext): void {
    if (!context.idempotencyKey) {
      throw new FormsError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "Submission requires an idempotency key",
      );
    }
  }

  private requireOrganization(context: FormsContext): void {
    if (!context.actor?.customerOrganizationId) {
      throw new FormsError(
        "ORGANIZATION_CONTEXT_REQUIRED",
        "Business workflow requires customer organization context",
      );
    }
  }

  private nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  private async emit(
    context: FormsContext,
    type: string,
    payload: unknown,
  ): Promise<void> {
    await this.providers.events.publish({
      id: this.nextId("event"),
      type,
      organizationId: context.organizationId,
      channelId: context.channelId,
      occurredAt: new Date().toISOString(),
      correlationId: context.correlationId,
      payload,
    });
  }
}

export function createReferenceFormsModule(
  sandbox: ReferenceFormsSandbox,
): FormsModule {
  return {
    manifest: {
      key: "sitegraph-reference-forms",
      name: "SiteGraph Reference Forms",
      version: "0.1.0",
      audiences: ["b2c", "b2b", "b2g"],
      capabilities: referenceCapabilities,
      description: "Non-production in-memory providers for contract and scenario tests.",
    },
    setup(context) {
      for (const [kind, provider] of Object.entries(sandbox.providers)) {
        context.registerProvider(
          kind as keyof FormsProviders,
          provider as FormsProviders[keyof FormsProviders],
        );
      }
    },
  };
}

export async function createReferenceForms(
  profile: FormsProfile = b2cFormsProfile,
  fixtures: ReferenceFormsFixtures = defaultReferenceFormsFixtures,
): Promise<ReferenceForms> {
  const sandbox = new ReferenceFormsSandbox(profile, fixtures);
  const engine = await FormsEngine.create({
    profile,
    modules: [createReferenceFormsModule(sandbox)],
  });
  return { engine, sandbox };
}

export function referenceFormsContext(
  overrides: Partial<FormsContext> = {},
): FormsContext {
  return {
    organizationId: "tenant-1",
    channelId: "channel-main",
    locale: "de-DE",
    correlationId: "forms-reference",
    ...overrides,
  };
}
