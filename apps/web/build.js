// The shared .env describes the API's local runtime. A web production build must
// set NODE_ENV before Vite reads it, including production-only shell registration.
process.env.NODE_ENV = 'production';
const { build } = await import('vite');
await build({ configLoader: 'native' });
