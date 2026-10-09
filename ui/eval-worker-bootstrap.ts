import { installEvalWorkerPolicy } from "./eval-worker-policy"

// This side effect must precede evaluator initialization in the single worker
// bundle. A dynamic-import bootstrap would lose early Comlink config messages.
export const evalWorkerPolicy = installEvalWorkerPolicy()
