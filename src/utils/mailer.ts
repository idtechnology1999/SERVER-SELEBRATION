import nodemailer from 'nodemailer';

export function makeTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: (process.env.EMAIL_PASS || '').replace(/\s/g, ''),
    },
    tls: { rejectUnauthorized: true },
  });
}

export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const transporter = makeTransporter();
  await transporter.sendMail({
    from: `"Selebration" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
  transporter.close();
}
