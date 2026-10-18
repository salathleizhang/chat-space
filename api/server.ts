import { proxyFetch } from "../chat/src/cloud/proxy";
Bun.serve({ fetch: proxyFetch });
