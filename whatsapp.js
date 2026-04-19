const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const db = require('../db');
const { processMessage } = require('../agents/ghostAgent');
const logger = require('../utils/logger');

// ─── SEND WHATSAPP MESSAGE ────────────────────────────────────────────────────
async function sendWhatsApp(to, messages) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  for (let i = 0; i < messages.length; i++) {
    // Simulate human typing delay
    if (i > 0) await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));

    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${to}`,
      body: messages[i],
    });
  }
}

// ─── FIND OR CREATE CONVERSATION ─────────────────────────────────────────────
async function findOrCreateConversation(tenantPhone, propertyKeyword) {
  // Try to find active conversation
  const existing = await db.query(
    `SELECT c.*, p.id as matched_property_id
     FROM conversations c
     LEFT JOIN properties p ON p.id = c.property_id
     WHERE c.tenant_phone = $1
       AND c.status = 'active'
       AND c.updated_at > NOW() - INTERVAL '48 hours'
     ORDER BY c.updated_at DESC
     LIMIT 1`,
    [tenantPhone]
  );

  if (existing.rows.length) return existing.rows[0].id;

  // Try to match property from message keywords
  let propertyId = null;
  let agentId = null;

  if (propertyKeyword) {
    const propMatch = await db.query(
      `SELECT id, agent_id FROM properties
       WHERE is_available = true
         AND (LOWER(title) LIKE $1 OR LOWER(suburb) LIKE $1 OR LOWER(address) LIKE $1)
       LIMIT 1`,
      [`%${propertyKeyword.toLowerCase()}%`]
    );
    if (propMatch.rows.length) {
      propertyId = propMatch.rows[0].id;
      agentId = propMatch.rows[0].agent_id;
    }
  }

  // If no match, get first available property (demo mode)
  if (!propertyId) {
    const anyProp = await db.query(
      'SELECT id, agent_id FROM properties WHERE is_available = true LIMIT 1'
    );
    if (anyProp.rows.length) {
      propertyId = anyProp.rows[0].id;
      agentId = anyProp.rows[0].agent_id;
    }
  }

  const result = await db.query(
    `INSERT INTO conversations (tenant_phone, channel, property_id, agent_id, status, stage)
     VALUES ($1, 'whatsapp', $2, $3, 'active', 'greeting')
     RETURNING id`,
    [tenantPhone, propertyId, agentId]
  );

  return result.rows[0].id;
}

// ─── WHATSAPP INBOUND WEBHOOK ─────────────────────────────────────────────────
router.post('/inbound', async (req, res) => {
  // Respond to Twilio immediately (required within 5s)
  res.status(200).send('<Response></Response>');

  const { From, Body, ProfileName } = req.body;

  if (!From || !Body) return;

  const tenantPhone = From.replace('whatsapp:', '');
  const message = Body.trim();

  logger.info(`WhatsApp inbound from ${tenantPhone}: ${message}`);

  try {
    // Extract property keyword from message (e.g. "Sea Point", "Woodstock")
    const propertyKeyword = extractPropertyKeyword(message);

    const conversationId = await findOrCreateConversation(tenantPhone, propertyKeyword);

    // Save tenant name if available
    if (ProfileName) {
      await db.query(
        'UPDATE conversations SET tenant_name = $1 WHERE id = $2 AND tenant_name IS NULL',
        [ProfileName, conversationId]
      );
    }

    const result = await processMessage({
      tenantPhone,
      message,
      channel: 'whatsapp',
      conversationId,
    });

    // Add typing delay before first message (feels human)
    await new Promise(r => setTimeout(r, 800 + Math.random() * 700));

    await sendWhatsApp(tenantPhone, result.messages);

    logger.info(`Replied to ${tenantPhone}: stage=${result.stage}, status=${result.qualificationStatus}`);
  } catch (err) {
    logger.error('WhatsApp processing error:', err);
    try {
      await sendWhatsApp(tenantPhone, ["Sorry, give me one moment — I'll be right back with you."]);
    } catch {}
  }
});

// ─── STATUS WEBHOOK ───────────────────────────────────────────────────────────
router.post('/status', (req, res) => {
  logger.info('WhatsApp status update:', req.body.MessageStatus);
  res.sendStatus(200);
});

function extractPropertyKeyword(message) {
  const suburbs = ['sea point', 'green point', 'woodstock', 'observatory', 'claremont',
    'rondebosch', 'newlands', 'kenilworth', 'wynberg', 'bergvliet', 'constantia',
    'camps bay', 'bantry bay', 'fresnaye', 'de waterkant', 'bo-kaap', 'gardens',
    'oranjezicht', 'tamboerskloof', 'vredehoek', 'century city', 'milnerton',
    'bellville', 'tygervalley', 'durbanville', 'brackenfell', 'strand', 'somerset west'];

  const lower = message.toLowerCase();
  return suburbs.find(s => lower.includes(s)) || null;
}

module.exports = router;
