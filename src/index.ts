import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import routes from './routes/index.js';
import { initSocket } from './socket.js';
import { startTrialReminderJob } from './jobs/trialReminder.js';
import { startPayoutReminderJob } from './jobs/payoutReminder.js';
import { startSubscriptionExpiryJob } from './jobs/subscriptionExpiry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config();

// Validate required secrets on startup
if (!process.env.JWT_SECRET) { console.error('FATAL: JWT_SECRET is not set'); process.exit(1); }
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) { console.error('FATAL: JWT_SECRET must be at least 32 characters'); process.exit(1); }

// Allowed origins: comma-separated list in CORS_ORIGIN env var, or '*' for local dev
const allowedOrigins: string | string[] = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : '*';

const corsOptions = { origin: allowedOrigins, credentials: true };

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { ...corsOptions, methods: ['GET', 'POST'] },
});
initSocket(io);
const PORT = process.env.PORT || 5000;

// Security headers
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(cors(corsOptions));


// Serve uploaded files as static assets
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Capture raw body for Paystack webhook HMAC verification, then parse JSON for everything else
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/payment/webhook') {
    let data = Buffer.alloc(0);
    req.on('data', (chunk: Buffer) => { data = Buffer.concat([data, chunk]); });
    req.on('end', () => {
      (req as any).rawBody = data;
      next();
    });
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

app.get('/', (_req, res) => {
  res.json({ message: 'Selliberation API is running' });
});

app.use('/', routes);

// Global error handler — catches any unhandled error thrown in route handlers
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not defined in .env');
  process.exit(1);
}


console.log('[MongoDB] Connecting to database...');

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
  .then(() => {
    const db = mongoose.connection;
    console.log('✅ MongoDB connected successfully');
    console.log(`   Host     : ${db.host}`);
    console.log(`   Database : ${db.name}`);
    console.log(`   State    : ${db.readyState === 1 ? 'connected' : 'unknown'}`);
    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
    startTrialReminderJob();
    startPayoutReminderJob();
    startSubscriptionExpiryJob();
  })
  
  .catch((err: Error) => {
    console.error('❌ MongoDB connection FAILED');
    console.error(`   Reason: ${err.message}`);
    process.exit(1);
  });

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  [MongoDB] Disconnected — attempting reconnect...');
  mongoose.connect(MONGO_URI);
});

mongoose.connection.on('error', (err: Error) => {
  console.error('❌ [MongoDB] Connection error:', err.message);
});
