import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  redact: {
    paths: [
      'password',
      'Password',
      'USERNAME',
      'username',
      'MEMORABLE_WORD',
      'memorableWord',
      'Authorization',
      'headers.Authorization',
      'config.headers.Authorization',
      'config.data',
      'err.config.data',
      'data.password',
      'data.Password',
      'data.MemorableWordList',
      'MemorableWordList',
      'TemporaryToken',
      'SessionToken',
      'token',
      'Token',
    ],
    censor: '[REDACTED]',
  },
  transport: process.env.PINO_PRETTY ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined,
});

export default logger;