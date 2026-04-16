const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── LAYER 1: INTENT INTERPRETER ─────────────────────────────────────────────
async function interpretIntent(message, conversationHistory, currentStage) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: `You are an intent classifier for a property leasing assistant in South Africa.
Classify the user's message into one of these intents:
- availability_check: asking if property is available
- income_response: sharing their income/salary
- deposit_response: answering about deposit
- move_date_response: sharing when they want to move
- employment_response: sharing employment status
- booking_request: wants to book a viewing
- general_question: asking about the property
- yes: affirmative response
- no: negative response
- unclear: cannot determine intent

Current conversation stage: ${currentStage}

Respond with ONLY a JSON object:
{"intent": "...", "extracted_value": "...", "confidence": "high|medium|low"}

For extracted_value: extract the actual value (e.g. "R35000", "1 June", "yes", "employed")`,
    messages: [{ role: 'user', content: `Message: "${message}"` }],
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { intent: 'unclear', extracted_value: null, confidence: 'low' };
  }
}

// ─── LAYER 2: CONVERSATION STRATEGIST ────────────────────────────────────────
function getStrategy(stage, tenantData, property) {
  const rent = property?.monthly_rent || 0;
  const strategies = {
    greeting: {
      goal: 'confirm_availability_and_start_qualification',
      nextStage: 'income',
      questions: ['confirm availability', 'ask when they want to move'],
    },
    income: {
      goal: 'capture_income',
      nextStage: 'deposit',
      questions: ['ask monthly income naturally'],
      hint: `Property rent is R${rent.toLocaleString()}. Need income of at least R${(rent * 3).toLocaleString()}`,
    },
    deposit: {
      goal: 'capture_deposit_readiness',
      nextStage: 'move_date',
      questions: ['ask if deposit is available', `deposit is R${(rent * 2).toLocaleString()}`],
    },
    move_date: {
      goal: 'capture_move_date',
      nextStage: 'employment',
      questions: ['ask when they want to move in'],
    },
    employment: {
      goal: 'capture_employment',
      nextStage: 'scoring',
      questions: ['ask if employed, self-employed, or other'],
    },
    scoring: {
      goal: 'score_and_respond',
      nextStage: 'booking',
      questions: ['deliver result and offer viewing if qualified'],
    },
    booking: {
      goal: 'book_viewing',
      nextStage: 'complete',
      questions: ['get preferred viewing time'],
    },
  };
  return strategies[stage] || strategies.greeting;
}

// ─── LAYER 3: HUMANIZER ───────────────────────────────────────────────────────
async function humanize(strategy, tenantData, property, conversationHistory, intent) {
  const rent = property?.monthly_rent || 0;
  const propertyTitle = property?.title || 'the apartment';
  const suburb = property?.suburb || '';

  const systemPrompt = `You are Aria, a leasing assistant for a property management company in South Africa.

PERSONALITY:
- Warm, professional, and efficient - like a smart junior leasing agent
- You text like a real person: short messages, natural language, no corporate speak
- Never say "I am an AI" or "As an AI assistant"
- Never use: "Certainly!", "Absolutely!", "Of course!", "Great question!"
- Avoid long messages. Max 2-3 short sentences per message.
- Use South African context naturally (Rands, local suburbs, etc.)

CURRENT GOAL: ${strategy.goal}
PROPERTY: ${propertyTitle}${suburb ? `, ${suburb}` : ''} — R${rent.toLocaleString()}/month
TENANT DATA COLLECTED SO FAR: ${JSON.stringify(tenantData)}

RULES:
- Ask ONE question at a time maximum
- Be conversational, not form-like
- If asking about income, be casual: "Just to make sure it's a good fit — what's your monthly income?"
- Never mention "qualification" or "pre-screening" to the tenant
- If tenant is unqualified: be kind, honest, brief. No false hope.
- Messages should feel like WhatsApp texts, not emails

Respond with a JSON array of message strings (1-3 messages max):
["message 1", "message 2 if needed"]`;

  const historyMessages = conversationHistory.slice(-6).map(m => ({
    role: m.role,
    content: m.content,
  }));

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: systemPrompt,
    messages: [
      ...historyMessages,
      {
        role: 'user',
        content: `Strategy hints: ${strategy.questions.join(', ')}. Intent detected: ${intent.intent}. Generate Aria's next response.`,
      },
    ],
  });

  try {
    const text = response.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return ["Sorry, one moment! Let me just check that for you."];
  }
}

// ─── QUALIFICATION SCORER ─────────────────────────────────────────────────────
function scoreQualification(tenantData, property) {
  const rent = property?.monthly_rent || 0;
  let score = 0;
  let reasons = [];

  const income = tenantData.monthly_income || 0;
  const coIncome = tenantData.co_applicant_income || 0;
  const totalIncome = income + coIncome;
  const incomeRatio = rent > 0 ? totalIncome / rent : 0;

  // Income check (most important - 40 points)
  if (incomeRatio >= 3.5) score += 40;
  else if (incomeRatio >= 3.0) score += 30;
  else if (incomeRatio >= 2.5) score += 15;
  else {
    reasons.push(`Income too low (ratio ${incomeRatio.toFixed(1)}x, need 3x)`);
  }

  // Deposit ready (30 points)
  if (tenantData.deposit_available === true) score += 30;
  else if (tenantData.deposit_available === false) {
    reasons.push('Deposit not available');
  }

  // Move date fit (20 points)
  if (tenantData.move_date) {
    const moveDate = new Date(tenantData.move_date);
    const availableFrom = property?.available_from ? new Date(property.available_from) : new Date();
    const daysDiff = Math.abs((moveDate - availableFrom) / (1000 * 60 * 60 * 24));
    if (daysDiff <= 30) score += 20;
    else if (daysDiff <= 60) score += 10;
    else reasons.push('Move date too far out');
  }

  // Employment (10 points)
  if (['employed', 'self-employed', 'business owner'].includes(tenantData.employment_status?.toLowerCase())) {
    score += 10;
  } else {
    reasons.push('Employment status unclear');
  }

  let status;
  if (score >= 70) status = 'qualified';
  else if (score >= 45) status = 'borderline';
  else status = 'unqualified';

  return {
    score,
    status,
    income_ratio: incomeRatio,
    disqualification_reason: reasons.join('; ') || null,
  };
}

// ─── EXTRACT TENANT DATA FROM INTENT ─────────────────────────────────────────
function extractTenantData(intent, currentData = {}) {
  const updated = { ...currentData };

  if (intent.intent === 'income_response' && intent.extracted_value) {
    const num = parseInt(intent.extracted_value.replace(/[^0-9]/g, ''));
    if (!isNaN(num)) updated.monthly_income = num;
  }

  if (intent.intent === 'deposit_response') {
    updated.deposit_available = ['yes', 'true', 'available', 'have it'].some(w =>
      intent.extracted_value?.toLowerCase().includes(w)
    );
  }

  if (intent.intent === 'move_date_response' && intent.extracted_value) {
    updated.move_date_raw = intent.extracted_value;
  }

  if (intent.intent === 'employment_response' && intent.extracted_value) {
    updated.employment_status = intent.extracted_value;
  }

  return updated;
}

// ─── ADVANCE STAGE ────────────────────────────────────────────────────────────
function advanceStage(currentStage, intent, tenantData) {
  const stageOrder = ['greeting', 'income', 'deposit', 'move_date', 'employment', 'scoring', 'booking', 'complete'];
  const currentIndex = stageOrder.indexOf(currentStage);

  // Auto-advance when we have what we need
  const shouldAdvance = {
    greeting: true,
    income: !!tenantData.monthly_income,
    deposit: tenantData.deposit_available !== undefined,
    move_date: !!tenantData.move_date_raw,
    employment: !!tenantData.employment_status,
    scoring: true,
    booking: intent.intent === 'booking_request' || intent.intent === 'yes',
  };

  if (shouldAdvance[currentStage] && currentIndex < stageOrder.length - 1) {
    return stageOrder[currentIndex + 1];
  }

  return currentStage;
}

// ─── MAIN GHOST AGENT ─────────────────────────────────────────────────────────
async function processMessage({ tenantPhone, message, channel, conversationId }) {
  // Load conversation
  let conv = await db.query(
    'SELECT * FROM conversations WHERE id = $1',
    [conversationId]
  );

  if (!conv.rows.length) {
    throw new Error('Conversation not found');
  }

  const conversation = conv.rows[0];
  const messages = conversation.messages || [];
  const currentStage = conversation.stage || 'greeting';

  // Load property
  let property = null;
  if (conversation.property_id) {
    const propResult = await db.query('SELECT * FROM properties WHERE id = $1', [conversation.property_id]);
    property = propResult.rows[0] || null;
  }

  // Load tenant profile data
  let tenantData = {};
  const profileResult = await db.query(
    'SELECT * FROM tenant_profiles WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
    [conversationId]
  );
  if (profileResult.rows.length) {
    const p = profileResult.rows[0];
    tenantData = {
      monthly_income: p.monthly_income,
      deposit_available: p.deposit_available,
      move_date_raw: p.move_date,
      employment_status: p.employment_status,
      applying_alone: p.applying_alone,
    };
  }

  // Add tenant message to history
  messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

  // LAYER 1: Interpret intent
  const intent = await interpretIntent(message, messages, currentStage);

  // Extract any data from this message
  tenantData = extractTenantData(intent, tenantData);

  // Advance stage if appropriate
  const nextStage = advanceStage(currentStage, intent, tenantData);

  // LAYER 2: Get strategy
  const strategy = getStrategy(nextStage, tenantData, property);

  // Score if we're at scoring stage
  let qualResult = null;
  if (nextStage === 'scoring' || nextStage === 'booking' || nextStage === 'complete') {
    qualResult = scoreQualification(tenantData, property);
  }

  // LAYER 3: Humanize response
  const replyMessages = await humanize(strategy, tenantData, property, messages, intent);

  // Add Aria's replies to history
  replyMessages.forEach(msg => {
    messages.push({ role: 'assistant', content: msg, timestamp: new Date().toISOString() });
  });

  // Determine conversation status
  let convStatus = conversation.status;
  if (qualResult) {
    if (qualResult.status === 'qualified') convStatus = 'qualified';
    else if (qualResult.status === 'unqualified') convStatus = 'unqualified';
  }
  if (nextStage === 'booking') convStatus = 'booked';

  // Save conversation state
  await db.query(
    `UPDATE conversations SET messages = $1, stage = $2, status = $3, updated_at = NOW() WHERE id = $4`,
    [JSON.stringify(messages), nextStage, convStatus, conversationId]
  );

  // Save or update tenant profile
  if (Object.keys(tenantData).length > 0) {
    await db.query(
      `INSERT INTO tenant_profiles (conversation_id, tenant_phone, monthly_income, deposit_available,
        move_date, employment_status, property_id, qualification_score, qualification_status,
        income_ratio, disqualification_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [
        conversationId,
        tenantPhone,
        tenantData.monthly_income || null,
        tenantData.deposit_available !== undefined ? tenantData.deposit_available : null,
        tenantData.move_date_raw || null,
        tenantData.employment_status || null,
        conversation.property_id,
        qualResult?.score || null,
        qualResult?.status || 'pending',
        qualResult?.income_ratio || null,
        qualResult?.disqualification_reason || null,
      ]
    );
  }

  // Schedule follow-up if conversation goes cold (24h later)
  if (nextStage !== 'complete' && nextStage !== 'booking') {
    const followUpTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO followups (conversation_id, tenant_phone, channel, message, scheduled_for)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        conversationId,
        tenantPhone,
        channel,
        `Hi! Just checking if you're still interested in viewing ${property?.title || 'the property'}? Happy to help if you have any questions.`,
        followUpTime,
      ]
    );
  }

  // Notify agent if qualified
  if (qualResult?.status === 'qualified' && conversation.agent_id) {
    await notifyAgent(conversation.agent_id, tenantPhone, tenantData, property, qualResult);
  }

  return {
    messages: replyMessages,
    stage: nextStage,
    qualificationStatus: qualResult?.status || null,
    qualificationScore: qualResult?.score || null,
  };
}

// ─── AGENT NOTIFICATION ───────────────────────────────────────────────────────
async function notifyAgent(agentId, tenantPhone, tenantData, property, qualResult) {
  const agentResult = await db.query('SELECT * FROM agents WHERE id = $1', [agentId]);
  if (!agentResult.rows.length) return;

  const agent = agentResult.rows[0];
  if (!agent.notification_whatsapp) return;

  const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  const summary = `🏠 *New Qualified Lead — Aria*

Property: ${property?.title || 'Unknown'}
Tenant: ${tenantData.tenant_name || tenantPhone}
Income: R${(tenantData.monthly_income || 0).toLocaleString()}
Move date: ${tenantData.move_date_raw || 'Not specified'}
Deposit ready: ${tenantData.deposit_available ? 'Yes ✅' : 'No ❌'}
Employment: ${tenantData.employment_status || 'Not specified'}
Score: ${qualResult.score}/100

They've been offered a viewing. Please confirm your availability.`;

  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${agent.notification_whatsapp}`,
      body: summary,
    });
  } catch (err) {
    console.error('Failed to notify agent:', err.message);
  }
}

module.exports = { processMessage, scoreQualification, interpretIntent };
