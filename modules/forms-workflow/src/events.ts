export const formsEventTypes = {
  draftCreated: "forms.submission.draft_created",
  draftUpdated: "forms.submission.draft_updated",
  submitted: "forms.submission.submitted",
  stateChanged: "forms.submission.state_changed",
  withdrawn: "forms.submission.withdrawn",
  fileUploaded: "forms.file.uploaded",
  consentRecorded: "forms.consent.recorded",
  signatureCreated: "forms.signature.created",
  taskCreated: "forms.task.created",
  taskCompleted: "forms.task.completed",
  notificationSent: "forms.notification.sent",
  integrationPushed: "forms.integration.pushed",
  exportCreated: "forms.export.created",
  retentionApplied: "forms.retention.applied",
} as const;

export type FormsEventType =
  (typeof formsEventTypes)[keyof typeof formsEventTypes];
