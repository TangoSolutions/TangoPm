require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const schema = `
-- Properties managed by agents
CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  title TEXT NOT NULL,
  address TEXT NOT NULL,
  suburb TEXT,
  city TEXT DEFAULT 'Cape Town',
  monthly_rent INTEGER NOT NULL,
  deposit INTEGER,
  bedrooms INTEGER,
  bathrooms NUMERIC(2,1),
  description TEXT,
  available_from DATE,
  is_available BOOLEAN DEFAULT true,
  property24_url TEXT,
  images TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Property managers / agents (your clients)
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  agency_name TEXT,
  email TEXT UNIQUE NOT NULL,
  whatsapp_number TEXT,
  phone TEXT,
  setup_fee_paid BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  notification_whatsapp TEXT,
  notification_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant conversations (one per tenant per channel session)
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_phone TEXT NOT NULL,
  tenant_name TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'voice')),
  property_id UUID REFERENCES properties(id),
  agent_id UUID REFERENCES agents(id),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'qualified', 'unqualified', 'booked', 'dropped')),
  stage TEXT DEFAULT 'greeting' CHECK (stage IN ('greeting', 'availability', 'income', 'deposit', 'move_date', 'employment', 'scoring', 'booking', 'complete')),
  messages JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant qualification profiles
CREATE TABLE IF NOT EXISTS tenant_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id),
  tenant_phone TEXT NOT NULL,
  tenant_name TEXT,
  monthly_income INTEGER,
  employment_status TEXT,
  move_date DATE,
  deposit_available BOOLEAN,
  applying_alone BOOLEAN,
  co_applicant_income INTEGER,
  property_id UUID REFERENCES properties(id),
  qualification_score INTEGER,
  qualification_status TEXT CHECK (qualification_status IN ('qualified', 'unqualified', 'borderline', 'pending')),
  income_ratio NUMERIC(4,2),
  disqualification_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Viewing bookings
CREATE TABLE IF NOT EXISTS viewings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_profile_id UUID REFERENCES tenant_profiles(id),
  property_id UUID REFERENCES properties(id),
  agent_id UUID REFERENCES agents(id),
  scheduled_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Follow-up queue (for tenants who went cold)
CREATE TABLE IF NOT EXISTS followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id),
  tenant_phone TEXT NOT NULL,
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bookings / revenue tracking
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewing_id UUID REFERENCES viewings(id),
  agent_id UUID REFERENCES agents(id),
  property_id UUID REFERENCES properties(id),
  tenant_profile_id UUID REFERENCES tenant_profiles(id),
  monthly_rent INTEGER NOT NULL,
  aria_fee_percent NUMERIC(3,1) DEFAULT 4.0,
  aria_fee_amount INTEGER,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'invoiced', 'paid')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(tenant_phone);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_followups_scheduled ON followups(scheduled_for, sent);
CREATE INDEX IF NOT EXISTS idx_viewings_agent ON viewings(agent_id);
CREATE INDEX IF NOT EXISTS idx_tenant_profiles_status ON tenant_profiles(qualification_status);
`;

async function migrate() {
  console.log('Running migrations...');
  try {
    await pool.query(schema);
    console.log('✅ Database schema created successfully');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
