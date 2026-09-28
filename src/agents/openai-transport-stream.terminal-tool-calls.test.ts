// Runs the terminal tool-call reconciliation suite against the source transport.
import { describeTerminalToolCallReconciliation } from "./openai-transport-stream.terminal-tool-calls.test-suite.js";
import { testing } from "./openai-transport-stream.test-support.js";

describeTerminalToolCallReconciliation("source", testing.processResponsesStream);
