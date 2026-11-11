{{- define "fireflint.name" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- define "fireflint.labels" -}}
app.kubernetes.io/name: fireflint
app.kubernetes.io/instance: {{ include "fireflint.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "fireflint.image" -}}
{{- printf "%s@%s" (required "image.repository is required" .repository) (required "image.digest is required" .digest) -}}
{{- end -}}
{{- define "fireflint.claim" -}}
{{- default (printf "%s-assets" (include "fireflint.name" .)) .Values.assets.existingClaim -}}
{{- end -}}
{{- define "fireflint.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
{{- define "fireflint.runtimeEnv" -}}
- name: APP_ENV
  value: production
- name: SITEGRAPH_LOAD_DOTENV
  value: "0"
- name: CORS_ALLOWED_ORIGINS
  value: {{ printf "https://%s" .Values.ingress.host | quote }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef: { name: {{ .Values.runtime.existingSecret | quote }}, key: database-url }
- name: JWT_SECRET
  valueFrom:
    secretKeyRef: { name: {{ .Values.runtime.existingSecret | quote }}, key: jwt-secret }
- name: AI_CONNECTOR_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef: { name: {{ .Values.runtime.existingSecret | quote }}, key: ai-connector-encryption-key }
{{- end -}}
{{- define "fireflint.caMount" -}}
{{- if .Values.database.caSecret }}
- name: database-ca
  mountPath: /etc/fireflint/database
  readOnly: true
{{- end }}
{{- end -}}
{{- define "fireflint.caVolume" -}}
{{- if .Values.database.caSecret }}
- name: database-ca
  secret:
    secretName: {{ .Values.database.caSecret | quote }}
    items: [{ key: {{ .Values.database.caKey | quote }}, path: ca.crt }]
{{- end }}
{{- end -}}

{{- define "fireflint.oidcEnv" -}}
{{- if .Values.oidc.enabled }}
- name: OIDC_ISSUER_URL
  value: {{ .Values.oidc.issuerUrl | quote }}
- name: OIDC_CLIENT_ID
  value: {{ .Values.oidc.clientId | quote }}
- name: OIDC_REQUIRE_APP_GROUP
  value: {{ ternary "true" "false" .Values.oidc.requireAppGroup | quote }}
- name: OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.oidc.existingSecret | quote }}
      key: {{ .Values.oidc.clientSecretKey | quote }}
- name: OIDC_REDIRECT_URI
  value: {{ printf "https://%s/oidc/callback" .Values.ingress.host | quote }}
- name: OIDC_POST_LOGOUT_REDIRECT_URI
  value: {{ printf "https://%s/login" .Values.ingress.host | quote }}
- name: OIDC_LABEL
  value: {{ .Values.oidc.label | quote }}
{{- end }}
{{- end -}}

{{- define "fireflint.instagramEnv" -}}
{{- if .Values.instagram.enabled }}
- name: INSTAGRAM_LOGIN_MODE
  value: {{ .Values.instagram.loginMode | quote }}
{{- if eq .Values.instagram.loginMode "unified" }}
- name: INSTAGRAM_CONFIG_ID
  value: {{ .Values.instagram.configurationId | quote }}
- name: INSTAGRAM_WEBHOOK_VERIFY_TOKEN
  valueFrom:
    secretKeyRef: { name: {{ .Values.instagram.existingSecret | quote }}, key: {{ .Values.instagram.webhookVerifyTokenSecretKey | quote }} }
{{- end }}
- name: INSTAGRAM_APP_ID
  valueFrom:
    secretKeyRef: { name: {{ .Values.instagram.existingSecret | quote }}, key: {{ .Values.instagram.appIdSecretKey | quote }} }
- name: INSTAGRAM_APP_SECRET
  valueFrom:
    secretKeyRef: { name: {{ .Values.instagram.existingSecret | quote }}, key: {{ .Values.instagram.appSecretKey | quote }} }
- name: INSTAGRAM_PUBLIC_ORIGIN
  value: {{ printf "https://%s" .Values.ingress.host | quote }}
- name: INSTAGRAM_API_VERSION
  value: {{ .Values.instagram.apiVersion | quote }}
{{- end }}
{{- end -}}
