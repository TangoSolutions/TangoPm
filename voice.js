const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const db = require('../db');
const { processMessage } = require('../agents/ghostAgent');
const logger = require('../utils/logger');

// ─── INBOUND VOICE CALL ───────────────────────────────────────────────────────
router.post('/inbound', async (req, res) => {
  const twiml = new VoiceResponse();
  const { From, CallSid } = req.body;
  const tenantPhone = From;

  logger.info(`Voice call from ${tenantPhone}, CallSid: ${CallSid}`);

  // Create or find conversation
  let conversationId;
  try {
    const existing = await db.query(
      `SELECT id FROM conversations WHERE tenant_phone = $1 AND channel = 'voice' AND status = 'active' AND updated_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [tenantPhone]
    );

    if (existing.rows.length) {
      conversationId = existing.rows[0].id;
    } else {
      // Get first available property
      const prop = await db.query('SELECT id, agent_id FROM properties WHERE is_available = true LIMIT 1');
      const result = await db.query(
        `INSERT INTO conversations (tenant_phone, channel, property_id, agent_id, status, stage)
         VALUES ($1, 'voice', $2, $3, 'active', 'greeting')
         RETURNING id`,
        [tenantPhone, prop.rows[0]?.id, prop.rows[0]?.agent_id]
      );
      conversationId = result.rows[0].id;
    }
  } catch (err) {
    logger.error('Voice conversation setup error:', err);
    twiml.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' },
      'Sorry, we\'re experiencing technical difficulties. Please try WhatsApp instead.');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // Greet and gather first input
  const gather = twiml.gather({
    input: 'speech',
    action: `/voice/process?conversationId=${conversationId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-ZA',
    timeout: 5,
  });

  gather.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' },
    'Hi, this is Aria, the leasing assistant. Thanks for calling. Which property are you enquiring about, and how can I help you today?'
  );

  twiml.redirect('/voice/inbound');

  res.type('text/xml').send(twiml.toString());
});

// ─── PROCESS VOICE INPUT ──────────────────────────────────────────────────────
router.post('/process', async (req, res) => {
  const twiml = new VoiceResponse();
  const { SpeechResult, From } = req.body;
  const { conversationId } = req.query;

  if (!SpeechResult) {
    const gather = twiml.gather({
      input: 'speech',
      action: `/voice/process?conversationId=${conversationId}`,
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-ZA',
      timeout: 5,
    });
    gather.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' },
      "Sorry, I didn't catch that. Could you say that again?"
    );
    res.type('text/xml').send(twiml.toString());
    return;
  }

  logger.info(`Voice input from ${From}: ${SpeechResult}`);

  try {
    const result = await processMessage({
      tenantPhone: From,
      message: SpeechResult,
      channel: 'voice',
      conversationId,
    });

    const responseText = result.messages.join(' ... ');

    if (result.stage === 'complete' || result.stage === 'booking') {
      twiml.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, responseText);
      twiml.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' },
        "I'll also send you a WhatsApp message to confirm everything. Thanks for calling — speak soon!"
      );
      twiml.hangup();
    } else {
      const gather = twiml.gather({
        input: 'speech',
        action: `/voice/process?conversationId=${conversationId}`,
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-ZA',
        timeout: 8,
      });
      gather.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, responseText);
    }
  } catch (err) {
    logger.error('Voice processing error:', err);
    twiml.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' },
      'Sorry about that. Please send us a WhatsApp message and we\'ll help you straight away.'
    );
    twiml.hangup();
  }

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
