import { createApiProxy } from './api-proxy.mjs';

// Run only in the trusted proxy container, never in the agent container.
const apiKey = process.env.AIWB_PROXY_API_KEY;
const accessToken = process.env.AIWB_PROXY_ACCESS_TOKEN;
const server = createApiProxy({ apiKey, accessToken });
server.listen(3128, '0.0.0.0', () => console.log('代理已启动'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.closeAllConnections();
  server.close();
});
