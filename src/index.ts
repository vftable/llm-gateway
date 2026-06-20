// Entry point. Loads config and starts the gateway.

import { loadConfig } from "./config";
import { Gateway } from "./gateway";

const config = loadConfig();
const gateway = new Gateway(config);
gateway.start();
