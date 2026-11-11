{{- define "sitegraph-operator.name" -}}
sitegraph-storage-operator
{{- end }}

{{- define "sitegraph-operator.fullname" -}}
{{ include "sitegraph-operator.name" . }}
{{- end }}

