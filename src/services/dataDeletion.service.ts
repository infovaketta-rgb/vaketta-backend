import prisma from "../db/connect";

const DEFAULT_CONTENT = `<h2>Your Right to Data Deletion</h2>
<p>Vaketta respects your right to have your data removed from our platform. This page explains what data we store on your behalf and how to request its permanent deletion.</p>

<h2>What Data We Store</h2>
<p>When you use Vaketta as a hotel or business operator, we store the following categories of data associated with your account:</p>
<h3>Account & Integration Credentials</h3>
<ul>
<li>Your hotel or business name, contact email, and account password (stored as a bcrypt hash)</li>
<li>WhatsApp Business API credentials (phone number ID, access token) provided by you for integration with Meta's messaging platform</li>
<li>Staff user accounts (names, emails, roles) created under your hotel account</li>
</ul>
<h3>Booking Records</h3>
<ul>
<li>Guest names and booking details (check-in/check-out dates, room type, pricing)</li>
<li>Booking status history (pending, confirmed, cancelled, etc.)</li>
<li>Advance payments and total pricing records associated with each booking</li>
</ul>
<h3>Guest Conversation Logs</h3>
<ul>
<li>WhatsApp message history between your guests and your hotel (both automated and staff-sent messages)</li>
<li>Guest phone numbers and names collected through WhatsApp interactions</li>
<li>Media files (images, documents, audio) exchanged in guest conversations, stored in Cloudflare R2</li>
<li>Bot flow session data — partial conversation state during automated flows</li>
</ul>
<h3>Platform Usage Data</h3>
<ul>
<li>Login timestamps and session records for your staff</li>
<li>Monthly usage statistics (message and AI reply counts) for billing purposes</li>
</ul>

<h2>How to Request Data Deletion</h2>
<p>To request the deletion of your account and all associated data, please send an email to:</p>
<p><strong>Email:</strong> <a href="mailto:infovaketta@gmail.com">infovaketta@gmail.com</a></p>
<p><strong>Subject line:</strong> Data Deletion Request</p>
<p>Please include the following in your email:</p>
<ul>
<li>The hotel or business name registered on Vaketta</li>
<li>The email address associated with your account</li>
<li>A brief description of what you would like deleted (full account, or specific data categories)</li>
</ul>

<h2>What Happens After You Request</h2>
<ul>
<li>We will acknowledge your request within <strong>3 business days</strong>.</li>
<li>We will complete the deletion within <strong>30 days</strong> of receiving your verified request.</li>
<li>Once deleted, your account data, booking records, guest conversations, and media files will be permanently removed from our systems and cannot be recovered.</li>
<li>Aggregate or anonymised analytics data that cannot be traced back to your account may be retained.</li>
</ul>

<h2>Guest Data Deletion</h2>
<p>If you are a guest (not a hotel operator) who has interacted with a hotel using the Vaketta platform and would like your personal data deleted, please contact the hotel directly. You may also reach us at <a href="mailto:infovaketta@gmail.com">infovaketta@gmail.com</a> and we will assist in coordinating with the relevant hotel operator.</p>

<h2>Contact</h2>
<p>For any questions about data deletion or your privacy rights, please contact:</p>
<p><strong>Vaketta</strong><br>Email: <a href="mailto:infovaketta@gmail.com">infovaketta@gmail.com</a><br>Location: Varkala, Kerala, India</p>`;

export async function getDataDeletion() {
  return prisma.dataDeletion.upsert({
    where:  { id: "global" },
    update: {},
    create: {
      id:            "global",
      effectiveDate: "April 17, 2026",
      content:       DEFAULT_CONTENT,
    },
  });
}

export async function updateDataDeletion(data: {
  effectiveDate?: string;
  content?:       string;
}) {
  return prisma.dataDeletion.upsert({
    where:  { id: "global" },
    update: {
      ...(data.effectiveDate != null && { effectiveDate: data.effectiveDate.trim() }),
      ...(data.content       != null && { content:       data.content }),
    },
    create: {
      id:            "global",
      effectiveDate: data.effectiveDate ?? "April 17, 2026",
      content:       data.content       ?? DEFAULT_CONTENT,
    },
  });
}
