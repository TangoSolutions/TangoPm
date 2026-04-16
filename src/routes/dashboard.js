const express = require('express');
const router = express.Router();
const db = require('../db');

// Simple auth middleware
function auth(req, res, next) {
  const token = req.headers['x-dashboard-key'] || req.query.key;
  if (token !== process.env.DASHBOARD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── DASHBOARD OVERVIEW ───────────────────────────────────────────────────────
router.get('/stats', auth, async (req, res) => {
  const { agent_id } = req.query;
  const filter = agent_id ? 'AND c.agent_id = $1' : '';
  const params = agent_id ? [agent_id] : [];

  const stats = await db.query(`
    SELECT
      COUNT(DISTINCT c.id) FILTER (WHERE c.created_at > NOW() - INTERVAL '30 days') as total_enquiries,
      COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'qualified') as qualified_leads,
      COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'unqualified') as unqualified_leads,
      COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'booked') as viewings_booked,
      COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'active') as active_conversations,
      ROUND(AVG(tp.qualification_score)) as avg_score
    FROM conversations c
    LEFT JOIN tenant_profiles tp ON tp.conversation_id = c.id
    WHERE 1=1 ${filter}
  `, params);

  const recentLeads = await db.query(`
    SELECT
      c.id,
      c.tenant_phone,
      c.tenant_name,
      c.status,
      c.stage,
      c.channel,
      c.created_at,
      p.title as property_title,
      p.suburb,
      p.monthly_rent,
      tp.monthly_income,
      tp.deposit_available,
      tp.move_date_raw,
      tp.employment_status,
      tp.qualification_score,
      tp.qualification_status,
      tp.income_ratio
    FROM conversations c
    LEFT JOIN properties p ON p.id = c.property_id
    LEFT JOIN tenant_profiles tp ON tp.conversation_id = c.id
    WHERE 1=1 ${filter}
    ORDER BY c.updated_at DESC
    LIMIT 50
  `, params);

  res.json({
    stats: stats.rows[0],
    leads: recentLeads.rows,
  });
});

// ─── SINGLE LEAD DETAIL ───────────────────────────────────────────────────────
router.get('/leads/:id', auth, async (req, res) => {
  const { id } = req.params;

  const conv = await db.query(`
    SELECT c.*, p.title, p.suburb, p.monthly_rent, p.address,
           a.name as agent_name, a.agency_name,
           tp.monthly_income, tp.deposit_available, tp.move_date_raw,
           tp.employment_status, tp.qualification_score, tp.qualification_status,
           tp.income_ratio, tp.disqualification_reason
    FROM conversations c
    LEFT JOIN properties p ON p.id = c.property_id
    LEFT JOIN agents a ON a.id = c.agent_id
    LEFT JOIN tenant_profiles tp ON tp.conversation_id = c.id
    WHERE c.id = $1
  `, [id]);

  if (!conv.rows.length) return res.status(404).json({ error: 'Not found' });

  res.json(conv.rows[0]);
});

// ─── PROPERTIES CRUD ──────────────────────────────────────────────────────────
router.get('/properties', auth, async (req, res) => {
  const { agent_id } = req.query;
  const result = await db.query(
    `SELECT * FROM properties ${agent_id ? 'WHERE agent_id = $1' : ''} ORDER BY created_at DESC`,
    agent_id ? [agent_id] : []
  );
  res.json(result.rows);
});

router.post('/properties', auth, async (req, res) => {
  const { title, address, suburb, monthly_rent, deposit, bedrooms, bathrooms, description, available_from, agent_id } = req.body;

  const result = await db.query(
    `INSERT INTO properties (title, address, suburb, monthly_rent, deposit, bedrooms, bathrooms, description, available_from, agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [title, address, suburb, monthly_rent, deposit, bedrooms, bathrooms, description, available_from, agent_id]
  );
  res.json(result.rows[0]);
});

router.patch('/properties/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { is_available } = req.body;
  const result = await db.query(
    'UPDATE properties SET is_available = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [is_available, id]
  );
  res.json(result.rows[0]);
});

// ─── AGENTS CRUD ──────────────────────────────────────────────────────────────
router.get('/agents', auth, async (req, res) => {
  const result = await db.query('SELECT * FROM agents ORDER BY created_at DESC');
  res.json(result.rows);
});

router.post('/agents', auth, async (req, res) => {
  const { name, agency_name, email, whatsapp_number, phone, notification_whatsapp } = req.body;
  const result = await db.query(
    `INSERT INTO agents (name, agency_name, email, whatsapp_number, phone, notification_whatsapp)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, agency_name, email, whatsapp_number, phone, notification_whatsapp]
  );
  res.json(result.rows[0]);
});

// ─── VIEWINGS ─────────────────────────────────────────────────────────────────
router.get('/viewings', auth, async (req, res) => {
  const { agent_id } = req.query;
  const result = await db.query(`
    SELECT v.*, p.title as property_title, p.suburb, p.address,
           tp.monthly_income, tp.tenant_name, tp.qualification_score
    FROM viewings v
    LEFT JOIN properties p ON p.id = v.property_id
    LEFT JOIN tenant_profiles tp ON tp.id = v.tenant_profile_id
    ${agent_id ? 'WHERE v.agent_id = $1' : ''}
    ORDER BY v.scheduled_at ASC
  `, agent_id ? [agent_id] : []);
  res.json(result.rows);
});

router.patch('/viewings/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const result = await db.query(
    'UPDATE viewings SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  res.json(result.rows[0]);
});

// ─── REVENUE TRACKER ──────────────────────────────────────────────────────────
router.get('/revenue', auth, async (req, res) => {
  const result = await db.query(`
    SELECT
      SUM(monthly_rent * aria_fee_percent / 100) as total_fees_earned,
      COUNT(*) as total_bookings,
      AVG(monthly_rent) as avg_rent,
      SUM(CASE WHEN status = 'paid' THEN monthly_rent * aria_fee_percent / 100 ELSE 0 END) as paid_fees
    FROM bookings
  `);
  res.json(result.rows[0]);
});

module.exports = router;
