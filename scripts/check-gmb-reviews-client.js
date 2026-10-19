/** Count gmbreviews rows for a clientId (uses .env + BrandOps mongo tunnel pattern). */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

function loadEnv() {
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

async function main() {
  const clientId = process.argv[2] || '699b09ea60e1953d60ae58f4';
  loadEnv();
  const uri = (process.env.MONGO_URI || '').trim();
  if (!uri) {
    console.error('Set MONGO_URI in .env or run outreach with SSH_TUNNEL (use app mongo URI from logs).');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const col = db.collection('gmbreviews');
  const total = await col.countDocuments({});
  const byStr = await col.countDocuments({ clientId });
  const byOid = mongoose.Types.ObjectId.isValid(clientId)
    ? await col.countDocuments({ clientId: new mongoose.Types.ObjectId(clientId) })
    : 0;
  const client = await db.collection('clientonboardings').findOne({
    _id: new mongoose.Types.ObjectId(clientId),
  });
  const gmbIds = (client?.googleMyBusiness || [])
    .map((g) => g.businessId)
    .filter(Boolean);
  let byGmb = 0;
  if (gmbIds.length) {
    byGmb = await col.countDocuments({ gmbId: { $in: gmbIds } });
  }
  console.log('gmbreviews total in DB:', total);
  console.log('clientId', clientId);
  console.log('match clientId (string):', byStr);
  console.log('match clientId (ObjectId):', byOid);
  console.log('googleMyBusiness.businessId on client:', gmbIds);
  console.log('match by gmbId:', byGmb);
  if (byGmb) {
    const sample = await col.findOne({ gmbId: { $in: gmbIds } });
    console.log('sample stored clientId:', sample?.clientId, 'gmbId:', sample?.gmbId);
    console.log('sample review count:', sample?.reviews?.length ?? 0);
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
