# Deployment des FireFlint Storage Operators

## Kustomize

```bash
kubectl apply -k deploy/operator
kubectl apply -f deploy/operator/examples/status-only.yaml
kubectl get sgsp,sgds,sgsb -n sitegraph-system
```

Das Beispiel bleibt bis O3 bewusst bei `SiteGraphDataStore=Pending`.

## Berechtigungsgrenze (ab O3)

Der Operator darf:

- FireFlint-CRDs lesen, beobachten und ihre Finalizer/Status aktualisieren
- seine Leader-Election-Lease lesen, erzeugen und aktualisieren
- für die Provisionierung (O3) genau diese Ressourcen verwalten:
  Secrets, Services, ConfigMaps, PersistentVolumeClaims (core), StatefulSets
  (apps), Jobs (batch) sowie Events erzeugen/patchen

Alle Rechte sind auf `sitegraph-system` beziehungsweise den Helm-
Release-Namespace begrenzt (kein `cluster-admin`). Ein clusterweiter
Betriebsmodus benötigt eine eigene, explizite RBAC-Variante.
