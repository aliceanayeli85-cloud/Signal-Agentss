import { createApp } from './app.js';
import { closeDb, initDb } from './db/index.js';
import { seedDefaults } from './db/seed.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';

function bootstrap(): void {
  if (env.liveTradingEnabled) {
    // There is no execution code in this repository. If this flag is somehow set,
    // refuse to start rather than let anyone believe execution is wired up.
    logger.error(
      'ENABLE_LIVE_TRADING is set, but this application implements no execution path. Refusing to start.',
    );
    process.exit(1);
  }

  try {
    const db = initDb(env.databasePath);
    seedDefaults(db);
  } catch (error) {
    logger.error('database initialisation failed', { error });
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, env.host, () => {
    logger.info('MemeTrader OS API listening', {
      url: `http://${env.host}:${env.port}`,
      env: env.nodeEnv,
    });
  });

  server.on('error', (error) => {
    logger.error('server error', { error });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason });
  });
}

bootstrap();
