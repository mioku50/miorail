import { app } from './app';

const port = process.env.PORT || 3000;

export function startServer() {
  const server = app.listen(port, () => {
    console.log(`API Server listening on port ${port}`);
  });
  return server;
}

// Start server if run directly
if (require.main === module) {
  startServer();
}

export { app };
