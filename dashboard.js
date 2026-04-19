const express = require('express');
const router = express.Router();
const db = require('../db');

function auth(req, res, next) {
  const token = req.headers['x-dashboard-key'] || req.query.key;
  if (token !== process.env.DASHBOARD_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.get('/stats', auth, async (req, res) => {
  const { agent_id } = req.query;
  const f = agent_id ? 'AND c.agent_id = $1' : '';
  const p = agent_id ? [agent_id] : [];
  const stats = await db.query(`
    SELECT COUNT(DISTINCT c.id) FILTER (WHERE c.created_at > NOW() - INTERVAL '30 days') as total_enquiries,
           COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'qualified') as qualified_leads,
           COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'unqualified') as unqualified_leads,
           COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'booked') as viewings_booked,
           COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'active') as active_conversations,
           ROUND(AVG(tp.qualification_score)) as avg_score,
           COUNT(DISTINCT mr.id) FILTER (WHERE mr.status = 'open') as open_maintenance
    FROM conversations c LEFT JOIN tenant_profiles tp ON tp.conversation_id = c.id
    LEFT JOIN maintenance_requests mr ON mr.agent_id = c.agent_id WHERE 1=1 ${f}`, p);
  const leads = await db.query(`
    SELECT c.id, c.tenant_phone, c.tenant_name, c.status, c.stage, c.channel, c.created_at,
           p.title as property_title, p.suburb, p.monthly_rent,
           tp.monthly_income, tp.deposit_available, tp.move_date_raw, tp.employment_status,
           tp.qualification_score, tp.qualification_status, tp.income_ratio
    FROM conversations c LEFT JOIN properties p ON p.id = c.property_id
    LEFT JOIN tenant_profiles tp ON tp.conversation_id = c.id WHERE 1=1 ${f}
    ORDER BY c.updated_at DESC LIMIT 50`, p);
  res.json({ stats: stats.rows[0], leads: leads.rows });
});

router.get('/analytics/peak-times', auth, async (req, res) => {
  const { agent_id } = req.query;
  const r = await db.query(`SELECT hour_of_day, COUNT(*) as count FROM analytics_events ${agent_id?'WHERE agent_id=$1':''} GROUP BY hour_of_day ORDER BY hour_of_day`, agent_id?[agent_id]:[]);
  res.json(r.rows);
});

router.get('/analytics/popular-listings', auth, async (req, res) => {
  const { agent_id } = req.query;
  const f = agent_id ? 'AND c.agent_id = $1' : '';
  const r = await db.query(`
    SELECT p.title, p.suburb, p.monthly_rent, COUNT(c.id) as total_enquiries,
           COUNT(c.id) FILTER (WHERE c.status='qualified') as qualified,
           COUNT(c.id) FILTER (WHERE c.status='booked') as booked,
           ROUND(AVG(tp.qualification_score)) as avg_score
    FROM properties p LEFT JOIN conversations c ON c.property_id=p.id ${f}
    LEFT JOIN tenant_profiles tp ON tp.conversation_id=c.id
    GROUP BY p.id ORDER BY total_enquiries DESC LIMIT 10`, agent_id?[agent_id]:[]);
  res.json(r.rows);
});

router.get('/analytics/drop-off', auth, async (req, res) => {
  const { agent_id } = req.query;
  const r = await db.query(`SELECT disqualification_reason, COUNT(*) as count FROM tenant_profiles WHERE qualification_status='unqualified' AND disqualification_reason IS NOT NULL GROUP BY disqualification_reason ORDER BY count DESC`, []);
  res.json(r.rows);
});

router.get('/analytics/pipeline', auth, async (req, res) => {
  const { agent_id } = req.query;
  const f = agent_id ? 'WHERE agent_id=$1' : '';
  const r = await db.query(`SELECT COUNT(*) FILTER (WHERE created_at>NOW()-INTERVAL '30 days') as enquiries, COUNT(*) FILTER (WHERE status='qualified') as qualified, COUNT(*) FILTER (WHERE status='booked') as viewings_booked FROM conversations ${f}`, agent_id?[agent_id]:[]);
  res.json(r.rows[0]);
});

router.get('/maintenance', auth, async (req, res) => {
  const { agent_id, status } = req.query;
  const conds = []; const params = [];
  if (agent_id) { conds.push(`mr.agent_id=$${params.length+1}`); params.push(agent_id); }
  if (status) { conds.push(`mr.status=$${params.length+1}`); params.push(status); }
  const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
  const r = await db.query(`SELECT mr.*, p.title as property_title, p.suburb FROM maintenance_requests mr LEFT JOIN properties p ON p.id=mr.property_id ${where} ORDER BY mr.created_at DESC`, params);
  res.json(r.rows);
});

router.patch('/maintenance/:id', auth, async (req, res) => {
  const { status, priority, notes } = req.body;
  const r = await db.query(`UPDATE maintenance_requests SET status=COALESCE($1,status),priority=COALESCE($2,priority),notes=COALESCE($3,notes),resolved_at=CASE WHEN $1='resolved' THEN NOW() ELSE resolved_at END WHERE id=$4 RETURNING *`,[status,priority,notes,req.params.id]);
  res.json(r.rows[0]);
});

router.get('/calendar', auth, async (req, res) => {
  const { agent_id, from, to } = req.query;
  const conds = ['v.scheduled_at IS NOT NULL']; const params = [];
  if (agent_id) { conds.push(`v.agent_id=$${params.length+1}`); params.push(agent_id); }
  if (from) { conds.push(`v.scheduled_at>=$${params.length+1}`); params.push(from); }
  if (to) { conds.push(`v.scheduled_at<=$${params.length+1}`); params.push(to); }
  const r = await db.query(`SELECT v.*, p.title as property_title, p.suburb, tp.qualification_score, c.tenant_phone, c.tenant_name FROM viewings v LEFT JOIN properties p ON p.id=v.property_id LEFT JOIN tenant_profiles tp ON tp.id=v.tenant_profile_id LEFT JOIN conversations c ON c.property_id=v.property_id WHERE ${conds.join(' AND ')} ORDER BY v.scheduled_at ASC`, params);
  res.json(r.rows);
});

router.post('/calendar/book', auth, async (req, res) => {
  const { tenant_profile_id, property_id, agent_id, scheduled_at, notes } = req.body;
  const r = await db.query(`INSERT INTO viewings(tenant_profile_id,property_id,agent_id,scheduled_at,status,notes) VALUES($1,$2,$3,$4,'confirmed',$5) RETURNING *`,[tenant_profile_id,property_id,agent_id,scheduled_at,notes]);
  res.json(r.rows[0]);
});

router.patch('/calendar/:id', auth, async (req, res) => {
  const { status, scheduled_at } = req.body;
  const r = await db.query('UPDATE viewings SET status=COALESCE($1,status),scheduled_at=COALESCE($2,scheduled_at) WHERE id=$3 RETURNING *',[status,scheduled_at,req.params.id]);
  res.json(r.rows[0]);
});

router.get('/properties', auth, async (req, res) => {
  const { agent_id } = req.query;
  const r = await db.query(`SELECT * FROM properties ${agent_id?'WHERE agent_id=$1':''} ORDER BY created_at DESC`, agent_id?[agent_id]:[]);
  res.json(r.rows);
});

router.post('/properties', auth, async (req, res) => {
  const { title, address, suburb, monthly_rent, deposit, bedrooms, bathrooms, description, available_from, agent_id } = req.body;
  const r = await db.query(`INSERT INTO properties(title,address,suburb,monthly_rent,deposit,bedrooms,bathrooms,description,available_from,agent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[title,address,suburb,monthly_rent,deposit,bedrooms,bathrooms,description,available_from,agent_id]);
  res.json(r.rows[0]);
});

router.patch('/properties/:id', auth, async (req, res) => {
  const { is_available, title, monthly_rent, description } = req.body;
  const r = await db.query(`UPDATE properties SET is_available=COALESCE($1,is_available),title=COALESCE($2,title),monthly_rent=COALESCE($3,monthly_rent),description=COALESCE($4,description),updated_at=NOW() WHERE id=$5 RETURNING *`,[is_available,title,monthly_rent,description,req.params.id]);
  res.json(r.rows[0]);
});

router.get('/agents', auth, async (req, res) => {
  const r = await db.query('SELECT * FROM agents ORDER BY created_at DESC');
  res.json(r.rows);
});

router.post('/agents', auth, async (req, res) => {
  const { name, agency_name, email, whatsapp_number, phone, notification_whatsapp } = req.body;
  const r = await db.query(`INSERT INTO agents(name,agency_name,email,whatsapp_number,phone,notification_whatsapp) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[name,agency_name,email,whatsapp_number,phone,notification_whatsapp]);
  res.json(r.rows[0]);
});

router.get('/leads/:id', auth, async (req, res) => {
  const r = await db.query(`SELECT c.*,p.title,p.suburb,p.monthly_rent,a.name as agent_name,a.agency_name,tp.monthly_income,tp.deposit_available,tp.move_date_raw,tp.employment_status,tp.qualification_score,tp.qualification_status,tp.income_ratio,tp.disqualification_reason FROM conversations c LEFT JOIN properties p ON p.id=c.property_id LEFT JOIN agents a ON a.id=c.agent_id LEFT JOIN tenant_profiles tp ON tp.conversation_id=c.id WHERE c.id=$1`,[req.params.id]);
  if(!r.rows.length) return res.status(404).json({error:'Not found'});
  res.json(r.rows[0]);
});

router.get('/revenue', auth, async (req, res) => {
  const r = await db.query(`SELECT SUM(monthly_rent*aria_fee_percent/100) as total_fees_earned,COUNT(*) as total_bookings,AVG(monthly_rent) as avg_rent,SUM(CASE WHEN status='paid' THEN monthly_rent*aria_fee_percent/100 ELSE 0 END) as paid_fees FROM bookings`);
  res.json(r.rows[0]);
});

module.exports = router;

// ─── MAINTENANCE ROUTES ───────────────────────────────────────────────────────
router.get('/maintenance', auth, async (req, res) => {
  const { agent_id } = req.query;
  const result = await db.query(`
    SELECT m.*, p.title as property_title, p.suburb
    FROM maintenance_reports m
    LEFT JOIN properties p ON p.id = m.property_id
    ${agent_id ? 'WHERE m.agent_id = $1' : ''}
    ORDER BY CASE WHEN m.urgency = 'high' THEN 1 WHEN m.urgency = 'medium' THEN 2 ELSE 3 END, m.created_at DESC
    LIMIT 100
  `, agent_id ? [agent_id] : []);
  res.json(result.rows);
});

router.patch('/maintenance/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const result = await db.query(
    'UPDATE maintenance_reports SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *',
    [status, id]
  );
  res.json(result.rows[0]);
});

// ─── PER-AGENT TRAINING CONFIG ────────────────────────────────────────────────
router.get('/agents/:id/config', auth, async (req, res) => {
  const result = await db.query('SELECT training_config FROM agents WHERE id = $1', [req.params.id]);
  res.json(result.rows[0]?.training_config || {});
});

router.patch('/agents/:id/config', auth, async (req, res) => {
  const { income_multiplier, deposit_multiplier, tone, pet_policy, min_lease_months, custom_rules } = req.body;
  const config = { income_multiplier: income_multiplier || 3, deposit_multiplier: deposit_multiplier || 2, tone: tone || 'warm', pet_policy, min_lease_months, custom_rules };
  const result = await db.query(
    `UPDATE agents SET training_config = $1 WHERE id = $2 RETURNING *`,
    [JSON.stringify(config), req.params.id]
  );
  res.json(result.rows[0]);
});
