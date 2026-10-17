import { proxyFetch } from "../chat/src/cloud/proxy";
// Bun 会往 fetch 传第二个参数（server），而 proxyFetch 的第二个参数是测试注入点，
// 所以这里显式只透传 request。
Bun.serve({ fetch: (request: Request) => proxyFetch(request) });
