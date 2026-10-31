import path from 'node:path';
const config = { outputFileTracingRoot: path.resolve('.'), allowedDevOrigins: ['127.0.0.1'], experimental: { externalDir: true } };
export default config;
