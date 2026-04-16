require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function seed() {
  // Only seed if database is empty
  const existing = await pool.query('SELECT COUNT(*) FROM properties');
  if (parseInt(existing.rows[0].count) > 0) {
    console.log('Database already seeded — skipping');
    await pool.end();
    return;
  }

  console.log('Seeding database...');

  // Create a demo agent
  const agentId = uuidv4();
  await pool.query(`
    INSERT INTO agents (id, name, agency_name, email, whatsapp_number, notification_whatsapp, is_active)
    VALUES ($1, 'Demo Agent', 'Cape Town Rentals', 'agent@demo.com', '+27820000000', '+27820000000', true)
    ON CONFLICT DO NOTHING
  `, [agentId]);

  // Sample Cape Town properties
  const properties = [
    {
      title: '2-Bed Apartment, Sea Point',
      address: '14 Ocean View Drive, Sea Point',
      suburb: 'Sea Point',
      monthly_rent: 18500,
      deposit: 37000,
      bedrooms: 2,
      bathrooms: 1,
      description: 'Modern apartment with ocean views, secure parking, gym access.',
      available_from: '2025-06-01',
    },
    {
      title: '1-Bed Studio, Woodstock',
      address: '88 Albert Road, Woodstock',
      suburb: 'Woodstock',
      monthly_rent: 9500,
      deposit: 19000,
      bedrooms: 1,
      bathrooms: 1,
      description: 'Trendy studio in the heart of Woodstock. Walking distance to UCT and hospitals.',
      available_from: '2025-05-15',
    },
    {
      title: '3-Bed House, Claremont',
      address: '22 Protea Road, Claremont',
      suburb: 'Claremont',
      monthly_rent: 28000,
      deposit: 56000,
      bedrooms: 3,
      bathrooms: 2,
      description: 'Spacious family home with garden and double garage. Top school catchment.',
      available_from: '2025-07-01',
    },
    {
      title: '1-Bed Apartment, Observatory',
      address: '5 Station Road, Observatory',
      suburb: 'Observatory',
      monthly_rent: 8200,
      deposit: 16400,
      bedrooms: 1,
      bathrooms: 1,
      description: 'Charming apartment close to Groote Schuur Hospital and UCT.',
      available_from: '2025-05-01',
    },
    {
      title: '2-Bed Flat, Green Point',
      address: '101 Somerset Road, Green Point',
      suburb: 'Green Point',
      monthly_rent: 22000,
      deposit: 44000,
      bedrooms: 2,
      bathrooms: 2,
      description: 'Luxury flat near Cape Town Stadium. Concierge, pool, parking.',
      available_from: '2025-06-15',
    },
  ];

  for (const p of properties) {
    await pool.query(`
      INSERT INTO properties (title, address, suburb, monthly_rent, deposit, bedrooms, bathrooms, description, available_from, agent_id, is_available)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
      ON CONFLICT DO NOTHING
    `, [p.title, p.address, p.suburb, p.monthly_rent, p.deposit, p.bedrooms, p.bathrooms, p.description, p.available_from, agentId]);
  }

  console.log('✅ Seed complete — 1 agent, 5 Cape Town properties added');
  await pool.end();
}

seed().catch(console.error);
