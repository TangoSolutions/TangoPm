require('dotenv').config();
const { execSync } = require('child_process');
const express = require('express');

// Auto-run migrations on startup
try {
  execSync('node scripts/migrate.js', { stdio: 'inherit' });
  execSync('node scripts/seed.js', { stdio: 'inherit' });
} catch (err) {
  console.error('Migration/seed failed:', err.message);
}
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const whatsappRoutes = require('./routes/whatsapp');
const voiceRoutes = require('./routes/voice');
const dashboardRoutes = require('./routes/dashboard');
const { startFollowUpCron } = require('./utils/followUpCron');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Rate limiting for webhook endpoints
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: 'Too many requests',
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/whatsapp', webhookLimiter, whatsappRoutes);
app.use('/voice', webhookLimiter, voiceRoutes);
app.use('/api', dashboardRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Aria Leasing Assistant', version: '1.0.0' });
});

// Serve dashboard static files if built
app.use(express.static(path.join(__dirname, '../dashboard/dist')));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../dashboard/dist/index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ message: 'Aria API running. Dashboard not built yet.' });
  }
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`Aria server running on port ${PORT}`);
  startFollowUpCron();
});

module.exports = app;
