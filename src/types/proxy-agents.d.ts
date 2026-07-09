// Ambient module shims for the proxy-agent packages. Their real types ship
// under an `exports` map that the project's classic `moduleResolution: "Node"`
// setting can't resolve. We only use the constructor + the fact that instances
// are http.Agent subclasses, so a minimal declaration is sufficient and avoids
// changing the whole tsconfig's module resolution (which would risk other imports).

declare module "socks-proxy-agent" {
  import { Agent } from "http";
  export class SocksProxyAgent extends Agent {
    constructor(uri: string, opts?: Record<string, unknown>);
  }
}

declare module "https-proxy-agent" {
  import { Agent } from "http";
  export class HttpsProxyAgent extends Agent {
    constructor(uri: string, opts?: Record<string, unknown>);
  }
}
