import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

async function migrate() {
  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const col = mongoose.connection.db!.collection('courses');

  // 1. Rename every stages[].stage value of 'free' → 'dolphin'
  const r1 = await col.updateMany(
    { 'stages.stage': 'free' },
    { $set: { 'stages.$[slot].stage': 'dolphin' } },
    { arrayFilters: [{ 'slot.stage': 'free' }] }
  );
  console.log(`Renamed free → dolphin in ${r1.modifiedCount} course(s)`);

  // 2. Set stage: 'fish' on any course document that has no top-level stage field yet
  const r2 = await col.updateMany(
    { stage: { $exists: false } },
    { $set: { stage: 'fish' } }
  );
  console.log(`Set stage: 'fish' on ${r2.modifiedCount} course(s) that had no stage field`);

  await mongoose.disconnect();
  console.log('Migration complete');
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
