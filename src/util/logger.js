import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  transport: process.env.PINO_PRETTY ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined,
});

export default logger;