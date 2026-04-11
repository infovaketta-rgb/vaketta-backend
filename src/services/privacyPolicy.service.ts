import prisma from "../db/connect";

const DEFAULT_CONTENT = `<h2>1. About Vaketta</h2>
<p>Vaketta is a multi-tenant SaaS platform that enables hotels and guesthouses to automate guest communication via WhatsApp and Instagram Direct Messages, manage bookings through conversational AI, and improve response times with multilingual automated replies. Vaketta is operated by Yoosaf, a sole proprietor based in Varkala, Kerala, India.</p>
<p><strong>Contact:</strong> privacy@vaketta.com | vaketta.com</p>

<h2>2. Information We Collect</h2>
<h3>2.1 Hotel Operator Information</h3>
<p>When a hotel registers on Vaketta, we collect:</p>
<ul>
<li>Business name, address, and contact details</li>
<li>Account credentials (email address and hashed password)</li>
<li>WhatsApp Business API credentials and Meta integration tokens</li>
<li>Payment and subscription information (processed via third-party payment providers)</li>
<li>Hotel configuration data (room types, availability settings, business hours, AI preferences)</li>
</ul>
<h3>2.2 Guest Information</h3>
<p>When guests interact with a hotel through Vaketta-powered messaging channels, we may collect:</p>
<ul>
<li>Name and phone number (from WhatsApp profile or message content)</li>
<li>Booking details (check-in/check-out dates, room preferences, number of guests)</li>
<li>Message content — the text of conversations between guests and the hotel's AI or staff</li>
<li>Language preferences inferred from conversation</li>
<li>Read receipts and message delivery status</li>
</ul>
<h3>2.3 Technical and Usage Data</h3>
<ul>
<li>IP addresses and browser/device metadata for staff using the web dashboard</li>
<li>Timestamps of logins, messages, and booking events</li>
<li>Socket connection data for real-time chat functionality</li>
<li>API request logs for debugging and security monitoring</li>
</ul>

<h2>3. How We Use Information</h2>
<h3>3.1 To Provide the Service</h3>
<ul>
<li>Routing guest messages to the correct hotel and AI agent</li>
<li>Processing and confirming booking requests made through chat</li>
<li>Delivering AI-generated or staff replies via WhatsApp and Instagram</li>
<li>Displaying guest conversations in the hotel operator dashboard</li>
<li>Sending delivery and read receipt status updates</li>
</ul>
<h3>3.2 To Operate and Improve Vaketta</h3>
<ul>
<li>Diagnosing technical issues and maintaining system reliability</li>
<li>Analysing aggregated, anonymised usage patterns to improve features</li>
<li>Monitoring for abuse, security threats, and policy violations</li>
</ul>
<h3>3.3 AI Processing</h3>
<p>Guest messages may be sent to the Claude AI API (operated by Anthropic, Inc.) to generate automated replies. Messages are processed transiently for the purpose of generating responses. Anthropic's data use is governed by their API usage policy and privacy documentation.</p>
<h3>3.4 Communications</h3>
<ul>
<li>Transactional emails regarding your subscription, billing, or account</li>
<li>Service announcements and critical security notices</li>
<li>We do not send unsolicited marketing emails without your explicit consent</li>
</ul>

<h2>4. Data Storage and Security</h2>
<h3>4.1 Where Data Is Stored</h3>
<p>Vaketta infrastructure operates across the following providers:</p>
<ul>
<li>Database (PostgreSQL): Hosted on Railway / Supabase (servers in the EU or US, depending on configuration)</li>
<li>Media files (photos, attachments): Cloudflare R2 object storage with zero-egress architecture</li>
<li>Session and queue data: Redis (Upstash) for temporary message queuing and token management</li>
<li>Frontend: Served via Vercel's global CDN</li>
</ul>
<h3>4.2 Security Measures</h3>
<ul>
<li>Passwords stored using bcrypt hashing — never in plain text</li>
<li>JWT-based authentication with httpOnly cookie storage</li>
<li>JWT token revocation via Redis blocklist on logout</li>
<li>WhatsApp webhook payloads verified using HMAC-SHA256 signatures</li>
<li>TLS encryption in transit for all API communications</li>
<li>Strict tenant isolation — hotel data is logically separated</li>
<li>Role-based access control (RBAC) enforced at the API level</li>
<li>Rate limiting on authentication endpoints</li>
</ul>
<h3>4.3 Data Retention</h3>
<p>Guest conversation history is retained for the duration of the hotel's subscription and for a reasonable period thereafter for support and dispute resolution purposes. Hotels may request deletion of guest data at any time. Technical logs are retained for up to 90 days.</p>

<h2>5. Sharing of Information</h2>
<p>We do not sell personal information. We share data only in the following circumstances:</p>
<h3>5.1 Sub-processors and Service Providers</h3>
<ul>
<li>Anthropic, Inc. — AI language model processing (Claude API)</li>
<li>Meta Platforms, Inc. — WhatsApp Business API and Instagram Messaging API</li>
<li>Railway / Supabase — database hosting</li>
<li>Cloudflare — media storage and CDN</li>
<li>Upstash — Redis caching and message queuing</li>
<li>Vercel — frontend hosting</li>
<li>Payment processor — subscription billing (specific provider disclosed at checkout)</li>
</ul>
<h3>5.2 Hotel Operators</h3>
<p>Guest messages and booking data are made visible to the hotel operator and their authorised staff through the Vaketta dashboard. Hotels are independent data controllers for information belonging to their guests.</p>
<h3>5.3 Legal Requirements</h3>
<p>We may disclose information if required by law, court order, or to protect the rights, property, or safety of Vaketta, our users, or the public.</p>

<h2>6. Cookies and Tracking</h2>
<ul>
<li>Essential cookies: Secure, httpOnly cookies for session authentication — required for the service to function</li>
<li>No third-party advertising or analytics cookies are used</li>
<li>We do not use tracking pixels or cross-site tracking technologies</li>
</ul>

<h2>7. Your Rights</h2>
<h3>7.1 Hotel Operators</h3>
<p>As a Vaketta account holder, you have the right to:</p>
<ul>
<li>Access and export your account data and conversation history</li>
<li>Correct inaccurate information in your hotel profile</li>
<li>Request deletion of your account and associated data</li>
<li>Withdraw consent for optional data processing at any time</li>
</ul>
<h3>7.2 Guests</h3>
<p>If you are a guest who has interacted with a hotel using Vaketta and wish to access, correct, or delete your personal data, you should contact the hotel directly. You may also contact us at privacy@vaketta.com.</p>
<h3>7.3 Exercising Your Rights</h3>
<p>To exercise any of the above rights, please email privacy@vaketta.com. We will respond within 30 days.</p>

<h2>8. International Data Transfers</h2>
<p>Vaketta is operated from India. Our cloud infrastructure providers may process data in the European Union, United States, or other regions. Where data is transferred internationally, we rely on the contractual data protection commitments of our sub-processors.</p>

<h2>9. Children's Privacy</h2>
<p>Vaketta is not directed at children under the age of 13. We do not knowingly collect personal information from children. If you believe a child's information has been collected through our platform, please contact us immediately at privacy@vaketta.com.</p>

<h2>10. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time to reflect changes in our practices, technology, or legal requirements. When we make material changes, we will update the Effective Date at the top of this document and notify account holders via email or an in-dashboard notice.</p>

<h2>11. Contact Us</h2>
<p>If you have any questions, concerns, or requests regarding this Privacy Policy or your personal data, please contact:</p>
<p><strong>Vaketta — Privacy Enquiries</strong><br>Email: privacy@vaketta.com<br>Website: vaketta.com<br>Location: Varkala, Kerala, India</p>`;

export async function getPrivacyPolicy() {
  const policy = await prisma.privacyPolicy.upsert({
    where:  { id: "global" },
    update: {},
    create: {
      id:            "global",
      effectiveDate: "April 11, 2026",
      content:       DEFAULT_CONTENT,
    },
  });
  return policy;
}

export async function updatePrivacyPolicy(data: {
  effectiveDate?: string;
  content?:       string;
}) {
  return prisma.privacyPolicy.upsert({
    where:  { id: "global" },
    update: {
      ...(data.effectiveDate != null && { effectiveDate: data.effectiveDate.trim() }),
      ...(data.content       != null && { content:       data.content }),
    },
    create: {
      id:            "global",
      effectiveDate: data.effectiveDate ?? "April 11, 2026",
      content:       data.content       ?? DEFAULT_CONTENT,
    },
  });
}
