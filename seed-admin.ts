import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const adminSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: 'superadmin' },
}, { timestamps: true });

const Admin = mongoose.model('Admin', adminSchema);

const EMAIL    = 'admin@selliberation.com';
const PASSWORD = 'Admin@2026';
const NAME     = 'Super Admin';

async function seed() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI not set in .env'); process.exit(1); }

  await mongoose.connect(uri);
  console.log('✅ Connected to:', mongoose.connection.name);

  const existing = await Admin.findOne({ email: EMAIL });
  if (existing) {
    console.log('⚠️  Admin already exists:', EMAIL);
    await mongoose.disconnect();
    return;
  }

  const hashed = await bcrypt.hash(PASSWORD, 10);
  await Admin.create({ name: NAME, email: EMAIL, password: hashed, role: 'superadmin' });

  console.log('✅ Admin created successfully!');
  console.log('   Email   :', EMAIL);
  console.log('   Password:', PASSWORD);
  console.log('\n👉 Log in at http://localhost:5173/login then change your password.');
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
