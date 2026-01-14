import dotenv from 'dotenv';
dotenv.config();

const config = {
  baseUrl: process.env.BASE_URL || process.env.KASHFLOW_BASE_URL || 'https://api.kashflow.com/v2',
  token: process.env.SESSION_TOKEN || process.env.KASHFLOW_SESSION_TOKEN || '',
  timeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 30000),
  concurrency: Number(process.env.CONCURRENCY || 4),
  mongoUri: process.env.MONGO_URI || '',
  mongoDbName: process.env.MONGO_DB_NAME || '',
};

export default config;