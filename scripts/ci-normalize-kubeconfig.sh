#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:-}"
context="${2:-${KUBE_CONTEXT:-honey}}"

if [ -z "$kubeconfig" ]; then
  echo "::error::usage: scripts/ci-normalize-kubeconfig.sh <kubeconfig> [context]"
  exit 64
fi

if [ ! -s "$kubeconfig" ]; then
  echo "::error::kubeconfig path is empty or missing"
  exit 66
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "::error::kubectl is required to normalize kubeconfig routing"
  exit 69
fi

cluster_name="$(kubectl --kubeconfig "$kubeconfig" config view -o "jsonpath={.contexts[?(@.name==\"${context}\")].context.cluster}")"
if [ -z "$cluster_name" ]; then
  echo "::error::could not find cluster for kubeconfig context ${context}"
  exit 65
fi

if [ -n "${KUBERNETES_SERVICE_HOST:-}" ]; then
  api_server="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS:-443}"
  kubectl --kubeconfig "$kubeconfig" config set-cluster "$cluster_name" --server="$api_server" >/dev/null
  echo "Normalized kubeconfig cluster endpoint for in-cluster runner context ${context}"
fi

kubectl --kubeconfig "$kubeconfig" config use-context "$context" >/dev/null
kubectl --kubeconfig "$kubeconfig" --context "$context" version --request-timeout=15s >/dev/null
