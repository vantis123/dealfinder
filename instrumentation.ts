// Next.js calls register() once on server boot. We keep Node-only code (the daily scheduler, which uses
// node:child_process) in a separate file imported ONLY for the Node runtime — otherwise the edge/client
// bundler chokes on node: built-ins.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
