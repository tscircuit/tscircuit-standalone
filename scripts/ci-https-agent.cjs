// Node 19+ gives the global HTTPS agent a five-second socket timeout. The
// legacy sharp installer uses it without an explicit timeout and aborts slow
// GitHub release redirects. Scope this longer, finite timeout to CI installs.
// Explicit request timeouts and TLS certificate verification still apply.
require("node:https").globalAgent.options.timeout = 60_000
