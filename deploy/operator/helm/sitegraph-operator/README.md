# Helm Chart

CRDs werden vor dem Chart aus dem versionierten Manifest installiert:

```bash
kubectl apply -f deploy/operator/crds/sitegraph-crds.yaml
helm upgrade --install sitegraph-operator \
  deploy/operator/helm/sitegraph-operator \
  --namespace sitegraph-system --create-namespace
```

Die bewusste Trennung verhindert, dass Helm CRDs bei normalen Chart-Upgrades
unkontrolliert ersetzt oder gelöscht.

