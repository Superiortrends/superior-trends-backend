import http from 'http';
import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { initSocketIO } from './socket/socket.js';
import { sweepUnpaidOnlineOrders } from './services/orderPayment.service.js';

const startServer = async () => {
  await connectDB();

  const httpServer = http.createServer(app);
  initSocketIO(httpServer);

  // Every 10 minutes: resolve online orders whose Thawani payment was never completed
  // (cancel them and give the stock back, or mark them paid if Thawani says they were paid).
  const sweepTimer = setInterval(() => {
    sweepUnpaidOnlineOrders()
      .then((r) => {
        if (r.cancelled || r.paid) console.log(`🧹 Unpaid-order sweep: ${r.cancelled} cancelled, ${r.paid} marked paid`);
      })
      .catch((e) => console.error('Unpaid-order sweep failed:', e));
  }, 10 * 60_000);
  sweepTimer.unref();

  httpServer.listen(env.PORT, () => {
    console.log(`🚀 Server running in ${env.NODE_ENV} mode on http://localhost:${env.PORT}`);
    console.log(`🔌 WebSocket ready for real-time order updates`);
  });

  process.on('unhandledRejection', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Unhandled Rejection: ${message}`);
    httpServer.close(() => process.exit(1));
  });
};

startServer();
