import { loadDispatchConfig, inspectNativeDispatchOwners } from "../src/state/thread-dispatch.js";
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--config" || args[2] !== "--inspect" || !args[1])
  throw new Error("NATIVE_OWNER_INSPECT_USAGE");
process.env.OPENCLAW_THREAD_DISPATCH_CONFIG = args[1];
const config = loadDispatchConfig();
if (!config) throw new Error("NATIVE_OWNER_INSPECT_CONFIG");
process.stdout.write(JSON.stringify(inspectNativeDispatchOwners(config)) + "\n");
