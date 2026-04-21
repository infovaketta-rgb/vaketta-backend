import prisma from "../db/connect";

const DEFAULT_CONTENT = `<h2>1. Introduction</h2>
<p>Welcome to Vaketta ("we", "our", "us"). Vaketta is a SaaS platform that provides AI-powered WhatsApp automation, booking management, and hotel operations tools. It is operated by a solo founder based in Varkala, Kerala, India.</p>
<p>By creating an account or using any part of the Vaketta platform, you agree to be bound by these Terms of Service. If you do not agree, you must not use the service.</p>
<p><strong>Contact:</strong> infovaketta@gmail.com</p>

<h2>2. Description of Service</h2>
<p>Vaketta provides hotel operators and service businesses with:</p>
<ul>
<li>Automated guest communication via WhatsApp Business API</li>
<li>AI-generated replies powered by large language models</li>
<li>Visual bot/flow builders for conversational automation</li>
<li>Booking management, room availability tracking, and guest records</li>
<li>A web-based dashboard for staff to monitor and respond to conversations</li>
</ul>
<p>The service is provided on a monthly subscription basis. Feature availability depends on the plan selected at the time of subscription.</p>

<h2>3. Eligibility and Account Registration</h2>
<ul>
<li>You must be at least 18 years of age and have the legal authority to enter into a binding agreement.</li>
<li>You must provide accurate, complete, and current information during registration.</li>
<li>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account.</li>
<li>You must notify us immediately at infovaketta@gmail.com if you suspect any unauthorised use of your account.</li>
</ul>

<h2>4. Acceptable Use</h2>
<p>You agree to use Vaketta only for lawful business purposes. You must not:</p>
<ul>
<li>Use the platform to send spam, unsolicited commercial messages, or abusive content to guests.</li>
<li>Violate Meta's WhatsApp Business API policies or any applicable messaging platform terms.</li>
<li>Attempt to reverse-engineer, decompile, or extract source code from the platform.</li>
<li>Resell, sublicense, or otherwise commercialise access to Vaketta without written permission.</li>
<li>Use the service to store, transmit, or process illegal content or content that infringes third-party intellectual property rights.</li>
<li>Circumvent or attempt to circumvent any security controls, rate limits, or access restrictions.</li>
</ul>

<h2>5. Payment Terms</h2>
<h3>5.1 Subscription Billing</h3>
<p>Vaketta operates on a monthly subscription model. Fees are billed in advance at the start of each billing cycle. All prices are listed in Indian Rupees (INR) unless stated otherwise.</p>
<h3>5.2 Payment Obligations</h3>
<ul>
<li>Payment is due at the beginning of each billing period.</li>
<li>Failure to pay on time may result in suspension or termination of your account.</li>
<li>All fees are non-refundable except as required by applicable law or as otherwise stated in a specific refund policy.</li>
</ul>
<h3>5.3 Plan Changes</h3>
<p>You may upgrade or downgrade your plan at any time. Upgrades take effect immediately; downgrades take effect at the start of the next billing cycle.</p>
<h3>5.4 Taxes</h3>
<p>You are responsible for all applicable taxes (including GST where applicable) associated with your subscription.</p>

<h2>6. Free Trial</h2>
<p>New accounts may be eligible for a limited free trial period. At the end of the trial, access will continue only if a paid plan is activated. Vaketta reserves the right to modify or withdraw trial offers at any time.</p>

<h2>7. Intellectual Property</h2>
<p>All intellectual property rights in the Vaketta platform — including software, designs, trademarks, and documentation — are owned by Vaketta or its licensors. These Terms do not grant you any ownership interest in the platform. You retain ownership of all data and content you upload to the platform.</p>

<h2>8. Data and Privacy</h2>
<p>Your use of Vaketta is also governed by our Privacy Policy, which is incorporated into these Terms by reference. By using the service, you consent to the collection and use of data as described in that policy.</p>

<h2>9. Third-Party Services</h2>
<p>Vaketta integrates with third-party services including Meta (WhatsApp Business API), Anthropic (AI), Cloudflare (storage), and others. Your use of those integrations is subject to the relevant third-party terms of service. Vaketta is not responsible for the availability, accuracy, or practices of third-party services.</p>

<h2>10. Termination</h2>
<h3>10.1 Termination by You</h3>
<p>You may cancel your subscription at any time by contacting infovaketta@gmail.com. Cancellation takes effect at the end of the current billing period. You will retain access to the platform until the period ends.</p>
<h3>10.2 Termination by Vaketta</h3>
<p>We may suspend or terminate your account immediately, without notice, if:</p>
<ul>
<li>You breach any provision of these Terms.</li>
<li>You use the platform in a way that may cause harm to Vaketta, other users, or third parties.</li>
<li>We are required to do so by law or court order.</li>
</ul>
<h3>10.3 Effect of Termination</h3>
<p>Upon termination, your access to the platform will cease. We will retain your data for a reasonable period for support and dispute resolution before permanently deleting it. You may request earlier deletion by emailing infovaketta@gmail.com.</p>

<h2>11. Disclaimer of Warranties</h2>
<p>Vaketta is provided "as is" and "as available" without warranties of any kind, either express or implied. We do not warrant that the service will be uninterrupted, error-free, or free of viruses. AI-generated replies are automated and may not always be accurate — you are responsible for reviewing content sent to guests.</p>

<h2>12. Limitation of Liability</h2>
<p>To the maximum extent permitted by applicable law, Vaketta and its founder shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, revenue, data, or goodwill, arising out of or in connection with your use of the service.</p>
<p>In no event shall our total aggregate liability to you exceed the amount paid by you to Vaketta in the three months preceding the claim.</p>

<h2>13. Indemnification</h2>
<p>You agree to indemnify, defend, and hold harmless Vaketta and its founder from and against any claims, liabilities, damages, losses, and expenses (including legal fees) arising out of your use of the platform, your violation of these Terms, or your violation of any rights of a third party.</p>

<h2>14. Governing Law and Dispute Resolution</h2>
<p>These Terms shall be governed by and construed in accordance with the laws of the State of Kerala, India, without regard to its conflict of law provisions. Any disputes arising out of or relating to these Terms shall be subject to the exclusive jurisdiction of the courts located in Thiruvananthapuram, Kerala, India.</p>

<h2>15. Changes to These Terms</h2>
<p>We may update these Terms from time to time. When we make material changes, we will update the effective date and notify you via email or an in-dashboard notice. Your continued use of the platform after the effective date constitutes acceptance of the revised Terms.</p>

<h2>16. Contact</h2>
<p>If you have any questions about these Terms, please contact us:</p>
<p><strong>Vaketta</strong><br>Email: infovaketta@gmail.com<br>Location: Varkala, Kerala, India</p>`;

export async function getTermsOfService() {
  return prisma.termsOfService.upsert({
    where:  { id: "global" },
    update: {},
    create: {
      id:            "global",
      effectiveDate: "April 17, 2026",
      content:       DEFAULT_CONTENT,
    },
  });
}

export async function updateTermsOfService(data: {
  effectiveDate?: string;
  content?:       string;
}) {
  return prisma.termsOfService.upsert({
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
