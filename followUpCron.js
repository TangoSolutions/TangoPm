const cron = require('node-cron');
const twilio = require('twilio');
const db = require('../db');
const logger = require('./logger');

function startFollowUpCron() {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    logger.info('Running follow-up cron...');

    try {
      const due = await db.query(
        `SELECT * FROM followups
         WHERE sent = false
           AND scheduled_for <= NOW()
         LIMIT 20`
      );

      if (!due.rows.length) return;

      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

      for (const followup of due.rows) {
        try {
          if (followup.channel === 'whatsapp') {
            await client.messages.create({
              from: process.env.TWILIO_WHATSAPP_NUMBER,
              to: `whatsapp:${followup.tenant_phone}`,
              body: followup.message,
            });
          }

          await db.query(
            'UPDATE followups SET sent = true, sent_at = NOW() WHERE id = $1',
            [followup.id]
          );

          logger.info(`Follow-up sent to ${followup.tenant_phone}`);
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          logger.error(`Failed follow-up to ${followup.tenant_phone}:`, err.message);
        }
      }
    } catch (err) {
      logger.error('Follow-up cron error:', err);
    }
  });

  logger.info('Follow-up cron started (every 15 minutes)');
}

module.exports = { startFollowUpCron };
