const closeServer = (server) => {
  if (!server) return Promise.resolve();
  server.closeIdleConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

export const createShutdownController = ({
  server = null,
  pool,
  stoppers = [],
  timeoutMs = 10_000,
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  logger = console,
} = {}) => {
  let shutdownPromise;

  const shutdown = (signal = "shutdown") => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info?.(`[shutdown] received ${signal}`);
      const timeout = setTimer(() => {
        logger.error?.(`[shutdown] exceeded ${timeoutMs}ms grace period`);
        exit(1);
      }, timeoutMs);
      timeout?.unref?.();

      try {
        // Stop accepting new HTTP work immediately, then drain workers before
        // closing the shared PostgreSQL pool. Both drains may overlap safely.
        const closingServer = closeServer(server);
        for (const stop of stoppers) await stop?.();
        await closingServer;
        await pool?.end?.();
        timeout?.close?.();
        exit(0);
      } catch (error) {
        timeout?.close?.();
        logger.error?.("[shutdown] graceful shutdown failed", error);
        exit(1);
      }
    })();
    return shutdownPromise;
  };

  return { shutdown };
};
