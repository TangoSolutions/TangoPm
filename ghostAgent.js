const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function interpretIntent(message, conversationHistory, currentStage) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 300,
    system: `You are an intent classifier for a property leasing assistant in South Africa.
Classify into: availability_check, income_response, deposit_response, move_date_response, employment_response, booking_request, maintenance_report, maintenance_followup, rental_inquiry, general_question, yes, no, unclear
Current stage: ${currentStage}
Respond ONLY with JSON: {"intent":"...","extracted_value":"...","confidence":"high|medium|low","maintenance_category":"plumbing|electrical|structural|appliance|security|other|null"}`,
    messages: [{ role: 'user', content: `Message: "${message}"` }],
  });
  try { return JSON.parse(response.content[0].text); }
  catch { return { intent: 'unclear', extracted_value: null, confidence: 'low', maintenance_category: null }; }
}

function getStrategy(stage, tenantData, property, intent) {
  const rent = property?.monthly_rent || 0;
  if (intent?.intent === 'maintenance_report') {
    return { goal: 'log_maintenance_and_confirm', nextStage: stage, questions: ['acknowledge issue', 'confirm logged', 'give 24-48hr timeline'] };
  }
  const s = {
    greeting: { goal: 'confirm_availability_and_start_qualification', nextStage: 'income', questions: ['confirm availability', 'ask move date'] },
    income: { goal: 'capture_income', nextStage: 'deposit', questions: ['ask monthly income naturally'], hint: `Need R${(rent*3).toLocaleString()} minimum` },
    deposit: { goal: 'capture_deposit_readiness', nextStage: 'move_date', questions: [`ask about deposit R${(rent*2).toLocaleString()}`] },
    move_date: { goal: 'capture_move_date', nextStage: 'employment', questions: ['ask when they want to move in'] },
    employment: { goal: 'capture_employment', nextStage: 'scoring', questions: ['ask employed or self-employed'] },
    scoring: { goal: 'score_and_respond', nextStage: 'booking', questions: ['deliver result, offer viewing if qualified'] },
    booking: { goal: 'book_viewing', nextStage: 'complete', questions: ['get preferred viewing time', 'confirm booking'] },
  };
  return s[stage] || s.greeting;
}

async function humanize(strategy, tenantData, property, conversationHistory, intent) {
  const rent = property?.monthly_rent || 0;
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 400,
    system: `You are Tino, a leasing assistant in South Africa.
PERSONALITY: Warm, efficient, like a junior leasing agent. Short WhatsApp-style texts. No corporate speak. Never reveal you're AI.
Never say: "Certainly!", "Absolutely!", "Of course!", "Great question!"
GOAL: ${strategy.goal}
PROPERTY: ${property?.title || 'the property'}, ${property?.suburb || ''} — R${rent.toLocaleString()}/month
TENANT DATA: ${JSON.stringify(tenantData)}
RULES: One question max. If maintenance: acknowledge, say logged, 24-48hr response. Never mention "qualification" or "pre-screening". If unqualified: kind and brief.
Respond with JSON array: ["message 1", "message 2 if needed"]`,
    messages: [
      ...conversationHistory.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: `Strategy: ${strategy.questions.join(', ')}. Intent: ${intent.intent}. Value: ${intent.extracted_value||'none'}. Generate response.` }
    ],
  });
  try { return JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim()); }
  catch { return ["Sorry, one moment — let me just check that."]; }
}

function scoreQualification(tenantData, property) {
  const rent = property?.monthly_rent || 0;
  let score = 0; let reasons = [];
  const totalIncome = (tenantData.monthly_income||0) + (tenantData.co_applicant_income||0);
  const ratio = rent > 0 ? totalIncome / rent : 0;
  if (ratio >= 3.5) score += 40; else if (ratio >= 3.0) score += 30; else if (ratio >= 2.5) score += 15; else reasons.push(`Income too low (${ratio.toFixed(1)}x, need 3x)`);
  if (tenantData.deposit_available === true) score += 30; else if (tenantData.deposit_available === false) reasons.push('Deposit not available');
  if (tenantData.move_date_raw) {
    const diff = Math.abs((new Date(tenantData.move_date_raw) - (property?.available_from ? new Date(property.available_from) : new Date())) / 86400000);
    if (diff <= 30) score += 20; else if (diff <= 60) score += 10; else reasons.push('Move date too far');
  }
  if (['employed','self-employed','business owner'].includes(tenantData.employment_status?.toLowerCase())) score += 10; else reasons.push('Employment unclear');
  return { score, status: score>=70?'qualified':score>=45?'borderline':'unqualified', income_ratio: ratio, disqualification_reason: reasons.join('; ')||null };
}

function extractTenantData(intent, d={}) {
  const u = {...d};
  if (intent.intent==='income_response'&&intent.extracted_value) { const n=parseInt(intent.extracted_value.replace(/[^0-9]/g,'')); if(!isNaN(n)) u.monthly_income=n; }
  if (intent.intent==='deposit_response') u.deposit_available=['yes','true','available','have it','ready'].some(w=>intent.extracted_value?.toLowerCase().includes(w));
  if (intent.intent==='move_date_response'&&intent.extracted_value) u.move_date_raw=intent.extracted_value;
  if (intent.intent==='employment_response'&&intent.extracted_value) u.employment_status=intent.extracted_value;
  return u;
}

function advanceStage(stage, intent, td) {
  if (['maintenance_report','maintenance_followup'].includes(intent.intent)) return stage;
  const order=['greeting','income','deposit','move_date','employment','scoring','booking','complete'];
  const idx=order.indexOf(stage);
  const adv={greeting:true,income:!!td.monthly_income,deposit:td.deposit_available!==undefined,move_date:!!td.move_date_raw,employment:!!td.employment_status,scoring:true,booking:intent.intent==='booking_request'||intent.intent==='yes'};
  return (adv[stage]&&idx<order.length-1)?order[idx+1]:stage;
}

async function handleMaintenance(conversationId, tenantPhone, intent, property, agentId) {
  try {
    await db.query(
      `INSERT INTO maintenance_requests (conversation_id,tenant_phone,property_id,agent_id,issue_description,category,status) VALUES ($1,$2,$3,$4,$5,$6,'open')`,
      [conversationId,tenantPhone,property?.id||null,agentId||null,intent.extracted_value||'Issue via WhatsApp',intent.maintenance_category||'other']
    );
    if (agentId) {
      const a=await db.query('SELECT * FROM agents WHERE id=$1',[agentId]);
      if(a.rows.length&&a.rows[0].notification_whatsapp){
        const tw=require('twilio')(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);
        await tw.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:`whatsapp:${a.rows[0].notification_whatsapp}`,body:`🔧 *Maintenance — Tino*\nProperty: ${property?.title||'Unknown'}\nTenant: ${tenantPhone}\nIssue: ${intent.extracted_value||'Not specified'}\nCategory: ${intent.maintenance_category||'other'}\n\nPlease follow up within 24-48 hours.`});
      }
    }
  } catch(e){console.error('Maintenance error:',e.message);}
}

async function logAnalyticsEvent(agentId, propertyId, intentType, stage, score) {
  try { await db.query(`INSERT INTO analytics_events(agent_id,property_id,event_type,stage,score,hour_of_day,day_of_week) VALUES($1,$2,$3,$4,$5,$6,$7)`,[agentId,propertyId,intentType,stage,score||null,new Date().getHours(),new Date().getDay()]); } catch{}
}

async function notifyAgent(agentId, tenantPhone, tenantData, property, qualResult) {
  const a=await db.query('SELECT * FROM agents WHERE id=$1',[agentId]);
  if(!a.rows.length||!a.rows[0].notification_whatsapp) return;
  try {
    const tw=require('twilio')(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);
    await tw.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:`whatsapp:${a.rows[0].notification_whatsapp}`,body:`🏠 *New Qualified Lead — Tino*\n\nProperty: ${property?.title||'Unknown'}\nTenant: ${tenantPhone}\nIncome: R${(tenantData.monthly_income||0).toLocaleString()}\nMove date: ${tenantData.move_date_raw||'Not specified'}\nDeposit ready: ${tenantData.deposit_available?'Yes ✅':'No ❌'}\nEmployment: ${tenantData.employment_status||'Not specified'}\nScore: ${qualResult.score}/100\n\nViewing offered. Please confirm availability.`});
  } catch(e){console.error('Agent notify error:',e.message);}
}

async function processMessage({ tenantPhone, message, channel, conversationId }) {
  const conv=await db.query('SELECT * FROM conversations WHERE id=$1',[conversationId]);
  if(!conv.rows.length) throw new Error('Conversation not found');
  const conversation=conv.rows[0];
  const messages=conversation.messages||[];
  const currentStage=conversation.stage||'greeting';

  let property=null;
  if(conversation.property_id){const r=await db.query('SELECT * FROM properties WHERE id=$1',[conversation.property_id]);property=r.rows[0]||null;}

  let tenantData={};
  const pr=await db.query('SELECT * FROM tenant_profiles WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1',[conversationId]);
  if(pr.rows.length){const p=pr.rows[0];tenantData={monthly_income:p.monthly_income,deposit_available:p.deposit_available,move_date_raw:p.move_date,employment_status:p.employment_status};}

  messages.push({role:'user',content:message,timestamp:new Date().toISOString()});
  const intent=await interpretIntent(message,messages,currentStage);
  if(intent.intent==='maintenance_report') await handleMaintenance(conversationId,tenantPhone,intent,property,conversation.agent_id);
  tenantData=extractTenantData(intent,tenantData);
  const nextStage=advanceStage(currentStage,intent,tenantData);
  const strategy=getStrategy(nextStage,tenantData,property,intent);
  let qualResult=null;
  if(['scoring','booking','complete'].includes(nextStage)) qualResult=scoreQualification(tenantData,property);
  const replyMessages=await humanize(strategy,tenantData,property,messages,intent);
  replyMessages.forEach(m=>messages.push({role:'assistant',content:m,timestamp:new Date().toISOString()}));

  let convStatus=conversation.status;
  if(qualResult){if(qualResult.status==='qualified')convStatus='qualified';else if(qualResult.status==='unqualified')convStatus='unqualified';}
  if(nextStage==='booking')convStatus='booked';

  await db.query(`UPDATE conversations SET messages=$1,stage=$2,status=$3,updated_at=NOW() WHERE id=$4`,[JSON.stringify(messages),nextStage,convStatus,conversationId]);

  if(Object.keys(tenantData).length>0){
    await db.query(`INSERT INTO tenant_profiles(conversation_id,tenant_phone,monthly_income,deposit_available,move_date,employment_status,property_id,qualification_score,qualification_status,income_ratio,disqualification_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [conversationId,tenantPhone,tenantData.monthly_income||null,tenantData.deposit_available!==undefined?tenantData.deposit_available:null,tenantData.move_date_raw||null,tenantData.employment_status||null,conversation.property_id,qualResult?.score||null,qualResult?.status||'pending',qualResult?.income_ratio||null,qualResult?.disqualification_reason||null]);
  }

  if(!['complete','booking'].includes(nextStage)&&intent.intent!=='maintenance_report'){
    await db.query(`INSERT INTO followups(conversation_id,tenant_phone,channel,message,scheduled_for) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [conversationId,tenantPhone,channel,`Hi! Just checking if you're still interested in viewing ${property?.title||'the property'}? Happy to help.`,new Date(Date.now()+86400000)]);
  }

  if(qualResult?.status==='qualified'&&conversation.agent_id) await notifyAgent(conversation.agent_id,tenantPhone,tenantData,property,qualResult);
  await logAnalyticsEvent(conversation.agent_id,property?.id,intent.intent,nextStage,qualResult?.score);

  return { messages: replyMessages, stage: nextStage, qualificationStatus: qualResult?.status||null, qualificationScore: qualResult?.score||null };
}

module.exports = { processMessage, scoreQualification, interpretIntent };
